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
}

/** pi's own compaction estimate: four characters per token. */
export function estimateTextTokens(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(0, Math.ceil(text.length / 4));
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Split the conversation into what the agent said and what tools returned.
 * Tool results are the part that grows without anyone deciding it should,
 * which is exactly why they deserve their own row.
 */
function foldEntries(entries: unknown[]): { conversation: number; toolResults: number } {
  let conversation = 0;
  let toolResults = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const message = isRecord(entry.message) ? entry.message : entry;
    const role = typeof message.role === "string" ? message.role : null;

    if (role === "toolResult" || role === "bashExecution") {
      toolResults += estimateTextTokens(message.content ?? message.output ?? message);
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
          conversation += estimateTextTokens(block.thinking);
        }
      }
      continue;
    }
    if (typeof entry.summary === "string") {
      conversation += estimateTextTokens(entry.summary);
      continue;
    }
    if (typeof entry.content === "string" || Array.isArray(entry.content)) {
      conversation += estimateTextTokens(entry.content);
      continue;
    }
    if (role) conversation += estimateTextTokens(message.content ?? message);
  }

  return { conversation, toolResults };
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
  const { conversation, toolResults } = foldEntries(input.entries);
  // Memory and skills live inside the prompt; subtract so rows do not overlap.
  const system = Math.max(0, estimateTextTokens(input.systemPrompt) - memory - skills);

  const parts: ContextPart[] = [
    { label: "System prompt", tokens: system },
    { label: "Context files", tokens: memory },
    { label: "Skills", tokens: skills },
    { label: "Tool definitions", tokens: tools },
    { label: "Tool results", tokens: toolResults },
    { label: "Conversation", tokens: conversation },
  ];

  return {
    parts,
    attributed: parts.reduce((sum, part) => sum + part.tokens, 0),
    contextWindow: Math.max(0, input.contextWindow),
  };
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
  const used = Math.max(reportedUsed ?? 0, breakdown.attributed);
  const other = Math.max(0, used - breakdown.attributed);
  const free = window > 0 ? Math.max(0, window - used) : 0;

  const rows = [...breakdown.parts];
  if (other > 0) rows.push({ label: "Other", tokens: other });
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
