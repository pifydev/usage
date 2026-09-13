import type { HistoryAggregate, UsageTotals } from "./types.ts";
import { windowTotals } from "./aggregate.ts";

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}

/** Footer text: short, live. Null clears the indicator. */
export function footerText(session: UsageTotals): string | undefined {
  if (session.messages === 0) return undefined;
  return `📊 ${formatTokens(session.totalTokens)} tok · ${formatCost(session.cost)}`;
}

const GAUGE_CELLS = 6;

/**
 * A compact live context gauge for the footer: a filled/empty bar and the
 * percentage of the window in use. The footer already carries tokens and cost;
 * this answers the third question you have mid-session — how close am I to the
 * wall — which was computed for the /usage dashboard but never shown live. It
 * warns once the window is nearly full, because that is when the number stops
 * being trivia and starts being a decision. Empty when there is no window to
 * measure against (e.g. under `-p`, or before the first response).
 */
export function contextGauge(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "";
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * GAUGE_CELLS);
  const bar = "▰".repeat(filled) + "▱".repeat(GAUGE_CELLS - filled);
  return `${clamped >= 90 ? "⚠ " : ""}ctx ${bar} ${Math.round(clamped)}%`;
}

export function sessionBlock(session: UsageTotals, contextPct: number | null): string {
  const lines = [
    "Session",
    `  tokens   in ${formatTokens(session.input)} · out ${formatTokens(session.output)} · cache ${formatTokens(session.cacheRead)} read / ${formatTokens(session.cacheWrite)} write`,
    `  cost     ${formatCost(session.cost)} (${session.messages} responses)`,
  ];
  if (contextPct !== null) {
    lines.push(`  context  ~${Math.round(contextPct)}% of the window`);
  }
  return lines.join("\n");
}

export function historyBlock(history: HistoryAggregate, now: number): string {
  const today = windowTotals(history.byDay, 1, now);
  const week = windowTotals(history.byDay, 7, now);
  const month = windowTotals(history.byDay, 30, now);

  const lines = [
    `History (${history.files} local session files)`,
    `  today    ${formatCost(today.cost)} · ${formatTokens(today.totalTokens)} tok`,
    `  7 days   ${formatCost(week.cost)} · ${formatTokens(week.totalTokens)} tok`,
    `  30 days  ${formatCost(month.cost)} · ${formatTokens(month.totalTokens)} tok`,
  ];

  pushBreakdown(lines, "By model (all time)", history.byModel, 6);
  pushBreakdown(lines, "By project (all time)", history.byProject, 5);
  return lines.join("\n");
}

/** One "name  $cost · N tok" table, biggest spend first. */
function pushBreakdown(
  lines: string[],
  heading: string,
  totals: Map<string, UsageTotals>,
  limit: number,
): void {
  const rows = [...totals.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, limit);
  if (rows.length === 0) return;
  lines.push(heading);
  const width = rows.reduce((m, [name]) => Math.max(m, Math.min(name.length, 40)), 0);
  for (const [name, t] of rows) {
    const label = name.length > 40 ? `${name.slice(0, 39)}…` : name;
    lines.push(`  ${label.padEnd(width)}  ${formatCost(t.cost)} · ${formatTokens(t.totalTokens)} tok`);
  }
}
