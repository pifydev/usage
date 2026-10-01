import { test } from "node:test";
import assert from "node:assert/strict";
import { buildByDayCsv, buildByModelCsv, buildByProjectCsv, buildTotalsJson } from "../src/export.ts";
import { emptyTotals, type UsageTotals } from "../src/types.ts";

const t = (over: Partial<UsageTotals>): UsageTotals => ({ ...emptyTotals(), ...over });

test("CSV builders order rows sensibly, quote what needs quoting, and keep full precision", () => {
  const byModel = new Map([
    ["cheap", t({ messages: 2, cost: 0.001234 })],
    ['model "x", v2', t({ messages: 1, cost: 1.5, input: 10 })],
  ]);
  const csv = buildByModelCsv(byModel);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], "model,messages,input,output,cacheRead,cacheWrite,totalTokens,cost");
  assert.equal(lines[1], '"model ""x"", v2",1,10,0,0,0,0,1.5', "costliest first, quoted");
  assert.equal(lines[2], "cheap,2,0,0,0,0,0,0.001234");
  const byDay = new Map([["2026-10-02", t({ messages: 1 })], ["2026-10-01", t({ messages: 3 })]]);
  assert.match(buildByDayCsv(byDay), /^day,.*\n2026-10-01,3.*\n2026-10-02,1/);
  assert.match(buildByProjectCsv(new Map([["", t({ cost: 1 })]])), /\n\(no project\),/);
});

test("the totals JSON carries the generation time and the file count", () => {
  const json = JSON.parse(buildTotalsJson(t({ cost: 2, totalTokens: 100 }), 7, Date.UTC(2026, 9, 1)));
  assert.equal(json.generatedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(json.files, 7);
  assert.equal(json.total.cost, 2);
});
