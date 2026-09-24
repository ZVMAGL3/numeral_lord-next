import type {
  PublishMapRequest,
  PublishTerrainModRequest,
  WorkshopCatalog,
  WorkshopDetail,
  WorkshopGetRequest,
  WorkshopKind,
  WorkshopMapEntry,
  WorkshopMapSummary,
  WorkshopPublished,
  WorkshopSourceFile,
  WorkshopTerrainModEntry,
  WorkshopTerrainModSummary
} from "@numeral-lord/content-schema";
import { parseMapCode, serializeMapCode } from "@numeral-lord/core-content";
import { Room, type Client } from "colyseus";
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_MAPS = 200;
const MAX_TERRAIN_MODS = 100;
const MAX_MAP_CODE_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_SOURCE_FILES = 16;
const MAX_DATABASE_BYTES = 32 * 1024 * 1024;
const PUBLICATION_COOLDOWN_MS = 3_000;
const MAX_PUBLICATIONS_PER_SESSION = 10;
const DATABASE_MIGRATION_LOCK = 918273645;

interface WorkshopDatabase {
  readonly version: 1;
  readonly maps: readonly WorkshopMapEntry[];
  readonly terrainMods: readonly WorkshopTerrainModEntry[];
}

interface PublicationRate {
  lastAt: number;
  count: number;
}

export class WorkshopInputError extends Error {}

/**
 * Local JSON persistence for a small workshop. All writes from this process
 * are serialized, and a new snapshot replaces the old one only after a
 * successful disk write. Run one server process per data directory.
 */
