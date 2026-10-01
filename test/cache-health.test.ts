import { test } from "node:test";
import assert from "node:assert/strict";
import { LOW_RUN, cacheHit, emptyCacheHealth, observeCacheHealth } from "../src/cache-health.ts";

const warm = { input: 500, cacheRead: 30_000, cacheWrite: 0 };
const cold = { input: 30_500, cacheRead: 0, cacheWrite: 0 };
const small = { input: 100, cacheRead: 0, cacheWrite: 0 };

test("cacheHit is the cached share of the prompt, null for a prompt too small to judge", () => {
  assert.ok(Math.abs(cacheHit(warm)! - 30_000 / 30_500) < 1e-9);
  assert.equal(cacheHit(cold), 0);
  assert.equal(cacheHit(small), null);
});

test("a collapse after a healthy stretch warns exactly once; a cold start never does", () => {
  const s = emptyCacheHealth();
  assert.equal(observeCacheHealth(s, warm), null);
  for (let i = 0; i < LOW_RUN - 1; i++) assert.equal(observeCacheHealth(s, cold), null, `not yet at ${i + 1}`);
  const warning = observeCacheHealth(s, cold);
  assert.match(warning ?? "", /Prompt cache collapsed/);
  assert.equal(observeCacheHealth(s, cold), null, "only once");
  // A session that was never warm has nothing to have lost.
  const never = emptyCacheHealth();
  for (let i = 0; i < LOW_RUN + 2; i++) assert.equal(observeCacheHealth(never, cold), null);
  // Small prompts are ignored; a warm prompt resets the run.
  const mixed = emptyCacheHealth();
  observeCacheHealth(mixed, warm);
  observeCacheHealth(mixed, cold);
  observeCacheHealth(mixed, small);
  observeCacheHealth(mixed, warm);
  for (let i = 0; i < LOW_RUN - 1; i++) observeCacheHealth(mixed, cold);
  assert.equal(mixed.warned, false);
});
