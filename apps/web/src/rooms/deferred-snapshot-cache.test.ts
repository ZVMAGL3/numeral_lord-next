import { afterEach, expect, it, vi } from "vitest";
import { createDeferredSnapshotCache } from "./deferred-snapshot-cache";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("coalesces recovery snapshots and cancels a queued write when leaving a room", () => {
  vi.useFakeTimers();
  const requestAnimationFrame = vi.fn(() => 0);
  const cancelAnimationFrame = vi.fn();
  vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame });

  const writeSnapshot = vi.fn();
  const cache = createDeferredSnapshotCache(writeSnapshot);
  cache.schedule();
  cache.schedule();
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

  cache.cancel();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(0);
  vi.advanceTimersByTime(250);
  expect(writeSnapshot).not.toHaveBeenCalled();

  cache.schedule();
  vi.advanceTimersByTime(250);
  expect(writeSnapshot).toHaveBeenCalledTimes(1);
});
