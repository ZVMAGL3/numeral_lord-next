import type { TerrainModDefinition } from "@numeral-lord/content-schema";
import { hashModContent, modContentIdentity } from "@numeral-lord/game-sdk";

const DATABASE_NAME = "numeral-lord-content";
const DATABASE_VERSION = 5;
const STORE_NAME = "installed-terrain-mods";
const SUBSCRIPTION_STORE = "subscribed-terrain-mods";
const RELEASE_STORE = "terrain-mod-releases";
const contentHashCache = new WeakMap<object, string>();

export interface CachedTerrainModRelease {
  readonly releaseKey: string;
  readonly id: string;
  readonly version: string;
  readonly contentHash: string;
  readonly name: string;
  readonly definition: TerrainModDefinition;
}

export interface InstalledTerrainModObject {
  readonly id: string;
  readonly name: string;
  readonly definition: TerrainModDefinition;
}

export interface ModSubscription {
  readonly id: string;
  readonly subscribedAt: string;
  readonly installedVersion: string;
}


/**
 * Workshop definitions are JSON data and may be Vue reactive proxies when they
 * arrive through component props. JSON round-tripping unwraps those proxies
 * before IndexedDB receives the value.
 */
export function cloneTerrainModDefinition(definition: TerrainModDefinition): TerrainModDefinition {
  const serialized = JSON.stringify(definition);
  if (serialized === undefined) throw new Error("Mod 属性对象无法序列化。");
  return JSON.parse(serialized) as TerrainModDefinition;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SUBSCRIPTION_STORE)) database.createObjectStore(SUBSCRIPTION_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(RELEASE_STORE)) database.createObjectStore(RELEASE_STORE, { keyPath: "releaseKey" });
      if (database.objectStoreNames.contains("content-meta")) database.deleteObjectStore("content-meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败。"));
    request.onblocked = () => reject(new Error("本地 Mod 数据库正在升级，请关闭其他游戏标签页后重试。"));
  });
}

export function terrainModContentHash(definition: TerrainModDefinition): string {
  const cacheKey = definition as object;
  const cached = contentHashCache.get(cacheKey);
  if (cached) return cached;
  const contentHash = hashModContent(modContentIdentity(definition as import("@numeral-lord/game-sdk").ModDefinition));
  contentHashCache.set(cacheKey, contentHash);
  return contentHash;
}

function releaseRecord(definition: TerrainModDefinition, name: string): CachedTerrainModRelease {
  const contentHash = terrainModContentHash(definition);
  return {
    releaseKey: `${definition.id}\u0000${definition.version}\u0000${contentHash}`,
    id: definition.id,
    version: definition.version,
    contentHash,
    name,
    definition
  };
}

export async function loadInstalledTerrainModObjects(): Promise<InstalledTerrainModObject[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as InstalledTerrainModObject[]);
      request.onerror = () => reject(request.error ?? new Error("读取本地 Mod 失败。"));
    });
  } finally {
    database.close();
  }
}

export async function loadInstalledTerrainModReleases(): Promise<CachedTerrainModRelease[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(RELEASE_STORE, "readonly").objectStore(RELEASE_STORE).getAll();
      request.onsuccess = () => resolve(request.result as CachedTerrainModRelease[]);
      request.onerror = () => reject(request.error ?? new Error("读取已缓存 Mod 版本失败。"));
    });
  } finally { database.close(); }
}

export async function persistInstalledTerrainModObject(definition: TerrainModDefinition, name: string): Promise<void> {
  const storedDefinition = cloneTerrainModDefinition(definition);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, RELEASE_STORE], "readwrite");
      transaction.objectStore(STORE_NAME).put({ id: storedDefinition.id, name, definition: storedDefinition } satisfies InstalledTerrainModObject);
      transaction.objectStore(RELEASE_STORE).put(releaseRecord(storedDefinition, name));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("保存本地 Mod 失败。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("保存本地 Mod 被中断。"));
    });
  } finally {
    database.close();
  }
}

/** Cache a room-compatible release without changing which release is active for subscriptions. */
export async function cacheTerrainModRelease(definition: TerrainModDefinition, name: string): Promise<void> {
  const storedDefinition = cloneTerrainModDefinition(definition);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(RELEASE_STORE, "readwrite");
      transaction.objectStore(RELEASE_STORE).put(releaseRecord(storedDefinition, name));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("缓存 Mod 版本失败。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("缓存 Mod 版本被中断。"));
    });
  } finally { database.close(); }
}

export async function loadModSubscriptions(): Promise<ModSubscription[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(SUBSCRIPTION_STORE, "readonly").objectStore(SUBSCRIPTION_STORE).getAll();
      request.onsuccess = () => resolve(request.result as ModSubscription[]);
      request.onerror = () => reject(request.error ?? new Error("读取 Mod 订阅失败。"));
    });
  } finally { database.close(); }
}

export async function subscribeToTerrainMod(definition: TerrainModDefinition, name: string): Promise<void> {
  const storedDefinition = cloneTerrainModDefinition(definition);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SUBSCRIPTION_STORE, STORE_NAME, RELEASE_STORE], "readwrite");
      transaction.objectStore(STORE_NAME).put({ id: storedDefinition.id, name, definition: storedDefinition } satisfies InstalledTerrainModObject);
      transaction.objectStore(RELEASE_STORE).put(releaseRecord(storedDefinition, name));
      transaction.objectStore(SUBSCRIPTION_STORE).put({ id: definition.id, subscribedAt: new Date().toISOString(), installedVersion: definition.version } satisfies ModSubscription);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("订阅并安装 Mod 失败。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("订阅并安装 Mod 被中断。"));
    });
  } finally { database.close(); }
}

export async function updateSubscribedMod(definition: TerrainModDefinition, name: string): Promise<void> {
  const storedDefinition = cloneTerrainModDefinition(definition);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SUBSCRIPTION_STORE, STORE_NAME, RELEASE_STORE], "readwrite");
      transaction.objectStore(STORE_NAME).put({ id: storedDefinition.id, name, definition: storedDefinition } satisfies InstalledTerrainModObject);
      transaction.objectStore(RELEASE_STORE).put(releaseRecord(storedDefinition, name));
      const store = transaction.objectStore(SUBSCRIPTION_STORE);
      const existing = store.get(definition.id);
      existing.onsuccess = () => {
        const old = existing.result as ModSubscription | undefined;
        store.put({ id: definition.id, subscribedAt: old?.subscribedAt ?? new Date().toISOString(), installedVersion: definition.version } satisfies ModSubscription);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("更新订阅 Mod 失败。"));
    });
  } finally { database.close(); }
}

export async function unsubscribeFromTerrainMod(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SUBSCRIPTION_STORE, "readwrite");
      transaction.objectStore(SUBSCRIPTION_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("取消订阅 Mod 失败。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("取消订阅 Mod 被中断。"));
    });
  } finally { database.close(); }
}
