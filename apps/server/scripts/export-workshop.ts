import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SqliteWorkshopStore } from "../src/workshop.js";

const destination = resolve(process.argv[2] ?? "workshop-export.json");
const store = new SqliteWorkshopStore();

try {
  const catalog = await store.list();
  const [maps, terrainMods] = await Promise.all([
    Promise.all(catalog.maps.map(async ({ id }) => {
      const detail = await store.get({ kind: "map", id });
      if (detail?.kind !== "map") throw new Error(`Missing map record ${id}.`);
      return detail.entry;
    })),
    Promise.all(catalog.terrainMods.map(async ({ id }) => {
      const detail = await store.get({ kind: "terrain-mod", id });
      if (detail?.kind !== "terrain-mod") throw new Error(`Missing terrain Mod record ${id}.`);
      return detail.entry;
    }))
  ]);
  await writeFile(destination, `${JSON.stringify({ version: 1, maps, terrainMods }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  process.stdout.write(`导出完成：${maps.length} 张地图、${terrainMods.length} 个地块 Mod → ${destination}\n`);
} finally {
  store.close();
}
