# @pify/usage

[![CI](https://github.com/pifydev/usage/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/usage/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/usage)](https://www.npmjs.com/package/@pify/usage) [![npm downloads](https://img.shields.io/npm/dm/@pify/usage)](https://www.npmjs.com/package/@pify/usage)

Token and cost reporting for [pi](https://github.com/earendil-works/pi) sessions — a live footer, a `/usage` dashboard, and an agent-callable status tool. Local by default: no network calls, and no LLM tokens spent asking about tokens.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install usage`](https://github.com/pifydev/cli) or `pi install npm:@pify/usage`.

## Why

Spend is invisible until the invoice arrives, and by then you cannot tell which session did it. Everything needed to answer that is already on disk — pi writes usage and cost into every session file — so the answer should cost nothing to produce.

## Live footer

```
📊 12.3k tok · $0.45 · ctx ▰▰▰▱▱▱ 34%
```

Folded from each message's `usage.cost`, which pi already computes. It survives `/reload` by replaying the session branch rather than keeping a running total in memory.

The gauge on the right is how full the context window is — the third mid-session question, next to tokens and cost. It was computed for the `/usage` dashboard but shown only there; now it is live. It appears once there is a window to measure against (so not under `-p`) and turns to `⚠` past 90%, the point where "how full" stops being trivia and becomes a decision. For the breakdown of what filled it, run `/context`.

## `/usage`

```
Session
  tokens   in 120.3k · out 8.2k · cache 1.1M read / 0 write
  cost     $0.45 (23 responses)
  context  ~34% of the window

History (214 local session files)
  today    $1.23 · 450.2k tok
  7 days   $8.90 · 3.2M tok
  30 days  $21.40 · 9.8M tok
By model (all time)
  anthropic/claude-fable-5  $12.30 · 4.1M tok
  openai/gpt-5.5            $9.10 · 5.7M tok
By project (all time)
  D--project-pify-plugins   $14.80 · 6.2M tok
  D--project-shop-api       $6.60 · 3.6M tok
```

History counts every usage-bearing entry in pi's session JSONL — assistant turns plus the tool-result usage pi persists, and the summariser's own call, which pi records on the compaction and branch-summary entries themselves rather than on a message. Those summary calls are among the most expensive in a session, so counting them is what makes a session's total match what you were billed rather than what the visible messages add up to; they have no model of their own, so they group under a `compaction` / `branch_summary` label in the by-model view. The live footer and session totals fold the same summariser usage in as it happens (on compaction and tree navigation), so the number does not jump only after a reload. Negative and NaN fields clamp to zero, days are your **local** calendar days, and a per-file mtime cache keeps repeat scans instant.

Per-project totals come for free: pi stores sessions one directory per project, so the dashboard can show where the money actually went.

## `/context` (or `/usage context`)

```
Context window: 22.6k of 200.0k used (11%)
  System prompt     ····························  <1%  11
  Context files     ····························   1%  3.0k
  Tool definitions  ····························  <1%  371
  Tool results      ██··························   8%  16.8k
  Conversation      ····························   1%  2.4k
  Free space        █████████████████████████···  89%  177.4k
```

"Why am I at 60%?" usually has a boring answer — one `read` of a 4,000-line file — and this is where you find it.

Computed entirely from what pi already holds: the assembled system prompt, the files and skills embedded in it, the enabled tool definitions, and the entries that would be sent. No network, no model call.

Context files and skills are counted only when their text is genuinely embedded in the prompt, and the system-prompt row is the remainder after subtracting them, so the rows sum to the whole instead of double-counting. When the provider reports more than can be attributed, the difference is shown as **Other** rather than quietly dropped. Image blocks (a `read` of a screenshot, a pasted image) are charged at pi's flat 4,800 chars each, not at the size of their base64 bytes, so one screenshot no longer reads as hundreds of thousands of tokens.

The "used" figure and the footer gauge are reconciled across three signals — pi's own `getContextUsage()` reading, the provider's last-request report, and the local content estimate — so a backend that reports a wrong number (a cumulative or cache-inflated total, or an implausibly small one) can't throw the gauge off: the provider's report is used when it agrees with pi's percent×window, pi's reading is trusted when they diverge beyond tolerance, and the figure is never allowed below the tokens visibly in context, nor above the window. The provider figure uses pi's own definition of context size — `totalTokens`, or `input + output + cacheRead + cacheWrite` — so it agrees with pi's footer rather than sitting low by the cache-write and output of each turn. (The reconciliation rule is from minuque/pi-cc-extensions.)

Right after `/compact`, pi reports the context as unknown until the next response, and the gauge follows: the pre-compaction figure is dropped so `/context` shows the fresh local estimate instead of the old near-full number, and the gauge reappears once the next reply lands.

Reasoning gets its own **Thinking** row rather than hiding inside Conversation — on keep-thinking models it is a large, otherwise-invisible share (the opaque signature bytes are never counted or stored). And when pi's auto-compaction is on, the tokens it holds back appear as a **Compaction reserve** row and are subtracted from **Free space**, so the headroom shown is what you can actually use before compaction fires.

## `/usage quota`

The one command here that touches the network, and only when you run it:

```
Quota (OpenRouter · sk-or-v1-abc...xyz)
  spent    $0.33 (no credit limit on this key)
  window   day $0.01 · week $0.33 · month $0.33

Quota (DeepSeek · granted 10 · topped up 100)
  balance  CNY 110.00
```

**Documented endpoints only.** OpenRouter's `/api/v1/key` and DeepSeek's `/user/balance` are published APIs that report a real balance. The subscription-quota endpoints available for some other providers are undocumented private APIs reverse-engineered from vendor CLIs — they break without notice and were never offered to third parties, so this package does not call them. A provider you have not configured is simply not shown; that is not a failure.

**Rate limits, for free.** OpenAI, Anthropic and Gemini publish no balance API, but every completion response carries rate-limit headers, and pi hands them to extensions through `after_provider_response` — before the stream is read, at no cost when unsubscribed. So `/usage quota` also shows what the current provider reported on its last call — requests and tokens left in the window, and for an Anthropic OAuth (Pro/Max) subscription the two unified windows it actually reports: the fraction of the 5-hour and 7-day windows still free (from the `-5h-utilization` / `-7d-utilization` headers, which state the fraction *used*), which of the two is currently binding, an `allowed_warning` / `rejected` status when the window is under pressure, and the reset time. All captured passively from calls the session already made, with no extra request and no credential to handle.

**A credentialed request is pinned down**, because it carries your provider key:

- HTTPS only, and the host must be on that provider's allowlist.
- Redirects are refused outright. Following one lets whatever answered choose where the next request goes, with the header already attached.
- A non-2xx body is **never read**. Error bodies echo request details back, and an echoed `Authorization` header pasted into a notification is exactly the leak this must not cause — the status alone becomes the message.
- Raw exception text is dropped rather than shown, and everything printed passes a redactor as a last line of defence.
- An 8-second timeout per provider; any failure renders as `unavailable — the provider rejected the key` rather than throwing.

**The key comes from pi**, resolved through `modelRegistry` rather than by reading `auth.json`. pi owns credential storage — env precedence, OAuth, whatever it grows next — and parsing that file here would mean handling secrets this package has no business touching, using a stale copy of pi's rules. Only the provider's own masked label is ever printed.

## Tool

### `usage_status`

No parameters. Returns session and today's totals plus how full the context window is (`~N% of the … window used`, with a `/compact` hint past 80%), so the agent can check both cost and remaining room before committing to expensive work — a wide subagent fan-out, a large read — instead of finding out afterwards.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
