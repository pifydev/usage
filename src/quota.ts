/**
 * Provider quota. Everything else in this package is computed from local
 * files; this is the one place that talks to a network, so it is opt-in per
 * call, short-timeout, pinned to allowlisted HTTPS hosts, and never blocks the
 * dashboard: a provider that is slow or down shows as unavailable next to the
 * local numbers.
 *
 * OpenRouter and DeepSeek expose balance APIs. Copilot and Codex expose
 * subscription quotas through endpoints published by their official clients,
 * without the same versioned REST contract. All four are opt-in per call;
 * polling is never started by a session, a model change, or a footer redraw.
 */

import { controlledGetJson, type HttpResult } from "./http.ts";
import { finite, isRecord } from "./types.ts";

export interface QuotaWindow {
  label: string;
  remainingPercent: number | null;
  resetAt: number | null;
  unlimited: boolean;
}

export interface QuotaInfo {
  /** Subscription windows are percentages, not monetary balances. */
  windows?: QuotaWindow[];
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

/** Copilot premium interactions (or AI credits on token-based billing). */
export function parseCopilotQuota(payload: unknown): QuotaInfo | null {
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots)) return null;
  const snapshot = payload.quota_snapshots.premium_interactions;
  if (!isRecord(snapshot)) return null;
  const remaining = num(snapshot.quota_remaining) ?? num(snapshot.remaining);
  const limit = num(snapshot.entitlement);
  const percent = num(snapshot.percent_remaining) ??
    (remaining !== null && limit !== null && limit > 0 ? remaining / limit * 100 : null);
  const unlimited = snapshot.unlimited === true || (remaining === 0 && limit === 0 && percent === 100);
  if (percent === null && !unlimited) return null;
  const reset = payload.quota_reset_date ?? payload.quota_reset_date_utc;
  const resetAt = typeof reset === "string" ? Date.parse(reset) : Number.NaN;
  return {
    ...emptyQuota("github-copilot"),
    windows: [{
      label: payload.token_based_billing === true ? "credits" : "premium",
      remainingPercent: percent === null || unlimited ? null : Math.max(0, Math.min(100, percent)),
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
      unlimited,
    }],
  };
}

/** The ChatGPT-authenticated Codex client's primary and secondary windows. */
export function parseCodexQuota(payload: unknown): QuotaInfo | null {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return null;
  const windows: QuotaWindow[] = [];
  for (const [key, fallback] of [["primary_window", "primary"], ["secondary_window", "secondary"]] as const) {
    const window = payload.rate_limit[key];
    if (!isRecord(window)) continue;
    const used = num(window.used_percent);
    if (used === null || used < 0) continue;
    const seconds = num(window.limit_window_seconds);
    const label = seconds !== null && seconds > 0 && seconds % 86400 === 0 ? `${seconds / 86400}d` :
      seconds !== null && seconds > 0 && seconds % 3600 === 0 ? `${seconds / 3600}h` : fallback;
    const epoch = num(window.reset_at);
    const resetAt = epoch === null ? Number.NaN : epoch * 1000;
    windows.push({ label, remainingPercent: Math.max(0, Math.min(100, 100 - used)),
      resetAt: Number.isFinite(new Date(resetAt).getTime()) ? resetAt : null, unlimited: false });
  }
  return windows.length > 0 ? { ...emptyQuota("openai-codex"), windows } : null;
}

function codexAccountId(accessToken: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (!isRecord(payload) || !isRecord(payload["https://api.openai.com/auth"])) return undefined;
    const account = payload["https://api.openai.com/auth"].chatgpt_account_id;
    return typeof account === "string" && account.length > 0 && !/[\r\n]/.test(account) ? account : undefined;
  } catch {
    return undefined;
  }
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
    id: "github-copilot",
    displayName: "GitHub Copilot",
    url: "https://api.github.com/copilot_internal/user",
    allowlist: ["api.github.com"],
    parse: parseCopilotQuota,
  },
  {
    id: "openai-codex",
    displayName: "Codex",
    url: "https://chatgpt.com/backend-api/wham/usage",
    allowlist: ["chatgpt.com"],
    parse: parseCodexQuota,
  },
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

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" };
  if (provider.id === "github-copilot") {
    headers["X-GitHub-Api-Version"] = "2022-11-28";
    headers["User-Agent"] = "pify-usage";
  }
  if (provider.id === "openai-codex") {
    const accountId = codexAccountId(apiKey.trim());
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  }
  const result: HttpResult<unknown> = await controlledGetJson({
    url: provider.url,
    headers,
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
  for (const window of q.windows ?? []) {
    const remaining = windowRemaining(window);
    lines.push(`  ${window.label}  ${remaining}${window.resetAt === null ? "" : ` · resets ${new Date(window.resetAt).toISOString()}`}`);
  }
  if (q.freeTier) lines.push("  tier     free");
  return lines.join("\n");
}

function windowRemaining(window: QuotaWindow): string {
  return window.unlimited ? "unlimited" : window.remainingPercent === null ? "unknown" : `${Math.round(window.remainingPercent)}% left`;
}

/** Cached subscription data never masquerades as a live counter. No network here. */
export function quotaFooter(result: QuotaResult | undefined, fetchedAt: number, now = Date.now()): string {
  if (!result) return "";
  const id = result.ok ? result.quota.provider : result.provider;
  const name = id === "github-copilot" ? "Copilot" : id === "openai-codex" ? "Codex" : null;
  if (!name) return "";
  if (!result.ok) return `${name} quota unavailable`;
  const windows = result.quota.windows;
  if (!windows?.length) return "";
  if (now - fetchedAt >= 15 * 60 * 1000 || windows.some(w => w.resetAt !== null && now >= w.resetAt)) {
    return `${name} quota stale · /pify-usage quota`;
  }
  const parts = windows.map(w => `${w.label} ${windowRemaining(w)}`);
  return `${name} ${parts.join(" · ")} · cached`;
}

/** What `/usage quota` prints: every provider that has suitable credentials. */
export function quotaReport(results: QuotaResult[]): string {
  if (results.length === 0) {
    return [
      "No provider with a quota endpoint is configured.",
      `Supported: ${QUOTA_PROVIDERS.map((p) => p.displayName).join(", ")}.`,
      "Balances use documented endpoints and API keys. Copilot and Codex use published client endpoints and require Pi OAuth login; their contracts may change. Quota requests are opt-in, with no background polling. Rate-limit headers are read passively from ordinary responses — shown above when the session has made a call.",
    ].join("\n");
  }
  return results.map(quotaBlock).join("\n\n");
}
