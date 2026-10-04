import { describe, expect, it } from "vitest";
import { withoutRoomInvite } from "./room-route";

describe("room invite routing", () => {
  it("removes only the room invite and keeps other query state", () => {
    const query = { room: "stale-room", source: "invite", debug: "1" };

    expect(withoutRoomInvite(query)).toEqual({ source: "invite", debug: "1" });
    expect(query.room).toBe("stale-room");
  });
});
