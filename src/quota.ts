/**
 * Provider quota. Everything else in this package is computed from local
 * files; this is the one place that talks to a network, so it is opt-in per
 * call, short-timeout, pinned to allowlisted HTTPS hosts, and never blocks the
 * dashboard: a provider that is slow or down shows as unavailable next to the
 * local numbers.
 *
 * Documented endpoints only. OpenRouter's `/api/v1/key` and DeepSeek's
 * `/user/balance` are both published APIs that report a real balance. The
 * subscription-quota endpoints some plugins use for OpenAI, Anthropic and
 * Gemini are undocumented private APIs reverse-engineered from vendor CLIs;
 * they break without notice and were never offered to third parties, so this
 * package does not call them. (That line is imdlan/pi-usage's, and it is a
 * better reason than the maintenance cost this package cited before.)
 */

import { controlledGetJson, type HttpResult } from "./http.ts";
import { finite, isRecord } from "./types.ts";

export interface QuotaInfo {
  provider: string;
  /** Spend on this key, in the provider's currency, as it reports it. */
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
  /** Currency for the amounts above; USD unless the provider says otherwise. */
  currency: string;
}

export type QuotaResult =
  | { ok: true; quota: QuotaInfo }
  | { ok: false; provider: string; reason: string };

export const QUOTA_TIMEOUT_MS = 8000;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** "110.00" — DeepSeek reports money as strings. */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyQuota(provider: string): QuotaInfo {
  return {
    provider,
    used: null,
    limit: null,
    remaining: null,
    daily: null,
    weekly: null,
    monthly: null,
    label: null,
    freeTier: null,
    currency: "USD",
  };
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
    ...emptyQuota("openrouter"),
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

/**
 * DeepSeek's documented `/user/balance`: a list of per-currency balances. The
 * first available one is reported; a key with no available balance is still a
 * successful answer, showing zero rather than an error.
 */
export function parseDeepSeekBalance(payload: unknown): QuotaInfo | null {
  if (!isRecord(payload)) return null;
  const infos = payload.balance_infos;
  if (!Array.isArray(infos)) return null;

  const first = infos.find((entry) => isRecord(entry) && numeric(entry.total_balance) !== null);
  if (!isRecord(first)) {
    return { ...emptyQuota("deepseek"), remaining: 0 };
  }
  const total = numeric(first.total_balance);
  const granted = numeric(first.granted_balance);
  const topped = numeric(first.topped_up_balance);
  const parts = [
    granted === null ? null : `granted ${granted}`,
    topped === null ? null : `topped up ${topped}`,
  ].filter((part): part is string => part !== null);

  return {
    ...emptyQuota("deepseek"),
    remaining: total,
    currency: typeof first.currency === "string" ? first.currency : "USD",
    label: parts.length > 0 ? parts.join(" · ") : null,
    freeTier: payload.is_available === false ? null : null,
  };
}

export interface QuotaProvider {
  /** pi's provider id, which is also how the key is looked up. */
  id: string;
  displayName: string;
  url: string;
  allowlist: readonly string[];
  parse(payload: unknown): QuotaInfo | null;
}

export const QUOTA_PROVIDERS: readonly QuotaProvider[] = [
  {
    id: "openrouter",
    displayName: "OpenRouter",
    url: "https://openrouter.ai/api/v1/key",
    allowlist: ["openrouter.ai"],
    parse: parseOpenRouterKey,
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    url: "https://api.deepseek.com/user/balance",
    allowlist: ["api.deepseek.com"],
    parse: parseDeepSeekBalance,
  },
];

export function findProvider(id: string): QuotaProvider | undefined {
  return QUOTA_PROVIDERS.find((provider) => provider.id === id.trim().toLowerCase());
}

/**
 * Query one provider. Never throws — failure is a result, and its reason is
 * this package's own wording, never the provider's response text.
 */
export async function fetchQuota(
  provider: QuotaProvider,
  apiKey: string,
  fetchImpl?: typeof fetch,
  timeoutMs = QUOTA_TIMEOUT_MS,
): Promise<QuotaResult> {
  if (!apiKey.trim()) return { ok: false, provider: provider.id, reason: "no API key configured" };

  const result: HttpResult<unknown> = await controlledGetJson({
    url: provider.url,
    headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
    timeoutMs,
    allowlist: provider.allowlist,
    fetchImpl,
  });
  if (!result.ok) return { ok: false, provider: provider.id, reason: result.reason };

  const quota = provider.parse(result.data);
  if (!quota) return { ok: false, provider: provider.id, reason: "the response did not match the documented shape" };
  return { ok: true, quota };
}

function money(value: number | null, currency = "USD"): string {
  if (value === null) return "—";
  const symbol = currency === "USD" ? "$" : `${currency} `;
  if (value === 0) return `${symbol}0`;
  if (Math.abs(value) < 0.01) return `<${symbol}0.01`;
  return `${symbol}${value.toFixed(2)}`;
}

export function quotaBlock(result: QuotaResult): string {
  const id = result.ok ? result.quota.provider : result.provider;
  const name = findProvider(id)?.displayName ?? id;
  if (!result.ok) return `Quota (${name})\n  unavailable — ${result.reason}`;

  const q = result.quota;
  const lines = [`Quota (${name}${q.label ? ` · ${q.label}` : ""})`];
  if (q.used !== null || q.limit !== null) {
    lines.push(
      q.limit === null
        ? `  spent    ${money(q.used, q.currency)} (no credit limit on this key)`
        : `  spent    ${money(q.used, q.currency)} of ${money(q.limit, q.currency)} · ${money(q.remaining, q.currency)} left`,
    );
  } else if (q.remaining !== null) {
    lines.push(`  balance  ${money(q.remaining, q.currency)}`);
  }
  if (q.daily !== null || q.weekly !== null || q.monthly !== null) {
    lines.push(
      `  window   day ${money(q.daily, q.currency)} · week ${money(q.weekly, q.currency)} · month ${money(q.monthly, q.currency)}`,
    );
  }
  if (q.freeTier) lines.push("  tier     free");
  return lines.join("\n");
}

/** What `/usage quota` prints: every provider that has a key, and nothing else. */
export function quotaReport(results: QuotaResult[]): string {
  if (results.length === 0) {
    return [
      "No provider with a quota endpoint is configured.",
      `Supported: ${QUOTA_PROVIDERS.map((p) => p.displayName).join(", ")}.`,
      "Only documented endpoints are used — OpenAI, Anthropic and Gemini publish none for subscription quota.",
    ].join("\n");
  }
  return results.map(quotaBlock).join("\n\n");
}
