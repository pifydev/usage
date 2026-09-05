/**
 * Provider quota (v0.3). Everything else in this package is computed from
 * local files — this is the one place that talks to a network, so it is
 * opt-in per call, short-timeout, and never blocks the dashboard: a provider
 * that is slow or down shows as unavailable next to the local numbers.
 *
 * Only OpenRouter is implemented. @narumitw/pi-usage shows what the full set
 * costs — roughly 18k lines of per-provider contract chasing — and OpenRouter
 * is the one endpoint that reports a real balance rather than an opaque
 * rate-limit window.
 */

import { finite, isRecord } from "./types.ts";

export interface QuotaInfo {
  provider: string;
  /** Spend on this key, in USD, as the provider reports it. */
  used: number | null;
  /** Hard credit limit, when the key has one. */
  limit: number | null;
  remaining: number | null;
  /** Rolling-window spend, when reported. */
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
  label: string | null;
  freeTier: boolean | null;
}

export type QuotaResult =
  | { ok: true; quota: QuotaInfo }
  | { ok: false; provider: string; reason: string };

export const QUOTA_TIMEOUT_MS = 8000;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Shape the /api/v1/key payload. OpenRouter reports `limit: null` for keys
 * with no cap, so "no limit" and "limit of zero" must not collapse together.
 */
export function parseOpenRouterKey(payload: unknown): QuotaInfo | null {
  if (!isRecord(payload)) return null;
  // The endpoint wraps its fields in `data`; a flat body is accepted too, but
  // a `data` that is present and not an object means the shape changed.
  if ("data" in payload && !isRecord(payload.data)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;

  const used = num(data.usage);
  const limit = num(data.limit);
  const remaining = num(data.limit_remaining) ?? (limit !== null && used !== null ? limit - used : null);

  return {
    provider: "openrouter",
    used: used === null ? null : finite(used),
    limit,
    remaining,
    daily: num(data.usage_daily),
    weekly: num(data.usage_weekly),
    monthly: num(data.usage_monthly),
    label: typeof data.label === "string" ? data.label : null,
    freeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
  };
}

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Fetch the OpenRouter key status. Never throws — failure is a result. */
export async function fetchOpenRouterQuota(
  apiKey: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
  timeoutMs = QUOTA_TIMEOUT_MS,
): Promise<QuotaResult> {
  if (!apiKey.trim()) return { ok: false, provider: "openrouter", reason: "no API key configured" };
  try {
    const response = await fetcher("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, provider: "openrouter", reason: `HTTP ${response.status}` };
    }
    const quota = parseOpenRouterKey(await response.json());
    if (!quota) return { ok: false, provider: "openrouter", reason: "unexpected response shape" };
    return { ok: true, quota };
  } catch (err) {
    return {
      ok: false,
      provider: "openrouter",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function money(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function quotaBlock(result: QuotaResult): string {
  if (!result.ok) {
    return `Quota (${result.provider})\n  unavailable — ${result.reason}`;
  }
  const q = result.quota;
  const lines = [`Quota (${q.provider}${q.label ? ` · ${q.label}` : ""})`];
  lines.push(
    q.limit === null
      ? `  spent    ${money(q.used)} (no credit limit on this key)`
      : `  spent    ${money(q.used)} of ${money(q.limit)} · ${money(q.remaining)} left`,
  );
  if (q.daily !== null || q.weekly !== null || q.monthly !== null) {
    lines.push(`  window   day ${money(q.daily)} · week ${money(q.weekly)} · month ${money(q.monthly)}`);
  }
  if (q.freeTier) lines.push("  tier     free");
  return lines.join("\n");
}
