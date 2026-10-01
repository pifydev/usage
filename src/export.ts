/**
 * Handing the history off: CSV for a spreadsheet, JSON for a script.
 * Pure builders over the aggregate the dashboard already computes; the
 * extension owns the disk write. Full precision, no rounding — rounding is
 * the reader's call.
 */
import type { UsageTotals } from "./types.ts";

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function totalsRow(key: string, t: UsageTotals): string {
  return [key, t.messages, t.input, t.output, t.cacheRead, t.cacheWrite, t.totalTokens, t.cost].map(csvCell).join(",");
}

const HEADER = "input,output,cacheRead,cacheWrite,totalTokens,cost";

/** One row per model, costliest first. */
export function buildByModelCsv(byModel: ReadonlyMap<string, UsageTotals>): string {
  const rows = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([model, t]) => totalsRow(model, t));
  return [`model,messages,${HEADER}`, ...rows].join("\n") + "\n";
}

/** One row per local calendar day, oldest first. */
export function buildByDayCsv(byDay: ReadonlyMap<string, UsageTotals>): string {
  const rows = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, t]) => totalsRow(day, t));
  return [`day,messages,${HEADER}`, ...rows].join("\n") + "\n";
}

/** One row per project, costliest first. */
export function buildByProjectCsv(byProject: ReadonlyMap<string, UsageTotals>): string {
  const rows = [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([p, t]) => totalsRow(p || "(no project)", t));
  return [`project,messages,${HEADER}`, ...rows].join("\n") + "\n";
}

export function buildTotalsJson(total: UsageTotals, files: number, generatedAt: number): string {
  return `${JSON.stringify({ generatedAt: new Date(generatedAt).toISOString(), files, total }, null, 2)}\n`;
}
