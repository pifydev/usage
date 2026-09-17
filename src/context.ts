/**
 * Where the context window actually went (the idea, and the accounting
 * discipline, are from minuque/pi-cc-extensions' /context).
 *
 * The rest of this package answers "what have I spent". This answers the
 * other question you have at 60% context: "spent on WHAT". Both are computed
 * from what pi already has in memory — no network, no model call — so the
 * numbers are estimates (chars/4, the same estimate pi uses for compaction),
 * not provider billing.
 *
 * Two rules keep the estimate honest:
 *  - context files and skills are counted only when their text is actually
 *    embedded in the assembled system prompt, so a file that was loaded but
 *    not injected does not appear twice;
 *  - the system-prompt row is the remainder after those are subtracted, so
 *    the parts sum to the whole instead of overlapping.
 */

export interface ContextPart {
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  parts: ContextPart[];
  /** Sum of every attributed part. */
  attributed: number;
  contextWindow: number;
  /** Tokens pi holds back for auto-compaction; free space excludes them. */
  reserveTokens: number;
}

/** pi's own compaction estimate: four characters per token. */
export function estimateTextTokens(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(0, Math.ceil(text.length / 4));
}

function nonNegNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The context size pi itself derives from a usage block — its own
 * calculateContextTokens: `totalTokens` when present, else the sum of input +
 * output + cacheRead + cacheWrite. Kept identical here so the footer gauge and
 * /context agree with pi's reading; the earlier input+cacheRead formula dropped
 * cacheWrite and output, which on Anthropic prompt caching are a real slice of
 * every turn, leaving the gauge systematically low.
 */
export function contextTokensFromUsage(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  const total = nonNegNumber(usage.totalTokens);
  if (total > 0) return total;
  return (
    nonNegNumber(usage.input) +
    nonNegNumber(usage.output) +
    nonNegNumber(usage.cacheRead) +
    nonNegNumber(usage.cacheWrite)
  );
}

/** pi's fixed per-image charge; a base64 blob is never billed as its bytes. */
const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * Character count of message content the way pi's compaction estimator counts
 * it (estimateTextAndImageContentChars): a string is its own length; a content
 * array charges each text block's text and a flat 4800 chars per image block,
 * ignoring every other field. Without this, JSON.stringify would bill an
 * ImageContent block's base64 `data` at chars/4 — one screenshot then reads as
 * hundreds of k tokens and pins /context at 100%.
 */
export function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** contentChars in tokens (chars/4), matching pi's estimateTokens. */
function contentTokens(content: unknown): number {
  return Math.ceil(contentChars(content) / 4);
}

/** Count a chunk only when the assembled prompt really contains it. */
export function embeddedTokens(systemPrompt: string, chunk: string): number {
  if (!chunk || !systemPrompt.includes(chunk)) return 0;
  return estimateTextTokens(chunk);
}

