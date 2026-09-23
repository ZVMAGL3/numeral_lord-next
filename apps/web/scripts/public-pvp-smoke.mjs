import { Client } from "@colyseus/sdk";

const endpoint = process.env.PVP_SMOKE_ENDPOINT ?? "ws://39.107.250.161/numeral-lord-stage";
const checkReturnToLobby = process.env.PVP_SMOKE_CHECK_RESET === "1";
const requiredModId = "mod-oil-field";
const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let host;
let guest;

function nextMessage(room, type, predicate = () => true, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    room.onMessage(type, (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

try {
  const client = new Client(endpoint);
  host = await client.create("pvp", {
    name: "公网冒烟测试 A", accountId: `smoke-a-${unique}`, installedModIds: [requiredModId]
  });
  const hostStarted = nextMessage(host, "match-start");
  guest = await client.joinById(host.roomId, { name: "公网冒烟测试 B", accountId: `smoke-b-${unique}` });
  const guestStarted = nextMessage(guest, "match-start");
  const guestSnapshot = nextMessage(guest, "host-snapshot", (payload) => payload?.state?.sequence === 1);

  const missingError = nextMessage(guest, "lobby-error", (payload) => payload?.message?.includes(requiredModId));
  guest.send("lobby-ready", { ready: true });
  await missingError;
  const installed = nextMessage(guest, "room-state", (payload) => payload?.members
    ?.find((member) => member.sessionId === guest.sessionId)?.missingModIds?.length === 0);
  guest.send("lobby-installed-mods", { installedModIds: [requiredModId] });
  await installed;

  const configured = nextMessage(guest, "room-state", (payload) => payload?.roomModSettings?.[requiredModId]?.incomePerTurn === 7);
  host.send("lobby-mod-settings", { modSettings: { [requiredModId]: { incomePerTurn: 7 } } });
  await configured;
  host.send("lobby-ready", { ready: true });
  guest.send("lobby-ready", { ready: true });
  const [hostMatch, guestMatch] = await Promise.all([hostStarted, guestStarted]);
  if (hostMatch.assignments.length !== 2 || guestMatch.assignments.length !== 2) {
    throw new Error("Both clients did not receive two-player match assignments");
  }
  if (hostMatch.roomModSettings?.[requiredModId]?.incomePerTurn !== 7
    || guestMatch.roomModSettings?.[requiredModId]?.incomePerTurn !== 7) {
    throw new Error("Both clients did not receive the same room Mod setting");
  }
  console.log(`PUBLIC_PVP_MOD_SYNC_OK room=${host.roomId} ${requiredModId}.incomePerTurn=7`);

  const snapshot = {
    state: { sequence: 1, smokePayload: "x".repeat(6_000) },
    clock: {},
    hostSentAtEpochMs: Date.now()
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (payloadBytes <= 4 * 1024) throw new Error("Smoke payload is not larger than old 4 KiB limit");
  host.send("host-snapshot", snapshot);
  await guestSnapshot;
  console.log(`PUBLIC_PVP_SNAPSHOT_OK room=${host.roomId} bytes=${payloadBytes}`);

  if (checkReturnToLobby) {
    const hostLobby = nextMessage(host, "room-state", (payload) => payload?.phase === "lobby");
    const guestLobby = nextMessage(guest, "room-state", (payload) => payload?.phase === "lobby");
    host.send("match-return-to-lobby", {});
    const [hostState, guestState] = await Promise.all([hostLobby, guestLobby]);
    if (hostState.members.length !== 2 || guestState.members.length !== 2
      || hostState.members.some((member) => member.ready)
      || guestState.members.some((member) => member.ready)) {
      throw new Error("Return-to-lobby did not preserve both members and clear readiness");
    }
    console.log(`PUBLIC_PVP_RETURN_TO_LOBBY_OK room=${host.roomId}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([host?.leave(), guest?.leave()]);
}
