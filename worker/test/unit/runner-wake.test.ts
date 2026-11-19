import assert from "node:assert/strict";
import { test } from "node:test";
import { RunnerWake, WAIT_MS } from "../../src/runner-wake.ts";

test("a wait with an old count, or none, answers the count at once", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const wake = new RunnerWake();
  const now = await wake.wait(null, WAIT_MS);
  assert.equal(await wake.wait(now - 1, WAIT_MS), now);
});

test("a held wait answers at the next wake, and every one held answers", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const wake = new RunnerWake();
  const now = await wake.wait(null, 0);
  const held = [wake.wait(now, WAIT_MS), wake.wait(now, WAIT_MS)];
  wake.wake();
  assert.deepEqual(await Promise.all(held), [now + 1, now + 1]);
});

test("a held wait with nothing sent answers the same count after its time", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const wake = new RunnerWake();
  const now = await wake.wait(null, 0);
  const held = wake.wait(now, 20);
  t.mock.timers.tick(20);
  assert.equal(await held, now);
});
