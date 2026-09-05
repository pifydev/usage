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
import { fetchOpenRouterQuota, parseOpenRouterKey, quotaBlock } from "../src/quota.ts";
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

test("v0.3 fetchOpenRouterQuota turns every failure into a result", async () => {
  const noKey = await fetchOpenRouterQuota("");
  assert.equal(noKey.ok, false);

  const http500 = await fetchOpenRouterQuota("k", async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  }));
  assert.equal(http500.ok, false);
  assert.ok(!http500.ok && http500.reason.includes("500"));

  const thrown = await fetchOpenRouterQuota("k", async () => {
    throw new Error("network down");
  });
  assert.equal(thrown.ok, false);
  assert.ok(!thrown.ok && thrown.reason.includes("network down"));

  let sentAuth = "";
  const good = await fetchOpenRouterQuota("secret-key", async (_url, init) => {
    sentAuth = init.headers.Authorization ?? "";
    return { ok: true, status: 200, json: async () => ({ data: { usage: 1.5, limit: 10 } }) };
  });
  assert.equal(good.ok, true);
  assert.equal(sentAuth, "Bearer secret-key");
  assert.ok(good.ok && good.quota.remaining === 8.5);
});

test("v0.3 quotaBlock never prints the key and states what is unknown", () => {
  const uncapped = quotaBlock({
    ok: true,
    quota: {
      provider: "openrouter", used: 0.0031, limit: null, remaining: null,
      daily: 0.0031, weekly: 0.0031, monthly: 0.0031, label: "sk-or-v1-abc...xyz", freeTier: false,
    },
  });
  assert.ok(uncapped.includes("no credit limit"));
  assert.ok(uncapped.includes("<$0.01"));
  assert.ok(uncapped.includes("sk-or-v1-abc...xyz"));

  const capped = quotaBlock({
    ok: true,
    quota: {
      provider: "openrouter", used: 4, limit: 10, remaining: 6,
      daily: null, weekly: null, monthly: null, label: null, freeTier: true,
    },
  });
  assert.ok(capped.includes("$4.00 of $10.00 · $6.00 left"));
  assert.ok(capped.includes("free"));

  const failed = quotaBlock({ ok: false, provider: "openrouter", reason: "HTTP 401" });
  assert.ok(failed.includes("unavailable — HTTP 401"));
});
