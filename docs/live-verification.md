# Live verification after a deploy

New Linear queries and GitHub fields are tested in CI only against fakes. This page is how an
operator checks them for real after each deploy, finds evidence in Sergeant's own records that a new
path ran in production, and closes "check the first live use" tickets (TECH-5279). There is no
staging workspace: the smoke check reads production and writes nothing.

1. After `sergeant-update`, run the **smoke check** on the host. It runs every named Linear read query
   in the adapter (except `SergeantCaller`, below) and every GitHub read Sergeant added since V2,
   through the production adapters and parsers, and checks the host serves the version it was updated to.
2. Once the new code has run in normal work, run the **evidence search** on the host. It searches
   Sergeant's records for the new path and prints a citation to paste on the live-check ticket.
3. **Close the live-check ticket** by the rules under [Closing a live-check ticket](#closing-a-live-check-ticket).

Neither command runs in CI or tests, and neither costs model money.

## The smoke check

Open a shell on the host (deploy/README.md, Live check on the host), then:

```sh
sudo -u sergeant -H bash -c 'cd /opt/sergeant/src/packages/sergeant &&
  node src/smoke.ts --config /etc/sergeant/installation.json --repo <owner/name> --issue <issue> --pr <number> \
    --upload <https://uploads.linear.app/... URL>'
```

- `--config` turns on the Linear and GitHub checks. It resolves the installation's secrets as `serve`
  does, and checks the Linear token is the configured agent. If that fails, the smoke check prints
  `FAIL installation connects` and stops.
- `--repo` is an enrolled repository; the first one in the config is used when you leave it out.
- `--issue` is an issue delegated to the agent, such as a controlled canary issue or any active task.
  Without it, the per-issue checks are `SKIP`.
- `--pr` is any pull request in `--repo`, such as Sergeant's latest merge. Without it, the PR checks are
  `SKIP`.
- `--upload` is a Linear upload URL (`https://uploads.linear.app/...`), such as a screenshot on the
  `--issue`: copy the image's address from Linear. Without it, the upload download check is `SKIP`.
- The host-version check reads `http://127.0.0.1:8080/status`, which answers only on the host. Change
  the URL with `--status-url`, or turn the check off with `--no-status`.
- `--api https://<host>` adds the hosted API check with the `sgt login` saved on that machine.
  Run it from a workstation where you have signed in, usually on its own:
  `pnpm --filter @terros/sergeant smoke --no-status --api https://<host>`.

The smoke check writes nothing to Linear or GitHub. Minting the control-plane App's installation
token is the only call that isn't a read, and `live-check` mints the same token. With `--api`, a login
that expires within five minutes is renewed and saved, as `sgt` does it. The smoke check prints no
secret.

### What it checks

| Check | Covers | The live read |
| --- | --- | --- |
| host serves this checkout's version | deployed version | `/status` answers `ok` with the version of the checkout `sergeant-update` installed |
| linear viewer and user names | V2 config | `SergeantViewer` and `SergeantUsers`: the token's user is the configured agent, and its name |
| linear upload download | TECH-4994, TECH-5042 | `fetchUpload`: a GET of the `--upload` URL with the agent token, redirects followed as attachment reading does. Shows status, content type, and size. `SKIP` without `--upload` |
| linear delegated issues (intake) | V2 intake | `SergeantDelegated`: open issues delegated to the agent, with blocking relations |
| linear completed issues in the feedback lookback | TECH-5049 | `SergeantCompleted` over the feedback sweep's 14-day lookback |
| linear follow-up lookup by key | TECH-5049 | `SergeantFollowupByKey` (`findFollowupIssue`), archived included, for a key nothing was filed under: it must answer "none", not fail |
| linear retro reads | TECH-5187 | `SergeantRetroDocuments`, `SergeantRetroFeedback`, `SergeantRetroFiled`. `SKIP` without `retro` in the config |
| linear issue conversation | TECH-5244 | `SergeantIssue` with the assignee's profile `url`, plus linked-issue background (`SergeantLinkedIssue`, when the issue links one) |
| linear task owner from delegation history | TECH-5192, TECH-5217 | `SergeantIssueOwnership` (creator, `botActor`, assignee) and `SergeantDelegationHistory` (`botActor`, `fromDelegate`). A refusal is a correct answer too |
| linear issue progress (close gate) | TECH-5232 | `SergeantIssueProgress`: state type and `completedAt` |
| linear issue labels and label by name | TECH-5186 | `SergeantIssueLabels` and `SergeantLabelsByName`, what `addLabel` reads before adding the feedback label. Shows whether that label exists in the workspace or the issue's team |
| linear blocked-by reads | TECH-5278 | `SergeantBlockedIssue`, `SergeantIssueId`, and `SergeantBlockedByRelation` under an id nothing was created with, what `recordBlockedBy` reads |
| linear issue workflow | TECH-4947, TECH-4989 | `SergeantIssueWorkflow`, what a move to In Progress or Todo, or a close, reads before it moves the issue |
| linear comment thread and comment by id | TECH-5052 | `SergeantCommentThread` and `SergeantCommentById` on the issue's first comment, what `resolveThread` and a comment's retry read, plus `SergeantCommentById` under a never-created id |
| linear follow-up and retro issue reads | TECH-5049, TECH-5187 | `SergeantFollowupOrigin`, `SergeantIssueById`, `SergeantRetroIssue`, and `SergeantRetroTeam` on the issue and its team, plus `SergeantRelationById` and `SergeantRetroDocumentById` under never-created ids: what filing a follow-up or a retro issue reads |
| github PR facts | TECH-5232, TECH-5218, TECH-5244 | `readPullRequest`: `mergeable_state`, human reviews and comments, required checks from rulesets, and the repository's merge policy |
| github squash message | TECH-5085 | The PR's title, body, and commits, built into the squash message a merge would send. Never sent. Shows the co-authors it keeps |
| github handoff read | TECH-5244 | The PR as a human handoff reads it: draft state, author, head, and requested reviewers and teams, and its comments, read as a handoff or a close does before posting one |
| github branch-delete read | TECH-5230 | What deleting a closed PR's branch reads before any delete: the PR's head, open PRs from or onto its branch, and the branch tip (a deleted branch is a correct answer). Nothing is deleted |
| api run list and run view | TECH-5148, TECH-5123 | `GET /v1/runs`, then `GET /v1/runs/<id>` for the first run, through the typed client with your `sgt login`. Shows the run's provider, provider choice, and account |

A lookup under a never-created id (the retry a create makes when its first attempt may have
succeeded) passes when Linear answers null or "not found"; any other error, or an entity under that
id, fails. `SergeantCaller` is the one Linear read not covered: it reads with a human's own OAuth
token, so every `sgt login` runs it. The Gate and every write, approval, merge, and comment are not
checked.

Each check parses with the production schema, so a field Linear or GitHub renamed, or a permission
the App lacks, fails here before a task needs it. A later change that adds a live read should add
its check in `packages/sergeant/src/smoke-checks.ts` and a row to this table.

### Reading the result

Each check prints one line, `PASS`, `FAIL`, or `SKIP`, followed by its name, the tickets it covers, and
a JSON detail. For a `FAIL`, the detail is the error. The last line is the overall result:

```text
PASS linear follow-up lookup by key [TECH-5049]: {"found":null}
FAIL github terros-inc/sergeant PR facts (...) [TECH-5232, TECH-5218, TECH-5244]: "GitHub API request failed (403): Resource not accessible by integration"
SMOKE FAIL: 9 passed, 1 failed, 2 skipped
```

The exit code is 0 when nothing failed and 1 when any check failed. A usage error exits with 2. A
`SKIP` doesn't fail the run, but it also checked nothing: give `--issue`, `--pr`, and `--upload` to
cover the whole table. A failed host-version check usually means serve didn't restart on the new checkout,
which deploy/README.md covers.

## Natural-use evidence

New code often runs in normal work soon after a deploy. The evidence search looks for that use in
Sergeant's own records under its state directory. It reads no credential and makes no network call:

- Each task's `tasks/<issue>/turns.jsonl` holds every action Sergeant took and its outcome. That
  covers merges, with the PR facts they were allowed on, comments and questions it posted,
  follow-ups filed, blocked-by relations, issues closed, and human-merge handoffs.
- Each run's `runs/<runId>/record.json` holds the provider, provider choice, model account, and
  report.

```sh
sudo -u sergeant node /opt/sergeant/src/packages/sergeant/src/evidence.ts \
  --match '<regex>' --since <deploy time> [--issue <issue>] [--state-dir /var/lib/sergeant/state] [--limit 10]
```

`--match` is a case-insensitive regular expression. It is tested against each outcome's JSON and each
run record's JSON. Pick text that only the new path writes. `--since` is the time of the deploy, from
`/etc/sergeant/release`, so older records don't count. Some examples:

| Path | `--match` |
| --- | --- |
| An issue Sergeant closed itself (TECH-5232) | `close_issue` |
| A filed follow-up (TECH-5049) | `create_followup` |
| A merge that read `mergeable_state` | `"mergeableState"` |
| A human-merge handoff (TECH-5244) | `"rule":"H1"` |
| A blocked-by relation recorded (TECH-5278) | `record_blocked_by` |
| A run's provider choice or account (TECH-5148) | `"providerChoice"` or `"holder"` |

Each hit has one of three kinds:

- **supporting**: the action was done, or the run succeeded.
- **contrary**: the action failed, or the run failed.
- **denied**: the Gate stopped the action. Sometimes that is the path working; a human-merge
  handoff, for example, is recorded as `denied by H1`. It is shown for you to judge, and it never
  decides the result.

Canceled and still-running runs are left out. The output is a Markdown citation, ready to paste:

```text
**Natural-use evidence** for `/close_issue/i` since 2026-10-06T08:00:00.000Z, from Sergeant's records on ip-10-0-1-23 (Sergeant 2.0.90+abc1234, searched 2026-10-08T09:00:00.000Z):
- supporting · 2026-10-07T03:12:44.120Z · TECH-5301 · turn outcome: `close_issue: done {"moved":true,"from":"In Progress","to":"Canceled"}`
Result: 1 supporting, 0 contrary, 0 denied.
```

The exit code is 0 when there is at least one supporting hit and no contrary one, and 1 otherwise. A
match is only a candidate. Before you cite a hit, read it and confirm it shows the new path, not
older code that writes similar text.

## Closing a live-check ticket

A live-check ticket asks for a new path's first live use to be checked. Close it on whichever of
these comes first:

- **Evidence.** The smoke check passes for the queries the ticket covers, or the evidence search finds
  a supporting hit for its path with nothing contrary. Close the ticket as Done. Paste the smoke
  check's lines or the evidence citation in the closing comment, with the deploy's version.
- **Stale, with no contrary evidence.** A couple of days, about two, after the deploy that shipped
  the path, nothing shows the path failing. The smoke check doesn't fail for it, the evidence search
  finds no contrary hit, and nobody has reported a problem. Close the ticket as Done anyway, and say
  so in the closing comment, for example: "Closed as stale: no contrary evidence since the deploy of
  2.0.90+abc1234 on 2026-10-06," followed by the evidence search's output. Nothing waits forever on
  a manual check.

Contrary evidence keeps the ticket open. That means a smoke check `FAIL` for its query, or a
contrary hit you confirm is the new path. Comment with the evidence, and treat it as a bug in the
change that shipped the path.
