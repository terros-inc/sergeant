# ADR-0043: The repository publishes releases; installations pull them

## Status

Accepted (UNF-637). Supersedes UNF-637's original push design (CI deploys Personal, soaks 24h,
then promotes the same artifact to Terros) and ADR-0042's "the CI/CD target this repository
deploys to comes from GitHub repository variables (`SERGEANT_CD_*`)".

## Context

Releases were deployed by the repository: `ci.yml` built and published an immutable GitHub Release,
and `deploy-stage.yml` mirrored it into Personal's S3 bucket and restarted Personal's instance over
SSM, using OIDC roles trusted by this repository and `SERGEANT_CD_*` variables naming Personal's
region, bucket and instance. A second installation (Terros) would have needed its own deploy
credentials in the same repository, and the repository is about to move to `terros-inc` and become
public (UNF-695). A public repository must hold no deploy credential for any installation.

The captain's decision (2026-10-01): **the repo publishes, installations pull.**

## Decision

**The repository only builds and publishes, and GitHub makes the result immutable.** CI builds and
smoke-tests every artifact (the daemon and each `sgt` CLI build) as an Actions artifact. A single
publisher job (`scripts/publish-release.sh`) then creates a draft release
(`v<version>+<short sha>`), attaches the complete asset set and `sgt-manifest.json`, and publishes it
once. The repository's **immutable-releases setting** must be on (a one-time operator step), so
GitHub locks the tag and every asset at publication. GitHub records a `sha256:` digest for every
asset; that digest is the artifact's identity everywhere. Nothing rebuilds the artifact, and nobody
can replace it under the same tag. Release notes stay editable, which yanking relies on. A re-run
of the publisher verifies an already-published release by digest and never changes it.

**Each installation pulls into itself with its own credentials.**

- **Release source and authentication.** The host lists releases and downloads the daemon asset
  from the GitHub REST API (`sergeant release fetch`, `crates/sergeant-daemon/src/release/`). It
  reads the repository **anonymously first**, so a public repository never involves the
  installation's App, its private-key secret or its IAM. Only a 404 (a private repository) makes
  it authenticate as the installation's own GitHub App, the
  `SERGEANT_GITHUB_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY_SECRET_REF` identity the daemon
  already holds. That App needs `contents: read` on the release repository, and the run then
  uses it for every request, the asset included. `SERGEANT_RELEASE_REPO` overrides the repository
  (default `terros-inc/sergeant`; GitHub redirects the API after a transfer).
- **Selection is not bounded by a page.** A named release is read by its tag
  (`/releases/tags/{tag}`), however old. Policy pages newest-first until it reaches its newest
  eligible release, so that release and every newer one are seen, which makes the no-downgrade
  check sound. It stops after 1,000 releases.
- **Verification (fail closed).** A release must be marked `immutable` by GitHub. A mutable one,
  including every release published before the setting was turned on, is never installed by
  policy or by name. The download's sha256 must equal the release's recorded digest; a mismatch
  is re-downloaded once and then rejected. The artifact must be a readable tarball whose
  `PROVENANCE.json` names the release's commit and which ships `host/upgrade.sh`. Otherwise
  nothing is installed.
- **One upgrade procedure.** `deploy/host/upgrade.sh`, shipped in each release and run from the new
  artifact (like `install.sh`): drain → `install.sh` → `/health` → `PROVENANCE.json` (now also
  release tag, digest and trigger) → critical-loop gate. Both the pull and the operator's
  `deploy/scripts/deploy.sh` S3 path run it. A release from before UNF-637 has no `upgrade.sh`
  and can only be installed by an older checkout's `deploy.sh`.
- **Manual pull.** `sgt admin upgrade [<installation>] [--release <tag>] [--dry-run] [--history]`
  runs the host's `pull.sh` over the existing SSM transport (ADR-0027) with the operator's AWS
  credentials for that installation. Without `--release` it installs the newest release that is not
  yanked; a named older release is a rollback.
