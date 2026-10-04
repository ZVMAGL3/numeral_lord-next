import { describe, expect, it } from "vitest";
import type { GameCommand, PlayerId } from "@numeral-lord/game-core";
import { usePendingCommand } from "./pending-command";

const command: GameCommand = {
  type: "end-action-phase",
  commandId: "command-1",
  actorId: "player-1" as PlayerId,
  expectedSequence: 4
};

describe("usePendingCommand", () => {
  it("allows only one command until its matching response arrives", () => {
    const pending = usePendingCommand();
    const resolution = { kind: "phase" as const, phase: "action" as const };

    expect(pending.begin(command, resolution)).toBe(true);
    expect(pending.isPending.value).toBe(true);
    expect(pending.begin({ ...command, commandId: "command-2" }, resolution)).toBe(false);

    expect(pending.resolve("command-2")).toBeNull();
    expect(pending.isPending.value).toBe(true);
    expect(pending.resolve("command-1")).toMatchObject({
      commandId: "command-1",
      expectedSequence: 4,
      resolution
    });
    expect(pending.isPending.value).toBe(false);
  });

  it("does not let a stale command failure clear a newer command", () => {
    const pending = usePendingCommand();
    const resolution = { kind: "phase" as const, phase: "action" as const };

    pending.begin(command, resolution);
    pending.resolve("command-1");
    pending.begin({ ...command, commandId: "command-2", expectedSequence: 5 }, resolution);

    expect(pending.clear("command-1")).toBe(false);
    expect(pending.current.value?.commandId).toBe("command-2");
    expect(pending.clear()).toBe(true);
    expect(pending.isPending.value).toBe(false);
  });
});
