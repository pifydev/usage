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
 * Everything above is local: no network, no LLM tokens. The exception is
 * /usage quota: opt-in balance/subscription requests, 8s timeout per provider.
 * The footer shows cached Copilot/Codex percentages, never background polling.
 */
import {
  formatSkillsForPrompt,
  getAgentDir,
  readStoredCredential,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { addRecord, aggregate, recordFromEntry, windowTotals } from "../src/aggregate.ts";
import { buildBreakdown, contextTokensFromUsage, formatBreakdown, formatToolTax, resolveUsedTokens } from "../src/context.ts";
import { contextGauge, footerText, formatCost, formatTokens, historyBlock, sessionBlock } from "../src/format.ts";
import { childSpendTotal, onChildSpend, resetChildSpend } from "../src/child-cost.ts";
import { buildByDayCsv, buildByModelCsv, buildByProjectCsv, buildTotalsJson } from "../src/export.ts";
import { emptyCacheHealth, observeCacheHealth } from "../src/cache-health.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { QUOTA_PROVIDERS, fetchQuota, quotaReport, quotaFooter, type QuotaResult } from "../src/quota.ts";
import { resolveQuotaAuth } from "../src/quota-auth.ts";
import { redact } from "../src/redact.ts";
import { scanSessions, persistScanCache, restoreScanCache } from "../src/sessions.ts";
import { parseRateLimit, formatRateLimit, type RateLimitSnapshot, footerQuotaSegment } from "../src/ratelimit.ts";
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
  const quotas = new Map<string, { result: QuotaResult; fetchedAt: number }>();

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

  /**
   * The ctx the footer is drawn into, for the child-spend listener: a child
   * finishing a turn fires no pi event on the parent, so the tally calls back
   * and the footer redraws into the latest session context.
   */
  let footerCtx: UiContext | null = null;
  let stopChildSpend: (() => void) | null = null;

  function updateFooter(ctx: UiContext): void {
    if (!ctx.hasUI) return;
    const base = footerText(session, childSpendTotal());
    const gauge = base ? contextGauge(contextInfo(ctx).pct) : "";
    const provider = ctx.model?.provider ?? "";
    const cached = quotas.get(provider);
    const subscription = quotaFooter(cached?.result, cached?.fetchedAt ?? 0);
    const passive = footerQuotaSegment(rateLimits.get(provider));
    // Quota first: compact footers may truncate the rest. Namespace our status
    // so another usage extension cannot overwrite or clear it.
    ctx.ui.setStatus("pify-usage", [subscription, base, gauge, passive].filter(Boolean).join(" · ") || undefined);
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

  /** The on-disk twin of the scan cache: read once before the first scan, written after each completed one. */
  const scanCacheFile = () => join(getAgentDir(), "usage-scan-cache.json");
  let scanCacheRestored = false;
  function scanHistory() {
    if (!scanCacheRestored) {
      scanCacheRestored = true;
      restoreScanCache(scanCacheFile());
    }
    const scan = scanSessions(join(getAgentDir(), "sessions"));
    persistScanCache(scanCacheFile());
    return scan;
  }

  /** Prompt-cache health for this session: warns once when a warm cache goes cold. */
  let cacheHealth = emptyCacheHealth();

  function dashboard(ctx: UiContext): string {
    const history = aggregate(...(() => {
      const scan = scanHistory();
      return [scan.records, scan.files] as const;
    })());
    return [sessionBlock(session, contextInfo(ctx).pct, childSpendTotal()), historyBlock(history, Date.now())].join("\n\n");
  }

  // ── Live tracking ────────────────────────────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    const record = recordFromEntry({ message: (event as { message?: unknown }).message });
    if (!record) return;
    addRecord(session, record);
    const message = (event as { message?: { role?: string; usage?: unknown } }).message;
    if (message?.role === "assistant" && isRecord(message.usage)) {
      const warning = observeCacheHealth(cacheHealth, message.usage as { input?: number; cacheRead?: number; cacheWrite?: number });
      if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");
      // Use pi's own formula so the gauge cannot drift below pi's reading —
      // input+cacheRead alone dropped cacheWrite and output, a real slice of
      // every Anthropic prompt-cached turn.
      lastPromptTokens = contextTokensFromUsage(message.usage);
    }
    updateFooter(ctx);
  });

  pi.on("model_select", async (_event, ctx) => updateFooter(ctx));

  pi.on("session_start", async (event, ctx) => {
    quotas.clear();
    // Rebuild the session totals from the branch so /reload keeps the count.
    session = emptyTotals();
    lastPromptTokens = 0;
    // Child spend is not in the branch, so a /reload must keep the tally; a
    // new, resumed or forked session starts its own.
    if ((event as { reason?: string }).reason !== "reload") resetChildSpend();
    cacheHealth = emptyCacheHealth();
    footerCtx = ctx;
    stopChildSpend?.();
    stopChildSpend = onChildSpend(() => {
      if (!footerCtx) return;
      try {
        updateFooter(footerCtx);
      } catch {
        // a stale ctx after a switch; the next session_start rebinds it
      }
    });
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
    stopChildSpend?.();
    stopChildSpend = null;
    footerCtx = null;
    quotas.clear();
    if (ctx.hasUI) ctx.ui.setStatus("pify-usage", undefined);
  });

  // ── Command & tool ───────────────────────────────────────────────────

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
      // Per model since pi 0.86 (compaction.modelOverrides); the global value
      // would misstate "free space" for a model with its own reserve.
      const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
      return settings.getCompactionEnabled() ? Math.max(0, settings.getCompactionReserveTokens(model)) : 0;
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
    const allTools =
      (pi as unknown as { getAllTools?: () => Array<{ name?: string; description?: string; parameters?: unknown }> }).getAllTools?.() ?? [];
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
    // Break the "Tool definitions" row into its heaviest tools, biggest first,
    // so a costly MCP server or a fat schema is nameable rather than a lump.
    const taxLines = formatToolTax(tools);
    return taxLines.length > 0 ? `${formatBreakdown(breakdown, reported)}\n\n${taxLines.join("\n")}` : formatBreakdown(breakdown, reported);
  }

  const usageCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Token and cost dashboard: /usage [context | quota | export]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if ((args ?? "").trim().toLowerCase() === "export") {
        // Hand the history off: CSV per model/day/project and a totals JSON,
        // in the OS temp dir by default (never the repo or home), or
        // PIFY_USAGE_EXPORT_DIR. Full precision; the reader rounds.
        const scan = scanHistory();
        const history = aggregate(scan.records, scan.files);
        const now = Date.now();
        const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
        const dir = join(process.env.PIFY_USAGE_EXPORT_DIR?.trim() || join(tmpdir(), "pify-usage"), stamp);
        // Spend and project names are the user's business: the folder and
        // files are readable by the user only, and `wx` never follows a link
        // someone else placed at the path (pi 1.0.3's own output-file rule).
        const fileOptions = { mode: 0o600, flag: "wx" } as const;
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          writeFileSync(join(dir, "by-model.csv"), buildByModelCsv(history.byModel), fileOptions);
          writeFileSync(join(dir, "by-day.csv"), buildByDayCsv(history.byDay), fileOptions);
          writeFileSync(join(dir, "by-project.csv"), buildByProjectCsv(history.byProject), fileOptions);
          writeFileSync(join(dir, "totals.json"), buildTotalsJson(history.total, history.files, now), fileOptions);
        } catch (err) {
          ctx.ui.notify(`Export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          return;
        }
        ctx.ui.notify(`✓ Exported by-model.csv, by-day.csv, by-project.csv and totals.json to ${dir}`, "info");
        return;
      }
      if ((args ?? "").trim().toLowerCase() === "context") {
        // Documented since the breakdown landed, but never wired — the handler
        // only knew "quota", so `/usage context` quietly showed the dashboard.
        ctx.ui.notify(contextBreakdown(ctx), "info");
        return;
      }
      if ((args ?? "").trim().toLowerCase() === "quota") {
        // Only the active provider: a configured balance key does not mean it is in use.
        const id = ctx.model?.provider ?? "";
        const provider = QUOTA_PROVIDERS.find(p => p.id === id);
        const snapshot = rateLimits.get(id);
        const passive = snapshot ? formatRateLimit(snapshot) : null;
        if (!provider) {
          updateFooter(ctx);
          ctx.ui.notify(redact(passive ?? "No quota endpoint is available for the active provider."), "info");
          return;
        }
        const auth = await resolveQuotaAuth(provider, ctx.modelRegistry, readStoredCredential);
        let result: QuotaResult;
        if (auth.ok) {
          ctx.ui.notify(`Checking quota for ${provider.displayName}…`, "info");
          result = await fetchQuota(auth.provider, auth.apiKey);
        } else {
          result = auth;
        }
        quotas.set(id, { result, fetchedAt: Date.now() });
        updateFooter(ctx);
        ctx.ui.notify(redact((passive ? `${passive}\n\n` : "") + quotaReport([result])), result.ok ? "info" : "warning");
        return;
      }
      ctx.ui.notify(dashboard(ctx), "info");
    },
  };
  pi.registerCommand("usage", usageCommand);
  pi.registerCommand("pify-usage", usageCommand);

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
      const scan = scanHistory();
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
