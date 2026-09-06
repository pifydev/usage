import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRecord,
  aggregate,
  dayKey,
  recordFromEntry,
  recordFromLine,
  windowTotals,
} from "../src/aggregate.ts";
import { footerText, formatCost, formatTokens, historyBlock, sessionBlock } from "../src/format.ts";
import { clearScanCache, projectLabel, scanSessions } from "../src/sessions.ts";
import {
  fetchQuota,
  findProvider,
  parseDeepSeekBalance,
  parseOpenRouterKey,
  quotaBlock,
  quotaReport,
} from "../src/quota.ts";
import { checkUrl, controlledGetJson } from "../src/http.ts";
import { redact } from "../src/redact.ts";
import { emptyTotals, type UsageRecord } from "../src/types.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestamp: new Date(2026, 8, 4, 12, 0).getTime(),
    model: "gpt-5.5",
    provider: "openai",
    project: "",
    input: 1000,
    output: 200,
    cacheRead: 5000,
    cacheWrite: 0,
    totalTokens: 6200,
    cost: 0.05,
    ...overrides,
  };
}

function entry(usage: object, extra: object = {}) {
  return {
    type: "message",
    timestamp: "2026-09-04T12:00:00.000Z",
    message: { role: "assistant", model: "gpt-5.5", provider: "openai", usage, ...extra },
  };
}

test("recordFromEntry extracts usage; clamps negatives; skips no-usage", () => {
  const r = recordFromEntry(
    entry({ input: 10, output: -5, cacheRead: 3, cacheWrite: 0, totalTokens: 13, cost: { total: 0.01 } }),
  );
  assert.ok(r);
  assert.equal(r!.input, 10);
  assert.equal(r!.output, 0);
  assert.equal(r!.cost, 0.01);
  assert.equal(r!.model, "gpt-5.5");
  assert.ok(r!.timestamp > 0);

  assert.equal(recordFromEntry({ type: "message", message: { role: "assistant" } }), null);
  assert.equal(recordFromEntry({ type: "custom" }), null);
  assert.equal(recordFromEntry(entry({ totalTokens: 0, cost: { total: 0 } })), null);
});

test("recordFromEntry counts non-assistant usage too (tool-result/compaction)", () => {
  const r = recordFromEntry(entry({ totalTokens: 500, cost: { total: 0.002 } }, { role: "toolResult" }));
  assert.ok(r);
  assert.equal(r!.totalTokens, 500);
});

test("recordFromLine tolerates junk lines", () => {
  assert.equal(recordFromLine(""), null);
  assert.equal(recordFromLine("not json"), null);
  assert.ok(recordFromLine(JSON.stringify(entry({ totalTokens: 5, cost: { total: 0.1 } }))));
});

test("aggregate groups by local day and provider/model", () => {
  const day1 = new Date(2026, 8, 3, 23, 30).getTime();
  const day2 = new Date(2026, 8, 4, 0, 30).getTime();
  const agg = aggregate(
    [
      record({ timestamp: day1, cost: 1 }),
      record({ timestamp: day2, cost: 2 }),
      record({ timestamp: day2, cost: 3, provider: "anthropic", model: "claude-fable-5" }),
    ],
    7,
  );
  assert.equal(agg.byDay.get("2026-09-03")!.cost, 1);
  assert.equal(agg.byDay.get("2026-09-04")!.cost, 5);
  assert.equal(agg.byModel.get("openai/gpt-5.5")!.messages, 2);
  assert.equal(agg.byModel.get("anthropic/claude-fable-5")!.cost, 3);
  assert.equal(agg.total.cost, 6);
  assert.equal(agg.files, 7);
});

test("windowTotals sums only trailing days", () => {
  const now = new Date(2026, 8, 4, 12, 0).getTime();
  const agg = aggregate(
    [
      record({ timestamp: now, cost: 1 }),
      record({ timestamp: now - 3 * 86_400_000, cost: 2 }),
      record({ timestamp: now - 40 * 86_400_000, cost: 4 }),
    ],
    1,
  );
  assert.equal(windowTotals(agg.byDay, 1, now).cost, 1);
  assert.equal(windowTotals(agg.byDay, 7, now).cost, 3);
  assert.equal(windowTotals(agg.byDay, 30, now).cost, 3);
});

test("dayKey uses local calendar day", () => {
  assert.equal(dayKey(new Date(2026, 8, 4, 23, 59).getTime()), "2026-09-04");
});

test("formatting tiers", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12_300), "12.3k");
  assert.equal(formatTokens(2_500_000), "2.5M");
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(1.234), "$1.23");
});

test("footer hides when empty, shows tokens+cost", () => {
  assert.equal(footerText(emptyTotals()), undefined);
  const totals = addRecord(emptyTotals(), record());
  assert.equal(footerText(totals), "📊 6.2k tok · $0.05");
});