- **Policy is installation configuration** (`sgt config set`, ADR-0042), in the runtime section,
  read fresh from SSM on every run so no restart is needed:
  `SERGEANT_UPGRADE_POLICY` = `manual` (default) | `every-release` | `soak`, with
  `SERGEANT_UPGRADE_SOAK_HOURS` (default 24) and optional `SERGEANT_UPGRADE_REQUIRE_LOOPS`.
  Personal (the canary) uses `every-release`; Terros uses `soak`. Policy installs the newest release
  that has been out at least the soak, is immutable, is not yanked, and has not already been
  rejected or failed on this installation. It never moves an installation backwards.
- **What runs the policy.** `sergeant-pull.timer` (hourly, randomized) starts
  `sergeant-pull.service`, a oneshot running `/opt/sergeant/host/pull.sh --policy` as root,
  separate from `sergeant.service`, so restarting the daemon never interrupts the upgrade doing
  it. A timer was chosen over a daemon loop because a process should not replace and restart
  itself.
- **Drain.** A policy upgrade defers (exit 75, retried next hour) when drain does not become ready
  or when an operator's drain is already in place — restarting would silently end that drain. A
  host-wide lock keeps two upgrades from overlapping.
- **Yank.** A release whose notes contain a line starting `Yanked:` is never installed by policy
  and is refused by name (`scripts/yank-release.sh <tag> <reason>`; `--unyank` reverses it).
  Yanking edits only the notes. The tag and assets stay immutable. An installation already
  running a yanked release keeps it until a newer one or an explicit `--release` replaces it.
  Personal's failures do not yank automatically, because Personal holds no credential that can
  write to the repository. Someone with repository write access yanks.
- **History.** Every attempt appends a JSON line to `/var/lib/sergeant/upgrade-history.jsonl` on the
  persistent data volume: time, event, trigger, invoker, release tag, digest, commit and the
  previous commit. `pull.sh` records what it decides before an upgrade starts. `error` is
  transient (GitHub, network or credentials) and is retried. `rejected` is a deterministic
  refusal of the release's own artifact and is not retried by policy. `upgrade.sh` records the
  rest: `installed`, `deferred`, `aborted` (retried), and `failed` (installed, then failed
  install, health or the loop gate; not retried). An operator can retry a skipped release by
  name, and a later success clears it. `sgt admin upgrade <installation> --history` prints the
  history with the installed provenance. There is no automatic rollback.

**CI stops deploying in the same change.** `deploy-stage.yml` is deleted. The release step
publishes with the default `GITHUB_TOKEN`: it no longer mints a GitHub App token, because nothing
downstream has to be triggered. The daily SSM smoke job that read Personal's configuration is
removed, and no workflow references `SERGEANT_CD_*` or an AWS role. No temporary bridge was kept.
It would only have saved Personal one bootstrap install, and keeping it would have needed a second
PR timed to a live proof. Personal is bootstrapped once with the existing operator path
(`publish-release-to-s3.sh` + `deploy.sh`). Deleting the repository's variables, secrets and
`stage-deploy` environment, and turning off the installation's `enable_github_actions_*` roles, are
one-time captain steps (runbook). Deleting the now-unused `github_oidc.tf` code is a follow-up.

## Consequences

- The release repository holds no installation's targets or credentials, so it can be public. An installation's upgrade authority stays in its own AWS account.
- Personal and Terros run the same immutable artifact, identified by its digest. Terros runs it
  only after it has been out for the soak period without being yanked.
- A release can only be pulled if it is immutable and carries `host/upgrade.sh`. The oldest
  possible rollback target is the first release published after the immutable-releases setting
  was turned on. Going further back needs the operator S3 path with that release's own
  `deploy.sh`.
- Yanking is a human action on the repository. "A failed Personal release is never promoted" holds
  when that failure is yanked within the soak window.
- A transient failure inside `install.sh` (for example a package mirror outage) records `failed`,
  and policy will not retry that release. `sgt admin upgrade --release <tag>` retries it by hand.
- The first pull-capable install on each host is a bootstrap through the S3 path, with an exact,
  verified release tag. The runbook spells out that cutover, including installing the new `sgt`
  before its first `sgt admin upgrade`.
