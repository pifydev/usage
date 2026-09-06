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
 * Everything above is local: no network, no LLM tokens. The single exception
 * is /usage quota (v0.3), which asks OpenRouter what this key has spent —
 * opt-in per call, 8s timeout, and a failure prints as "unavailable" beside
 * the local numbers. Other providers stay out: @narumitw/pi-usage shows the
 * full set costs ~18k lines of per-provider contract chasing, and OpenRouter
 * is the one that reports a real balance rather than an opaque window.
 */
import {
  formatSkillsForPrompt,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { addRecord, aggregate, recordFromEntry, windowTotals } from "../src/aggregate.ts";
import { buildBreakdown, formatBreakdown } from "../src/context.ts";
import { footerText, formatCost, formatTokens, historyBlock, sessionBlock } from "../src/format.ts";
import { QUOTA_PROVIDERS, fetchQuota, quotaReport, type QuotaResult } from "../src/quota.ts";
import { redact } from "../src/redact.ts";
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

  /**
   * The key pi itself uses, read from the same auth.json — no second place to
   * configure credentials, and no key is ever printed.
   */
  /**
   * Ask pi for the key rather than reading auth.json. pi owns credential
   * storage — env precedence, OAuth, whatever it grows next — and parsing
   * that file here meant handling secrets this package has no business
   * touching, with a copy of pi's rules that would quietly go stale.
   */
  async function providerKey(ctx: UiContext, provider: string): Promise<string> {
    const registry = ctx.modelRegistry as unknown as {
      getApiKeyForProvider?: (id: string) => Promise<string | undefined>;
      getProviderAuth?: (id: string) => Promise<{ auth?: { apiKey?: string } } | undefined>;
    };
    try {
      const direct = await registry.getApiKeyForProvider?.(provider);
      if (direct) return direct;
      const auth = await registry.getProviderAuth?.(provider);
      if (auth?.auth?.apiKey) return auth.auth.apiKey;
    } catch {
      // an unconfigured provider is not an error here
    }
    return "";
  }

  /**
   * Where the context window went, computed from what pi already holds:
   * the assembled system prompt, the context files and skills embedded in
   * it, the enabled tool definitions, and the entries that would be sent.
   * No network, no model call — same rule as the rest of the package.
   */
  function contextBreakdown(ctx: UiContext): string {
    const host = ctx as unknown as {
      getSystemPrompt?: () => string;
      getSystemPromptOptions?: () => {
        contextFiles?: Array<{ path?: string; content?: string }>;
        skills?: unknown[];
        selectedTools?: string[];
      };
      getContextUsage?: () => { contextWindow?: number; used?: number; total?: number } | undefined;
      sessionManager?: { buildContextEntries?: () => unknown[]; getBranch?: () => unknown[] };
    };

    const systemPrompt = host.getSystemPrompt?.() ?? "";
    const options = host.getSystemPromptOptions?.() ?? {};
    const selected = new Set(options.selectedTools ?? []);
    const allTools = (pi as unknown as { getAllTools?: () => Array<{ name?: string }> }).getAllTools?.() ?? [];
    const tools = selected.size > 0 ? allTools.filter((t) => selected.has(t.name ?? "")) : allTools;

    let skillsText = "";
    try {
      skillsText = formatSkillsForPrompt((options.skills ?? []) as never).trim();
    } catch {
      // A pi version that formats skills differently just reports 0 here.
    }

    const entries = host.sessionManager?.buildContextEntries?.() ?? host.sessionManager?.getBranch?.() ?? [];
    const usage = host.getContextUsage?.();
    const contextWindow =
      usage?.contextWindow ?? (ctx.model as { contextWindow?: number } | null)?.contextWindow ?? 0;

    const breakdown = buildBreakdown({
      systemPrompt,
      contextFiles: options.contextFiles ?? [],
      skillsText,
      tools,
      entries,
      contextWindow,
    });
    const reported = typeof usage?.used === "number" ? usage.used : lastPromptTokens || null;
    return formatBreakdown(breakdown, reported);
  }

  pi.registerCommand("usage", {
    description: "Token and cost dashboard: /usage [quota]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if ((args ?? "").trim().toLowerCase() === "quota") {
        // The one networked path in this package, and only when asked for.
        // Providers with no key are skipped entirely rather than reported as
        // broken: an unconfigured provider is not a failure.
        const configured: Array<{ provider: (typeof QUOTA_PROVIDERS)[number]; key: string }> = [];
        for (const provider of QUOTA_PROVIDERS) {
          const key = await providerKey(ctx, provider.id);
          if (key) configured.push({ provider, key });
        }
        if (configured.length === 0) {
          ctx.ui.notify(quotaReport([]), "info");
          return;
        }
        ctx.ui.notify(`Checking quota for ${configured.map((c) => c.provider.displayName).join(", ")}…`, "info");
        const results: QuotaResult[] = [];
        for (const { provider, key } of configured) {
          results.push(await fetchQuota(provider, key));
        }
        ctx.ui.notify(redact(quotaReport(results)), results.every((r) => r.ok) ? "info" : "warning");
        return;
      }
      ctx.ui.notify(dashboard(ctx), "info");
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
