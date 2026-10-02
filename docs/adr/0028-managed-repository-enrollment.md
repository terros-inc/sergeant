# ADR-0028: managed-repository enrollment via `sgt admin repo`

## Status

Superseded in part by UNF-567 ([`docs/data-model.md`](../data-model.md)) at the table level only: a Run's repository scope is now `runs.repo_slugs_json` (the `run_repositories` table and `domain::run_repositories` are gone; see `domain::repo_scope`). The `managed_repositories` table is unchanged.

Accepted. Unit-tested Rust only (mocked SSM discovery/transport, a fake `GitHubAppProbe`-style
live-GitHub check, and a real-but-temporary SQLite database for the domain module) — no live SSM
registration, no real `sgt admin repo add` run against the Unforgotten instance's GitHub App or
runtime database. That verification happens separately, outside a sandboxed task worktree, with a
human/Firstmate holding real AWS credentials driving it explicitly (this machine's crewmate
worktrees inherit real ambient AWS credentials, so nothing here was run against them — see
UNF-393's own launch brief).

**Corrected by UNF-403** (see `docs/adr/0029`'s own status note for the full corrected model):
this ADR's original decision coupled enrollment to a "one Linear project routes to exactly one
managed repository" rule, enforced by a `linear_project_id` column and `UNIQUE` constraint on
`managed_repositories`. That coupling was the wrong abstraction boundary — a Sergeant installation
connects to one Linear *workspace*, which may contain many Linear *projects*, and Linear project
membership is workflow/product organization metadata, never a repository-routing key. UNF-403
removed `linear_project_id` from this table outright (`migrations/0019_drop_managed_repository_linear_project_routing.sql`)
rather than replacing it with another Project-to-repository registry — repository scope now lives
on the *Run* (`domain::run_repositories`), not on enrollment or on a Task. The rest of this ADR's
decision (the minimal enrollment shape, the `sergeant admin-repo` on-box mutation boundary, GitHub
App access validation) is unaffected and still describes the current design; only the
Linear-project-routing pieces below are struck through/corrected. Separately, UNF-400 (merged
before UNF-403) fixed `sgt admin repo`'s remote script to parse `/etc/sergeant/sergeant.env`
directly (`ENV_LOADER_FN`, POSIX `sh`, never `eval`/`source`) instead of shell-sourcing it — the
"sourcing `/etc/sergeant/sergeant.env`" language later in this ADR's Decision section describes
that now-superseded pre-UNF-400 behavior; see `docs/repo-map.md`'s UNF-400 entry and
`crates/sergeant-cli/src/commands/admin/repo.rs`'s own module doc for the current mechanism.

## Context

UNF-393 lets one Sergeant installation manage multiple repositories without reviving the
Repository/Application/Environment topology registry UNF-233 removed (`docs/adr/0014`) — a
repository's own `sergeant.toml` (`repo_config::RepoConfig`) stays authoritative for topology,
build/test/deploy commands, permissions, and tools. What Sergeant itself still needs, durably, is
the minimal routing/enrollment fact: which repositories this installation manages and their
source. (UNF-393 originally also enrolled each repository under a single routing Linear project;
UNF-403 corrected that — see this ADR's own Status note above.)

ADR-0027 already established `sgt admin` as the one `sgt` namespace that never talks to the
daemon's HTTP API — installation administration goes `AWS credentials -> SSM -> Sergeant
installation` instead, gated by AWS IAM rather than a Sergeant-side admin identity. That ADR's own
"Command surface is deliberately two subcommands" line described UNF-392's scope at the time, not
a ceiling on the namespace — this ticket extends it with `sgt admin repo add/list/show/remove/
disable`, reusing the exact same AWS-gating pattern rather than inventing a second one.

The open design question this ADR answers: given `sgt admin` never touches the daemon's HTTP API,
and the durable SQLite database (ADR-0003) lives on the installation's own EC2 instance, how does
a repo-enrollment mutation actually reach that database, and how does "validate the GitHub App can
access the repo" (the ticket's own acceptance criterion) get a real answer without inventing a
second GitHub credential path?

## Decision

**A new on-box subcommand, `sergeant admin-repo`, is the actual mutation boundary — `sgt admin
repo *` never opens the database itself.** `sergeant-daemon`'s binary (previously just `sergeant
serve | sergeant --version`) grows `sergeant admin-repo add|list|show|remove|disable`
(`crates/sergeant-daemon/src/admin_repo/`), which opens the exact same `SERGEANT_DB_PATH` SQLite
file `sergeant serve` uses (`sergeant_core::db::open_database`) and calls a new domain module,
`sergeant_core::domain::managed_repositories`. `sgt admin repo add/list/show/remove/disable`
(`sergeant-cli`'s `commands::admin::repo`) composes a shell command invoking this subcommand and
runs it over the *same* SSM Run Command transport `sgt admin exec` already uses
(`commands::admin::exec::ExecReport`) — reading `/etc/sergeant/sergeant.env` (and the optional
`sergeant.local.env`) first so the on-box command sees the same `SERGEANT_DB_PATH`/GitHub App
configuration `sergeant serve` itself runs with (UNF-400: parsed directly via a POSIX-`sh`
`ENV_LOADER_FN`, never shell-sourced — see `crates/sergeant-cli/src/commands/admin/repo.rs`'s own
module doc for why shell-sourcing a systemd `EnvironmentFile` is a command-execution boundary, not
just a parsing quirk), then `cd`-ing into `/var/lib/sergeant` (`sergeant.service`'s own
`WorkingDirectory`, since `SERGEANT_DB_PATH` defaults to a path relative to it). Arguments are
POSIX-single-quote-escaped (`repo::shell_quote`) before being spliced into the command string.

This keeps the mutation on the one machine SQLite's single-writer model (ADR-0003) already assumes
is authoritative, without adding a second write path to the database or a new HTTP endpoint that
would have to duplicate `sgt admin`'s AWS-gating decision. `sergeant admin-repo` always prints
exactly one JSON value to stdout and returns a process exit code (`0` success, `1` a reported
domain failure, `2` a usage error) — `sergeant-cli` is its only caller and parses that JSON rather
than any human-formatted text; a human never invokes `sergeant admin-repo` directly.

**Minimal persisted model, exactly the ticket's own shape**
(`migrations/0015_managed_repositories.sql`, `domain::managed_repositories::ManagedRepository`):
`id`, `repo_slug` (`UNIQUE`), `source_url`, `enabled`, `created_at`/`updated_at`. (UNF-403 dropped
this table's original `linear_project_id` column — see this ADR's own Status note.) `source_url` is
derived (`https://github.com/{repo_slug}`) rather than taken as a separate CLI flag — V1 has exactly
one supported source (the GitHub App), so a second flag would only invite drift from `repo_slug`.
Nothing from the removed Repository/Application/Environment tables is reintroduced; a Run's
`resolved_context` snapshot carries no foreign key to this table, so `remove`/`disable` never touch
historical Run provenance (the ticket's other acceptance criterion) — `remove` deletes the
enrollment row outright, `disable` flips `enabled` to `false` reversibly.

**GitHub App access validation reuses the exact reachability approach `sgt doctor` already uses**
(`commands::doctor::github`), not a second GitHub client construction path:
`GET /installation/repositories` (`GitHubClient::list_installation_repositories`, deliberately not
gated by `GitHubAppConfig::allows_repository` — its own doc comment says why: "used by sgt
doctor-style reachability checks... since its whole purpose is inspecting what the installation
actually grants"), then a membership check against the target `owner/repo`
(`admin_repo::github_check::evaluate`, kept pure and feature-independent so the membership logic is
unit-tested regardless of build flags). "Where practical" per the ticket:
`admin_repo::github_check::resolve_and_check` degrades to `AccessCheck::NotConfigured` — never a
hard failure — when the App identity isn't configured on this installation at all, or (`#[cfg(not(
feature = "github-live"))]`) when this binary lacks real GitHub connectivity, mirroring
`github_instance::resolve_github_instance`'s existing optionality exactly. Only a definite
`AccessCheck::NotAccessible` (the installation's own repository list doesn't include the target) or
`AccessCheck::Error` blocks `add`.

**`sgt admin repo` surfaces two distinct failure shapes as one clear JSON result**
(`commands::admin::repo::RepoReport`): a discovery/IAM/transport failure that never reached the
on-box command (rendered from `AdminError`, same as `sgt admin exec`), and a well-formed `{"error":
...}` JSON the on-box command itself printed on a reported domain failure (duplicate slug,
unenrolled repo, GitHub App access denied) — both surface through the same `{"error": ...,
"profile": ...}` shape rather than treating a non-zero remote exit as an opaque SSM failure the way
plain `sgt admin exec` does.

## Consequences

- Enrollment survives daemon and EC2 restart via the same durable SQLite file every other Sergeant
  table already relies on (ADR-0003) — there is no separate admin datastore to fall out of sync or
  need its own backup/restore story.
- `sgt admin repo add` genuinely proves GitHub App access before enabling a repository wherever the
  installation's GitHub identity is configured and this binary has real GitHub connectivity;
  elsewhere it degrades to "not verified" rather than blocking enrollment on infrastructure that
  isn't there yet.
- **Not built** (deliberately, per the ticket's own simplification boundary and UNF-394/UNF-403's
  adjacent scope): any Repository/Application/Environment domain table, a generic capability graph,
  cross-repo transactions, a new Sergeant Project entity, and an `enable` subcommand (the ticket
  lists `remove`/`disable` only — the domain module's `set_enabled(..., true)` exists and is
  tested, but no CLI surface calls it with `true` yet).
- Repository scope for Linear intake/Task dispatch routing does **not** live on this table (UNF-394
  originally wired it in via `linear_project_id`; UNF-403 corrected that — repository scope now
  lives on the Run, `domain::run_repositories`/`domain::task_repo_scope`, per `docs/adr/0029`).
