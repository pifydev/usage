import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRateLimit, formatRateLimit } from "../src/ratelimit.ts";

const NOW = 1_700_000_000_000;

test("anthropic rate-limit headers, including the OAuth subscription window", () => {
  const snap = parseRateLimit(
    "anthropic",
    {
      "anthropic-ratelimit-requests-remaining": "48",
      "anthropic-ratelimit-tokens-remaining": "180000",
      "anthropic-ratelimit-unified-remaining": "72",
      "anthropic-ratelimit-unified-reset": "2026-09-13T20:00:00Z",
    },
    NOW,
  )!;
  assert.equal(snap.source, "anthropic");
  assert.equal(snap.requestsRemaining, 48);
  assert.equal(snap.tokensRemaining, 180000);
  assert.equal(snap.unifiedRemaining, 0.72);
  assert.equal(snap.resets, "2026-09-13T20:00:00Z");
  assert.match(formatRateLimit(snap)!, /72% of subscription window left/);
});

test("openai x-ratelimit headers", () => {
  const snap = parseRateLimit(
    "openai",
    { "x-ratelimit-remaining-requests": "9999", "x-ratelimit-remaining-tokens": "1500000", "x-ratelimit-reset-tokens": "6s" },
    NOW,
  )!;
  assert.equal(snap.source, "openai");
  assert.equal(snap.requestsRemaining, 9999);
  assert.equal(snap.resets, "6s");
  assert.match(formatRateLimit(snap)!, /9999 requests left, 1500000 tokens left/);
});

test("openrouter reports one credit window", () => {
  const snap = parseRateLimit("openrouter", { "x-ratelimit-remaining": "40", "x-ratelimit-reset": "1700000600000" }, NOW)!;
  assert.equal(snap.source, "openrouter");
  assert.equal(snap.requestsRemaining, 40);
  assert.equal(snap.tokensRemaining, null);
});

test("header case does not matter", () => {
  const snap = parseRateLimit("anthropic", { "Anthropic-RateLimit-Requests-Remaining": "5" }, NOW)!;
  assert.equal(snap.requestsRemaining, 5);
});

test("a bag with nothing useful, or an unknown provider, is null — never a wrong snapshot", () => {
  assert.equal(parseRateLimit("anthropic", { "content-type": "application/json" }, NOW), null);
  assert.equal(parseRateLimit("deepseek", { "x-ratelimit-remaining": "10" }, NOW), null);
  assert.equal(parseRateLimit("openai", {}, NOW), null);
  assert.equal(formatRateLimit(null), null);
  // A snapshot whose only fields are absent renders nothing rather than an
  // empty line — no-silent-caps' opposite: no meaningless output either.
  assert.equal(
    formatRateLimit({
      provider: "x",
      requestsRemaining: null,
      tokensRemaining: null,
      resets: null,
      unifiedRemaining: null,
      source: "openai",
      capturedAtMs: NOW,
    }),
    null,
  );
});
