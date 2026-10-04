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
  TerrainModDefinition,
  WorkshopTerrainModDetailEntry,
  WorkshopTerrainModPreview,
  WorkshopTerrainModEntry,
  WorkshopTerrainModSummary
} from "@numeral-lord/content-schema";
import { validateTerrainModDefinition } from "@numeral-lord/content-schema";
import { parseMapCode, serializeMapCode } from "@numeral-lord/core-content";
import { Room, type Client } from "colyseus";
import { Pool, type PoolClient } from "pg";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { hashModContent, modContentIdentity, type ModDefinition } from "@numeral-lord/game-sdk";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultWorkshopDataDirectory,
  getTerrainAssetContentType,
  getTerrainAssetFileName,
  persistTerrainVisualAssets,
  workshopTerrainAssetDirectory,
  type StoredVisualAsset
} from "./workshop-assets.js";

const MAX_MAPS = 200;
const MAX_TERRAIN_MODS = 1_024;
const MAX_TERRAIN_MOD_RELEASES_PER_MOD = 128;
const MAX_MAP_CODE_BYTES = 64 * 1024;
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const PUBLICATION_COOLDOWN_MS = 3_000;
const MAX_PUBLICATIONS_PER_SESSION = 10;
const DATABASE_MIGRATION_LOCK = 918273645;
const WORKSHOP_ASSET_RETENTION_MS = 24 * 60 * 60 * 1000;
const WORKSHOP_ASSET_CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

interface WorkshopDatabase {
  readonly version: 1;
  readonly maps: readonly WorkshopMapEntry[];
  readonly terrainMods: readonly StoredWorkshopTerrainModEntry[];
}

/** Database form: definitions are JSON-only and art is deduplicated in persistent files. */
interface StoredWorkshopTerrainModEntry extends Omit<WorkshopTerrainModEntry, "definition"> {
  readonly definition?: Omit<TerrainModDefinition, "visualAssets">;
  readonly visualAssetUrls?: Readonly<Record<string, string>>;
  /** Presentation-only artwork is separate from the immutable playable Mod definition/hash. */
  readonly previewArtworkUrls?: Readonly<Record<string, string>>;
  /** Pre single-terrain releases used a plural terrainIds field. */
  readonly terrainIds?: readonly string[];
}

interface PublicationRate {
  lastAt: number;
  count: number;
}

interface TerrainAssetUploadRecord {
  readonly uploadId: string;
  readonly assetUrl: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly uploadedAt: string;
}

interface TerrainAssetUploadRow {
  readonly asset_url: string;
  readonly last_uploaded_at: string;
}

