import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveQuotaAuth } from "../src/quota-auth.ts";
import { findProvider, fetchQuota } from "../src/quota.ts";

const copilot = findProvider("github-copilot")!;
const registry = { getApiKeyForProvider: async () => { throw Error("must not resolve an inference token"); } };
const credential = (enterpriseUrl: unknown) => ({ type: "oauth", refresh: "synthetic-github-login", access: "synthetic-inference", enterpriseUrl });

test("Copilot binds each GitHub OAuth credential to its matching API authority", async () => {
  for (const [domain, host] of [
    [undefined, "api.github.com"], [null, "api.github.com"], ["", "api.github.com"],
    ["github.com", "api.github.com"], ["https://github.com/", "api.github.com"],
    ["example.ghe.com", "api.example.ghe.com"], ["https://EXAMPLE.ghe.com/", "api.example.ghe.com"],
  ] as const) {
    const auth = await resolveQuotaAuth(copilot, registry, () => credential(domain));
    assert.ok(auth.ok);
    if (!auth.ok) continue;
    assert.equal(auth.apiKey, "synthetic-github-login");
    assert.equal(auth.provider.url, `https://${host}/copilot_internal/user`);
    assert.deepEqual(auth.provider.allowlist, [host]);
  }
});

test("unsupported, spoofed or credential-bearing authorities never return a usable token/endpoint pair", async () => {
  for (const domain of [false, 42, {}, "http://example.ghe.com", "example.ghe.com.evil.invalid", "https://github.com@evil.invalid",
    "https://example.ghe.com:8443", "https://example.ghe.com/redirect", "https://github.com?redirect=evil", "https://example.ghe.com#fragment"]) {
    const auth = await resolveQuotaAuth(copilot, registry, () => credential(domain));
    assert.equal(auth.ok, false);
    assert.ok(!JSON.stringify(auth).includes("synthetic-github-login"));
    if (!auth.ok) assert.match(auth.reason, /unsupported.*authority/);
  }
});

test("GHE request is pinned to its own host with no redirect or fallback to public GitHub", async () => {
  const auth = await resolveQuotaAuth(copilot, registry, () => credential("example.ghe.com"));
  assert.ok(auth.ok);
  if (!auth.ok) return;
  let calls = 0;
  const result = await fetchQuota(auth.provider, auth.apiKey, (async (url, init) => {
    calls++;
    assert.equal(url, "https://api.example.ghe.com/copilot_internal/user");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-github-login");
    return new Response("synthetic-github-login", { status: 403 });
  }) as typeof fetch);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes("synthetic-github-login"));
});

test("credential failures have an explicit safe diagnostic instead of silently skipping the active provider", async () => {
  for (const read of [() => undefined, () => ({ type: "oauth", access: "synthetic-inference" }), () => { throw Error("synthetic-private-error"); }]) {
    const auth = await resolveQuotaAuth(copilot, registry, read);
    assert.equal(auth.ok, false);
    if (!auth.ok) assert.ok(auth.reason.length > 0);
    assert.ok(!JSON.stringify(auth).includes("synthetic-private-error"));
  }
});
