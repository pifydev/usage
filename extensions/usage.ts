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
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { addRecord, aggregate, recordFromEntry, windowTotals } from "../src/aggregate.ts";
import { buildBreakdown, contextTokensFromUsage, formatBreakdown, resolveUsedTokens } from "../src/context.ts";
import { contextGauge, footerText, formatCost, formatTokens, historyBlock, sessionBlock } from "../src/format.ts";
import { QUOTA_PROVIDERS, fetchQuota, quotaReport, type QuotaResult } from "../src/quota.ts";
import { redact } from "../src/redact.ts";
import { scanSessions } from "../src/sessions.ts";
import { parseRateLimit, formatRateLimit, type RateLimitSnapshot } from "../src/ratelimit.ts";
import { emptyTotals, isRecord, type UsageTotals } from "../src/types.ts";

type UiContext = ExtensionContext;

export default function usage(pi: ExtensionAPI) {
  let session: UsageTotals = emptyTotals();
  /**
   * The most recent assistant turn's context size, via pi's own
   * calculateContextTokens (totalTokens, or input+output+cacheRead+cacheWrite).
   * Cleared on compaction until the next post-compaction response, matching
   * what pi's getContextUsage reports.
   */
  let lastPromptTokens = 0;
  /**
   * The latest rate-limit headers seen per provider — passive quota, captured
   * free from responses the session already made, no extra network call.
   */
  const rateLimits = new Map<string, RateLimitSnapshot>();

  // after_provider_response carries the status and full headers of every
  // provider call, before the stream is read; gated on hasHandlers, so
  // subscribing costs nothing per request. The event does not name the
  // provider, so it is read from the model in context.
  pi.on("after_provider_response", async (event, ctx) => {
    const provider = (ctx as { model?: { provider?: string } }).model?.provider;
    if (!provider) return;
    const evt = event as unknown as { headers?: Record<string, string> };
    const snap = parseRateLimit(provider, evt.headers ?? {}, Date.now());
    if (snap) rateLimits.set(provider, snap);
  });

  function updateFooter(ctx: UiContext): void {
    if (!ctx.hasUI) return;
    const base = footerText(session);
    if (!base) {
      ctx.ui.setStatus("usage", undefined);
      return;
    }
    const gauge = contextGauge(contextInfo(ctx).pct);
    ctx.ui.setStatus("usage", gauge ? `${base} · ${gauge}` : base);
  }

  /**
   * The context fill percentage and the window it is measured against. The
   * window is returned alongside the percentage so callers (the usage_status
   * tool) can name the window without recomputing it. `pct` is null when there
   * is nothing to measure (no window, or nothing known about usage).
   */
  function contextInfo(ctx: UiContext): { pct: number | null; window: number } {
    const usage = (
      ctx as { getContextUsage?: () => { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined }
    ).getContextUsage?.();
    const window = usage?.contextWindow ?? (ctx.model as { contextWindow?: number } | null)?.contextWindow ?? 0;
    // Reconcile pi's own reading with the provider's last-request report, rather
    // than trusting the provider number blind (some backends report it wrong).
    const used = resolveUsedTokens({
      hostTokens: usage?.tokens ?? null,
      hostPercent: usage?.percent ?? null,
      window,
      providerTokens: lastPromptTokens || null,
    });
    if (used === null || window <= 0) return { pct: null, window };
    return { pct: Math.min(100, (used / window) * 100), window };
  }

  function dashboard(ctx: UiContext): string {
    const history = aggregate(...(() => {
      const scan = scanSessions(join(getAgentDir(), "sessions"));
      return [scan.records, scan.files] as const;
    })());
    return [sessionBlock(session, contextInfo(ctx).pct), historyBlock(history, Date.now())].join("\n\n");
  }

  // ── Live tracking ────────────────────────────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    const record = recordFromEntry({ message: (event as { message?: unknown }).message });
    if (!record) return;
    addRecord(session, record);
    const message = (event as { message?: { role?: string; usage?: unknown } }).message;
    if (message?.role === "assistant" && isRecord(message.usage)) {
      // Use pi's own formula so the gauge cannot drift below pi's reading —
      // input+cacheRead alone dropped cacheWrite and output, a real slice of
      // every Anthropic prompt-cached turn.
      lastPromptTokens = contextTokensFromUsage(message.usage);
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

  pi.on("session_compact", async (event, ctx) => {
    // pi's getContextUsage returns {tokens:null} until the first post-compaction
    // response, so the stale pre-compaction figure would otherwise keep the
    // gauge and /context at the old ~90% right after /compact. Drop it and let
    // the local estimate drive the number until the next assistant reply.
    lastPromptTokens = 0;
    // The summariser's own call is one of the priciest turns in a session and
    // fires no message_end (it is a direct completion, not the agent loop), so
    // fold its usage — carried on the compaction entry itself — into the live
    // footer and session totals here.
    const record = recordFromEntry((event as { compactionEntry?: unknown }).compactionEntry);
    if (record) addRecord(session, record);
    updateFooter(ctx);
  });

  pi.on("session_tree", async (event, ctx) => {
    // A branch summary is generated the same way (a direct completion), with its
    // usage on the summary entry; count it so tree navigation is not free.
    const record = recordFromEntry((event as { summaryEntry?: unknown }).summaryEntry);
    if (record) {
      addRecord(session, record);
      updateFooter(ctx);
    }
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
  /**
   * Tokens pi holds back for auto-compaction, so "Free space" reflects real
   * headroom. Best-effort: 0 when compaction is off or the API is unavailable.
   */
  function compactionReserve(ctx: UiContext): number {
    try {
      const projectTrusted = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false;
      const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
      return settings.getCompactionEnabled() ? Math.max(0, settings.getCompactionReserveTokens()) : 0;
    } catch {
      return 0;
    }
  }

  function contextBreakdown(ctx: UiContext): string {
    const host = ctx as unknown as {
      getSystemPrompt?: () => string;
      getSystemPromptOptions?: () => {
        contextFiles?: Array<{ path?: string; content?: string }>;
        skills?: unknown[];
        selectedTools?: string[];
      };
      getContextUsage?: () => { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined;
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
      reserveTokens: compactionReserve(ctx),
    });
    // The provider's real last-request number is the primary "used" figure (it
    // makes the "Other" row — what the provider counts that we can't attribute —
    // meaningful), reconciled against pi's own reading and floored by the local
    // estimate so a wrong provider total can't over- or under-state the window.
    const reported = resolveUsedTokens({
      hostTokens: usage?.tokens ?? null,
      hostPercent: usage?.percent ?? null,
      window: contextWindow,
      providerTokens: lastPromptTokens || null,
      estimate: breakdown.attributed,
    });
    return formatBreakdown(breakdown, reported);
  }

  pi.registerCommand("usage", {
    description: "Token and cost dashboard: /usage [context | quota]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if ((args ?? "").trim().toLowerCase() === "context") {
        // Documented since the breakdown landed, but never wired — the handler
        // only knew "quota", so `/usage context` quietly showed the dashboard.
        ctx.ui.notify(contextBreakdown(ctx), "info");
        return;
      }
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
          const passive = [...rateLimits.values()]
            .map((s) => formatRateLimit(s))
            .filter((line): line is string => line !== null);
          ctx.ui.notify(
            passive.length > 0 ? redact(`${passive.join("\n")}\n\n${quotaReport([])}`) : quotaReport([]),
            "info",
          );
          return;
        }
        ctx.ui.notify(`Checking quota for ${configured.map((c) => c.provider.displayName).join(", ")}…`, "info");
        const results: QuotaResult[] = [];
        for (const { provider, key } of configured) {
          results.push(await fetchQuota(provider, key));
        }
        const passive = [...rateLimits.values()]
          .map((s) => formatRateLimit(s))
          .filter((line): line is string => line !== null);
        const passiveBlock = passive.length > 0 ? `${passive.join("\n")}\n\n` : "";
        ctx.ui.notify(redact(passiveBlock + quotaReport(results)), results.every((r) => r.ok) ? "info" : "warning");
        return;
      }
      ctx.ui.notify(dashboard(ctx), "info");
    },
  });

  pi.registerCommand("context", {
    description: "Where the context window went: /context",
    handler: async (_args, ctx) => {
      // The live footer gauge says how full the window is; this says spent on
      // WHAT — the breakdown was built for the /usage dashboard's one-line note
      // but the full bar view had no command to reach it until now.
      if (ctx.hasUI) ctx.ui.notify(contextBreakdown(ctx), "info");
    },
  });

  pi.registerTool({
    name: "usage_status",
    label: "Usage status",
    promptSnippet: "Tokens, cost, and context used so far this session",
    description:
      "Current session token/cost totals, today's local aggregate, and how full the context " +
      "window is. Use when deciding whether an expensive approach (large reads, many subagents) " +
      "is proportionate, or whether to /compact first.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const scan = scanSessions(join(getAgentDir(), "sessions"));
      const history = aggregate(scan.records, scan.files);
      const today = windowTotals(history.byDay, 1, Date.now());
      const lines = [
        `Session: ${formatTokens(session.totalTokens)} tokens, ${formatCost(session.cost)} across ${session.messages} responses.`,
        `Today (all sessions): ${formatTokens(today.totalTokens)} tokens, ${formatCost(today.cost)}.`,
      ];
      // The snippet promises "context used", and the skill tells the model to
      // call this before large reads — so return the one number that decides
      // whether the read fits, with a hint to compact when the window is tight.
      const { pct, window } = contextInfo(ctx);
      const contextPercent = pct === null ? null : Math.round(pct);
      if (pct !== null) {
        const hint = pct >= 80 ? " — consider /compact before large reads" : "";
        lines.push(`Context: ~${contextPercent}% of the ${formatTokens(window)} window used${hint}.`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { session, today, contextPercent, contextWindow: window },
      };
    },
  });
}
