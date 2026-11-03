# Changelog

## [0.15.0] - 2026-11-03

- Costs that pi could not get from the provider are marked with a `≈`
  (estimated from the model catalog); figures the provider actually billed —
  pi 1.5.0's `usage.cost.totalFromProvider` — are shown exact. The footer, the
  session block, and every history and breakdown row carry the mark, with a
  one-line legend in the dashboard when it appears. The JSON export gains an
  `estimatedCost` field.

## [0.14.0] - 2026-10-14

- Opt-in Copilot and Codex subscription quotas, targeting the active provider
  with host-bound GitHub Enterprise quota auth (#1).
