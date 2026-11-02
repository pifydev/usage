import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchQuota, findProvider, parseCopilotQuota, parseCodexQuota, quotaBlock, quotaFooter } from "../src/quota.ts";
import { resolveQuotaAuth } from "../src/quota-auth.ts";

async function quotaApiKey(id: string, registry: Parameters<typeof resolveQuotaAuth>[1], reader: (id: string) => unknown): Promise<string> {
  const auth = await resolveQuotaAuth(findProvider(id)!, registry, reader);
  return auth.ok ? auth.apiKey : "";
}

const now = Date.UTC(2026, 9, 23, 12);
const reset = now + 5 * 60 * 60 * 1000;
const copilot = (snapshot: object = { percent_remaining: 49, entitlement: 300, remaining: 147 }) => ({
  quota_snapshots: { premium_interactions: snapshot }, quota_reset_date: new Date(reset).toISOString(),
});
const codex = (used: unknown = 25) => ({ rate_limit: {
  primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: reset / 1000 },
  secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: (now + 604800000) / 1000 },
} });

test("Copilot parses remaining premium quota, credits, reset, and unlimited without inventing zero", () => {
  const q = parseCopilotQuota(copilot())!;
  assert.equal(q.provider, "github-copilot");
  assert.equal(q.windows![0]!.remainingPercent, 49);
  assert.equal(q.windows![0]!.resetAt, reset);
  assert.match(quotaBlock({ ok: true, quota: q }), /premium.*49% left/);
  assert.equal(parseCopilotQuota({ ...copilot(), token_based_billing: true })!.windows![0]!.label, "credits");
  assert.equal(parseCopilotQuota(copilot({ entitlement: 200, quota_remaining: 50 }))!.windows![0]!.remainingPercent, 25);
  assert.equal(parseCopilotQuota(copilot({ unlimited: true }))!.windows![0]!.unlimited, true);
  assert.equal(parseCopilotQuota(copilot({ entitlement: 0, remaining: 0, percent_remaining: 100 }))!.windows![0]!.unlimited, true);
  for (const payload of [null, {}, { quota_snapshots: [] }, copilot({}), copilot({ percent_remaining: "49" })]) {
    assert.equal(parseCopilotQuota(payload), null);
  }
});

test("Codex reports percent LEFT for both windows, including exhausted and malformed data", () => {
  const q = parseCodexQuota(codex())!;
  assert.deepEqual(q.windows!.map(w => [w.label, w.remainingPercent]), [["5h", 75], ["7d", 40]]);
  assert.equal(q.windows![0]!.resetAt, reset);
  assert.equal(parseCodexQuota(codex(120))!.windows![0]!.remainingPercent, 0);
  assert.equal(parseCodexQuota({ rate_limit: { primary_window: { used_percent: 100 } } })!.windows![0]!.remainingPercent, 0);
  for (const payload of [null, {}, { rate_limit: {} }, { rate_limit: { primary_window: { used_percent: "25" } } }, { rate_limit: { primary_window: { used_percent: -1 } } }]) {
    assert.equal(parseCodexQuota(payload), null);
  }
});

test("subscription footer is compact, cached, and expires by age or provider reset", () => {
  const result = { ok: true as const, quota: parseCopilotQuota(copilot())! };
  const text = quotaFooter(result, now, now);
  assert.match(text, /Copilot.*49% left/);
  assert.match(text, /cached/);
  assert.ok(text.length <= 48);
  assert.match(quotaFooter(result, now, now + 15 * 60 * 1000), /stale/);
  assert.match(quotaFooter(result, reset - 100, reset), /stale/);
  assert.match(quotaFooter({ ok: false, provider: "github-copilot", reason: "timeout" }, now, now), /unavailable/);
  assert.match(quotaFooter({ ok: true, quota: parseCopilotQuota(copilot({ unlimited: true }))! }, now, now), /unlimited/);
  assert.equal(quotaFooter(undefined, now, now), "");
  assert.equal(quotaFooter({ ok: true, quota: { ...result.quota, provider: "openrouter", windows: undefined } }, now, now), "");
});

