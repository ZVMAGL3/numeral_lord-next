import type { TerrainModDefinition } from "@numeral-lord/content-schema";

const DATABASE_NAME = "numeral-lord-content";
const DATABASE_VERSION = 2;
const STORE_NAME = "installed-terrain-mods";
const SUBSCRIPTION_STORE = "subscribed-terrain-mods";
const META_STORE = "content-meta";

export interface ModSubscription {
  readonly id: string;
  readonly subscribedAt: string;
  readonly installedVersion: string;
}

const DAILY_CHECK_KEY = "last-mod-update-check";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SUBSCRIPTION_STORE)) database.createObjectStore(SUBSCRIPTION_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败。"));
    request.onblocked = () => reject(new Error("本地 Mod 数据库正在升级，请关闭其他游戏标签页后重试。"));
  });
}

export async function loadInstalledTerrainModObjects(): Promise<TerrainModDefinition[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as TerrainModDefinition[]);
      request.onerror = () => reject(request.error ?? new Error("读取本地 Mod 失败。"));
    });
  } finally {
    database.close();
  }
}

export async function persistInstalledTerrainModObject(definition: TerrainModDefinition): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(structuredClone(definition));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("保存本地 Mod 失败。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("保存本地 Mod 被中断。"));
    });
  } finally {
    database.close();
  }
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

export async function subscribeToTerrainMod(definition: TerrainModDefinition): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SUBSCRIPTION_STORE, STORE_NAME], "readwrite");
      transaction.objectStore(STORE_NAME).put(structuredClone(definition));
      transaction.objectStore(SUBSCRIPTION_STORE).put({ id: definition.id, subscribedAt: new Date().toISOString(), installedVersion: definition.version } satisfies ModSubscription);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("订阅并安装 Mod 失败。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("订阅并安装 Mod 被中断。"));
    });
  } finally { database.close(); }
}

export async function updateSubscribedMod(definition: TerrainModDefinition): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SUBSCRIPTION_STORE, STORE_NAME], "readwrite");
      transaction.objectStore(STORE_NAME).put(structuredClone(definition));
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

export async function shouldCheckModUpdates(now = new Date()): Promise<boolean> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(META_STORE, "readonly").objectStore(META_STORE).get(DAILY_CHECK_KEY);
      request.onsuccess = () => {
        const last = typeof request.result === "string" ? new Date(request.result) : null;
        resolve(!last || Number.isNaN(last.valueOf()) || now.toDateString() !== last.toDateString());
      };
      request.onerror = () => reject(request.error ?? new Error("读取 Mod 更新检查记录失败。"));
    });
  } finally { database.close(); }
}

export async function markModUpdateCheck(now = new Date()): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(META_STORE, "readwrite");
      transaction.objectStore(META_STORE).put(now.toISOString(), DAILY_CHECK_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("保存 Mod 更新检查记录失败。"));
    });
  } finally { database.close(); }
}