interface TerrainAssetBinding {
  readonly assetUrl: string;
  readonly releaseId: string;
  readonly modId: string;
  readonly boundAt: string;
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
      terrainMods: this.database.terrainMods.map(terrainModSummary)
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
      return entry ? terrainModDetail(entry) : undefined;
    }
    throw new WorkshopInputError("工坊内容类型无效。");
  }

  async getTerrainModPreview(id: string): Promise<WorkshopTerrainModPreview | undefined> {
    await this.load();
    const entry = this.database.terrainMods.find((mod) => mod.id === id);
    if (!entry) return undefined;
    const preview = terrainModVisualPreview(entry);
    return preview ? { id, preview } : undefined;
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
      modId: payload.definition.id,
      name: payload.name,
      version: payload.definition.version,
      description: payload.description,
      terrainId: terrainIdForModId(payload.definition.id),
      contentHash: hashModContent(terrainModContent(payload.definition)),
      definition: payload.definition,
      authorName: normalizeAuthorName(authorName),
      createdAt: new Date().toISOString()
    };
    return this.mutate(async (database) => {
      if (database.terrainMods.length >= MAX_TERRAIN_MODS) throw new WorkshopInputError("工坊地块 Mod 已达到容量上限。");
      if (database.terrainMods.some((existing) => existing.modId === entry.modId)) {
        throw new WorkshopInputError("该 Mod ID 已有不可变发布记录，请通过“发布新版本”更新。");
      }
      if (database.terrainMods.some((existing) => existing.modId === entry.modId && existing.version === entry.version)) {
        throw new WorkshopInputError("相同 ID 和版本的地块 Mod 已发布。");
      }
      const storedEntry = await storeTerrainModAssets(entry, this.dataDirectory);
      return {
        database: { ...database, terrainMods: [storedEntry, ...database.terrainMods] },
        result: { kind: "terrain-mod", id: entry.id } as const
      };
    });
  }

  async updateTerrainMod(input: unknown, authorName: string): Promise<WorkshopPublished> {
    const { updateId, payload } = validateTerrainModUpdateRequest(input);
    const normalizedAuthor = normalizeAuthorName(authorName);
    return this.mutate(async (database) => {
      const current = database.terrainMods.find((entry) => entry.id === updateId);
      if (!current) throw new WorkshopInputError("要更新的 Mod 已不存在，请刷新工坊后重试。");
      const entry = createUpdatedTerrainMod(current, payload, normalizedAuthor, database.terrainMods);
      const storedEntry = await storeTerrainModAssets(entry, this.dataDirectory);
      return {
        database: { ...database, terrainMods: [storedEntry, ...database.terrainMods] },
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
    const legacyDatabase = decoded as unknown as WorkshopDatabase;
    const terrainMods: StoredWorkshopTerrainModEntry[] = [];
    let migrated = false;
    for (const entry of legacyDatabase.terrainMods) {
      const storedEntry = await storeTerrainModAssets(entry as WorkshopTerrainModEntry, this.dataDirectory);
      if (JSON.stringify(storedEntry) !== JSON.stringify(entry)) migrated = true;
      terrainMods.push(storedEntry);
    }
    this.database = { ...legacyDatabase, terrainMods };
    if (migrated) await this.writeDatabase(this.database);
  }

  private async mutate<T>(transform: (database: WorkshopDatabase) => Promise<{ database: WorkshopDatabase; result: T }> | { database: WorkshopDatabase; result: T }): Promise<T> {
    const operation = this.pendingWrite.then(async () => {
      await this.load();
      const { database, result } = await transform(this.database);
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
      terrainMods: terrainMods.rows.map(({ entry }) => terrainModSummary(parseStoredEntry<StoredWorkshopTerrainModEntry>(entry)))
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
      return result.rows[0] ? terrainModDetail(parseStoredEntry<StoredWorkshopTerrainModEntry>(result.rows[0].entry)) : undefined;
    }
    throw new WorkshopInputError("工坊内容类型无效。");
  }

  async getTerrainModPreview(id: string): Promise<WorkshopTerrainModPreview | undefined> {
    await this.load();
    const result = await this.pool.query<{ entry: string }>(
      "SELECT entry FROM nl_workshop_terrain_mods WHERE id = $1", [id]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const entry = parseStoredEntry<StoredWorkshopTerrainModEntry>(row.entry);
    const preview = terrainModVisualPreview(entry);
    return preview ? { id, preview } : undefined;
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
      id: randomUUID(), modId: payload.definition.id, name: payload.name, version: payload.definition.version,
      description: payload.description, terrainId: terrainIdForModId(payload.definition.id),
      contentHash: hashModContent(terrainModContent(payload.definition)), definition: payload.definition,
      authorName: normalizeAuthorName(authorName), createdAt: new Date().toISOString()
    };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [DATABASE_MIGRATION_LOCK]);
      const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM nl_workshop_terrain_mods");
      if (Number(count.rows[0]?.count ?? 0) >= MAX_TERRAIN_MODS) throw new WorkshopInputError("工坊地块 Mod 已达到容量上限。");
      const previousRelease = await client.query("SELECT 1 FROM nl_workshop_terrain_mods WHERE mod_id = $1 LIMIT 1", [entry.modId]);
      if (previousRelease.rowCount) throw new WorkshopInputError("该 Mod ID 已有不可变发布记录，请通过“发布新版本”更新。");
      const existing = await client.query("SELECT 1 FROM nl_workshop_terrain_mods WHERE mod_id = $1 AND version = $2 LIMIT 1",
        [entry.modId, entry.version]);
      if (existing.rowCount) throw new WorkshopInputError("相同 ID 和版本的地块 Mod 已发布。");
      const storedEntry = await storeTerrainModAssets(entry, this.dataDirectory);
      await client.query("INSERT INTO nl_workshop_terrain_mods (id, mod_id, version, entry, created_at) VALUES ($1, $2, $3, $4, $5)",
        [entry.id, entry.modId, entry.version, JSON.stringify(storedEntry), entry.createdAt]);
      await insertPostgresTerrainAssetBindings(client, storedEntry);
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

  async updateTerrainMod(input: unknown, authorName: string): Promise<WorkshopPublished> {
    await this.load();
    const { updateId, payload } = validateTerrainModUpdateRequest(input);
    const normalizedAuthor = normalizeAuthorName(authorName);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [DATABASE_MIGRATION_LOCK]);
      const selected = await client.query<{ entry: string }>("SELECT entry FROM nl_workshop_terrain_mods WHERE id = $1 FOR UPDATE", [updateId]);
      if (!selected.rows[0]) throw new WorkshopInputError("要更新的 Mod 已不存在，请刷新工坊后重试。");
      const current = parseStoredEntry<WorkshopTerrainModEntry>(selected.rows[0].entry);
      const versions = await client.query<{ entry: string }>("SELECT entry FROM nl_workshop_terrain_mods WHERE mod_id = $1", [current.modId]);
      const releases = versions.rows.map(({ entry }) => parseStoredEntry<WorkshopTerrainModEntry>(entry));
      const entry = createUpdatedTerrainMod(current, payload, normalizedAuthor, releases);
      const storedEntry = await storeTerrainModAssets(entry, this.dataDirectory);
      await client.query("INSERT INTO nl_workshop_terrain_mods (id, mod_id, version, entry, created_at) VALUES ($1, $2, $3, $4, $5)",
        [entry.id, entry.modId, entry.version, JSON.stringify(storedEntry), entry.createdAt]);
      await insertPostgresTerrainAssetBindings(client, storedEntry);
      await client.query("COMMIT");
      return { kind: "terrain-mod", id: entry.id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof WorkshopInputError) throw error;
      throw new Error("Failed to update workshop terrain Mod.", { cause: error });
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async recordTerrainAssetUpload(input: Omit<TerrainAssetUploadRecord, "uploadId" | "uploadedAt">): Promise<TerrainAssetUploadRecord> {
    await this.load();
    const record: TerrainAssetUploadRecord = { ...input, uploadId: randomUUID(), uploadedAt: new Date().toISOString() };
    await this.pool.query(
      "INSERT INTO nl_workshop_asset_uploads (upload_id, asset_url, sha256, content_type, byte_size, uploaded_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [record.uploadId, record.assetUrl, record.sha256, record.contentType, record.byteSize, record.uploadedAt]
    );
    return record;
  }

  async cleanupUnboundTerrainAssets(cutoff: Date): Promise<number> {
    await this.load();
    const [releases, bindings, uploads] = await Promise.all([
      this.pool.query<{ entry: string }>("SELECT entry FROM nl_workshop_terrain_mods"),
      this.pool.query<{ asset_url: string }>("SELECT asset_url FROM nl_workshop_asset_bindings"),
      this.pool.query<TerrainAssetUploadRow>(
        "SELECT asset_url, max(uploaded_at)::text AS last_uploaded_at FROM nl_workshop_asset_uploads GROUP BY asset_url"
      )
    ]);
    const boundUrls = collectBoundTerrainAssetUrls(releases.rows.map(({ entry }) => parseStoredEntry<StoredWorkshopTerrainModEntry>(entry)));
    for (const { asset_url: url } of bindings.rows) boundUrls.add(url);
    const removedUrls = await removeUnboundTerrainAssetFiles(
      this.dataDirectory,
      boundUrls,
      uploads.rows,
      cutoff
    );
    if (removedUrls.length) {
      await this.pool.query("DELETE FROM nl_workshop_asset_uploads WHERE asset_url = ANY($1::text[])", [removedUrls]);
    }
    await this.pool.query(
      "INSERT INTO nl_workshop_asset_maintenance (name, last_run_at) VALUES ($1, now()) ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at",
      ["unbound-terrain-assets"]
    );
    return removedUrls.length;
  }

  async getTerrainAssetCleanupLastRun(): Promise<string | undefined> {
    await this.load();
    const result = await this.pool.query<{ last_run_at: string }>(
      "SELECT last_run_at::text FROM nl_workshop_asset_maintenance WHERE name = $1", ["unbound-terrain-assets"]
    );
    return result.rows[0]?.last_run_at;
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
      CREATE TABLE IF NOT EXISTS nl_workshop_asset_uploads (
        upload_id text PRIMARY KEY,
        asset_url text NOT NULL,
        sha256 text NOT NULL,
        content_type text NOT NULL,
        byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 131072),
        uploaded_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nl_workshop_asset_uploads_url_idx ON nl_workshop_asset_uploads (asset_url, uploaded_at DESC);
      CREATE TABLE IF NOT EXISTS nl_workshop_asset_bindings (
        asset_url text NOT NULL,
        mod_release_id text NOT NULL,
        mod_id text NOT NULL,
        bound_at timestamptz NOT NULL,
        PRIMARY KEY (asset_url, mod_release_id)
      );
      CREATE INDEX IF NOT EXISTS nl_workshop_asset_bindings_release_idx ON nl_workshop_asset_bindings (mod_release_id);
      CREATE TABLE IF NOT EXISTS nl_workshop_asset_maintenance (
        name text PRIMARY KEY,
        last_run_at timestamptz NOT NULL
      );
    `);
    await this.importLegacyJsonOnce();
    await this.removeLegacySourceFilesOnce();
    await this.externalizeInlineTerrainAssetsOnce();
    await this.backfillTerrainAssetBindings();
  }

  private async backfillTerrainAssetBindings(): Promise<void> {
    const rows = await this.pool.query<{ entry: string }>("SELECT entry FROM nl_workshop_terrain_mods");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const { entry } of rows.rows) {
        await insertPostgresTerrainAssetBindings(client, parseStoredEntry<StoredWorkshopTerrainModEntry>(entry));
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

  /** Purge the former raw TypeScript payload field; current Mods are JSON definition objects only. */
  private async removeLegacySourceFilesOnce(): Promise<void> {
    const migrationName = "terrain_mod_definition_objects_v1";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [DATABASE_MIGRATION_LOCK]);
      const done = await client.query("SELECT 1 FROM nl_schema_migrations WHERE name = $1", [migrationName]);
      if (!done.rowCount) {
        const rows = await client.query<{ id: string; entry: string }>(
          "SELECT id, entry FROM nl_workshop_terrain_mods WHERE entry::jsonb ? 'sourceFiles' FOR UPDATE"
        );
        for (const row of rows.rows) {
          const legacy = JSON.parse(row.entry) as WorkshopTerrainModEntry;
          await client.query("UPDATE nl_workshop_terrain_mods SET entry = $2 WHERE id = $1", [
            row.id, JSON.stringify(stripLegacySourceFiles(legacy))
          ]);
        }
        await client.query("INSERT INTO nl_schema_migrations (name) VALUES ($1)", [migrationName]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** One-time migration from historical inline data URLs to immutable image files. */
  private async externalizeInlineTerrainAssetsOnce(): Promise<void> {
    const migrationName = "terrain_mod_visual_assets_urls_v1";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [DATABASE_MIGRATION_LOCK]);
      const done = await client.query("SELECT 1 FROM nl_schema_migrations WHERE name = $1", [migrationName]);
      if (!done.rowCount) {
        const rows = await client.query<{ id: string; entry: string }>(
          "SELECT id, entry FROM nl_workshop_terrain_mods WHERE entry::jsonb #> '{definition,visualAssets}' IS NOT NULL FOR UPDATE"
        );
        for (const row of rows.rows) {
          const stored = await storeTerrainModAssets(parseStoredEntry<WorkshopTerrainModEntry>(row.entry), this.dataDirectory);
          await client.query("UPDATE nl_workshop_terrain_mods SET entry = $2 WHERE id = $1", [row.id, JSON.stringify(stored)]);
        }
        await client.query("INSERT INTO nl_schema_migrations (name) VALUES ($1)", [migrationName]);
      }
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
      terrainMods: terrainMods.map(({ entry }) => terrainModSummary(parseStoredEntry<StoredWorkshopTerrainModEntry>(entry)))
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
      return row ? terrainModDetail(parseStoredEntry<StoredWorkshopTerrainModEntry>(row.entry)) : undefined;
    }
    throw new WorkshopInputError("工坊内容类型无效。");
  }

  async getTerrainModPreview(id: string): Promise<WorkshopTerrainModPreview | undefined> {
    await this.load();
    const row = this.database!.prepare("SELECT entry FROM nl_workshop_terrain_mods WHERE id = ?").get(id) as { entry: string } | undefined;
    if (!row) return undefined;
    const entry = parseStoredEntry<StoredWorkshopTerrainModEntry>(row.entry);
    const preview = terrainModVisualPreview(entry);
    return preview ? { id, preview } : undefined;
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
      id: randomUUID(), modId: payload.definition.id, name: payload.name, version: payload.definition.version,
      description: payload.description, terrainId: terrainIdForModId(payload.definition.id),
      contentHash: hashModContent(terrainModContent(payload.definition)), definition: payload.definition,
      authorName: normalizeAuthorName(authorName), createdAt: new Date().toISOString()
    };
    const storedEntry = await storeTerrainModAssets(entry, this.legacyDataDirectory);
    const database = this.database!;
    database.exec("BEGIN IMMEDIATE");
    try {
      const count = database.prepare("SELECT count(*) AS count FROM nl_workshop_terrain_mods").get() as { count: number };
      if (count.count >= MAX_TERRAIN_MODS) throw new WorkshopInputError("工坊地块 Mod 已达到容量上限。");
      const previousRelease = database.prepare("SELECT 1 FROM nl_workshop_terrain_mods WHERE mod_id = ? LIMIT 1").get(entry.modId);
      if (previousRelease) throw new WorkshopInputError("该 Mod ID 已有不可变发布记录，请通过“发布新版本”更新。");
      const existing = database.prepare("SELECT 1 FROM nl_workshop_terrain_mods WHERE mod_id = ? AND version = ? LIMIT 1")
        .get(entry.modId, entry.version);
      if (existing) throw new WorkshopInputError("相同 ID 和版本的地块 Mod 已发布。");
      database.prepare("INSERT INTO nl_workshop_terrain_mods (id, mod_id, version, entry, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(entry.id, entry.modId, entry.version, JSON.stringify(storedEntry), entry.createdAt);
      insertSqliteTerrainAssetBindings(database, storedEntry);
      database.exec("COMMIT");
      return { kind: "terrain-mod", id: entry.id };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async updateTerrainMod(input: unknown, authorName: string): Promise<WorkshopPublished> {
    await this.load();
    const { updateId, payload } = validateTerrainModUpdateRequest(input);
    const normalizedAuthor = normalizeAuthorName(authorName);
    const database = this.database!;
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database.prepare("SELECT entry FROM nl_workshop_terrain_mods WHERE id = ?").get(updateId) as { entry: string } | undefined;
      if (!row) throw new WorkshopInputError("要更新的 Mod 已不存在，请刷新工坊后重试。");
      const current = parseStoredEntry<WorkshopTerrainModEntry>(row.entry);
      const releases = (database.prepare("SELECT entry FROM nl_workshop_terrain_mods WHERE mod_id = ?").all(current.modId) as { entry: string }[])
        .map(({ entry }) => parseStoredEntry<WorkshopTerrainModEntry>(entry));
      const entry = createUpdatedTerrainMod(current, payload, normalizedAuthor, releases);
      const storedEntry = await storeTerrainModAssets(entry, this.legacyDataDirectory);
      database.prepare("INSERT INTO nl_workshop_terrain_mods (id, mod_id, version, entry, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(entry.id, entry.modId, entry.version, JSON.stringify(storedEntry), entry.createdAt);
      insertSqliteTerrainAssetBindings(database, storedEntry);
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

  async recordTerrainAssetUpload(input: Omit<TerrainAssetUploadRecord, "uploadId" | "uploadedAt">): Promise<TerrainAssetUploadRecord> {
    await this.load();
    const record: TerrainAssetUploadRecord = { ...input, uploadId: randomUUID(), uploadedAt: new Date().toISOString() };
    this.database!.prepare(
      "INSERT INTO nl_workshop_asset_uploads (upload_id, asset_url, sha256, content_type, byte_size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(record.uploadId, record.assetUrl, record.sha256, record.contentType, record.byteSize, record.uploadedAt);
    return record;
  }

  async cleanupUnboundTerrainAssets(cutoff: Date): Promise<number> {
    await this.load();
    const database = this.database!;
    const releases = database.prepare("SELECT entry FROM nl_workshop_terrain_mods").all() as { entry: string }[];
    const bindings = database.prepare("SELECT asset_url FROM nl_workshop_asset_bindings").all() as { asset_url: string }[];
    const uploads = database.prepare(
      "SELECT asset_url, max(uploaded_at) AS last_uploaded_at FROM nl_workshop_asset_uploads GROUP BY asset_url"
    ).all() as unknown as TerrainAssetUploadRow[];
    const boundUrls = collectBoundTerrainAssetUrls(releases.map(({ entry }) => parseStoredEntry<StoredWorkshopTerrainModEntry>(entry)));
    for (const { asset_url: url } of bindings) boundUrls.add(url);
    const removedUrls = await removeUnboundTerrainAssetFiles(
      this.legacyDataDirectory,
      boundUrls,
      uploads,
      cutoff
    );
    if (removedUrls.length) {
      const removeUploadRows = database.prepare("DELETE FROM nl_workshop_asset_uploads WHERE asset_url = ?");
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const url of removedUrls) removeUploadRows.run(url);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    database.prepare(
      "INSERT INTO nl_workshop_asset_maintenance (name, last_run_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at"
    ).run("unbound-terrain-assets", new Date().toISOString());
    return removedUrls.length;
  }

  async getTerrainAssetCleanupLastRun(): Promise<string | undefined> {
    await this.load();
    const row = this.database!.prepare(
      "SELECT last_run_at FROM nl_workshop_asset_maintenance WHERE name = ?"
    ).get("unbound-terrain-assets") as { last_run_at: string } | undefined;
    return row?.last_run_at;
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
      CREATE TABLE IF NOT EXISTS nl_workshop_asset_uploads (
        upload_id TEXT PRIMARY KEY,
        asset_url TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 131072),
        uploaded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nl_workshop_asset_uploads_url_idx ON nl_workshop_asset_uploads (asset_url, uploaded_at DESC);
      CREATE TABLE IF NOT EXISTS nl_workshop_asset_bindings (
        asset_url TEXT NOT NULL,
        mod_release_id TEXT NOT NULL,
        mod_id TEXT NOT NULL,
        bound_at TEXT NOT NULL,
        PRIMARY KEY (asset_url, mod_release_id)
      );
      CREATE INDEX IF NOT EXISTS nl_workshop_asset_bindings_release_idx ON nl_workshop_asset_bindings (mod_release_id);
      CREATE TABLE IF NOT EXISTS nl_workshop_asset_maintenance (
        name TEXT PRIMARY KEY,
        last_run_at TEXT NOT NULL
      );
    `);
    this.importLegacyJsonOnce();
    this.removeLegacySourceFilesOnce();
    await this.externalizeInlineTerrainAssetsOnce();
    this.backfillTerrainAssetBindings();
  }

  private backfillTerrainAssetBindings(): void {
    const database = this.database!;
    const entries = database.prepare("SELECT entry FROM nl_workshop_terrain_mods").all() as { entry: string }[];
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const { entry } of entries) {
        insertSqliteTerrainAssetBindings(database, parseStoredEntry<StoredWorkshopTerrainModEntry>(entry));
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private async externalizeInlineTerrainAssetsOnce(): Promise<void> {
    const database = this.database!;
    const migrationName = "terrain_mod_visual_assets_urls_v1";
    if (database.prepare("SELECT 1 FROM nl_schema_migrations WHERE name = ?").get(migrationName)) return;
    database.exec("BEGIN IMMEDIATE");
    try {
      const rows = database.prepare("SELECT id, entry FROM nl_workshop_terrain_mods WHERE json_type(entry, '$.definition.visualAssets') IS NOT NULL")
        .all() as { id: string; entry: string }[];
      const update = database.prepare("UPDATE nl_workshop_terrain_mods SET entry = ? WHERE id = ?");
      for (const row of rows) {
        const stored = await storeTerrainModAssets(parseStoredEntry<WorkshopTerrainModEntry>(row.entry), this.legacyDataDirectory);
        update.run(JSON.stringify(stored), row.id);
      }
      database.prepare("INSERT INTO nl_schema_migrations (name) VALUES (?)").run(migrationName);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private removeLegacySourceFilesOnce(): void {
    const database = this.database!;
    const migrationName = "terrain_mod_definition_objects_v1";
    if (database.prepare("SELECT 1 FROM nl_schema_migrations WHERE name = ?").get(migrationName)) return;
    database.exec("BEGIN IMMEDIATE");
    try {
      const rows = database.prepare("SELECT id, entry FROM nl_workshop_terrain_mods WHERE json_type(entry, '$.sourceFiles') IS NOT NULL").all() as { id: string; entry: string }[];
      const update = database.prepare("UPDATE nl_workshop_terrain_mods SET entry = ? WHERE id = ?");
      for (const row of rows) {
        update.run(JSON.stringify(stripLegacySourceFiles(JSON.parse(row.entry) as WorkshopTerrainModEntry)), row.id);
      }
      database.prepare("INSERT INTO nl_schema_migrations (name) VALUES (?)").run(migrationName);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
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
    await this.setMetadata({ kind: "workshop" });
    this.maxClients = 256;
    this.autoDispose = false;
    this.onMessage("workshop-list", (client) => { void this.sendList(client); });
    this.onMessage("workshop-get", (client, payload: unknown) => { void this.sendDetail(client, payload); });
    this.onMessage("workshop-preview", (client, payload: unknown) => { void this.sendTerrainModPreview(client, payload); });
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

  private async sendTerrainModPreview(client: Client, payload: unknown): Promise<void> {
    if (!isRecord(payload) || typeof payload.id !== "string" || payload.id.length > 80) {
      this.sendError(client, "地块预览请求无效。");
      return;
    }
    try {
      const preview = await this.store.getTerrainModPreview(payload.id);
      if (preview) client.send("workshop-preview", preview);
    } catch {
      this.sendError(client, "地块预览暂时无法读取。");
    }
  }

  private async publish(client: Client, kind: WorkshopKind, payload: unknown): Promise<void> {
    // 发布权限按服务环境单独配置；测试站可用于测试，生产环境默认应关闭。
    if (process.env.NODE_ENV === "production" && process.env.WORKSHOP_PUBLISH_ENABLED !== "1") {
      this.sendError(client, "当前环境暂未开放工坊发布。");
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
        : await serializeWorkshopAssetMaintenance(async () => {
          const normalizedPayload = await materializeTerrainModAssetReferences(payload);
          return isRecord(payload) && typeof payload.updateId === "string"
            ? this.store.updateTerrainMod(normalizedPayload, authorName)
            : this.store.publishTerrainMod(normalizedPayload, authorName);
        });
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

let workshopAssetMaintenanceQueue: Promise<unknown> = Promise.resolve();
let workshopAssetCleanupTimer: NodeJS.Timeout | undefined;

function serializeWorkshopAssetMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  const next = workshopAssetMaintenanceQueue.then(operation);
  workshopAssetMaintenanceQueue = next.catch(() => undefined);
  return next;
}

/** 服务开始接入请求前完成工坊准备，避免首次访问承担数据库初始化延迟。 */
export async function initializeWorkshopStore(): Promise<void> {
  await sharedWorkshopStore.load();
}

/** Save an uploaded file immediately, then record a traceable database event for it. */
export async function saveUploadedTerrainAsset(
  dataUrl: string,
  contentType: string,
  byteSize: number
): Promise<TerrainAssetUploadRecord> {
  return serializeWorkshopAssetMaintenance(async () => {
    if (!isWorkshopEnabled() || (process.env.NODE_ENV === "production" && process.env.WORKSHOP_PUBLISH_ENABLED !== "1")) {
      throw new WorkshopInputError("当前环境暂未开放工坊图片上传。");
    }
    const stored = await persistTerrainVisualAssets([{ id: "uploaded-asset", dataUrl }]);
    const assetUrl = stored[0]?.url;
    const fileName = assetUrl ? getTerrainAssetFileName(assetUrl) : undefined;
    const sha256 = fileName?.split(".")[0];
    if (!assetUrl || !sha256) throw new WorkshopInputError("地块图片无法保存。");
    return sharedWorkshopStore.recordTerrainAssetUpload({
      assetUrl,
      sha256,
      contentType,
      byteSize
    });
  });
}

/** Delete only files absent from every Mod release and older than the retention window. */
export async function cleanupUnboundWorkshopTerrainAssets(now = new Date()): Promise<number> {
  return serializeWorkshopAssetMaintenance(() => sharedWorkshopStore.cleanupUnboundTerrainAssets(
    new Date(now.getTime() - WORKSHOP_ASSET_RETENTION_MS)
  ));
}

/** Run the orphan sweep weekly, preserving its schedule across relay restarts. */
export function startWorkshopAssetCleanupScheduler(): void {
  if (workshopAssetCleanupTimer || !isWorkshopEnabled()) return;
  const runCleanup = async (): Promise<void> => {
    try {
      const removedCount = await cleanupUnboundWorkshopTerrainAssets();
      if (removedCount) console.info(`Workshop image cleanup removed ${removedCount} unbound asset(s).`);
      scheduleNextRun();
    } catch (error) {
      console.error("Workshop image cleanup failed.", error);
      workshopAssetCleanupTimer = setTimeout(() => { void runCleanup(); }, 60 * 60 * 1000);
      workshopAssetCleanupTimer.unref();
    }
  };
  const scheduleNextRun = (): void => {
    void sharedWorkshopStore.getTerrainAssetCleanupLastRun().then((lastRun) => {
      const lastRunMs = lastRun ? Date.parse(lastRun) : 0;
      const delay = Number.isFinite(lastRunMs) && lastRunMs > 0
        ? Math.max(0, lastRunMs + WORKSHOP_ASSET_CLEANUP_INTERVAL_MS - Date.now())
        : 0;
      workshopAssetCleanupTimer = setTimeout(() => { void runCleanup(); }, delay);
      workshopAssetCleanupTimer.unref();
    }).catch((error: unknown) => {
      console.error("Workshop image cleanup schedule could not be loaded.", error);
      workshopAssetCleanupTimer = setTimeout(() => { void runCleanup(); }, 60 * 60 * 1000);
      workshopAssetCleanupTimer.unref();
    });
  };
  scheduleNextRun();
}

export function isWorkshopEnabled(): boolean {
  return process.env.WORKSHOP_ENABLED === "1"
    || (process.env.NODE_ENV !== "production" && process.env.WORKSHOP_ENABLED !== "0");
}

async function insertPostgresTerrainAssetBindings(
  client: PoolClient,
  entry: StoredWorkshopTerrainModEntry
): Promise<void> {
  const urls = [...new Set(Object.values(entry.visualAssetUrls ?? {}))];
  for (const assetUrl of urls) {
    await client.query(
      "INSERT INTO nl_workshop_asset_bindings (asset_url, mod_release_id, mod_id, bound_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [assetUrl, entry.id, entry.modId, entry.createdAt]
    );
  }
}

function insertSqliteTerrainAssetBindings(database: DatabaseSync, entry: StoredWorkshopTerrainModEntry): void {
  const insert = database.prepare(
    "INSERT OR IGNORE INTO nl_workshop_asset_bindings (asset_url, mod_release_id, mod_id, bound_at) VALUES (?, ?, ?, ?)"
  );
  for (const assetUrl of new Set(Object.values(entry.visualAssetUrls ?? {}))) {
    insert.run(assetUrl, entry.id, entry.modId, entry.createdAt);
  }
}

function collectBoundTerrainAssetUrls(entries: readonly StoredWorkshopTerrainModEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => Object.values(entry.visualAssetUrls ?? {})));
}

async function removeUnboundTerrainAssetFiles(
  dataDirectory: string,
  boundUrls: ReadonlySet<string>,
  uploads: readonly TerrainAssetUploadRow[],
  cutoff: Date
): Promise<string[]> {
  const directory = workshopTerrainAssetDirectory(dataDirectory);
  let fileNames: string[];
  try {
    fileNames = await readdir(directory);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const lastUploadedAt = new Map(uploads.map((upload) => [upload.asset_url, Date.parse(upload.last_uploaded_at)]));
  const removed: string[] = [];
  for (const fileName of fileNames) {
    const assetUrl = `assets/terrain/${fileName}`;
    if (!getTerrainAssetFileName(assetUrl) || boundUrls.has(assetUrl)) continue;
    const uploadedAt = lastUploadedAt.get(assetUrl);
    let lastActivity = uploadedAt;
    if (lastActivity === undefined) {
      try { lastActivity = (await stat(join(directory, fileName))).mtimeMs; }
      catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
    }
    if (lastActivity === undefined || !Number.isFinite(lastActivity) || lastActivity >= cutoff.getTime()) continue;
    try {
      await unlink(join(directory, fileName));
      removed.push(assetUrl);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  return removed;
}

async function materializeTerrainModAssetReferences(input: unknown): Promise<unknown> {
  if (!isRecord(input) || !isRecord(input.definition) || input.definition.visualAssets === undefined) return input;
  if (!Array.isArray(input.definition.visualAssets)) throw new WorkshopInputError("visualAssets 必须是图片资源数组。");
  const visualAssets = await Promise.all(input.definition.visualAssets.map(async (rawAsset) => {
    if (!isRecord(rawAsset) || typeof rawAsset.id !== "string") throw new WorkshopInputError("图片资源必须包含 id 和后台 URL。");
    if (typeof rawAsset.dataUrl === "string") return { id: rawAsset.id, dataUrl: rawAsset.dataUrl };
    if (typeof rawAsset.url !== "string") throw new WorkshopInputError(`图片资源 ${rawAsset.id} 缺少后台 URL。`);
    const fileName = getTerrainAssetFileName(rawAsset.url);
    const contentType = fileName ? getTerrainAssetContentType(fileName) : undefined;
    if (!fileName || !contentType) throw new WorkshopInputError(`图片资源 ${rawAsset.id} 的地址无效。`);
    let bytes: Buffer;
    try {
      bytes = await readFile(join(workshopTerrainAssetDirectory(defaultWorkshopDataDirectory()), fileName));
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new WorkshopInputError(`图片资源 ${rawAsset.id} 已不存在，请重新上传。`);
      throw error;
    }
    const expectedHash = fileName.slice(0, 64);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      throw new WorkshopInputError(`图片资源 ${rawAsset.id} 校验失败，请重新上传。`);
    }
    return { id: rawAsset.id, dataUrl: `data:${contentType};base64,${bytes.toString("base64")}` };
  }));
  return { ...input, definition: { ...input.definition, visualAssets } };
}

function validateMapRequest(input: unknown): PublishMapRequest {
  if (!isRecord(input) || typeof input.code !== "string" || byteLength(input.code) === 0
    || byteLength(input.code) > MAX_MAP_CODE_BYTES) {
    throw new WorkshopInputError("地图码为空或超过 64 KiB。");
  }
  return { code: input.code, description: validateDescription(input.description) };
}

function validateTerrainModRequest(input: unknown): PublishTerrainModRequest {
  if (!isRecord(input) || !isRecord(input.definition)) throw new WorkshopInputError("地块 Mod 必须提交结构化 definition 对象。");
  if (typeof input.name !== "string" || input.name.trim().length === 0 || byteLength(input.name) > 120) {
    throw new WorkshopInputError("Mod 名称无效或过长。");
  }
  let definition: TerrainModDefinition;
  try {
    definition = validateTerrainModDefinition(input.definition, { requireBaseLayer: true });
  } catch (error) {
    throw new WorkshopInputError(error instanceof Error ? error.message : "地块 Mod 属性对象无效。");
  }
  return {
    name: input.name.trim(),
    description: validateDescription(input.description),
    definition
  };
}

function validateTerrainModUpdateRequest(input: unknown): { updateId: string; payload: PublishTerrainModRequest } {
  if (!isRecord(input) || typeof input.updateId !== "string" || !input.updateId || input.updateId.length > 80) {
    throw new WorkshopInputError("Mod 更新目标无效，请刷新工坊后重试。");
  }
  const { updateId, ...submission } = input;
  return { updateId, payload: validateTerrainModRequest(submission) };
}

function createUpdatedTerrainMod(
  current: WorkshopTerrainModEntry,
  payload: PublishTerrainModRequest,
  authorName: string,
  releases: readonly WorkshopTerrainModEntry[]
): WorkshopTerrainModEntry {
  const ownReleases = releases.filter((entry) => entry.modId === current.modId);
  if (ownReleases.length >= MAX_TERRAIN_MOD_RELEASES_PER_MOD) throw new WorkshopInputError("该 Mod 已达到版本历史上限（128 个发布版本）。");
  const latest = ownReleases
    .reduce<WorkshopTerrainModEntry | undefined>((highest, entry) =>
      !highest || compareSemanticVersions(entry.version, highest.version) > 0 ? entry : highest, undefined);
  if (!latest || latest.id !== current.id) throw new WorkshopInputError("当前发布版本已变化，请刷新工坊后重试。");
  if (latest.authorName !== authorName) throw new WorkshopInputError("只能更新由当前作者发布的 Mod。");
  if (payload.definition.id !== current.modId) throw new WorkshopInputError("更新不能更改 Mod ID。");
  if (compareSemanticVersions(payload.definition.version, latest.version) <= 0) {
    throw new WorkshopInputError("更新版本必须高于当前版本。");
  }
  const nextSettings = new Map((payload.definition.settings ?? []).map((setting) => [setting.id, setting]));
  for (const previous of current.definition?.settings ?? []) {
    const next = nextSettings.get(previous.id);
    if (!next || next.kind !== previous.kind || JSON.stringify(next.target) !== JSON.stringify(previous.target)) {
      throw new WorkshopInputError(`为保证地图配置兼容，更新不能删除或重定向旧参数「${previous.id}」。`);
    }
    if (previous.kind === "integer" && next.kind === "integer"
      && (next.min > previous.min || next.max < previous.max)) {
      throw new WorkshopInputError(`为保证地图配置兼容，参数「${previous.id}」的新范围不能缩小。`);
    }
    if (previous.kind === "choice" && next.kind === "choice"
      && previous.options.some((option) => !next.options.includes(option))) {
      throw new WorkshopInputError(`为保证地图配置兼容，参数「${previous.id}」不能删除已有选项。`);
    }
  }
  return {
    ...stripStoredAssetReferences(current),
    id: randomUUID(),
    name: payload.name,
    description: payload.description,
    version: payload.definition.version,
    terrainId: terrainIdForModId(payload.definition.id),
    contentHash: hashModContent(terrainModContent(payload.definition)),
    definition: payload.definition,
    authorName: latest.authorName,
    createdAt: new Date().toISOString()
  };
}

function terrainModContent(definition: TerrainModDefinition): unknown {
  return modContentIdentity(definition as ModDefinition);
}

function terrainIdForModId(modId: string): string {
  return `mod/${modId.slice(4)}`;
}

function compareSemanticVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version);
    return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] } : null;
  };
  const a = parse(left), b = parse(right);
  if (!a || !b) return left.localeCompare(right, undefined, { numeric: true });
  for (let index = 0; index < 3; index += 1) {
    const difference = a.parts[index]! - b.parts[index]!;
    if (difference) return Math.sign(difference);
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index], y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x) ? Number(x) : undefined;
    const numericY = /^\d+$/.test(y) ? Number(y) : undefined;
    if (numericX !== undefined && numericY !== undefined) { if (numericX !== numericY) return Math.sign(numericX - numericY); }
    else if (numericX !== undefined) return -1;
    else if (numericY !== undefined) return 1;
    else { const difference = x.localeCompare(y); if (difference) return Math.sign(difference); }
  }
  return 0;
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

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function parseStoredEntry<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stripLegacySourceFiles<T extends object>(entry: T): T {
  const { sourceFiles: _legacySourceFiles, ...dataOnlyEntry } = entry as T & { readonly sourceFiles?: unknown };
  return dataOnlyEntry as T;
}

function stripStoredAssetReferences(entry: WorkshopTerrainModEntry | StoredWorkshopTerrainModEntry): WorkshopTerrainModEntry {
  const {
    sourceFiles: _legacySourceFiles,
    visualAssetUrls: _visualAssetUrls,
    ...dataOnlyEntry
  } = entry as (WorkshopTerrainModEntry | StoredWorkshopTerrainModEntry) & {
    readonly sourceFiles?: unknown;
    readonly visualAssetUrls?: Readonly<Record<string, string>>;
    readonly previewArtworkUrls?: Readonly<Record<string, string>>;
  };
  return dataOnlyEntry as WorkshopTerrainModEntry;
}

function isCurrentTerrainModDefinition(definition: unknown): definition is TerrainModDefinition {
  return isRecord(definition) && isRecord(definition.terrain) && Array.isArray(definition.terrain.capabilities);
}

function terrainModSummary(entry: WorkshopTerrainModEntry | StoredWorkshopTerrainModEntry): WorkshopTerrainModSummary {
  const {
    definition,
    sourceFiles: _legacySourceFiles,
    visualAssetUrls: _visualAssetUrls,
    previewArtworkUrls: _previewArtworkUrls,
    terrainIds: _legacyTerrainIds,
    terrainId: _terrainId,
    ...summary
  } = entry as (WorkshopTerrainModEntry | StoredWorkshopTerrainModEntry) & {
    readonly sourceFiles?: unknown;
    readonly visualAssetUrls?: Readonly<Record<string, string>>;
    readonly previewArtworkUrls?: Readonly<Record<string, string>>;
    readonly terrainIds?: readonly string[];
  };
  const terrainId = typeof entry.terrainId === "string"
    ? entry.terrainId
    : _legacyTerrainIds?.[0] ?? terrainIdForModId(entry.modId);
  const currentDefinition = isCurrentTerrainModDefinition(definition) ? definition : undefined;
  const contentHash = entry.contentHash ?? (currentDefinition ? hashModContent(terrainModContent(currentDefinition)) : undefined);
  return { ...summary, terrainId, ...(contentHash ? { contentHash } : {}) };
}

function terrainModVisualPreview(entry: WorkshopTerrainModEntry | StoredWorkshopTerrainModEntry): WorkshopTerrainModPreview["preview"] | undefined {
  if (!isCurrentTerrainModDefinition(entry.definition)) return undefined;
  const storedAssetUrls = (entry as StoredWorkshopTerrainModEntry).visualAssetUrls ?? {};
  const terrain = entry.definition.terrain;
  const referencedAssetIds = referencedTerrainVisualAssetIds(terrain);
  const visualAssets = Object.entries(storedAssetUrls)
    .filter(([id]) => referencedAssetIds.has(id))
    .map(([id, url]) => ({ id, url }));
  return {
    terrainId: terrainIdForModId(entry.modId),
    displayName: entry.name,
    ...(terrain.visuals ? { visuals: terrain.visuals } : {}),
    visualAssets
  };
}

function referencedTerrainVisualAssetIds(terrain: TerrainModDefinition["terrain"]): ReadonlySet<string> {
  return new Set([
    terrain.visuals?.baseAssetId,
    terrain.visuals?.overlay?.assetId
  ].filter((id): id is string => typeof id === "string"));
}

async function storeTerrainModAssets(
  entry: WorkshopTerrainModEntry | StoredWorkshopTerrainModEntry,
  dataDirectory: string
): Promise<StoredWorkshopTerrainModEntry> {
  const { visualAssetUrls: previousUrls, ...withoutPreviousUrls } = entry as StoredWorkshopTerrainModEntry;
  if (!entry.definition) return stripStoredAssetReferences(withoutPreviousUrls) as StoredWorkshopTerrainModEntry;

  const definitionWithAssets = entry.definition as TerrainModDefinition;
  const assets = definitionWithAssets.visualAssets;
  const contentHash = entry.contentHash ?? hashModContent(terrainModContent(definitionWithAssets));
  if (!assets?.length) {
    if (previousUrls) return {
      ...stripStoredAssetReferences(withoutPreviousUrls),
      visualAssetUrls: previousUrls,
      contentHash
    } as StoredWorkshopTerrainModEntry;
    const { visualAssets: _visualAssets, ...definition } = definitionWithAssets;
    return { ...stripStoredAssetReferences(withoutPreviousUrls), definition, contentHash } as StoredWorkshopTerrainModEntry;
  }

  const storedAssets = await persistTerrainVisualAssets(assets, dataDirectory);
  const { visualAssets: _visualAssets, ...definition } = definitionWithAssets;
  return {
    ...stripStoredAssetReferences(withoutPreviousUrls),
    definition,
    contentHash,
    visualAssetUrls: Object.fromEntries(storedAssets.map(({ id, url }) => [id, url]))
  } as StoredWorkshopTerrainModEntry;
}

function terrainModDetail(entry: StoredWorkshopTerrainModEntry): WorkshopDetail {
  const storedDefinition: unknown = entry.definition;
  const definition = isCurrentTerrainModDefinition(storedDefinition) ? storedDefinition : undefined;
  const visualAssetUrls = entry.visualAssetUrls;
  const referencedAssetIds = definition ? referencedTerrainVisualAssetIds(definition.terrain) : new Set<string>();
  const visualAssets: readonly StoredVisualAsset[] = Object.entries(visualAssetUrls ?? {})
    .filter(([id]) => referencedAssetIds.has(id))
    .map(([id, url]) => ({ id, url }));
  const detailDefinition = definition ? (() => {
    const { visualAssets: _inlineVisualAssets, ...definitionWithoutInlineAssets } = definition;
    return {
      ...definitionWithoutInlineAssets,
      ...(visualAssets.length ? { visualAssets } : {})
    };
  })() : undefined;
  const detail: WorkshopTerrainModDetailEntry = {
    ...terrainModSummary(entry),
    ...(detailDefinition ? { definition: detailDefinition } : {})
  };
  return { kind: "terrain-mod", entry: detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}
