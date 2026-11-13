import assert from "node:assert/strict";
import test from "node:test";
import { FlushScheduler } from "./runtime.js";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const afterTimer = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test("immediate flush coalesces same-turn requests into one callback", async () => {
  let callbacks = 0;
  const queued: number[] = [];
  const batches: number[][] = [];
  const scheduler = new FlushScheduler("immediate", 2, () => {
    callbacks += 1;
    batches.push(queued.splice(0));
  });
  for (const request of [1, 2, 3]) {
    queued.push(request);
    scheduler.schedule();
  }
  assert.equal(scheduler.scheduled, true);
  await nextTurn();
  assert.equal(callbacks, 1);
  assert.deepEqual(batches, [[1, 2, 3]]);
  assert.equal(scheduler.scheduled, false);
});

test("timer flush preserves the existing wait-window coalescing", async () => {
  let callbacks = 0;
  const scheduler = new FlushScheduler("timer", 2, () => { callbacks += 1; });
  scheduler.schedule();
  scheduler.schedule();
  await afterTimer();
  assert.equal(callbacks, 1);
});

test("cancel prevents timer and immediate callbacks and permits a fresh schedule", async () => {
  for (const mode of ["timer", "immediate"] as const) {
    let callbacks = 0;
    const scheduler = new FlushScheduler(mode, 2, () => { callbacks += 1; });
    scheduler.schedule();
    scheduler.cancel();
    assert.equal(scheduler.scheduled, false);
    await afterTimer();
    assert.equal(callbacks, 0, `${mode} callback was not cancelled`);
    scheduler.schedule();
    await afterTimer();
    assert.equal(callbacks, 1, `${mode} scheduler did not recover after cancellation`);
  }
});

test("invalid flush modes and waits fail closed", () => {
  assert.throws(() => new FlushScheduler("other" as "timer", 2, () => {}), /timer or immediate/);
  assert.throws(() => new FlushScheduler("timer", -1, () => {}), /non-negative/);
});
