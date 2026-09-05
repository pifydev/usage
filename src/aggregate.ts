import {
  emptyTotals,
  finite,
  isRecord,
  type HistoryAggregate,
  type UsageRecord,
  type UsageTotals,
} from "./types.ts";

/** Fold one record into a totals accumulator (mutates and returns it). */
export function addRecord(totals: UsageTotals, record: UsageRecord): UsageTotals {
  totals.input += record.input;
  totals.output += record.output;
  totals.cacheRead += record.cacheRead;
  totals.cacheWrite += record.cacheWrite;
  totals.totalTokens += record.totalTokens;
  totals.cost += record.cost;
  totals.messages += 1;
  return totals;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar day key (matches the suite's local-day discipline). */
export function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function aggregate(records: UsageRecord[], files: number): HistoryAggregate {
  const byDay = new Map<string, UsageTotals>();
  const byModel = new Map<string, UsageTotals>();
  const byProject = new Map<string, UsageTotals>();
  const total = emptyTotals();

  for (const record of records) {
    addRecord(total, record);
    const day = dayKey(record.timestamp);
    addRecord(byDay.get(day) ?? byDay.set(day, emptyTotals()).get(day)!, record);
    const model = `${record.provider}/${record.model}`;
    addRecord(byModel.get(model) ?? byModel.set(model, emptyTotals()).get(model)!, record);
    if (record.project) {
      const p = record.project;
      addRecord(byProject.get(p) ?? byProject.set(p, emptyTotals()).get(p)!, record);
    }
  }

  return { byDay, byModel, byProject, total, files };
}

/** Sum totals for days within the trailing window (inclusive of today). */
export function windowTotals(byDay: Map<string, UsageTotals>, days: number, now: number): UsageTotals {
  const totals = emptyTotals();
  const cutoff = new Set<string>();
  for (let i = 0; i < days; i++) {
    cutoff.add(dayKey(now - i * 86_400_000));
  }
  for (const [day, t] of byDay) {
    if (!cutoff.has(day)) continue;
    totals.input += t.input;
    totals.output += t.output;
    totals.cacheRead += t.cacheRead;
    totals.cacheWrite += t.cacheWrite;
    totals.totalTokens += t.totalTokens;
    totals.cost += t.cost;
    totals.messages += t.messages;
  }
  return totals;
}

/**
 * Extract a usage record from one parsed session-JSONL entry. Counts any
 * entry whose message carries a usage block (assistant turns dominate; pi
 * 0.81+ also persists tool-result/compaction usage the same way). Returns
 * null for entries without usage. Negative/NaN fields clamp to 0.
 */
export function recordFromEntry(entry: unknown): UsageRecord | null {
  if (!isRecord(entry)) return null;
  const message = entry.message;
  if (!isRecord(message) || !isRecord(message.usage)) return null;
  const usage = message.usage;
  const total = finite(usage.totalTokens);
  const cost = isRecord(usage.cost) ? finite(usage.cost.total) : 0;
  if (total === 0 && cost === 0) return null;

  const ts =
    typeof entry.timestamp === "string"
      ? Date.parse(entry.timestamp)
      : typeof message.timestamp === "number"
        ? message.timestamp
        : Number.NaN;

  return {
    timestamp: Number.isFinite(ts) ? ts : 0,
    model: typeof message.model === "string" ? message.model : "unknown",
    provider: typeof message.provider === "string" ? message.provider : "unknown",
    project: "",
    input: finite(usage.input),
    output: finite(usage.output),
    cacheRead: finite(usage.cacheRead),
    cacheWrite: finite(usage.cacheWrite),
    totalTokens: total,
    cost,
  };
}

/** Parse one JSONL line into a usage record, or null. */
export function recordFromLine(line: string): UsageRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return recordFromEntry(JSON.parse(trimmed));
  } catch {
    return null;
  }
}
