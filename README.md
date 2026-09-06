# @pify/usage

Token and cost reporting for [pi](https://github.com/earendil-works/pi) sessions — a live footer, a `/usage` dashboard, and an agent-callable status tool. Entirely local: no network calls, no LLM tokens spent asking about tokens.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install usage`](https://github.com/pifydev/cli) or `pi install npm:@pify/usage`.

## What it does

- **Live footer**: `📊 12.3k tok · $0.45` — folded from each message's `usage.cost` that pi already computes; survives `/reload` by replaying the session branch.
- **`/usage` dashboard**:

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

- **History done right** (tmustier's lessons): counts every usage-bearing entry in pi's session JSONL — assistant turns plus the tool-result/compaction usage pi 0.81+ persists; negative/NaN fields clamp to zero; days are your local calendar days; a per-file mtime cache keeps repeat scans instant.
- **Where the window went** (v0.4): `/usage context` breaks the context window into system prompt, context files, skills, tool definitions, tool results, and conversation — so "why am I at 60%?" has an answer that is usually "one `read` of a 4,000-line file", not a mystery.

```
Context window: 22.6k of 200.0k used (11%)
  System prompt     ····························  <1%  11
  Context files     ····························   1%  3.0k
  Tool definitions  ····························  <1%  371
  Tool results      ██··························   8%  16.8k
  Conversation      ····························   1%  2.4k
  Free space        █████████████████████████···  89%  177.4k
```

  Computed from what pi already holds — the assembled system prompt, the files and skills embedded in it, the enabled tool definitions, and the entries that would be sent. No network, no model call. Context files and skills are counted only when their text is genuinely embedded in the prompt, and the system-prompt row is the remainder after subtracting them, so the rows sum to the whole instead of double-counting. When the provider reports more than we can attribute, the difference is shown as **Other** rather than dropped. (The idea is from [`pi-cc-extensions`](https://github.com/minuque/pi-cc-extensions)' `/context`.)

- **Per-project spend** (v0.2): pi stores sessions one directory per project, so the dashboard can show where the money actually went — the top 5 projects by cost, all time.
- **`usage_status` tool**: the agent can check session + today totals before committing to expensive work (subagent fan-outs, large reads).

## `/usage quota` (v0.3)

The one command in this package that touches the network, and only when you run it:

```
Quota (openrouter · sk-or-v1-abc...xyz)
  spent    $0.32 (no credit limit on this key)
  window   day $0.32 · week $0.32 · month $0.32
```

The key is read from the same `~/.pi/agent/auth.json` pi already uses (or `OPENROUTER_API_KEY`) — no second place to configure credentials — and only the provider's own masked label is ever printed. An 8-second timeout, and any failure renders as `unavailable — HTTP 401` rather than throwing.

Only OpenRouter is implemented. The other providers report opaque rate-limit windows rather than a balance, and chasing all of them costs ~18k lines of per-provider contract maintenance (see `@narumitw/pi-usage` if you need them today).

## License

MIT © [Pify maintainers](https://github.com/pifydev)
