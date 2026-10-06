import type { TerrainModDefinition } from "@numeral-lord/content-schema";

const LEGACY_DATABASE_NAME = "numeral-lord-content";
const LEGACY_SUBSCRIPTION_STORE = "subscribed-terrain-mods";

/** JSON round-trip unwraps nested Vue proxies before Mod data enters runtime memory. */
export function cloneTerrainModDefinition(definition: TerrainModDefinition): TerrainModDefinition {
  const serialized = JSON.stringify(definition);
  if (serialized === undefined) throw new Error("Mod 属性对象无法序列化。");
  return JSON.parse(serialized) as TerrainModDefinition;
}

/**
 * One-time bridge from the old browser-only Mod database. Runtime content and
 * current subscriptions are server-owned; this is the sole remaining IndexedDB
 * access and is removed together with the old database after server ack.
 */
export async function readLegacyModSubscriptions(): Promise<string[] | null> {
  const database = await openExistingLegacyDatabase();
  if (!database) return null;
  try {
    if (!database.objectStoreNames.contains(LEGACY_SUBSCRIPTION_STORE)) return [];
    return await new Promise((resolve, reject) => {
      const request = database.transaction(LEGACY_SUBSCRIPTION_STORE, "readonly")
        .objectStore(LEGACY_SUBSCRIPTION_STORE).getAll();
      request.onsuccess = () => resolve((request.result as unknown[]).flatMap((record) => {
        if (typeof record !== "object" || record === null || !("id" in record)) return [];
        const id = (record as { id?: unknown }).id;
        return typeof id === "string" && /^mod-[a-z0-9][a-z0-9._-]{0,63}$/.test(id) ? [id] : [];
      }));
      request.onerror = () => reject(request.error ?? new Error("读取旧订阅记录失败。"));
    });
  } finally {
    database.close();
  }
}

/** Call only after the server confirms the subscription migration was saved. */
export async function deleteLegacyModDatabase(): Promise<void> {
  const database = await openExistingLegacyDatabase();
  if (!database) return;
  try {
    const stores = [...database.objectStoreNames];
    if (stores.length) {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(stores, "readwrite");
        for (const name of stores) transaction.objectStore(name).clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("清除旧 Mod 记录失败。"));
        transaction.onabort = () => reject(transaction.error ?? new Error("清除旧 Mod 记录被中断。"));
      });
    }
  } finally {
    database.close();
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LEGACY_DATABASE_NAME);
    // All object stores are already empty. Another old tab may keep the empty
    // database alive; a later connection retries deletion after its ack.
    request.onblocked = () => resolve();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("删除旧 Mod 数据库失败。"));
  });
}

function openExistingLegacyDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DATABASE_NAME);
    let didNotExist = false;
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) return;
      didNotExist = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      if (didNotExist) {
        request.result.close();
        resolve(null);
      } else resolve(request.result);
    };
    request.onerror = () => {
      if (didNotExist) resolve(null);
      else reject(request.error ?? new Error("旧 Mod 数据库打开失败。"));
    };
    request.onblocked = () => reject(new Error("旧 Mod 数据库正被其他标签页占用，请关闭其他游戏标签页后重试。"));
  });
}
