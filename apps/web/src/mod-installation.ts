import type { TerrainModDefinition } from "@numeral-lord/content-schema";

const DATABASE_NAME = "numeral-lord-content";
const DATABASE_VERSION = 1;
const STORE_NAME = "installed-terrain-mods";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
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
