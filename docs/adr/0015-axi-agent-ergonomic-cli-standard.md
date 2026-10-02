# ADR-0015: Sergeant's agent-facing CLI adopts AXI principles, with deviations for stable programmatic consumption

## Status

Accepted.

## Context

UNF-211 (`sergeant-cli`, the `sgt` binary) is a thin HTTP client of the daemon, built for three
audiences: human operators, FirstMate/scripts, and future agents — ahead of any web dashboard. Its
users are disproportionately agents rather than humans typing interactively, and that only grows
as more of Sergeant's own surface (provider adapters, a future task-system adapter, `sgt doctor`'s
host diagnostics from UNF-216) becomes something agents drive directly.

AXI (Agent eXperience Interface, https://axi.md/) names 10 concrete principles for agent-ergonomic
CLI design, grouped into three categories: Efficiency (token-efficient output, minimal default
schemas, content truncation), Robustness (pre-computed aggregates, definitive empty states,
structured errors/exit codes), and Discoverability (ambient context, content-first default view,
contextual next-step hints, consistent help). UNF-212 asks Sergeant to evaluate these as explicit
design standards for `sgt` and for future adapters/interfaces, and to document where Sergeant
deviates and why.

This ADR is a design standard, not a rewrite mandate: per the walking-skeleton rule in `AGENTS.md`,
it records what's already true, states what's normative going forward, and calls out the specific
places it changed existing `sgt` output because doing so was cheap and low-risk. It does not
restructure `sgt`'s command surface or its HTTP contract with the daemon.

## Decision

Each of the 10 AXI principles is evaluated below against `sgt` as it exists today (`crates/sergeant-cli/`,
UNF-211) and, where relevant, the not-yet-merged `sgt doctor` (UNF-216), which independently arrived
at several of the same conventions.

### Efficiency

**1. Token-efficient output.** AXI's own recommendation (TOON instead of JSON) is **not adopted**.
`sgt --json` prints the daemon's stable `{"error": {"code","message"}}` / resource JSON verbatim
(`main.rs::print_json`) — this is deliberately a stable, ecosystem-standard wire format that
scripts, CI, and general-purpose JSON tooling can consume without a Sergeant-specific parser.
Trading that for ~40% token savings is not worth losing "any `jq`/any HTTP client can read this."
The spirit of the principle — don't force an agent to parse verbose output when a compact one
would do — is instead served by the second default rendering path: plain human-readable text
(`output.rs`) is markedly more token-dense than either JSON or TOON for the common "glance at
status" case, and is what every command defaults to. An agent that wants structure asks for
`--json`; an agent that wants density gets it by default. **Deviation, with rationale**: stable
JSON over a novel token-optimized encoding.

**2. Minimal default schemas.** **Already conformant.** `output.rs`'s human-rendered lines carry
3–5 fields per row (id, state/status, title/role/provider), not the full daemon resource. `--json`
intentionally returns the full daemon response rather than a filtered subset — see the deviation
under principle 1: `--json` is the "give me everything, in a standard shape" escape hatch, not
another abbreviated view. There is no partial `--fields`-style flag today; one isn't warranted
until a real response grows large enough to need it (see principle 3).

**3. Content truncation.** **Adopted, applied where it was cheap.** A `Run`'s `result_summary` is
free text a provider adapter writes and can be arbitrarily long; `output.rs::print_run_detail` now
truncates it in the human view to 200 characters with an explicit `(truncated, N chars total — use
--json to see the full text)` hint, matching AXI's pattern exactly. No other field in today's
schema (task titles, artifact metadata, doctor check messages) is long enough to need this, and
none are truncated. `--json` is always the full-content escape hatch; there is no separate
`--full` flag because `--json` already serves that purpose for every command.

### Robustness

**4. Pre-computed aggregates.** **Already conformant.** `sgt status` composes three daemon calls
into one glance specifically so an agent doesn't have to (`commands/status.rs`'s doc comment names
this explicitly). List responses' human rendering always shows the count in its header (`"Runs
({}):"`, `"Active/waiting tasks ({}):"`), not just the rows returned. `sgt doctor`'s report
(UNF-216, not yet merged) precomputes a `pass`/`warn`/`fail` summary line in both its human and
`--json` output rather than making the caller count check statuses itself — the same pattern this
principle asks for, arrived at independently.

**5. Definitive empty states.** **Already conformant.** Every list/detail path prints an explicit
zero-result line rather than silent empty output: `"No tasks."`, `"No runs."`, `"No stale runs."`,
`"none"` for empty sub-lists in detail/status views. This was true before this ADR; it is now the
documented standard for any future list-shaped command.

