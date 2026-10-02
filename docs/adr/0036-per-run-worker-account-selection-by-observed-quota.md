# ADR-0036: Per-Run worker account selection by observed provider quota

## Status

Table renamed by UNF-567 ([`docs/data-model.md`](../data-model.md)): `worker_account_quota` is now `worker_accounts` (`domain::worker_accounts`), same columns and semantics.

Accepted (UNF-541). Amends [ADR-0021](0021-claude-subscription-auth-on-ec2.md): replaces its
"selection happens once per daemon process start, not per Run" limitation. ADR-0021's profile model,
health probe, secret handling, and fail-closed-once-configured startup rule all still stand.

## Context

`SERGEANT_CLAUDE_PROFILES` can name several captain-owned Claude subscription accounts, but the
daemon used only the first healthy one for its whole lifetime, so a busy (or rate-limited) preferred
account kept receiving every Run while another had plenty of headroom. The 4-worker soak makes this
matter: concurrent Runs drain one subscription's 5-hour/7-day windows much faster.

What each provider actually exposes (checked live, not assumed):

- **claude** — `claude --output-format stream-json` emits a `rate_limit_event` built from the
  subscription API's own `anthropic-ratelimit-unified-*` headers: status
  (`allowed`/`allowed_warning`/`rejected`), the binding window's reset time, and per-window
  utilization. It is observed only *after* a request on that account; there is still no cheap
  preflight read for a `claude setup-token` credential (ADR-0021's `quota-axi` limitation).
- **codex** — `codex exec --json` reports token usage only. Rate limits appear solely in Codex's
  internal session rollout files, which are not a stable interface. No usable signal.
- **openai** — one platform API key; no named accounts to choose between.

## Decision

1. **Provider-neutral shape, not a quota framework.** `worker::account_quota` defines a
   `QuotaObservation` (status, highest window utilization, reset time, observed-at) and a pure
   `select_account` policy. An adapter reports an observation on `WorkerResult::quota`; only Claude
   does today.
2. **Observe after Runs, persist the latest per account.** Finalize records a Run's observation
   best-effort into `worker_account_quota` (one row per provider/account, replaced only by a newer
   reading). A Run with no observation records nothing.
3. **Select per Run at the dispatch choke point.** `implementation_tick`'s `dispatch` picks, among
   configured accounts of the Run's provider (in configured preference order), in tiers: usable
   accounts by most headroom (within a 0.1 utilization margin, preference order wins, so selection
   only moves for materially more headroom); then accounts with no fresh reading, in preference
   order; then near-exhausted (provider warning or utilization ≥ 0.8) by least utilization; then
   exhausted by soonest reset. A reading is stale once its window resets or after one hour
   (accounts are shared with work outside Sergeant).
4. **Only the provider's own `rejected` status means exhausted.** A failed Run, a transient API
   error, a startup probe failure, or a failed observation lookup never marks an account exhausted —
   they produce no reading, and a failed lookup degrades selection to preference order.
5. **Honest fallback.** With no fresh readings, selection is exactly ADR-0021's "first healthy
   profile in configured order". Codex, with no signal, keeps its single startup-selected profile.
6. **Provenance.** The Run's `resolved_context` records `worker_account` (non-secret profile name;
   the Run's `provider` column completes the identity) and `worker_account_selection` (the tier that
   chose it). This replaces the legacy `claude_profile` key, which was also written on non-Claude
   Runs; UNF-543's usage breakdown reads `worker_account` and falls back to `claude_profile` for older
   Runs. The adapter pins the account in its own run record so every later turn of a Run — and the
   `CLAUDE_CONFIG_DIR` holding its session — stays on that account.

## Consequences

- Several Runs dispatched in the same tick see the same readings and may all pick the same account;
  readings only change as Runs finish. No in-flight capacity estimate is invented to spread them.
- If every account is exhausted, a Run is still dispatched (to the soonest reset) and fails through
  the ordinary retry policy — the same behavior as before this ADR. Holding dispatch until a reset is
  a separate policy decision.
- A profile unhealthy at startup stays out of the pool until restart (unchanged from ADR-0021).
