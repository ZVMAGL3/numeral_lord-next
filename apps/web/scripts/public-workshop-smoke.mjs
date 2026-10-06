import { Client } from "@colyseus/sdk";

const endpoint = process.env.PVP_SMOKE_ENDPOINT ?? "ws://39.107.250.161/numeral-lord-stage";
let room;
let secondDevice;

function nextMessage(target, type, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    target.onMessage(type, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

try {
  const firstName = "Numeral Lord Identity Smoke";
  const client = new Client(endpoint);
  room = await client.joinOrCreate("workshop", { name: firstName });
  const firstAccountReply = nextMessage(room, "workshop-account");
  room.send("workshop-account", {});
  const firstAccount = await firstAccountReply;

  secondDevice = await new Client(endpoint).joinOrCreate("workshop", { name: "  numeral lord identity smoke  " });
  const secondAccountReply = nextMessage(secondDevice, "workshop-account");
  secondDevice.send("workshop-account", {});
  const secondAccount = await secondAccountReply;
  if (typeof firstAccount?.userId !== "string" || secondAccount?.userId !== firstAccount.userId) {
    throw new Error("The same normalized player name did not resolve to the same user_id");
  }
  console.log("PUBLIC_WORKSHOP_IDENTITY_OK same normalized name resolves to the same user_id");

  const catalogReply = nextMessage(room, "workshop-list");
  room.send("workshop-list", {});
  const catalog = await catalogReply;
  if (!Array.isArray(catalog?.maps) || !Array.isArray(catalog?.terrainMods)) {
    throw new Error("Workshop catalog has an invalid shape");
  }
  console.log(`PUBLIC_WORKSHOP_LIST_OK maps=${catalog.maps.length} terrainMods=${catalog.terrainMods.length}`);
  const httpBase = new URL("http://39.107.250.161/numeral-lord/");
  for (const mod of catalog.terrainMods) {
    if (!mod.preview || !Array.isArray(mod.preview.visualAssets)) {
      throw new Error(`Terrain Mod ${mod.modId} has no catalog preview`);
    }
    for (const asset of mod.preview.visualAssets) {
      if (typeof asset.url !== "string" || !/^assets\/terrain\/[a-f0-9]{64}\.(png|webp|svg)$/.test(asset.url)) {
        throw new Error(`Terrain Mod ${mod.modId} has an invalid image URL`);
      }
      const response = await fetch(new URL(asset.url, httpBase));
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
        throw new Error(`Terrain Mod ${mod.modId} image failed: HTTP ${response.status}`);
      }
    }
  }
  console.log(`PUBLIC_WORKSHOP_PREVIEWS_OK mods=${catalog.terrainMods.length}`);

} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([room?.leave(), secondDevice?.leave()]);
}
