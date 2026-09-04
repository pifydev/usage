---
name: usage
description: Use when cost or token consumption matters to a decision - before expensive operations (large reads, many subagents, long loops) or when the user asks about spend - explains usage_status and /usage
---

# Usage awareness

This project has the `@pify/usage` extension installed: a live footer
(tokens + cost for this session) and local history aggregation.

## When to check (usage_status)

- Before an expensive plan: fanning out subagents, reading many large
  files, or long automatic loops — confirm the spend is proportionate.
- When the user asks "how much has this cost?" — answer from usage_status,
  never estimate from memory.

## Notes

- All numbers are computed locally from pi's session files and the current
  session's message usage — no network, no tokens spent asking.
- `/usage` (user command) shows the full dashboard: session breakdown,
  today/7d/30d history, and per-model totals.
- Costs come from pi's own per-message usage.cost; if a model has no price
  configured, its cost reads as $0 while tokens still count.
