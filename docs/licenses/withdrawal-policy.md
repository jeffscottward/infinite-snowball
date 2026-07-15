# Withdrawal, dispute, and replacement policy

A provenance dispute or license withdrawal changes install eligibility; it does not silently erase user history.

## Fail-closed behavior

When evidence becomes disputed or withdrawn:

1. Mark the exact package/asset version `disputed` or `withdrawn`.
2. Block all new installs, updates to that version, catalog promotion, and cache seeding.
3. Preserve existing save and install-history references so records remain intelligible.
4. Record a reviewed replacement package/asset and deterministic migration map when one exists.
5. Display a factual local warning without repeating sensitive imported metadata or making unsupported legal claims.
6. Retain audit evidence; do not rewrite the old record as though it never existed.

A removal record is invalid if new installs remain allowed, either `save` or `history` is omitted from preserved references, or the replacement/migration map is absent. The stable rules are `E_WITHDRAWAL_INSTALL`, `E_WITHDRAWAL_HISTORY`, and `E_WITHDRAWAL_REPLACEMENT`.

`docs/licenses/withdrawals/starter-rock-simulated.json` is a simulation fixture only. It proves that a withdrawn `starter-rock@1.0.0` would block new installs while preserving save/history references and mapping to `starter-rock-v2@2.0.0`. The currently shipped starter rock remains verified and eligible.

P07 will implement catalog/install state transitions atomically and idempotently. P03 provides the policy, machine fixture, and tests; it does not mutate a live catalog or user save.
