import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRateLimit, formatRateLimit } from "../src/ratelimit.ts";

const NOW = 1_700_000_000_000;

// The Anthropic OAuth (Pro/Max) "unified" family, reconstructed from the
// verifier's observation of live responses rather than captured here (no OAuth
// credential in this environment): -unified-status, -representative-claim,
// -5h-utilization / -7d-utilization (fraction USED, 0..1), and -unified-reset
// (epoch SECONDS). There is no "-unified-remaining" header — the earlier code
// invented one, so its test proved nothing.
test("anthropic rate-limit headers, including the OAuth 5h/7d subscription windows", () => {
  const snap = parseRateLimit(
    "anthropic",
    {
      "anthropic-ratelimit-requests-remaining": "48",
      "anthropic-ratelimit-tokens-remaining": "180000",
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "anthropic-ratelimit-unified-representative-claim": "7d",
      "anthropic-ratelimit-unified-5h-utilization": "0.28",
      "anthropic-ratelimit-unified-7d-utilization": "0.91",
      "anthropic-ratelimit-unified-reset": "1757793600",
    },
    NOW,
  )!;
  assert.equal(snap.source, "anthropic");
  assert.equal(snap.requestsRemaining, 48);
  assert.equal(snap.tokensRemaining, 180000);
  // utilization is the fraction USED; remaining is its complement.
  assert.ok(Math.abs(snap.unified5hRemaining! - 0.72) < 1e-9);
  assert.ok(Math.abs(snap.unified7dRemaining! - 0.09) < 1e-9);
  assert.equal(snap.unifiedBinding, "7d");
  assert.equal(snap.unifiedStatus, "allowed_warning");
  const line = formatRateLimit(snap)!;
  assert.match(line, /72% of 5h window left/);
  assert.match(line, /9% of 7d window left \(binding\)/);
  assert.match(line, /subscription allowed warning/);
  // epoch seconds are rendered as a local time, not shown as the raw number.
  assert.ok(!line.includes("1757793600"), "the raw epoch is not printed");
});

test("anthropic OAuth response with only unified headers still yields a snapshot", () => {
  // OAuth responses may omit the API-key requests/tokens-remaining headers.
  const snap = parseRateLimit(
    "anthropic",
    {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.10",
    },
    NOW,
  )!;
  assert.ok(snap, "a unified-only bag is not dropped");
  assert.equal(snap.requestsRemaining, null);
  assert.ok(Math.abs(snap.unified5hRemaining! - 0.9) < 1e-9);
  // a healthy "allowed" status is not repeated as noise in the line
  assert.ok(!formatRateLimit(snap)!.includes("subscription"));
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
      unified5hRemaining: null,
      unified7dRemaining: null,
      unifiedBinding: null,
      unifiedStatus: null,
      source: "openai",
      capturedAtMs: NOW,
    }),
    null,
  );
});