**6. Structured errors & exit codes.** **Adopted as the explicit standard; already substantially
conformant.** `sgt` never prompts interactively (there is no interactive code path anywhere in the
crate). Daemon errors carry a stable `{"code","message"}` shape (`crates/sergeant-daemon/src/http/error.rs`)
that `sgt --json` passes through unchanged, and `CliError`'s `Display` renders the human form. Exit
codes: `0` success, `1` a reported operational error (`main.rs::report_error` then
`process::exit(1)`, matching `sgt doctor`'s "FAIL causes a non-zero exit" — see UNF-216), `2` a
clap usage error (unknown flag/subcommand — clap's default, unchanged). This 0/1/2 split is now the
documented convention for every current and future subcommand. One clarification against AXI's
literal wording: errors are the JSON on **stdout** only for the `--json` path (so a script that
parses `--json` output always gets JSON regardless of exit code); the human-readable path still
writes errors to stderr, following standard Unix convention, since a human-facing message isn't
the "structured output a script parses" case AXI's stdout guidance is protecting.

### Discoverability

**7. Ambient context.** **Not adopted for `sgt` itself, deliberately.** AXI's mechanism is a
session-hook install so context is visible before an agent acts. `sgt` is a stateless HTTP client
invoked per-command; there is no persistent agent session for it to hook into, and inventing one
(e.g. a background daemon-status cache) would be exactly the kind of not-yet-justified machinery
`AGENTS.md`'s walking-skeleton rule warns against building ahead of a real need. `sgt status` is
the equivalent one-command way to get oriented, and costs one explicit invocation instead of zero —
an acceptable tradeoff for a control-plane CLI that agents already invoke deliberately, not one
they live inside continuously.

**8. Content-first default view.** **Deviation, documented.** Running `sgt` with no subcommand
prints clap's usage/help and exits `2`, rather than defaulting to live data. This is intentional:
`sgt` fronts a live daemon over the network, and a bare invocation silently making a network call
by default (with no explicit verb) is more surprising than helpful for an operator tool whose
mutating commands (`cancel`, `retry`, `reconcile`) sit one subcommand away. `sgt status` already is
the "no-argument, show me what matters" view AXI asks for — it is just one explicit token away
rather than zero. This is called out here specifically so a future contributor doesn't "fix" it by
making `status` the default without weighing the tradeoff again.

**9. Contextual disclosure.** **Adopted where cheap.** The top-level `sgt --help` now points
explicitly at `sgt status` as the starting point and at `sgt <command> --help` for subcommand
detail (see `cli.rs`'s `after_help`). Per-response "next step" hints on every list/detail output
(an AXI `help[]`-style line after every command) are **not** added: `sgt`'s command surface is
small enough (4 top-level commands) that the fixed, one-time top-level hint covers discovery
without adding a repeated line to every invocation's output — which would work against principle 2
(minimal output) for no real discovery gain at this surface's size. Revisit this once the command
surface grows enough that "what do I do next" stops being obvious from `--help` alone.

**10. Consistent way to get help.** **Already conformant; unchanged.** Every command and subcommand
gets clap's standard `--help` for free, with the same format throughout. No change needed.

## Consequences

- The two adopted-but-not-yet-present conventions (result_summary truncation, top-level
  contextual `--help` hint) are implemented in this PR as the concrete, low-risk application of
  this standard; nothing else in `sgt`'s current output needed to change to match it.
- This ADR's five per-principle "already conformant" findings are the standard now, not
  accidental byproducts: a future subcommand that omits an empty-state message, adds interactive
  prompting, or returns a schema wider than a human needs by default is a regression against this
  ADR, not a new design choice up for debate each time.
- The two firm deviations (stable JSON over TOON; no-args shows help, not live state) are
  permanent unless a future ADR revisits them with new evidence — they are not "not done yet."
- Future Sergeant interfaces this reasoning extends to, per UNF-212's scope, when they gain an
  agent-facing surface: a Codex/other provider adapter's own CLI invocation shape (if any),
  `sgt doctor`'s check surface (UNF-216), and any future task-system adapter CLI. None of these
  need a new ADR to justify following this one; they should cite it.
- AXI is treated purely as interface-design guidance. Nothing in Sergeant depends on the AXI
  skill package or any other AXI runtime artifact; this ADR is Sergeant's own restatement of the
  parts adopted, so the standard survives independent of that external project's availability.