test("subscription requests stay on fixed hosts, refuse redirects, and do not echo credentials", async () => {
  const provider = findProvider("github-copilot")!;
  assert.ok(provider);
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://api.github.com/copilot_internal/user");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-github-oauth");
    return new Response(JSON.stringify(copilot()));
  }) as typeof fetch;
  assert.equal((await fetchQuota(provider, "synthetic-github-oauth", fake)).ok, true);
  const failed = await fetchQuota(provider, "synthetic-github-oauth", (async () => new Response("synthetic-github-oauth", { status: 403 })) as typeof fetch);
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes("synthetic-github-oauth"));
  const denied = await fetchQuota({ ...provider, url: "https://untrusted.invalid/quota" }, "synthetic-github-oauth", (async () => { throw Error("must not dial"); }) as typeof fetch);
  assert.equal(denied.ok, false);
});

test("Codex sends only the account-id claim alongside the OAuth access token", async () => {
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" }, unrelated: "not-a-header" })).toString("base64url")}.signature`;
  const provider = findProvider("openai-codex")!;
  assert.ok(provider);
  const result = await fetchQuota(provider, token, (async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("ChatGPT-Account-Id"), "synthetic-account");
    assert.equal(headers.get("Authorization"), `Bearer ${token}`);
    assert.ok(!JSON.stringify([...headers]).includes("not-a-header"));
    return new Response(JSON.stringify(codex()));
  }) as typeof fetch);
  assert.equal(result.ok, true);
});

test("Codex ignores malformed account claims rather than forwarding extra headers", async () => {
  const provider = findProvider("openai-codex")!;
  const tokens = ["not-a-jwt", ...[{}, { chatgpt_account_id: 42 }, { chatgpt_account_id: "bad\r\nX-Injected: yes" }].map(claim =>
    `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claim })).toString("base64url")}.signature`)];
  for (const token of tokens) {
    const result = await fetchQuota(provider, token, (async (_url, init) => {
      assert.equal(new Headers(init?.headers).has("ChatGPT-Account-Id"), false);
      return new Response(JSON.stringify(codex()));
    }) as typeof fetch);
    assert.equal(result.ok, true);
  }
});

test("Copilot quota uses the stored GitHub OAuth token, NEVER the inference token", async () => {
  const registry = { getApiKeyForProvider: async () => { throw Error("must not request the inference token"); } };
  assert.equal(await quotaApiKey("github-copilot", registry, () => ({ type: "oauth", refresh: "synthetic-github-oauth", access: "synthetic-inference" })), "synthetic-github-oauth");
  for (const credential of [undefined, { type: "api_key", key: "synthetic-inference" }, { type: "oauth", access: "synthetic-inference" },
    { type: "oauth", refresh: "synthetic-enterprise-token", enterpriseUrl: "example.ghe.com.evil.invalid" },
    { type: "oauth", refresh: "synthetic-enterprise-token", enterpriseUrl: "https://github.com@evil.invalid" }]) {
    assert.equal(await quotaApiKey("github-copilot", registry, () => credential), "");
  }
});

test("Codex resolves fresh OAuth through Pi but never sends a regular OpenAI API key to ChatGPT", async () => {
  const credential = { type: "oauth", access: "synthetic-expired-access" };
  const registry = { getApiKeyForProvider: async () => { credential.access = "synthetic-fresh-access"; return credential.access; } };
  assert.equal(await quotaApiKey("openai-codex", registry, () => credential), "synthetic-fresh-access");
  assert.equal(await quotaApiKey("openai-codex", registry, () => ({ type: "api_key", key: "synthetic-api-key" })), "");
  assert.equal(await quotaApiKey("openai-codex", { getApiKeyForProvider: async () => "synthetic-unrelated-api-key" }, () => credential), "");
  assert.equal(await quotaApiKey("openrouter", registry, () => { throw Error("API-key providers must not read stored OAuth"); }), "synthetic-fresh-access");
  assert.equal(await quotaApiKey("openai-codex", registry, () => { throw Error("synthetic-secret failure"); }), "");
  assert.equal(await quotaApiKey("deepseek", { getProviderAuth: async () => ({ auth: { apiKey: "synthetic-key" } }) }, () => undefined), "synthetic-key");
});
