import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBreakdown,
  embeddedTokens,
  estimateTextTokens,
  formatBreakdown,
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
