/**
 * Noticing when the prompt cache stops working.
 *
 * A session that enjoyed a warm prefix cache can lose it mid-way — a model
 * switch, a provider dropping its cached KV, a context edit that rewrote
 * the prefix — and from then on every turn re-bills the whole prompt cold.
 * The footer shows the spend climbing; nothing names the cause. This is a
 * small state machine fed with each assistant message's usage: once the
 * session has shown a healthy hit rate on a large prompt, a run of large
 * prompts at ~0% hit trips one warning, and only one. Pure; the extension
 * feeds it and resets it at session start. (billion-context's cache-warn,
 * reduced to the in-process case — a restart is a new session here.)
 */

export const MIN_PROMPT_TOKENS = 8_000;
export const HEALTHY_HIT = 0.5;
export const COLLAPSED_HIT = 0.05;
export const LOW_RUN = 5;

export interface CacheHealthState {
  sawHealthy: boolean;
  lowRun: number;
  warned: boolean;
  lastHealthyHit: number;
}

export function emptyCacheHealth(): CacheHealthState {
  return { sawHealthy: false, lowRun: 0, warned: false, lastHealthyHit: 0 };
}

export interface PromptUsageLike {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The share of the prompt that came from the cache; null when the prompt is too small to judge. */
export function cacheHit(usage: PromptUsageLike): number | null {
  const input = Math.max(0, usage.input ?? 0);
  const read = Math.max(0, usage.cacheRead ?? 0);
  const write = Math.max(0, usage.cacheWrite ?? 0);
  const prompt = input + read + write;
  if (prompt < MIN_PROMPT_TOKENS) return null;
  return read / prompt;
}

/** Feed one assistant message; returns the warning text exactly once, when the collapse is confirmed. */
export function observeCacheHealth(state: CacheHealthState, usage: PromptUsageLike): string | null {
  const hit = cacheHit(usage);
  if (hit === null) return null;
  if (hit >= HEALTHY_HIT) {
    state.sawHealthy = true;
    state.lastHealthyHit = hit;
    state.lowRun = 0;
    return null;
  }
  if (!state.sawHealthy || hit > COLLAPSED_HIT) {
    state.lowRun = 0;
    return null;
  }
  state.lowRun++;
  if (state.lowRun < LOW_RUN || state.warned) return null;
  state.warned = true;
  return (
    `Prompt cache collapsed: ${LOW_RUN} large prompts in a row at ~${Math.round(hit * 100)}% cache hit after a healthy ` +
    `${Math.round(state.lastHealthyHit * 100)}%. Every turn is now re-billing the whole prefix. Likely causes: a model ` +
    `or thinking-level switch, a provider dropping its cache, or something rewriting the start of the context each turn.`
  );
}
