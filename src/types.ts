/**
 * Local structural types for @pify/usage.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  messages: number;
}

export function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, messages: 0 };
}

/** One usage-bearing record extracted from a session file or live event. */
export interface UsageRecord {
  /** Epoch ms. */
  timestamp: number;
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface HistoryAggregate {
  byDay: Map<string, UsageTotals>;
  byModel: Map<string, UsageTotals>;
  total: UsageTotals;
  files: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
