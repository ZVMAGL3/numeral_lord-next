import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@colyseus/sdk";
import { WorkshopClient } from "./workshop-client.js";

const { joinOrCreate } = vi.hoisted(() => ({ joinOrCreate: vi.fn() }));

vi.mock("@colyseus/sdk", () => ({
  Client: class {
    joinOrCreate(...args: unknown[]): Promise<unknown> { return joinOrCreate(...args); }
  }
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

type FakeRoom = Room & { receiveMessage(type: string, payload: unknown): void };

function fakeRoom(): FakeRoom {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    onMessage: vi.fn((type: string, handler: (payload: unknown) => void) => { handlers.set(type, handler); }),
    onLeave: vi.fn(),
    onError: vi.fn(),
    send: vi.fn(),
    leave: vi.fn().mockResolvedValue(undefined),
    receiveMessage(type: string, payload: unknown) { handlers.get(type)?.(payload); }
  } as unknown as FakeRoom;
}

function makeEvents(errors: string[], statuses: string[]) {
  return {
    account: vi.fn(),
    subscriptions: vi.fn(),
    catalog: vi.fn(),
    detail: vi.fn(),
    preview: vi.fn(),
    personalMaps: vi.fn(),
    published: vi.fn(),
    error: (message: string) => errors.push(message),
    status: (status: "offline" | "connecting" | "connected") => statuses.push(status)
  };
}

describe("WorkshopClient initial connection", () => {
  beforeEach(() => joinOrCreate.mockReset());

  it("queues first-entry detail and artwork reads until the workshop room is ready", async () => {
    const joining = deferred<Room>();
    const room = fakeRoom();
    const errors: string[] = [];
    const statuses: string[] = [];
    joinOrCreate.mockReturnValueOnce(joining.promise);
    const client = new WorkshopClient("ws://workshop.test", makeEvents(errors, statuses));

    const connection = client.connect({ name: "guest" });
    expect(client.status).toBe("connecting");
    expect(client.requestDetail("terrain-mod", "release-1")).toBe(true);
    expect(client.requestTerrainModPreview("release-1")).toBe(true);
    expect(client.requestTerrainModPreview("release-1")).toBe(true);
    expect(errors).toEqual([]);
    expect(room.send).not.toHaveBeenCalled();

    joining.resolve(room);
    await expect(connection).resolves.toBe(true);

    expect(room.send).toHaveBeenNthCalledWith(1, "workshop-account");
    expect(room.send).toHaveBeenNthCalledWith(2, "workshop-list");
    expect(room.send).toHaveBeenNthCalledWith(3, "workshop-get", { kind: "terrain-mod", id: "release-1" });
    expect(room.send).toHaveBeenNthCalledWith(4, "workshop-preview", { id: "release-1" });
    expect(room.send).toHaveBeenCalledTimes(4);
    expect(statuses).toEqual(["connecting", "connected"]);
  });

  it("keeps the not-connected error for a request made while no join is underway", () => {
    const errors: string[] = [];
    const client = new WorkshopClient("ws://workshop.test", makeEvents(errors, []));

    expect(client.requestDetail("terrain-mod", "release-1")).toBe(false);
    expect(errors).toEqual(["创意工坊尚未连接。"]);
  });

  it("sends and reactively delivers account personal-map sync results", async () => {
    const room = fakeRoom();
    const errors: string[] = [];
    const events = makeEvents(errors, []);
    joinOrCreate.mockResolvedValueOnce(room);
    const client = new WorkshopClient("ws://workshop.test", events);
    await expect(client.connect({ name: "guest" })).resolves.toBe(true);

    const request = {
      cachedMaps: [],
      operations: [{ operationId: "op-1", type: "upsert" as const, mapId: "map-1", code: "{}" }]
    };
    expect(client.syncPersonalMaps(request)).toBe(true);
    expect(room.send).toHaveBeenCalledWith("workshop-sync-personal-maps", request);

    const payload = { userId: "user-1", maps: [{ mapId: "map-1", code: "{}", updatedAt: "now" }], acknowledgedOperationIds: ["op-1"] };
    room.receiveMessage("workshop-personal-maps", payload);
    expect(events.personalMaps).toHaveBeenCalledWith(payload);
    expect(errors).toEqual([]);
    await client.leave();
  });

  it("reuses an existing identity for the same normalized name and reconnects when the player changes names", async () => {
    const firstRoom = fakeRoom();
    const secondRoom = fakeRoom();
    const errors: string[] = [];
    joinOrCreate.mockResolvedValueOnce(firstRoom).mockResolvedValueOnce(secondRoom);
    const client = new WorkshopClient("ws://workshop.test", makeEvents(errors, []));

    await expect(client.connect({ name: "ZVMAGL3" })).resolves.toBe(true);
    await expect(client.connect({ name: "  zvmagl3  " })).resolves.toBe(true);
    expect(joinOrCreate).toHaveBeenCalledTimes(1);

    await expect(client.connect({ name: "ZVMAGL4" })).resolves.toBe(true);
    expect(firstRoom.leave).toHaveBeenCalledTimes(1);
    expect(joinOrCreate).toHaveBeenCalledTimes(2);
    expect(joinOrCreate).toHaveBeenLastCalledWith("workshop", { name: "ZVMAGL4" });
    expect(errors).toEqual([]);
  });

  it("normalizes relative preview asset URLs received in the catalog into relay URLs", async () => {
    const room = fakeRoom();
    const errors: string[] = [];
    const events = makeEvents(errors, []);
    joinOrCreate.mockResolvedValueOnce(room);
    const client = new WorkshopClient("ws://workshop.test/numeral-lord", events);
    await expect(client.connect({ name: "guest" })).resolves.toBe(true);

    room.receiveMessage("workshop-list", {
      maps: [],
      terrainMods: [{
        id: "publication-1",
        modId: "mod-test",
        name: "测试地块",
        version: "1.0.0",
        description: "",
        authorName: "作者",
        createdAt: "2026-01-01T00:00:00.000Z",
        terrainId: "mod/test",
        preview: {
          terrainId: "mod/test",
          displayName: "测试地块",
          visuals: { baseAssetId: "base" },
          visualAssets: [{ id: "base", url: `assets/terrain/${"a".repeat(64)}.svg` }]
        }
      }]
    });

    expect(errors).toEqual([]);
    expect(events.catalog).toHaveBeenCalledWith(expect.objectContaining({
      terrainMods: [expect.objectContaining({
        preview: expect.objectContaining({
          visualAssets: [{ id: "base", url: `http://workshop.test/numeral-lord/assets/terrain/${"a".repeat(64)}.svg` }]
        })
      })]
    }));
    await client.leave();
  });
});
