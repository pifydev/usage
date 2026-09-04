/**
 * @pify/usage — token and cost reporting for pi sessions.
 *
 * Live session tracking in the footer (📊 12.3k tok · $0.45, folded from
 * each message's usage.cost that pi already computes) and a /usage dashboard
 * combining the current session with local history aggregated from pi's
 * session JSONL files — zero network calls, zero LLM tokens spent
 * (aporcelli's principle). History counts every usage-bearing entry
 * (assistant turns plus pi 0.81+'s persisted tool-result/compaction usage,
 * tmustier's lesson) with a per-file mtime cache. The usage_status tool
 * lets the agent itself check consumption mid-session.
 *
 * Provider quota APIs (Codex windows, Copilot, OpenRouter…) are deliberately
 * v0.2 — @narumitw/pi-usage shows they cost ~18k lines of per-provider
 * contract maintenance.
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";

import { addRecord, aggregate, recordFromEntry, windowTotals } from "../src/aggregate.ts";
import { footerText, formatCost, formatTokens, historyBlock, sessionBlock } from "../src/format.ts";
import { scanSessions } from "../src/sessions.ts";
import { emptyTotals, isRecord, type UsageTotals } from "../src/types.ts";

type UiContext = ExtensionContext;

export default function usage(pi: ExtensionAPI) {
  let session: UsageTotals = emptyTotals();
  /** input+cacheRead of the most recent assistant message ≈ context size. */
  let lastPromptTokens = 0;

  function updateFooter(ctx: UiContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("usage", footerText(session));
  }

  function contextPct(ctx: UiContext): number | null {
    const window = (ctx.model as { contextWindow?: number } | null)?.contextWindow;
    if (!window || lastPromptTokens === 0) return null;
    return Math.min(100, (lastPromptTokens / window) * 100);
  }

  function dashboard(ctx: UiContext): string {
    const history = aggregate(...(() => {
      const scan = scanSessions(join(getAgentDir(), "sessions"));
      return [scan.records, scan.files] as const;
    })());
    return [sessionBlock(session, contextPct(ctx)), historyBlock(history, Date.now())].join("\n\n");
  }

  // ── Live tracking ────────────────────────────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    const record = recordFromEntry({ message: (event as { message?: unknown }).message });
    if (!record) return;
    addRecord(session, record);
    const message = (event as { message?: { role?: string; usage?: unknown } }).message;
    if (message?.role === "assistant" && isRecord(message.usage)) {
      const input = message.usage.input;
      const cacheRead = message.usage.cacheRead;
      lastPromptTokens =
        (typeof input === "number" ? input : 0) + (typeof cacheRead === "number" ? cacheRead : 0);
    }
    updateFooter(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    // Rebuild the session totals from the branch so /reload keeps the count.
    session = emptyTotals();
    lastPromptTokens = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      const record = recordFromEntry(entry);
      if (record) addRecord(session, record);
    }
    updateFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("usage", undefined);
  });

  // ── Command & tool ───────────────────────────────────────────────────

  pi.registerCommand("usage", {
    description: "Token and cost dashboard: current session + local history",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(dashboard(ctx), "info");
    },
  });

  pi.registerTool({
    name: "usage_status",
    label: "Usage status",
    description:
      "Current session token/cost totals plus today's local aggregate. Use when deciding whether " +
      "an expensive approach (large reads, many subagents) is proportionate.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const scan = scanSessions(join(getAgentDir(), "sessions"));
      const history = aggregate(scan.records, scan.files);
      const today = windowTotals(history.byDay, 1, Date.now());
      const text = [
        `Session: ${formatTokens(session.totalTokens)} tokens, ${formatCost(session.cost)} across ${session.messages} responses.`,
        `Today (all sessions): ${formatTokens(today.totalTokens)} tokens, ${formatCost(today.cost)}.`,
      ].join("\n");
      void ctx;
      return {
        content: [{ type: "text", text }],
        details: { session, today },
      };
    },
  });
}