export class WorkshopStore {
  private database: WorkshopDatabase = { version: 1, maps: [], terrainMods: [] };
  private loading: Promise<void> | undefined;
  private pendingWrite: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDirectory = process.env.WORKSHOP_DATA_DIR ?? join(process.cwd(), "data", "workshop")) {}

  async load(): Promise<void> {
    this.loading ??= this.readDatabase();
    return this.loading;
  }

  async list(): Promise<WorkshopCatalog> {
    await this.load();
    return {
      maps: this.database.maps.map(({ code: _code, ...summary }): WorkshopMapSummary => summary),
      terrainMods: this.database.terrainMods.map(({ sourceFiles: _sourceFiles, ...summary }): WorkshopTerrainModSummary => summary)
    };
  }

  async get(request: WorkshopGetRequest): Promise<WorkshopDetail | undefined> {
    await this.load();
    if (request.kind === "map") {
      const entry = this.database.maps.find((map) => map.id === request.id);
      return entry ? { kind: "map", entry } : undefined;
    }
    if (request.kind === "terrain-mod") {
      const entry = this.database.terrainMods.find((mod) => mod.id === request.id);
      return entry ? { kind: "terrain-mod", entry } : undefined;
    }
    throw new WorkshopInputError("工坊内容类型无效。");
  }

  async publishMap(input: unknown, authorName: string): Promise<WorkshopPublished> {
    const payload = validateMapRequest(input);
    let map;
    let code;
    try {
      // A map is ordinary JSON. Missing optional terrain Mods are allowed for
      // catalog preview but the game still requires installation before play.
      map = parseMapCode(payload.code, { allowUnknownTerrainMods: true });
      code = serializeMapCode(map, { allowUnknownTerrainMods: true });
    } catch (error) {
      throw new WorkshopInputError(error instanceof Error ? error.message : "地图码无效。");
    }
    const entry: WorkshopMapEntry = {
      id: randomUUID(),
      mapId: map.id,
      name: map.name,
      description: payload.description,
      authorName: normalizeAuthorName(authorName),
      createdAt: new Date().toISOString(),
      players: map.players,
      requiredTerrainModIds: map.requiredTerrainModIds,
      code
    };
    return this.mutate((database) => {
      if (database.maps.length >= MAX_MAPS) throw new WorkshopInputError("工坊地图已达到容量上限。");
      if (database.maps.some((existing) => existing.code === code)) throw new WorkshopInputError("这份地图码已经发布过了。");
      return {
        database: { ...database, maps: [entry, ...database.maps] },
        result: { kind: "map", id: entry.id } as const
      };
    });
  }

  async publishTerrainMod(input: unknown, authorName: string): Promise<WorkshopPublished> {
    const payload = validateTerrainModRequest(input);
    const entry: WorkshopTerrainModEntry = {
      id: randomUUID(),
      modId: payload.id,
      name: payload.name,
      version: payload.version,
      description: payload.description,
      terrainIds: payload.terrainIds,
      sourceFiles: payload.sourceFiles,
      authorName: normalizeAuthorName(authorName),
      createdAt: new Date().toISOString()
    };
    return this.mutate((database) => {
      if (database.terrainMods.length >= MAX_TERRAIN_MODS) throw new WorkshopInputError("工坊地块 Mod 已达到容量上限。");
      if (database.terrainMods.some((existing) => existing.modId === entry.modId && existing.version === entry.version)) {
        throw new WorkshopInputError("相同 ID 和版本的地块 Mod 已发布。");
      }
      return {
        database: { ...database, terrainMods: [entry, ...database.terrainMods] },
        result: { kind: "terrain-mod", id: entry.id } as const
      };
    });
  }

  private async readDatabase(): Promise<void> {
    const file = join(this.dataDirectory, "workshop.json");
    let size;
    try {
      size = (await stat(file)).size;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    if (size > MAX_DATABASE_BYTES) throw new Error("Workshop database exceeds its size limit.");
    const decoded: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(decoded) || decoded.version !== 1 || !Array.isArray(decoded.maps) || !Array.isArray(decoded.terrainMods)
      || decoded.maps.length > MAX_MAPS || decoded.terrainMods.length > MAX_TERRAIN_MODS) {
      throw new Error("Workshop database has an invalid format.");
    }
    // This file is server-owned. Refuse an invalid snapshot instead of
    // silently overwriting it and losing submissions.
    this.database = decoded as unknown as WorkshopDatabase;
  }

  private async mutate<T>(transform: (database: WorkshopDatabase) => { database: WorkshopDatabase; result: T }): Promise<T> {
    const operation = this.pendingWrite.then(async () => {
      await this.load();
      const { database, result } = transform(this.database);
      await this.writeDatabase(database);
      this.database = database;
      return result;
    });
    this.pendingWrite = operation.catch(() => undefined);
    return operation;
  }

  private async writeDatabase(database: WorkshopDatabase): Promise<void> {
    const serialized = JSON.stringify(database);
    if (Buffer.byteLength(serialized, "utf8") > MAX_DATABASE_BYTES) throw new WorkshopInputError("工坊存储空间已满。");
    await mkdir(this.dataDirectory, { recursive: true });
    const temporaryFile = join(this.dataDirectory, `workshop-${process.pid}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryFile, serialized, { encoding: "utf8", flag: "wx" });
      await rename(temporaryFile, join(this.dataDirectory, "workshop.json"));
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
  }
}

/** PostgreSQL persistence used by the public service; JSON remains the local-dev fallback. */
export class PostgresWorkshopStore {
  private readonly pool: Pool;
  private loading: Promise<void> | undefined;

  constructor(private readonly dataDirectory = process.env.WORKSHOP_DATA_DIR ?? join(process.cwd(), "data", "workshop")) {
    this.pool = new Pool({
      ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
      ...(process.env.PGHOST ? { host: process.env.PGHOST } : {}),
      ...(process.env.PGPORT ? { port: Number(process.env.PGPORT) } : {}),
      ...(process.env.PGDATABASE ? { database: process.env.PGDATABASE } : {}),
      ...(process.env.PGUSER ? { user: process.env.PGUSER } : {}),
      max: 8,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000
    });
  }

  async load(): Promise<void> {
    this.loading ??= this.initialize();
    return this.loading;
  }

  async list(): Promise<WorkshopCatalog> {
    await this.load();
    const [maps, terrainMods] = await Promise.all([
      this.pool.query<{ entry: string }>("SELECT entry FROM nl_workshop_maps ORDER BY created_at DESC, id"),
      this.pool.query<{ entry: string }>("SELECT entry FROM nl_workshop_terrain_mods ORDER BY created_at DESC, id")
    ]);
    return {
      maps: maps.rows.map(({ entry }) => {
        const { code: _code, ...summary } = parseStoredEntry<WorkshopMapEntry>(entry);
        return summary;
      }),
      terrainMods: terrainMods.rows.map(({ entry }) => {
        const { sourceFiles: _sourceFiles, ...summary } = parseStoredEntry<WorkshopTerrainModEntry>(entry);
        return summary;
      })
    };
  }

  async get(request: WorkshopGetRequest): Promise<WorkshopDetail | undefined> {
    await this.load();
    if (request.kind === "map") {
      const result = await this.pool.query<{ entry: string }>(
        "SELECT entry FROM nl_workshop_maps WHERE id = $1", [request.id]
      );
      return result.rows[0] ? { kind: "map", entry: parseStoredEntry<WorkshopMapEntry>(result.rows[0].entry) } : undefined;
    }
    if (request.kind === "terrain-mod") {
      const result = await this.pool.query<{ entry: string }>(
        "SELECT entry FROM nl_workshop_terrain_mods WHERE id = $1", [request.id]
      );
      return result.rows[0] ? { kind: "terrain-mod", entry: parseStoredEntry<WorkshopTerrainModEntry>(result.rows[0].entry) } : undefined;
    }
    throw new WorkshopInputError("工坊内容类型无效。");
  }

  async publishMap(input: unknown, authorName: string): Promise<WorkshopPublished> {
    await this.load();
    const payload = validateMapRequest(input);
    let map;
    let code;
    try {
      map = parseMapCode(payload.code, { allowUnknownTerrainMods: true });
      code = serializeMapCode(map, { allowUnknownTerrainMods: true });
    } catch (error) {
      throw new WorkshopInputError(error instanceof Error ? error.message : "地图码无效。");
    }
    const entry: WorkshopMapEntry = {
      id: randomUUID(), mapId: map.id, name: map.name, description: payload.description,
      authorName: normalizeAuthorName(authorName), createdAt: new Date().toISOString(),
      players: map.players, requiredTerrainModIds: map.requiredTerrainModIds, code
    };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [DATABASE_MIGRATION_LOCK]);
      const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM nl_workshop_maps");
      if (Number(count.rows[0]?.count ?? 0) >= MAX_MAPS) throw new WorkshopInputError("工坊地图已达到容量上限。");
      const existing = await client.query("SELECT 1 FROM nl_workshop_maps WHERE code = $1 LIMIT 1", [code]);
      if (existing.rowCount) throw new WorkshopInputError("这份地图码已经发布过了。");
      await client.query("INSERT INTO nl_workshop_maps (id, code, entry, created_at) VALUES ($1, $2, $3, $4)",
        [entry.id, code, JSON.stringify(entry), entry.createdAt]);
      await client.query("COMMIT");
      return { kind: "map", id: entry.id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof WorkshopInputError) throw error;
      throw new Error("Failed to persist workshop map.", { cause: error });
    } finally {
      client.release();
    }
  }

  async publishTerrainMod(input: unknown, authorName: string): Promise<WorkshopPublished> {
    await this.load();
    const payload = validateTerrainModRequest(input);
    const entry: WorkshopTerrainModEntry = {
      id: randomUUID(), modId: payload.id, name: payload.name, version: payload.version,
      description: payload.description, terrainIds: payload.terrainIds, sourceFiles: payload.sourceFiles,
      authorName: normalizeAuthorName(authorName), createdAt: new Date().toISOString()
    };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [DATABASE_MIGRATION_LOCK]);
      const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM nl_workshop_terrain_mods");
      if (Number(count.rows[0]?.count ?? 0) >= MAX_TERRAIN_MODS) throw new WorkshopInputError("工坊地块 Mod 已达到容量上限。");
      const existing = await client.query("SELECT 1 FROM nl_workshop_terrain_mods WHERE mod_id = $1 AND version = $2 LIMIT 1",
        [entry.modId, entry.version]);
      if (existing.rowCount) throw new WorkshopInputError("相同 ID 和版本的地块 Mod 已发布。");
      await client.query("INSERT INTO nl_workshop_terrain_mods (id, mod_id, version, entry, created_at) VALUES ($1, $2, $3, $4, $5)",
        [entry.id, entry.modId, entry.version, JSON.stringify(entry), entry.createdAt]);
      await client.query("COMMIT");
      return { kind: "terrain-mod", id: entry.id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof WorkshopInputError) throw error;
      throw new Error("Failed to persist workshop terrain Mod.", { cause: error });
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS nl_schema_migrations (
        name text PRIMARY KEY,
        completed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS nl_workshop_maps (
        id text PRIMARY KEY,
        code text NOT NULL UNIQUE,
        entry text NOT NULL CHECK (jsonb_typeof(entry::jsonb) = 'object'),
        created_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nl_workshop_maps_created_idx ON nl_workshop_maps (created_at DESC);
      CREATE TABLE IF NOT EXISTS nl_workshop_terrain_mods (
        id text PRIMARY KEY,
        mod_id text NOT NULL,
        version text NOT NULL,
        entry text NOT NULL CHECK (jsonb_typeof(entry::jsonb) = 'object'),
        UNIQUE(mod_id, version),
        created_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nl_workshop_mods_created_idx ON nl_workshop_terrain_mods (created_at DESC);
    `);
    await this.importLegacyJsonOnce();
  }

  /** Merge legacy JSON entries once; never overwrite or truncate existing database rows. */
  private async importLegacyJsonOnce(): Promise<void> {
    const migrationName = "legacy_workshop_json_v1";
    const done = await this.pool.query("SELECT 1 FROM nl_schema_migrations WHERE name = $1", [migrationName]);
    if (done.rowCount) return;
    const file = join(this.dataDirectory, "workshop.json");
    let decoded: unknown;
    try {
      const size = (await stat(file)).size;
      if (size > MAX_DATABASE_BYTES) throw new Error("Workshop database exceeds its size limit.");
      decoded = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      decoded = undefined;
    }
    if (decoded !== undefined && (!isRecord(decoded) || decoded.version !== 1 || !Array.isArray(decoded.maps)
      || !Array.isArray(decoded.terrainMods) || decoded.maps.length > MAX_MAPS || decoded.terrainMods.length > MAX_TERRAIN_MODS)) {
      throw new Error("Legacy workshop JSON has an invalid format; refusing to mark it imported.");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [DATABASE_MIGRATION_LOCK]);
      const recheck = await client.query("SELECT 1 FROM nl_schema_migrations WHERE name = $1", [migrationName]);
      if (!recheck.rowCount && decoded !== undefined) {
        const data = decoded as unknown as WorkshopDatabase;
        for (const entry of data.maps) {
          await client.query("INSERT INTO nl_workshop_maps (id, code, entry, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
            [entry.id, entry.code, JSON.stringify(entry), entry.createdAt]);
        }
        for (const entry of data.terrainMods) {
          await client.query("INSERT INTO nl_workshop_terrain_mods (id, mod_id, version, entry, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
            [entry.id, entry.modId, entry.version, JSON.stringify(entry), entry.createdAt]);
        }
      }
      await client.query("INSERT INTO nl_schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [migrationName]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Local development uses the same portable JSON records inside a SQLite file. */
export class SqliteWorkshopStore {
  private database: DatabaseSync | undefined;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly databasePath = process.env.LOCAL_DATABASE_PATH ?? join(process.cwd(), "data", "numeral-lord.sqlite"),
    private readonly legacyDataDirectory = process.env.WORKSHOP_DATA_DIR ?? join(process.cwd(), "data", "workshop")
  ) {}

  async load(): Promise<void> {
    this.loading ??= this.initialize();
    return this.loading;
  }

  async list(): Promise<WorkshopCatalog> {
    await this.load();
    const maps = this.database!.prepare("SELECT entry FROM nl_workshop_maps ORDER BY created_at DESC, id").all() as { entry: string }[];
    const terrainMods = this.database!.prepare("SELECT entry FROM nl_workshop_terrain_mods ORDER BY created_at DESC, id").all() as { entry: string }[];
    return {
      maps: maps.map(({ entry }) => {
        const { code: _code, ...summary } = parseStoredEntry<WorkshopMapEntry>(entry);
        return summary;
      }),
      terrainMods: terrainMods.map(({ entry }) => {
        const { sourceFiles: _sourceFiles, ...summary } = parseStoredEntry<WorkshopTerrainModEntry>(entry);
        return summary;
      })
    };
  }

  async get(request: WorkshopGetRequest): Promise<WorkshopDetail | undefined> {
    await this.load();
    if (request.kind === "map") {
      const row = this.database!.prepare("SELECT entry FROM nl_workshop_maps WHERE id = ?").get(request.id) as { entry: string } | undefined;
      return row ? { kind: "map", entry: parseStoredEntry<WorkshopMapEntry>(row.entry) } : undefined;
    }
    if (request.kind === "terrain-mod") {
      const row = this.database!.prepare("SELECT entry FROM nl_workshop_terrain_mods WHERE id = ?").get(request.id) as { entry: string } | undefined;
      return row ? { kind: "terrain-mod", entry: parseStoredEntry<WorkshopTerrainModEntry>(row.entry) } : undefined;
    }
    throw new WorkshopInputError("工坊内容类型无效。");
  }

  async publishMap(input: unknown, authorName: string): Promise<WorkshopPublished> {
    await this.load();
    const payload = validateMapRequest(input);
    let map;
    let code;
    try {
      map = parseMapCode(payload.code, { allowUnknownTerrainMods: true });
      code = serializeMapCode(map, { allowUnknownTerrainMods: true });
    } catch (error) {
      throw new WorkshopInputError(error instanceof Error ? error.message : "地图码无效。");
    }
    const entry: WorkshopMapEntry = {
      id: randomUUID(), mapId: map.id, name: map.name, description: payload.description,
      authorName: normalizeAuthorName(authorName), createdAt: new Date().toISOString(),
      players: map.players, requiredTerrainModIds: map.requiredTerrainModIds, code
    };
    const database = this.database!;
    database.exec("BEGIN IMMEDIATE");
    try {
      const count = database.prepare("SELECT count(*) AS count FROM nl_workshop_maps").get() as { count: number };
      if (count.count >= MAX_MAPS) throw new WorkshopInputError("工坊地图已达到容量上限。");
      const existing = database.prepare("SELECT 1 FROM nl_workshop_maps WHERE code = ? LIMIT 1").get(code);
      if (existing) throw new WorkshopInputError("这份地图码已经发布过了。");
      database.prepare("INSERT INTO nl_workshop_maps (id, code, entry, created_at) VALUES (?, ?, ?, ?)")
        .run(entry.id, code, JSON.stringify(entry), entry.createdAt);
      database.exec("COMMIT");
      return { kind: "map", id: entry.id };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async publishTerrainMod(input: unknown, authorName: string): Promise<WorkshopPublished> {
    await this.load();
    const payload = validateTerrainModRequest(input);
    const entry: WorkshopTerrainModEntry = {
      id: randomUUID(), modId: payload.id, name: payload.name, version: payload.version,
      description: payload.description, terrainIds: payload.terrainIds, sourceFiles: payload.sourceFiles,
      authorName: normalizeAuthorName(authorName), createdAt: new Date().toISOString()
    };
    const database = this.database!;
    database.exec("BEGIN IMMEDIATE");
    try {
      const count = database.prepare("SELECT count(*) AS count FROM nl_workshop_terrain_mods").get() as { count: number };
      if (count.count >= MAX_TERRAIN_MODS) throw new WorkshopInputError("工坊地块 Mod 已达到容量上限。");
      const existing = database.prepare("SELECT 1 FROM nl_workshop_terrain_mods WHERE mod_id = ? AND version = ? LIMIT 1")
        .get(entry.modId, entry.version);
      if (existing) throw new WorkshopInputError("相同 ID 和版本的地块 Mod 已发布。");
      database.prepare("INSERT INTO nl_workshop_terrain_mods (id, mod_id, version, entry, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(entry.id, entry.modId, entry.version, JSON.stringify(entry), entry.createdAt);
      database.exec("COMMIT");
      return { kind: "terrain-mod", id: entry.id };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS nl_schema_migrations (
        name TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS nl_workshop_maps (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        entry TEXT NOT NULL CHECK (json_valid(entry) AND json_type(entry) = 'object'),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nl_workshop_maps_created_idx ON nl_workshop_maps (created_at DESC);
      CREATE TABLE IF NOT EXISTS nl_workshop_terrain_mods (
        id TEXT PRIMARY KEY,
        mod_id TEXT NOT NULL,
        version TEXT NOT NULL,
        entry TEXT NOT NULL CHECK (json_valid(entry) AND json_type(entry) = 'object'),
        created_at TEXT NOT NULL,
        UNIQUE (mod_id, version)
      );
      CREATE INDEX IF NOT EXISTS nl_workshop_mods_created_idx ON nl_workshop_terrain_mods (created_at DESC);
    `);
    this.importLegacyJsonOnce();
  }

  /** Merge legacy JSON entries once; never overwrite or truncate existing database rows. */
  private importLegacyJsonOnce(): void {
    const database = this.database!;
    const migrationName = "legacy_workshop_json_v1";
    if (database.prepare("SELECT 1 FROM nl_schema_migrations WHERE name = ?").get(migrationName)) return;
    const file = join(this.legacyDataDirectory, "workshop.json");
    let decoded: unknown;
    try {
      const size = statSync(file).size;
      if (size > MAX_DATABASE_BYTES) throw new Error("Workshop database exceeds its size limit.");
      decoded = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      decoded = undefined;
    }
    if (decoded !== undefined && (!isRecord(decoded) || decoded.version !== 1 || !Array.isArray(decoded.maps)
      || !Array.isArray(decoded.terrainMods) || decoded.maps.length > MAX_MAPS || decoded.terrainMods.length > MAX_TERRAIN_MODS)) {
      throw new Error("Legacy workshop JSON has an invalid format; refusing to mark it imported.");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      if (decoded !== undefined) {
        const data = decoded as unknown as WorkshopDatabase;
        const mapInsert = database.prepare("INSERT OR IGNORE INTO nl_workshop_maps (id, code, entry, created_at) VALUES (?, ?, ?, ?)");
        const modInsert = database.prepare("INSERT OR IGNORE INTO nl_workshop_terrain_mods (id, mod_id, version, entry, created_at) VALUES (?, ?, ?, ?, ?)");
        for (const entry of data.maps) mapInsert.run(entry.id, entry.code, JSON.stringify(entry), entry.createdAt);
        for (const entry of data.terrainMods) modInsert.run(entry.id, entry.modId, entry.version, JSON.stringify(entry), entry.createdAt);
      }
      database.prepare("INSERT OR IGNORE INTO nl_schema_migrations (name) VALUES (?)").run(migrationName);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Read/publish protocol over the existing Colyseus transport. Uploaded source
 * never leaves this room as executable code: it is stored and returned only
 * as text for preview. `authorName` is self-declared, not authenticated.
 */
export class WorkshopRoom extends Room {
  private readonly authorNames = new Map<string, string>();
  private readonly publicationRates = new Map<string, PublicationRate>();
  private readonly store = sharedWorkshopStore;

  override async onCreate(): Promise<void> {
    await this.store.load();
    this.maxClients = 256;
    this.autoDispose = false;
    this.onMessage("workshop-list", (client) => { void this.sendList(client); });
    this.onMessage("workshop-get", (client, payload: unknown) => { void this.sendDetail(client, payload); });
    this.onMessage("publish-map", (client, payload: unknown) => { void this.publish(client, "map", payload); });
    this.onMessage("publish-terrain-mod", (client, payload: unknown) => { void this.publish(client, "terrain-mod", payload); });
  }

  override async onJoin(client: Client, options: Record<string, unknown> = {}): Promise<void> {
    this.authorNames.set(client.sessionId, normalizeAuthorName(options.name));
    await this.sendList(client);
  }

  override onLeave(client: Client): void {
    this.authorNames.delete(client.sessionId);
    this.publicationRates.delete(client.sessionId);
  }

  private async sendList(client: Client): Promise<void> {
    try {
      client.send("workshop-list", await this.store.list());
    } catch {
      this.sendError(client, "工坊列表暂时无法读取。");
    }
  }

  private async sendDetail(client: Client, payload: unknown): Promise<void> {
    if (!isRecord(payload) || (payload.kind !== "map" && payload.kind !== "terrain-mod")
      || typeof payload.id !== "string" || payload.id.length > 80) {
      this.sendError(client, "工坊条目请求无效。");
      return;
    }
    try {
      const detail = await this.store.get(payload as unknown as WorkshopGetRequest);
      if (!detail) this.sendError(client, "这项内容不存在或已移除。");
      else client.send("workshop-detail", detail);
    } catch {
      this.sendError(client, "工坊内容暂时无法读取。");
    }
  }

  private async publish(client: Client, kind: WorkshopKind, payload: unknown): Promise<void> {
    // Reading community content is safe for the public test instance, but
    // anonymous publishing is not an authorization model. Production must
    // opt in only after accounts, moderation and durable rate limits exist.
    if (process.env.NODE_ENV === "production" && process.env.WORKSHOP_PUBLISH_ENABLED !== "1") {
      this.sendError(client, "当前公网测试版仅开放预览，暂不接受发布。");
      return;
    }
    const now = Date.now();
    const rate = this.publicationRates.get(client.sessionId) ?? { lastAt: -Infinity, count: 0 };
    if (rate.count >= MAX_PUBLICATIONS_PER_SESSION || now - rate.lastAt < PUBLICATION_COOLDOWN_MS) {
      this.sendError(client, "发布过于频繁，请稍后再试。");
      return;
    }
    try {
      const authorName = this.authorNames.get(client.sessionId) ?? "匿名玩家";
      const published = kind === "map"
        ? await this.store.publishMap(payload, authorName)
        : await this.store.publishTerrainMod(payload, authorName);
      this.publicationRates.set(client.sessionId, { lastAt: now, count: rate.count + 1 });
      client.send("workshop-published", published);
      this.broadcast("workshop-list", await this.store.list());
    } catch (error) {
      this.sendError(client, error instanceof WorkshopInputError ? error.message : "发布失败，工坊暂时不可用。");
    }
  }

  private sendError(client: Client, message: string): void {
    client.send("workshop-error", { message });
  }
}

const sharedWorkshopStore = process.env.DATABASE_URL || process.env.PGHOST
  ? new PostgresWorkshopStore()
  : new SqliteWorkshopStore();

function validateMapRequest(input: unknown): PublishMapRequest {
  if (!isRecord(input) || typeof input.code !== "string" || byteLength(input.code) === 0
    || byteLength(input.code) > MAX_MAP_CODE_BYTES) {
    throw new WorkshopInputError("地图码为空或超过 64 KiB。");
  }
  return { code: input.code, description: validateDescription(input.description) };
}

function validateTerrainModRequest(input: unknown): PublishTerrainModRequest {
  if (!isRecord(input)) throw new WorkshopInputError("地块 Mod 数据无效。");
  const { id, name, version, terrainIds, sourceFiles } = input;
  if (typeof id !== "string" || !/^mod-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 80) {
    throw new WorkshopInputError("Mod ID 应采用 mod-名称 格式。");
  }
  if (typeof name !== "string" || name.trim().length === 0 || byteLength(name) > 120) {
    throw new WorkshopInputError("Mod 名称无效或过长。");
  }
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || version.length > 40) {
    throw new WorkshopInputError("Mod 版本应采用 1.0.0 格式。");
  }
  if (!Array.isArray(terrainIds) || terrainIds.length === 0 || terrainIds.length > 32
    || terrainIds.some((terrainId) => typeof terrainId !== "string" || terrainId.length > 120
      || !new RegExp(`^mod/${id.slice(4)}(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$`).test(terrainId))
    || new Set(terrainIds).size !== terrainIds.length) {
    throw new WorkshopInputError("地形 ID 必须属于该 Mod，且不能重复。");
  }
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0 || sourceFiles.length > MAX_SOURCE_FILES) {
    throw new WorkshopInputError("Mod 源码文件应为 1 到 16 个。");
  }
  let totalSourceBytes = 0;
  const files: WorkshopSourceFile[] = [];
  const paths = new Set<string>();
  for (const item of sourceFiles) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.content !== "string"
      || item.path.length > 120 || !isSafeRelativePath(item.path) || paths.has(item.path)) {
      throw new WorkshopInputError("Mod 源码文件路径无效或重复。");
    }
    const size = byteLength(item.content);
    totalSourceBytes += size;
    if (size === 0 || totalSourceBytes > MAX_SOURCE_BYTES) {
      throw new WorkshopInputError("Mod 源码为空或总量超过 64 KiB。");
    }
    paths.add(item.path);
    files.push({ path: item.path, content: item.content });
  }
  return {
    id,
    name: name.trim(),
    version,
    description: validateDescription(input.description),
    terrainIds: [...terrainIds] as string[],
    sourceFiles: files
  };
}

function validateDescription(value: unknown): string {
  if (typeof value !== "string" || byteLength(value) > 1_000) {
    throw new WorkshopInputError("简介必须是文字，且不能超过 1,000 字节。");
  }
  return value.trim();
}

function normalizeAuthorName(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : "匿名玩家";
}

function isSafeRelativePath(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\\") && !path.includes(":")
    && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function parseStoredEntry<T>(value: string): T {
  return JSON.parse(value) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}
