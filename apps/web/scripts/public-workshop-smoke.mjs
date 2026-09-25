import { Client } from "@colyseus/sdk";

const endpoint = process.env.PVP_SMOKE_ENDPOINT ?? "ws://39.107.250.161/numeral-lord-stage";
let room;

function nextMessage(type, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    room.onMessage(type, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

try {
  room = await new Client(endpoint).joinOrCreate("workshop", { name: "工坊只读冒烟测试" });
  const catalogReply = nextMessage("workshop-list");
  room.send("workshop-list", {});
  const catalog = await catalogReply;
  if (!Array.isArray(catalog?.maps) || !Array.isArray(catalog?.terrainMods)) {
    throw new Error("Workshop catalog has an invalid shape");
  }
  console.log(`PUBLIC_WORKSHOP_LIST_OK maps=${catalog.maps.length} terrainMods=${catalog.terrainMods.length}`);

} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await room?.leave();
}