export interface BreakdownInput {
  systemPrompt: string;
  /** Context files (AGENTS.md, CLAUDE.md, …) pi loaded for the prompt. */
  contextFiles: Array<{ path?: string; content?: string }>;
  /** Skills text as pi formats it into the prompt. */
  skillsText: string;
  /** Definitions of the tools actually enabled this turn. */
  tools: Array<{ name?: string; description?: string; parameters?: unknown }>;
  /** Entries pi would send as conversation this turn. */
  entries: unknown[];
  contextWindow: number;
  /** Tokens pi reserves for auto-compaction (0 when compaction is off). */
  reserveTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Split the conversation into what the agent said and what tools returned.
 * Tool results are the part that grows without anyone deciding it should,
 * which is exactly why they deserve their own row.
 */
function foldEntries(entries: unknown[]): { conversation: number; toolResults: number; thinking: number } {
  let conversation = 0;
  let toolResults = 0;
  let thinking = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const message = isRecord(entry.message) ? entry.message : entry;
    const role = typeof message.role === "string" ? message.role : null;

    if (role === "toolResult" || role === "bashExecution") {
      // Tool results carry image blocks (pi's read tool returns them); charge
      // those at pi's flat rate rather than the base64 bytes' chars/4.
      const content = message.content ?? message.output;
      toolResults += content === undefined ? estimateTextTokens(message) : contentTokens(content);
      continue;
    }
    if (role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (!isRecord(block)) continue;
        if (block.type === "toolCall") {
          conversation += estimateTextTokens(block.name) + estimateTextTokens(block.arguments);
        } else if (block.type === "text") {
          conversation += estimateTextTokens(block.text);
        } else if (block.type === "thinking") {
          // Reasoning tokens are their own line — on keep-thinking models they
          // are a large, invisible share otherwise buried in "Conversation".
          // The opaque signature bytes are deliberately never counted or kept.
          thinking += estimateTextTokens(block.thinking);
        }
      }
      continue;
    }
    if (typeof entry.summary === "string") {
      conversation += estimateTextTokens(entry.summary);
      continue;
    }
    if (typeof entry.content === "string" || Array.isArray(entry.content)) {
      // A raw user message; its content may hold a pasted screenshot.
      conversation += contentTokens(entry.content);
      continue;
    }
    if (role) {
      conversation +=
        message.content === undefined ? estimateTextTokens(message) : contentTokens(message.content);
    }
  }

  return { conversation, toolResults, thinking };
}

export function buildBreakdown(input: BreakdownInput): ContextBreakdown {
  const memory = input.contextFiles.reduce(
    (sum, file) => sum + embeddedTokens(input.systemPrompt, file.content ?? ""),
    0,
  );
  const skills = embeddedTokens(input.systemPrompt, input.skillsText.trim());
  const tools = input.tools.reduce(
    (sum, tool) =>
      sum +
      estimateTextTokens({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }),
    0,
  );
  const { conversation, toolResults, thinking } = foldEntries(input.entries);
  // Memory and skills live inside the prompt; subtract so rows do not overlap.
  const system = Math.max(0, estimateTextTokens(input.systemPrompt) - memory - skills);

  const parts: ContextPart[] = [
    { label: "System prompt", tokens: system },
    { label: "Context files", tokens: memory },
    { label: "Skills", tokens: skills },
    { label: "Tool definitions", tokens: tools },
    { label: "Tool results", tokens: toolResults },
    { label: "Thinking", tokens: thinking },
    { label: "Conversation", tokens: conversation },
  ];

  return {
    parts,
    attributed: parts.reduce((sum, part) => sum + part.tokens, 0),
    contextWindow: Math.max(0, input.contextWindow),
    reserveTokens: Math.max(0, input.reserveTokens ?? 0),
  };
}

export interface UsedTokensInput {
  /** pi's own estimate of context tokens (getContextUsage().tokens), or null. */
  hostTokens: number | null;
  /** pi's own percent-of-window (getContextUsage().percent), or null. */
  hostPercent: number | null;
  /** The context window; 0 when unknown. */
  window: number;
  /**
   * The provider's report for the last request, via pi's own
   * calculateContextTokens (totalTokens, or input+output+cacheRead+cacheWrite),
   * or null.
   */
  providerTokens: number | null;
  /** A local content estimate (a hard lower bound), when one is available. */
  estimate?: number;
}

/**
 * Reconcile the several "how full is the window" signals into one used-tokens
 * figure, so the gauge does not blindly trust a provider number that some
 * backends report wrong (cumulative totals, cache-inflated counts, or an
 * implausibly small figure). The rule — from minuque/pi-cc-extensions'
 * resolveUsedTokens:
 *
 *  - the provider's report is the primary signal (it is the real last request),
 *  - but when it diverges beyond tolerance from pi's own percent×window reading
 *    (what pi itself uses for the gauge and for compaction), trust pi's number,
 *  - and never report fewer tokens than the content visibly in context.
 *
 * Returns null only when nothing is known (so the gauge can hide itself).
 */
