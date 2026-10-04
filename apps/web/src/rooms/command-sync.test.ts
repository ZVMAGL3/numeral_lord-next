import { describe, expect, it } from "vitest";
import type { GameCommand, PlayerId } from "@numeral-lord/game-core";
import { createCommandTimeline } from "./command-sync.js";

function command(commandId: string, expectedSequence: number): GameCommand {
  return {
    type: "end-action-phase",
    commandId,
    actorId: "player-1" as PlayerId,
    expectedSequence
  };
}

describe("command timeline", () => {
  it("allows consecutive local commands before remote delivery and preserves their order", () => {
    const local = createCommandTimeline();
    const remote = createCommandTimeline();

    const first = local.envelope(command("first", 0));
    expect(local.inspect(first)).toBe("ready");
    local.commit(first);
    const second = local.envelope(command("second", 1));
    local.commit(second);

    expect(first.parentCommandId).toBeNull();
    expect(second.parentCommandId).toBe("first");
    expect(local.headId).toBe("second");
    expect(remote.headId).toBeNull();
    expect(remote.inspect(second)).toBe("conflict");
    expect(remote.inspect(first)).toBe("ready");
    remote.commit(first);
    expect(remote.inspect(second)).toBe("ready");
    remote.commit(second);
    expect(remote.headId).toBe(local.headId);
  });

  it("recognizes echoed or retried commands without applying them twice or moving the head back", () => {
    const timeline = createCommandTimeline();
    const first = timeline.envelope(command("first", 0));
    timeline.commit(first);
    const second = timeline.envelope(command("second", 1));
    timeline.commit(second);

    expect(timeline.inspect(first)).toBe("duplicate");
    expect(timeline.inspect(second)).toBe("duplicate");
    timeline.commit(first);
    expect(timeline.headId).toBe("second");
  });

  it("rejects different histories even when the command sequence matches", () => {
    const local = createCommandTimeline();
    const remote = createCommandTimeline();
    local.commit(local.envelope(command("local-first", 0)));
    remote.commit(remote.envelope(command("remote-first", 0)));
    const nextLocal = local.envelope(command("local-second", 1));
    const nextRemote = remote.envelope(command("remote-second", 1));

    expect(nextLocal.command.expectedSequence).toBe(nextRemote.command.expectedSequence);
    expect(local.inspect(nextRemote)).toBe("conflict");
    expect(() => local.commit(nextRemote)).toThrow("different command history");
    expect(local.headId).toBe("local-first");
  });

  it("resets history to a reconciled snapshot and accepts commands continuing from its head", () => {
    const timeline = createCommandTimeline();
    const old = timeline.envelope(command("old", 0));
    timeline.commit(old);
    timeline.reset("host-head");

    expect(timeline.headId).toBe("host-head");
    expect(timeline.inspect({ command: command("host-head", 5), parentCommandId: null })).toBe("duplicate");
    expect(timeline.inspect(old)).toBe("conflict");
    const resumed = timeline.envelope(command("resumed", 6));
    expect(resumed.parentCommandId).toBe("host-head");
    expect(timeline.inspect(resumed)).toBe("ready");
    timeline.commit(resumed);
    expect(timeline.headId).toBe("resumed");

    timeline.reset(null);
    expect(timeline.headId).toBeNull();
    expect(timeline.inspect(old)).toBe("ready");
  });

  it("bounds duplicate tracking to the latest 256 committed commands", () => {
    const timeline = createCommandTimeline();
    const oldest = timeline.envelope(command("command-0", 0));
    timeline.commit(oldest);
    const retained = timeline.envelope(command("command-1", 1));
    timeline.commit(retained);
    for (let index = 2; index <= 256; index += 1) {
      timeline.commit(timeline.envelope(command(`command-${index}`, index)));
    }

    expect(timeline.inspect(oldest)).toBe("conflict");
    expect(timeline.inspect(retained)).toBe("duplicate");
    expect(timeline.headId).toBe("command-256");
  });
});
