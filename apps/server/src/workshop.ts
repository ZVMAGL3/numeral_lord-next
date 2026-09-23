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
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_MAPS = 200;
const MAX_TERRAIN_MODS = 100;
const MAX_MAP_CODE_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_SOURCE_FILES = 16;
const MAX_DATABASE_BYTES = 32 * 1024 * 1024;
const PUBLICATION_COOLDOWN_MS = 3_000;
const MAX_PUBLICATIONS_PER_SESSION = 10;

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

const sharedWorkshopStore = new WorkshopStore();

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}
