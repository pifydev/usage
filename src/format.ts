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

  const models = [...history.byModel.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 6);
  if (models.length > 0) {
    lines.push("By model (all time)");
    const width = models.reduce((m, [name]) => Math.max(m, Math.min(name.length, 40)), 0);
    for (const [name, totals] of models) {
      const label = name.length > 40 ? `${name.slice(0, 39)}…` : name;
      lines.push(`  ${label.padEnd(width)}  ${formatCost(totals.cost)} · ${formatTokens(totals.totalTokens)} tok`);
    }
  }
  return lines.join("\n");
}