test("session and history blocks render", () => {
  const totals = addRecord(emptyTotals(), record());
  const block = sessionBlock(totals, 34.4);
  assert.ok(block.includes("in 1.0k · out 200"));
  assert.ok(block.includes("~34% of the window"));
  assert.ok(sessionBlock(totals, null).includes("cost"));

  const agg = aggregate([record({ cost: 1.5 })], 3);
  const history = historyBlock(agg, record().timestamp);
  assert.ok(history.includes("3 local session files"));
  assert.ok(history.includes("today    $1.50"));
  assert.ok(history.includes("openai/gpt-5.5"));
});

test("scanSessions reads jsonl recursively with cache", () => {
  const base = mkdtempSync(join(tmpdir(), "pify-usage-"));
  try {
    mkdirSync(join(base, "sub"), { recursive: true });
    const lines = [
      JSON.stringify(entry({ totalTokens: 100, cost: { total: 0.01 } })),
      "garbage line",
      JSON.stringify({ type: "custom" }),
    ].join("\n");
    writeFileSync(join(base, "a.jsonl"), lines);
    writeFileSync(join(base, "sub", "b.jsonl"), lines);
    writeFileSync(join(base, "ignore.txt"), lines);

    clearScanCache();
    const first = scanSessions(base);
    assert.equal(first.files, 2);
    assert.equal(first.records.length, 2);
    // cached second scan returns the same
    const second = scanSessions(base);
    assert.equal(second.records.length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("v0.2 scanSessions labels records with their project directory", () => {
  const base = mkdtempSync(join(tmpdir(), "pify-usage-proj-"));
  try {
    const line = JSON.stringify(entry({ totalTokens: 100, cost: { total: 0.01 } }));
    mkdirSync(join(base, "--D--project-alpha--"), { recursive: true });
    mkdirSync(join(base, "--D--project-beta--"), { recursive: true });
    writeFileSync(join(base, "--D--project-alpha--", "s1.jsonl"), line);
    writeFileSync(join(base, "--D--project-beta--", "s2.jsonl"), [line, line].join("\n"));
    writeFileSync(join(base, "loose.jsonl"), line);

    clearScanCache();
    const scan = scanSessions(base);
    assert.equal(scan.files, 3);
    const projects = scan.records.map((r) => r.project).sort();
    assert.deepEqual(projects, ["", "D--project-alpha", "D--project-beta", "D--project-beta"]);

    const history = aggregate(scan.records, scan.files);
    // loose files (project "") stay out of the project breakdown
    assert.equal(history.byProject.size, 2);
    assert.equal(history.byProject.get("D--project-beta")!.messages, 2);
    assert.ok(historyBlock(history, Date.now()).includes("By project (all time)"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("v0.2 projectLabel strips fences and keeps the recognizable tail", () => {
  assert.equal(projectLabel("--D--project-pify-plugins--"), "D--project-pify-plugins");
  assert.equal(projectLabel("----"), "unknown");
  const long = projectLabel(`--${"a".repeat(60)}--`);
  assert.equal(long.length, 34);
  assert.ok(long.startsWith("…"));
});

test("v0.3 parseOpenRouterKey shapes the real payload", () => {
  // captured from https://openrouter.ai/api/v1/key
  const live = {
    data: {
      label: "sk-or-v1-abc...xyz",
      limit: null,
      limit_remaining: null,
      usage: 0.0031,
      usage_daily: 0.0031,
      usage_weekly: 0.0031,
      usage_monthly: 0.0031,
      is_free_tier: false,
    },
  };
  const quota = parseOpenRouterKey(live)!;
  assert.equal(quota.provider, "openrouter");
  assert.equal(quota.used, 0.0031);
  assert.equal(quota.limit, null);
  assert.equal(quota.remaining, null);
  assert.equal(quota.freeTier, false);
  assert.equal(quota.label, "sk-or-v1-abc...xyz");

  // a capped key derives what is left when the API does not state it
  const capped = parseOpenRouterKey({ data: { usage: 4, limit: 10 } })!;
  assert.equal(capped.remaining, 6);
  // "no limit" must not read as "limit of zero"
  assert.notEqual(parseOpenRouterKey({ data: { usage: 4, limit: null } })!.limit, 0);
  assert.equal(parseOpenRouterKey("nonsense"), null);
  assert.equal(parseOpenRouterKey({ data: null }), null);
});

test("v0.5 fetchQuota turns every failure into a result, with our own wording", async () => {
  const openrouter = findProvider("openrouter")!;

  const noKey = await fetchQuota(openrouter, "");
  assert.equal(noKey.ok, false);
  assert.ok(!noKey.ok && noKey.reason.includes("no API key"));

  const http500 = await fetchQuota(openrouter, "k", async () =>
    new Response("provider said something with a token in it", { status: 500 }),
  );
  assert.equal(http500.ok, false);
  assert.ok(!http500.ok && http500.reason.includes("trouble"));
  assert.ok(!http500.ok && !http500.reason.includes("token"), "the body is never read into the message");

  const unauthorized = await fetchQuota(openrouter, "k", async () => new Response("{}", { status: 401 }));
  assert.ok(!unauthorized.ok && unauthorized.reason.includes("rejected the key"));

  const thrown = await fetchQuota(openrouter, "k", async () => {
    throw new Error("connect ECONNREFUSED 1.2.3.4:443 with Authorization: Bearer secret");
  });
  assert.equal(thrown.ok, false);
  assert.ok(!thrown.ok && !thrown.reason.includes("secret"), "raw errors are dropped, not shown");

  let sentAuth = "";
  let sentRedirect: RequestRedirect | undefined;
  const good = await fetchQuota(openrouter, "secret-key", async (_url, init) => {
    sentAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    sentRedirect = init?.redirect;
    return new Response(JSON.stringify({ data: { usage: 1.5, limit: 10 } }), { status: 200 });
  });
  assert.equal(good.ok, true);
  assert.equal(sentAuth, "Bearer secret-key");
  assert.equal(sentRedirect, "error", "a credentialed request must never follow a redirect");
  assert.ok(good.ok && good.quota.remaining === 8.5);
});

test("v0.5 a credentialed request only ever goes to an allowlisted HTTPS host", async () => {
  assert.equal(checkUrl("https://openrouter.ai/api/v1/key", ["openrouter.ai"]), null);
  assert.equal(checkUrl("http://openrouter.ai/api/v1/key", ["openrouter.ai"])!.kind, "unsafe-url");
  assert.equal(checkUrl("https://evil.example/api", ["openrouter.ai"])!.kind, "not-allowed");
  assert.equal(checkUrl("not a url", ["openrouter.ai"])!.kind, "unsafe-url");

  // and the guard runs before anything is dialled
  let called = false;
  const result = await controlledGetJson({
    url: "https://evil.example/steal",
    timeoutMs: 100,
    allowlist: ["openrouter.ai"],
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(called, false, "the request is never made");
  assert.ok(!result.ok && result.kind === "not-allowed");
});

test("v0.5 DeepSeek balance parses the documented shape", () => {
  const payload = {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
    ],
  };
  const quota = parseDeepSeekBalance(payload)!;
  assert.equal(quota.provider, "deepseek");
  assert.equal(quota.remaining, 110);
  assert.equal(quota.currency, "CNY");
  assert.ok(quota.label!.includes("granted 10"));
  assert.ok(quota.label!.includes("topped up 100"));

  // a key with no balances is a successful answer, not an error
  assert.equal(parseDeepSeekBalance({ is_available: false, balance_infos: [] })!.remaining, 0);
  assert.equal(parseDeepSeekBalance({ balance_infos: "nope" }), null);
  assert.equal(parseDeepSeekBalance(null), null);

  assert.ok(quotaBlock({ ok: true, quota }).includes("CNY 110.00"));
});

test("v0.5 the report lists only configured providers, and says so when there are none", () => {
  const empty = quotaReport([]);
  assert.ok(empty.includes("No provider"));
  assert.ok(empty.includes("OpenRouter") && empty.includes("DeepSeek"));
  assert.ok(empty.includes("documented"), "the stance on private APIs is stated, not implied");

  const both = quotaReport([
    { ok: false, provider: "deepseek", reason: "rate limited by the provider" },
    { ok: true, quota: { ...parseOpenRouterKey({ data: { usage: 2, limit: 10 } })! } },
  ]);
  assert.ok(both.includes("DeepSeek"));
  assert.ok(both.includes("OpenRouter"));
});

test("v0.5 redact scrubs what should never have been there", () => {
  assert.ok(!redact("failed with sk-or-v1-abcdefghijklmnopqrstuvwxyz012345").includes("abcdefgh"));
  assert.ok(!redact("Authorization: Bearer hunter2hunter2hunter2").includes("hunter2"));
  assert.ok(!redact("api_key=abcdefghijklmnop").includes("abcdefghijklmnop"));
  assert.ok(!redact("https://openrouter.ai/api?key=secretvalue").includes("secretvalue"));
  // ordinary text is untouched
  assert.equal(redact("spent $1.50 of $10.00"), "spent $1.50 of $10.00");
  assert.equal(redact(""), "");
});

test("v0.3 quotaBlock never prints the key and states what is unknown", () => {
  const uncapped = quotaBlock({
    ok: true,
    quota: {
      provider: "openrouter", used: 0.0031, limit: null, remaining: null,
      daily: 0.0031, weekly: 0.0031, monthly: 0.0031, label: "sk-or-v1-abc...xyz", freeTier: false, currency: "USD",
    },
  });
  assert.ok(uncapped.includes("no credit limit"));
  assert.ok(uncapped.includes("<$0.01"));
  assert.ok(uncapped.includes("sk-or-v1-abc...xyz"));

  const capped = quotaBlock({
    ok: true,
    quota: {
      provider: "openrouter", used: 4, limit: 10, remaining: 6,
      daily: null, weekly: null, monthly: null, label: null, freeTier: true, currency: "USD",
    },
  });
  assert.ok(capped.includes("$4.00 of $10.00 · $6.00 left"));
  assert.ok(capped.includes("free"));

  const failed = quotaBlock({ ok: false, provider: "openrouter", reason: "HTTP 401" });
  assert.ok(failed.includes("unavailable — HTTP 401"));
});
