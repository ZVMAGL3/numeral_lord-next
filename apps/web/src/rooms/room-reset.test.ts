import { describe, expect, it, vi } from "vitest";
import { requestReturnToLobby } from "./room-reset.js";

describe("online match reset request", () => {
  it("asks the room to return every client to the lobby when the host clicks", () => {
    const send = vi.fn();
    expect(requestReturnToLobby({ send }, true)).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith("match-return-to-lobby", {});
  });

  it("cannot send a room reset from a guest or an offline match", () => {
    const send = vi.fn();
    expect(requestReturnToLobby({ send }, false)).toBe(false);
    expect(requestReturnToLobby(undefined, true)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
