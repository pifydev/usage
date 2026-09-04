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
```

- **History done right** (tmustier's lessons): counts every usage-bearing entry in pi's session JSONL — assistant turns plus the tool-result/compaction usage pi 0.81+ persists; negative/NaN fields clamp to zero; days are your local calendar days; a per-file mtime cache keeps repeat scans instant.
- **`usage_status` tool**: the agent can check session + today totals before committing to expensive work (subagent fan-outs, large reads).

Provider quota APIs (Codex windows, Copilot allowances, OpenRouter credits…) are deliberately out of v0.1 — they cost ~18k lines of per-provider contract maintenance (see `@narumitw/pi-usage` if you need them today).

## License

MIT © [Pify maintainers](https://github.com/pifydev)
