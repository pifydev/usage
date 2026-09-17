import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBreakdown,
  contentChars,
  contextTokensFromUsage,
  embeddedTokens,
  estimateTextTokens,
  formatBreakdown,
  resolveUsedTokens,
} from "../src/context.ts";

const AGENTS_MD = "Always run bun test before committing. ".repeat(20);
const SKILLS = "## Skill: deploy\nRun the deploy script.";
const SYSTEM = `You are a coding assistant.\n\n${AGENTS_MD}\n\n${SKILLS}\n\nBe concise.`;

function input(overrides: Partial<Parameters<typeof buildBreakdown>[0]> = {}) {
  return buildBreakdown({
    systemPrompt: SYSTEM,
    contextFiles: [{ path: "AGENTS.md", content: AGENTS_MD }],
    skillsText: SKILLS,
    tools: [{ name: "read", description: "Read a file", parameters: { path: "string" } }],
    entries: [],
    contextWindow: 200_000,
    ...overrides,
  });
}

test("thinking blocks get their own row, not folded into conversation", () => {
  const entries = [
    {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x".repeat(4000) }, // ~1000 tok
          { type: "text", text: "y".repeat(400) }, // ~100 tok
        ],
      },
    },
  ];
  const byLabel = new Map(input({ entries }).parts.map((p) => [p.label, p.tokens]));
  assert.equal(byLabel.get("Thinking"), 1000);
  assert.equal(byLabel.get("Conversation"), 100, "thinking is not double-counted into conversation");
});

test("the compaction reserve is its own row and is carved out of free space", () => {
  const withReserve = formatBreakdown(input({ reserveTokens: 20_000 }), 50_000);
  assert.match(withReserve, /Compaction reserve/);
  // Free space = window - used - reserve. used=50k, reserve=20k, window=200k → 130k free.
  assert.match(withReserve, /Free space[^\n]*130\.0k/);
  // Without a reserve there is no such row.
  assert.ok(!formatBreakdown(input({ reserveTokens: 0 }), 50_000).includes("Compaction reserve"));
});

test("estimateTextTokens follows pi's four-chars-per-token estimate", () => {
  assert.equal(estimateTextTokens("a".repeat(400)), 100);
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens(null), 0);
  assert.equal(estimateTextTokens(undefined), 0);
  // objects are measured as the JSON that goes over the wire
  assert.equal(estimateTextTokens({ a: 1 }), Math.ceil(JSON.stringify({ a: 1 }).length / 4));
});

test("embedded chunks count only when the prompt really carries them", () => {
  assert.ok(embeddedTokens(SYSTEM, AGENTS_MD) > 0);
  assert.equal(embeddedTokens(SYSTEM, "a file that was never injected"), 0);
  assert.equal(embeddedTokens(SYSTEM, ""), 0);
});

test("the rows do not overlap: system prompt is the remainder", () => {
  const breakdown = input();
  const byLabel = new Map(breakdown.parts.map((p) => [p.label, p.tokens]));
  const system = byLabel.get("System prompt")!;
  const memory = byLabel.get("Context files")!;
  const skills = byLabel.get("Skills")!;

  assert.ok(memory > 0, "AGENTS.md is embedded, so it should be counted");
  assert.ok(skills > 0);
  // system + memory + skills reconstructs the whole prompt, not more
  assert.equal(system + memory + skills, estimateTextTokens(SYSTEM));
});

test("a context file that was loaded but not injected is not charged twice", () => {
  const breakdown = input({
    contextFiles: [
      { path: "AGENTS.md", content: AGENTS_MD },
      { path: "NOTES.md", content: "never made it into the prompt" },
    ],
  });
  const memory = breakdown.parts.find((p) => p.label === "Context files")!.tokens;
  assert.equal(memory, estimateTextTokens(AGENTS_MD));
});

test("tool definitions are measured, and only the enabled ones are passed in", () => {
  const one = input().parts.find((p) => p.label === "Tool definitions")!.tokens;
  const three = input({
    tools: [
      { name: "read", description: "Read a file", parameters: { path: "string" } },
      { name: "bash", description: "Run a command", parameters: { command: "string" } },
      { name: "edit", description: "Edit a file", parameters: { path: "string" } },
    ],
  }).parts.find((p) => p.label === "Tool definitions")!.tokens;
  assert.ok(three > one * 2, `${three} should dwarf ${one}`);
});