export function resolveUsedTokens(input: UsedTokensInput): number | null {
  const w = input.window > 0 ? input.window : 0;
  const fromPercent = input.hostPercent !== null && w > 0 ? (input.hostPercent / 100) * w : null;
  const host = input.hostTokens !== null ? input.hostTokens : fromPercent;
  const provider = input.providerTokens !== null && input.providerTokens > 0 ? input.providerTokens : null;
  const estimate = typeof input.estimate === "number" && input.estimate > 0 ? input.estimate : null;

  let used = provider ?? host ?? estimate;
  if (used === null || used === undefined) return null;

  // Trust pi's own reading when the provider's number diverges beyond tolerance
  // (25% of the host reading, or 2k tokens, whichever is larger).
  if (provider !== null && host !== null) {
    const tolerance = Math.max(2000, host * 0.25);
    if (Math.abs(provider - host) > tolerance) used = host;
  }

  // A content estimate is a hard floor: you cannot be using fewer tokens than
  // the text that is demonstrably in context.
  if (estimate !== null && estimate > used) used = estimate;

  if (w > 0) used = Math.min(used, w);
  return Math.max(0, Math.round(used));
}

const BAR_WIDTH = 28;

function bar(fraction: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(fraction * BAR_WIDTH)));
  return `${"█".repeat(filled)}${"·".repeat(BAR_WIDTH - filled)}`;
}

function pct(tokens: number, total: number): string {
  if (total <= 0) return "  — ";
  const value = (tokens / total) * 100;
  if (value > 0 && value < 0.5) return " <1%";
  return `${Math.round(value).toString().padStart(3)}%`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Render the breakdown. `reportedUsed` is the provider's own number for the
 * last request when pi has one: it is authoritative, so anything it counts
 * that the parts do not is shown as "Other" rather than silently dropped.
 */
export function formatBreakdown(breakdown: ContextBreakdown, reportedUsed: number | null): string {
  const window = breakdown.contextWindow;
  // Clamp to the window so a stale or odd figure can never print above 100%
  // (resolveUsedTokens already clamps its own result, but `attributed` does not).
  const raw = Math.max(reportedUsed ?? 0, breakdown.attributed);
  const used = window > 0 ? Math.min(window, raw) : raw;
  const other = Math.max(0, used - breakdown.attributed);
  // pi holds back a reserve for auto-compaction; real headroom excludes it, so
  // show it as its own row and subtract it from free space rather than letting
  // "Free space" overstate what you can actually use before compaction fires.
  const reserve = window > 0 ? Math.min(breakdown.reserveTokens, Math.max(0, window - used)) : 0;
  const free = window > 0 ? Math.max(0, window - used - reserve) : 0;

  const rows = [...breakdown.parts];
  if (other > 0) rows.push({ label: "Other", tokens: other });
  if (reserve > 0) rows.push({ label: "Compaction reserve", tokens: reserve });
  if (window > 0) rows.push({ label: "Free space", tokens: free });

  const width = rows.reduce((m, row) => Math.max(m, row.label.length), 0);
  const denominator = window > 0 ? window : used;

  const lines = [
    window > 0
      ? `Context window: ${formatTokens(used)} of ${formatTokens(window)} used (${pct(used, window).trim()})`
      : `Context: ${formatTokens(used)} used (no window reported)`,
  ];
  for (const row of rows) {
    if (row.tokens === 0 && row.label !== "Free space") continue;
    lines.push(
      `  ${row.label.padEnd(width)}  ${bar(denominator > 0 ? row.tokens / denominator : 0)} ${pct(row.tokens, denominator)}  ${formatTokens(row.tokens)}`,
    );
  }
  lines.push("Estimated locally (≈4 chars/token); provider billing may differ.");
  return lines.join("\n");
}
