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
  /** Fraction 0..1 of the unified 5-hour subscription window still free (Anthropic OAuth). */
  unified5hRemaining: number | null;
  /** Fraction 0..1 of the unified 7-day subscription window still free (Anthropic OAuth). */
  unified7dRemaining: number | null;
  /** Which unified window Anthropic marks as binding, from -representative-claim. */
  unifiedBinding: "5h" | "7d" | null;
  /** Unified subscription status: "allowed" | "allowed_warning" | "rejected". */
  unifiedStatus: string | null;
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

/** A fraction 0..1 (Anthropic reports utilization as a decimal fraction USED). */
function fracOf(headers: Record<string, string>, key: string): number | null {
  const raw = headers[key] ?? headers[key.toLowerCase()];
  if (raw === undefined) return null;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
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
    // The OAuth Pro/Max unified subscription windows. Anthropic reports
    // UTILIZATION — the fraction USED, 0..1 — for a 5-hour and a 7-day window
    // (there is no "-remaining" header), plus which window is binding
    // (-representative-claim) and an overall status. Remaining = 1 − utilization.
    const util5h = fracOf(h, "anthropic-ratelimit-unified-5h-utilization");
    const util7d = fracOf(h, "anthropic-ratelimit-unified-7d-utilization");
    const claim = strOf(h, "anthropic-ratelimit-unified-representative-claim");
    const unifiedStatus = strOf(h, "anthropic-ratelimit-unified-status");
    const hasUnified = util5h !== null || util7d !== null || unifiedStatus !== null;
    if (reqs !== null || toks !== null || hasUnified) {
      snap = {
        provider,
        requestsRemaining: reqs,
        tokensRemaining: toks,
        resets:
          strOf(h, "anthropic-ratelimit-unified-reset") ??
          strOf(h, "anthropic-ratelimit-unified-5h-reset") ??
          strOf(h, "anthropic-ratelimit-unified-7d-reset") ??
          strOf(h, "anthropic-ratelimit-tokens-reset") ??
          strOf(h, "anthropic-ratelimit-requests-reset"),
        unified5hRemaining: util5h === null ? null : 1 - util5h,
        unified7dRemaining: util7d === null ? null : 1 - util7d,
        unifiedBinding: claim === "5h" || claim === "7d" ? claim : null,
        unifiedStatus,
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
        unified5hRemaining: null,
        unified7dRemaining: null,
        unifiedBinding: null,
        unifiedStatus: null,
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
        unified5hRemaining: null,
        unified7dRemaining: null,
        unifiedBinding: null,
        unifiedStatus: null,
        source: "openrouter",
        capturedAtMs: nowMs,
      };
    }
  }

  return snap;
}

/**
 * Anthropic's unified reset is epoch SECONDS; render it as a readable local
 * time. Other providers' values (ISO strings, "6s" durations, openrouter's
 * epoch millis) are left untouched, so this only reinterprets the anthropic
 * numeric case.
 */
function formatReset(snap: RateLimitSnapshot): string {
  const raw = snap.resets;
  if (!raw) return "";
  if (snap.source === "anthropic" && /^\d{9,}$/.test(raw)) {
    const d = new Date(Number.parseInt(raw, 10) * 1000);
    if (Number.isFinite(d.getTime())) return d.toLocaleString();
  }
  return raw;
}

/** One human line for the /usage quota report; null when nothing was captured. */
export function formatRateLimit(snap: RateLimitSnapshot | null): string | null {
  if (!snap) return null;
  const parts: string[] = [];
  // Surface the subscription status only when it is not the ordinary "allowed",
  // so a healthy window does not add noise but a warning/rejection is visible.
  if (snap.unifiedStatus && snap.unifiedStatus !== "allowed") {
    parts.push(`subscription ${snap.unifiedStatus.replace(/_/g, " ")}`);
  }
  if (snap.unified5hRemaining !== null) {
    parts.push(
      `${Math.round(snap.unified5hRemaining * 100)}% of 5h window left${snap.unifiedBinding === "5h" ? " (binding)" : ""}`,
    );
  }
  if (snap.unified7dRemaining !== null) {
    parts.push(
      `${Math.round(snap.unified7dRemaining * 100)}% of 7d window left${snap.unifiedBinding === "7d" ? " (binding)" : ""}`,
    );
  }
  if (snap.requestsRemaining !== null) parts.push(`${snap.requestsRemaining} requests left`);
  if (snap.tokensRemaining !== null) parts.push(`${snap.tokensRemaining} tokens left`);
  if (parts.length === 0) return null;
  const reset = formatReset(snap);
  const when = reset ? `, resets ${reset}` : "";
  return `${snap.provider}: ${parts.join(", ")}${when} (from response headers)`;
}