test("tool results are split from the conversation", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "please read the file" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should read it" },
          { type: "text", text: "Reading now." },
          { type: "toolCall", name: "read", arguments: { path: "src/app.ts" } },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", toolName: "read", content: "x".repeat(4000) } },
    { type: "message", message: { role: "bashExecution", command: "bun test", output: "y".repeat(400) } },
  ];
  const breakdown = input({ entries });
  const results = breakdown.parts.find((p) => p.label === "Tool results")!.tokens;
  const conversation = breakdown.parts.find((p) => p.label === "Conversation")!.tokens;

  assert.equal(results, 1000 + 100, "4000 + 400 chars of output");
  assert.ok(conversation > 0);
  assert.ok(results > conversation, "the file dump should dominate, which is the point of the split");
});

test("compaction and custom entries land in the conversation row", () => {
  const breakdown = input({
    entries: [
      { type: "compaction", summary: "z".repeat(800) },
      { type: "custom_message", customType: "memory-context", content: "w".repeat(400) },
    ],
  });
  assert.equal(breakdown.parts.find((p) => p.label === "Conversation")!.tokens, 200 + 100);
});

test("junk entries are skipped rather than throwing", () => {
  const breakdown = input({ entries: [null, "nonsense", 42, {}, { message: null }] as unknown[] });
  assert.equal(breakdown.parts.find((p) => p.label === "Conversation")!.tokens, 0);
});

test("the report shows the window, the rows, and what it cannot attribute", () => {
  const breakdown = input({ entries: [] });
  // the provider says more was used than we could attribute
  const text = formatBreakdown(breakdown, breakdown.attributed + 5_000);
  assert.match(text, /Context window: .* of 200\.0k used/);
  assert.match(text, /System prompt/);
  assert.match(text, /Other/, "unattributed tokens must be visible, not dropped");
  assert.match(text, /Free space/);
  assert.match(text, /Estimated locally/);

  // zero rows are hidden, so an empty session is not a wall of zeroes
  assert.ok(!/Tool results/.test(text));
});

test("the report degrades when no window is known", () => {
  const text = formatBreakdown(input({ contextWindow: 0 }), null);
  assert.match(text, /no window reported/);
  assert.ok(!/Free space/.test(text));
});

test("a provider number below our estimate never shrinks the rows", () => {
  const breakdown = input();
  const text = formatBreakdown(breakdown, 1);
  // used is the max of the two, so percentages stay sane
  assert.ok(!/-\d/.test(text), "no negative values");
  assert.ok(!/Other/.test(text));
});

test("contextTokensFromUsage matches pi's calculateContextTokens (cacheWrite + output counted)", () => {
  // An Anthropic prompt-cached turn: cacheWrite and output are a real slice of
  // the prompt. The old input+cacheRead formula would report 80,500.
  const usage = { input: 500, output: 1000, cacheRead: 80_000, cacheWrite: 20_000, totalTokens: 101_500 };
  assert.equal(contextTokensFromUsage(usage), 101_500);
  // No totalTokens → sum of the four components, not input+cacheRead.
  assert.equal(contextTokensFromUsage({ input: 500, output: 1000, cacheRead: 80_000, cacheWrite: 20_000 }), 101_500);
  // totalTokens of 0 is falsy, so it falls back to the sum (matching pi's `||`).
  assert.equal(contextTokensFromUsage({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }), 6);
  // Negative/NaN/missing fields clamp to 0 rather than poisoning the sum.
  assert.equal(contextTokensFromUsage({ input: 5, output: -3, cacheRead: Number.NaN }), 5);
  assert.equal(contextTokensFromUsage(null), 0);
  assert.equal(contextTokensFromUsage("nonsense"), 0);
});

