/**
 * Rate-limit quota from the headers the provider already sent.
 *
 * The polling path in quota.ts asks OpenRouter and DeepSeek what a key has
 * spent, over an extra credentialed GET, and tells the user OpenAI/Anthropic/
 * Gemini "publish none". That last part is only true of the *balance* APIs.
 * Every one of them returns rate-limit headers on the ordinary completion
 * response, and pi hands extensions the full header set of every provider call
 * through `after_provider_response` — status + headers, emitted before the
 * stream is read, free when nobody subscribes. So this is per-request quota
 * with zero extra network calls and zero credentials to handle.
 *
 * Pure: the extension captures the latest snapshot per provider and this turns
 * one header bag into it. Unknown providers and empty bags return null, so a
 * response that carries nothing simply leaves the last snapshot untouched.
 */

export interface RateLimitSnapshot {
  provider: string;
  /** Requests left in the current window, when the provider reports it. */
  requestsRemaining: number | null;
  /** Tokens left in the current window, when reported. */
  tokensRemaining: number | null;
  /** When the window resets — provider's own string (seconds, ISO, or duration). */
  resets: string | null;
  /** A unified subscription-window fraction 0..1 remaining, Anthropic OAuth only. */
  unifiedRemaining: number | null;
  /** Which header family this came from, for the report line. */
  source: "anthropic" | "openai" | "openrouter";
  capturedAtMs: number;
}

function intOf(headers: Record<string, string>, key: string): number | null {
  const raw = headers[key] ?? headers[key.toLowerCase()];
  if (raw === undefined) return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function strOf(headers: Record<string, string>, key: string): string | null {
  const raw = headers[key] ?? headers[key.toLowerCase()];
  return raw === undefined || raw === "" ? null : String(raw);
}

/**
 * Parse a header bag for a given provider id. `nowMs` is passed in rather than
 * read from the clock, so this stays pure and testable.
 */
export function parseRateLimit(
  provider: string,
  headers: Record<string, string>,
  nowMs: number,
): RateLimitSnapshot | null {
  // Header keys can arrive in any case; normalise once so lookups are stable.
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = v;

  const family = provider.includes("anthropic")
    ? "anthropic"
    : provider.includes("openrouter")
      ? "openrouter"
      : provider.includes("openai") || provider.includes("azure")
        ? "openai"
        : null;
  if (!family) return null;

  let snap: RateLimitSnapshot | null = null;

  if (family === "anthropic") {
    const reqs = intOf(h, "anthropic-ratelimit-requests-remaining");
    const toks = intOf(h, "anthropic-ratelimit-tokens-remaining");
    // The OAuth Pro/Max unified subscription window, reported as a percentage.
    const unifiedRaw = strOf(h, "anthropic-ratelimit-unified-status")
      ? intOf(h, "anthropic-ratelimit-unified-remaining")
      : intOf(h, "anthropic-ratelimit-unified-remaining");
    if (reqs !== null || toks !== null || unifiedRaw !== null) {
      snap = {
        provider,
        requestsRemaining: reqs,
        tokensRemaining: toks,
        resets:
          strOf(h, "anthropic-ratelimit-unified-reset") ??
          strOf(h, "anthropic-ratelimit-tokens-reset") ??
          strOf(h, "anthropic-ratelimit-requests-reset"),
        unifiedRemaining: unifiedRaw === null ? null : Math.max(0, Math.min(1, unifiedRaw / 100)),
        source: "anthropic",
        capturedAtMs: nowMs,
      };
    }
  } else if (family === "openai") {
    const reqs = intOf(h, "x-ratelimit-remaining-requests");
    const toks = intOf(h, "x-ratelimit-remaining-tokens");
    if (reqs !== null || toks !== null) {
      snap = {
        provider,
        requestsRemaining: reqs,
        tokensRemaining: toks,
        resets: strOf(h, "x-ratelimit-reset-tokens") ?? strOf(h, "x-ratelimit-reset-requests"),
        unifiedRemaining: null,
        source: "openai",
        capturedAtMs: nowMs,
      };
    }
  } else {
    // openrouter: a single credit window on the completion response.
    const remaining = intOf(h, "x-ratelimit-remaining");
    if (remaining !== null) {
      snap = {
        provider,
        requestsRemaining: remaining,
        tokensRemaining: null,
        resets: strOf(h, "x-ratelimit-reset"),
        unifiedRemaining: null,
        source: "openrouter",
        capturedAtMs: nowMs,
      };
    }
  }

  return snap;
}

/** One human line for the /usage quota report; null when nothing was captured. */
export function formatRateLimit(snap: RateLimitSnapshot | null): string | null {
  if (!snap) return null;
  const parts: string[] = [];
  if (snap.unifiedRemaining !== null) parts.push(`${Math.round(snap.unifiedRemaining * 100)}% of subscription window left`);
  if (snap.requestsRemaining !== null) parts.push(`${snap.requestsRemaining} requests left`);
  if (snap.tokensRemaining !== null) parts.push(`${snap.tokensRemaining} tokens left`);
  if (parts.length === 0) return null;
  const when = snap.resets ? `, resets ${snap.resets}` : "";
  return `${snap.provider}: ${parts.join(", ")}${when} (from response headers)`;
}
