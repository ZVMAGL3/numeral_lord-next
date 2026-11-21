/** Allow the board to paint before serializing a recovery snapshot. */
export function createDeferredSnapshotCache(writeSnapshot: () => void) {
  let frame: number | undefined;
  let timer: number | undefined;

  function cancel(): void {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    if (timer !== undefined) window.clearTimeout(timer);
    frame = undefined;
    timer = undefined;
  }

  function flush(): void {
    cancel();
    writeSnapshot();
  }

  function schedule(): void {
    if (frame !== undefined || timer !== undefined) return;

    // The fallback also runs when a background tab throttles animation frames.
    timer = window.setTimeout(flush, 250);
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, 0);
    });
  }

  return { cancel, schedule };
}