test("a base64 image in a tool result is charged at pi's flat rate, not its bytes", () => {
  // pi's read tool returns image blocks; the base64 `data` must not be billed
  // as chars/4, or one screenshot reads as ~200k tokens and pins /context.
  const image = { type: "image", data: "A".repeat(800_000), mimeType: "image/png" };
  const entries = [
    { type: "message", message: { role: "toolResult", toolName: "read", content: [image] } },
  ];
  const breakdown = input({ entries });
  const toolResults = breakdown.parts.find((p) => p.label === "Tool results")!.tokens;
  // 4800 chars / 4 = 1200 tokens, regardless of the 800k base64 bytes.
  assert.equal(toolResults, 1200);
  // contentChars mirrors pi: string length, text-block text, 4800 per image.
  assert.equal(contentChars("hello"), 5);
  assert.equal(contentChars([{ type: "text", text: "hi" }, image]), 2 + 4800);
});

test("a pasted screenshot in a user message is charged flat too", () => {
  const image = { type: "image", data: "B".repeat(400_000), mimeType: "image/png" };
  // Both the wrapped-entry path and the raw-message path carry user content.
  const wrapped = input({
    entries: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "look" }, image] } }],
  });
  const raw = input({ entries: [{ role: "user", content: [{ type: "text", text: "look" }, image] }] });
  const conv = (b: ReturnType<typeof input>) => b.parts.find((p) => p.label === "Conversation")!.tokens;
  // ceil((4 + 4800) / 4) = 1201 in both cases, never the 100k of base64.
  assert.equal(conv(wrapped), 1201);
  assert.equal(conv(raw), 1201);
});

test("the report never prints above 100% even if a part overflows the window", () => {
  // A pathological attributed total larger than the window (e.g. a stale scan)
  // must clamp the header, not read as 115%.
  const breakdown = input({ contextWindow: 10_000 });
  const text = formatBreakdown(breakdown, 50_000);
  assert.match(text, /of 10\.0k used \(100%\)/);
  assert.match(text, /Free space[^\n]*\b0\b/);
  assert.ok(!/(1[1-9]\d|[2-9]\d\d)%/.test(text), "no figure above 100%");
});

test("post-compaction contract: with no host and no provider signal, the estimate drives the figure", () => {
  // Right after /compact the extension clears lastPromptTokens and pi returns
  // null tokens; the local estimate is all that is left, and it must win alone
  // (no stale pre-compaction 'Other' row).
  assert.equal(
    resolveUsedTokens({ hostTokens: null, hostPercent: null, window: 200_000, providerTokens: null, estimate: 25_000 }),
    25_000,
  );
});

test("resolveUsedTokens takes the provider report when it agrees with pi", () => {
  const used = resolveUsedTokens({
    hostTokens: 120_000,
    hostPercent: 60,
    window: 200_000,
    providerTokens: 122_000,
  });
  assert.equal(used, 122_000); // within tolerance → the more precise provider number
});

test("resolveUsedTokens trusts pi's reading when the provider diverges wildly", () => {
  // A provider that reports a cumulative/inflated 900k against a 200k window
  // where pi says 60% → trust 60% × 200k = 120k, and clamp to the window.
  const used = resolveUsedTokens({
    hostTokens: null,
    hostPercent: 60,
    window: 200_000,
    providerTokens: 900_000,
  });
  assert.equal(used, 120_000);
});

test("resolveUsedTokens falls back to the provider when pi has no reading", () => {
  assert.equal(
    resolveUsedTokens({ hostTokens: null, hostPercent: null, window: 200_000, providerTokens: 80_000 }),
    80_000,
  );
});

test("resolveUsedTokens floors by the content estimate (never below visible content)", () => {
  // Provider under-reports 5k but we can see ~90k of content → report 90k.
  const used = resolveUsedTokens({
    hostTokens: null,
    hostPercent: null,
    window: 200_000,
    providerTokens: 5_000,
    estimate: 90_000,
  });
  assert.equal(used, 90_000);
});

test("resolveUsedTokens clamps to the window and returns null when nothing is known", () => {
  assert.equal(
    resolveUsedTokens({ hostTokens: 250_000, hostPercent: null, window: 200_000, providerTokens: null }),
    200_000,
  );
  assert.equal(
    resolveUsedTokens({ hostTokens: null, hostPercent: null, window: 0, providerTokens: null }),
    null,
  );
});
