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

function fakeRoom(): Room {
  return {
    onMessage: vi.fn(),
    onLeave: vi.fn(),
    onError: vi.fn(),
    send: vi.fn(),
    leave: vi.fn().mockResolvedValue(undefined)
  } as unknown as Room;
}

function makeEvents(errors: string[], statuses: string[]) {
  return {
    catalog: vi.fn(),
    detail: vi.fn(),
    preview: vi.fn(),
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

    expect(room.send).toHaveBeenNthCalledWith(1, "workshop-list");
    expect(room.send).toHaveBeenNthCalledWith(2, "workshop-get", { kind: "terrain-mod", id: "release-1" });
    expect(room.send).toHaveBeenNthCalledWith(3, "workshop-preview", { id: "release-1" });
    expect(room.send).toHaveBeenCalledTimes(3);
    expect(statuses).toEqual(["connecting", "connected"]);
  });

  it("keeps the not-connected error for a request made while no join is underway", () => {
    const errors: string[] = [];
    const client = new WorkshopClient("ws://workshop.test", makeEvents(errors, []));

    expect(client.requestDetail("terrain-mod", "release-1")).toBe(false);
    expect(errors).toEqual(["创意工坊尚未连接。"]);
  });
});
