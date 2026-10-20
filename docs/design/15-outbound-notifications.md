# 15 — Outbound notifications to agent harnesses (proposal)

**Status: proposal (TECH-6005), pending approval. Nothing here is built.** Implementation goes in a
follow-up issue once this design is approved. Written against `main` at `8797d94`. Customer, company
and person details are placeholders.

## 0. Summary

Today a person, or their agent, has to keep asking Sergeant whether it needs anything. With this
design Sergeant pushes a notification instead. When a task needs a human, Sergeant POSTs one signed
JSON event to every **subscription** registered by the issue's assignee. Subscriptions belong to
agent harnesses (for example a scheduled agent routine with a webhook trigger, or Firstmate).

- **Five events** (§1). Each one announces a Linear comment Sergeant has already posted, and **the
  event id is that comment's id**. That one choice gives a stable dedup key across retries, restarts
  and holds; the key for mapping a Slack reply back; a guarantee that a notification never says more
  than the record; and no new Linear or GitHub reads.
- **Linear stays the system of record.** Answers come back only as Linear comments, typed there or
  relayed from Slack by the harness as the person who wrote them (§7). The existing Linear webhook
  (TECH-5942) then wakes the task.
- **Each person registers their own subscriptions through the authenticated `sgt` API** (§4), as
  they register model accounts today. Sergeant issues each subscription its own HMAC secret, shows
  it once, and keeps it in one Secrets Manager secret that only the host reads and writes.
- **Quiet hours become an optional per-subscription setting, off by default** (§6). A harness that
  pages a phone can ask Sergeant to hold overnight; one that queues or routes messages itself gets
  everything at once.

## 1. Events

Each event is emitted only after its Linear comment is confirmed posted. If the post fails, nothing is
sent; the comment is retried as it is today, and the event follows it. The keys below are the
comments' existing idempotency keys on `main`; the event id is `commentIdFor(key)`.

| `eventType` | When | Source comment (key, file) | `replyOptions` |
|---|---|---|---|
| `pr.ready_for_human` | A PR head is ready for a human's review or merge: a `human` merge-policy handoff, a protected-CI handoff, a repeated merge refusal or failure, or a task parked for human review | `merge-handoff:<issue>:<repo>#<n>:<head>` (`handoff.ts`) | `[]`: the answer is a GitHub review or merge, which the GitHub webhook already delivers |
| `task.needs_decision` | Sergeant asked a blocking question, or a clarifying follow-up in that thread | `question:<issue>:<revision>` (`question.ts`) | the question's options, in order (empty for free text) |
| `task.budget_exhausted` | The budget window ran out and Sergeant asked whether to continue | `budget-question:<issue>:<taskStart>:<windowSeq>` (`budget.ts`) | `Extend`, `Accept as-is` |
| `task.done` | The PR merged and the outcome comment was posted, or a human accepted the work as-is | `outcome:<issue>:<repo>#<n>:<mergedSha>` (`after-merge.ts`); `accepted:<issue>:<reply>` or `closed:<issue>:<revision>` (`accepted.ts`) | `[]` (informational) |
| `task.failed` | Sergeant cannot go on until a human fixes something it cannot: a model-login failure (`codex-auth-failure:<issue>:<run>`, `auth-alert.ts`), a human handoff that failed twice and needs manual help (`handoff.ts`, `humanFailure`), or any other stop Sergeant explains in a comment | that comment | `[]`, or the options the comment offers |

Not events: stops a human caused (undelegation, cancel, `sgt task cancel`), progress comments, the
edit-noted comment, rate-limit pauses (they resume by themselves), and non-blocking questions. The rule
is **no comment, no notification**: a future failure that has no comment today gets one first.

## 2. Payload schema (`sergeant-notify/1`)

`Content-Type: application/json; charset=utf-8`. The body is UTF-8 JSON, at most 16 KiB, built once
per subscription and identical on every attempt; only the headers change.

```ts
type Notification = {
  schemaVersion: "sergeant-notify/1";
  /** The source Linear comment's id: stable forever, the same for every subscription. The dedup key. */
  eventId: string; // UUID
  eventType: "pr.ready_for_human" | "task.needs_decision" | "task.budget_exhausted" | "task.done" | "task.failed" | "ping";
  /** When the source comment was posted (ISO 8601, UTC). */
  occurredAt: string;
  /** The subscription this delivery is for (§4), so one harness can serve several. */
  subscriptionId: string;
  /** Set when the subscription's quiet hours held the event: when the hold began. Otherwise null. */
  held: { reason: "quiet_hours"; since: string } | null;
  issue: { id: string; identifier: string; url: string; title: string };
  /** The PR the event is about, if any. */
  pullRequest: { repo: string; number: number; url: string; headSha: string } | null;
  /** One line (at most 280 characters) saying what is needed. Never the full comment. */
  needed: string;
  /** What a human can answer. `reply` is text Sergeant reads as that choice when posted in Linear. */
  replyOptions: { label: string; reply: string }[];
  /** Where an answer goes: the Linear question thread. For a PR event, answer on the PR instead. */
  reply: { linearIssueId: string; linearCommentId: string; url: string };
  /** The issue's assignee when the event was emitted, on whose behalf it is sent. */
  recipient: { linearUserId: string; name: string };
};
```

Headers:

| Header | Value |
|---|---|
| `Sergeant-Signature` | `t=<unix seconds>,v1=<hex>[,v1=<hex>]`: one `v1` per active secret (§4) |
| `Sergeant-Event-Id` | the same as `eventId` |
| `Sergeant-Event-Type` | the same as `eventType` |
| `Sergeant-Delivery-Id` | a fresh UUID per attempt, for the subscriber's logs only |
| `Sergeant-Attempt` | `1`, `2`, … |
| `User-Agent` | `Sergeant-Notify/1` |

Compatibility: fields may be added within `/1`, so subscribers must ignore unknown fields. Removing or
renaming a field needs `/2`. A new event type stays within `/1`, because it is sent only to a
subscription that lists it (§4). The one extra type, `ping`, is sent only by `sgt notify test` (§4).

### Signed example

The secrets are placeholders. The event id is `commentIdFor("budget-question:9b1d6c2e-4a7f-4d3b-8e5a-2c6f1b0d9e74:2026-10-13T19:02:40.000Z:0")`.
The body is the single line below, with no trailing newline (1053 bytes):

```
{"schemaVersion":"sergeant-notify/1","eventId":"0b5edfd1-890d-4d65-b4c6-98503c429a28","eventType":"task.budget_exhausted","occurredAt":"2026-10-13T21:05:12.000Z","subscriptionId":"sub_7Q2mX9","held":null,"issue":{"id":"9b1d6c2e-4a7f-4d3b-8e5a-2c6f1b0d9e74","identifier":"ENG-123","url":"https://linear.app/example-org/issue/ENG-123/example-task","title":"Example task"},"pullRequest":{"repo":"example-org/example-repo","number":42,"url":"https://github.com/example-org/example-repo/pull/42","headSha":"0123456789abcdef0123456789abcdef01234567"},"needed":"Budget window used up ($25.00 of $25.00): reply Extend to continue or Accept as-is to stop here.","replyOptions":[{"label":"Extend","reply":"Extend"},{"label":"Accept as-is","reply":"Accept as-is"}],"reply":{"linearIssueId":"9b1d6c2e-4a7f-4d3b-8e5a-2c6f1b0d9e74","linearCommentId":"0b5edfd1-890d-4d65-b4c6-98503c429a28","url":"https://linear.app/example-org/issue/ENG-123/example-task#comment-0b5edfd1"},"recipient":{"linearUserId":"5e8a2b7c-1d4f-4c9e-a3b6-7f0e9d2c8a15","name":"Example Assignee"}}
```

```
POST /hooks/sergeant HTTP/1.1
Host: harness.example.com
Content-Type: application/json; charset=utf-8
User-Agent: Sergeant-Notify/1
Sergeant-Event-Id: 0b5edfd1-890d-4d65-b4c6-98503c429a28
Sergeant-Event-Type: task.budget_exhausted
Sergeant-Delivery-Id: 6a0f3e1b-2c4d-4b8e-9f7a-1d2c3b4a5e6f
Sergeant-Attempt: 1
Sergeant-Signature: t=1791925513,v1=68ec656f51b7ebfc568a6c1ed4e27317095c951e4ee5f81ad5b8c496b5173ffe,v1=9bd3bd3aaf1714432676ffd86301fd34de50759736993a6ecbb6b1db11213816
```

The first `v1` is HMAC-SHA256 with the key `example-secret-current-do-not-use` over `1791925513.`
followed by the body; the second uses `example-secret-next-do-not-use`, a secret being rotated in. Both
were computed from the exact body above, and the pair is the test vector the reference verifier ships
with.

## 3. Signing and verification

**Signing.** `v1 = hex(HMAC-SHA256(secret, "<t>." + rawBody))`, where `t` is the send time in Unix
seconds. Each attempt is signed again, because `t` changes. Unlike GitHub's scheme, the timestamp is
inside the signature, so a subscriber can refuse replays: the protection Sergeant's own Linear
endpoint gets from `webhookTimestamp` (`webhooks.ts`, `LINEAR_REPLAY_MS`).

**Verifying (what a subscriber must do):**

1. Read the raw body bytes before any JSON parsing, and cap their size.
2. Parse `Sergeant-Signature`. Refuse the request if `t` is more than 300 s from the subscriber's clock.
3. Compute the expected `v1` for each secret it holds. Accept if any received `v1` matches any
   expected value, compared in constant time (as `verifySignature` in `webhooks.ts` does).
4. Only then parse the body. Dedup on `eventId` (§5), answer `2xx` quickly, and process asynchronously.

The docs ship a ~30-line reference verifier and the test vector above.

**Transport rules (Sergeant's side).**

- `https://` URLs only. Redirects are not followed.
- The resolved address must be public: Sergeant refuses loopback, private, link-local (which includes
  the instance metadata address) and unique-local addresses, checked on the address it actually
  connects to, so a DNS answer cannot point a delivery at the host's own loopback API or its network
  (§4, "Why this is safe to open up").
- A 10 s timeout. The response body is read up to 4 KiB, then ignored.
- The payload never holds secrets, run ids, cost detail beyond the `needed` line, or comment bodies.

## 4. Subscriptions: registration, authentication and secrets

### Recommendation: per-person subscriptions through the `sgt` API

The captain's reading is right, and it reverses this proposal's first draft, which recommended static
installation config. That draft assumed an operator configures a few shared harnesses. The agreed
recipient rule (notify on behalf of the issue's assignee) and harnesses such as Firstmate or a personal
agent routine make subscriptions **personal**: each person has their own harnesses and URLs, and they
change as people try new ones. Installation config is the wrong owner for that. Every change would need
an approver to edit the config, update the Terraform list of secrets the host may read, and restart.

It is also not much more to build, because the shape already exists: `sgt account register` stores
each person's model accounts in one Secrets Manager secret that only the host reads and writes, keyed
by the Linear user id taken from their login (`accounts.ts`, TECH-5113, TECH-5204). Subscriptions copy
that pattern.

**Static config, for comparison.** A `notifications.subscribers` list in the installation config, each
entry with a URL, a `SecretRef`, and the users it is for, is the less code of the two: no endpoints, no
secret writes. But it is not easier to run. Each subscriber's secret must be created by hand, added to
the host's Terraform allow-list (`deploy/terraform/variables.tf`, today four to nine names), and loaded
by a restart, and a person cannot add or rotate their own. It remains the right choice only for a
shared, team-wide harness, and v1 has none (Decisions for the captain, D2).

### Who may register for whom

- **A person registers, lists, rotates and removes only their own subscriptions**, as with model
  accounts: the API takes the owner from the caller's `sgt login` (a team member, `auth.ts`), never
  from the request.
- **A subscription receives only events whose recipient is its owner**: tasks where they are the
  issue's assignee (or, with no assignee, the task's owner, `state.json` `owner.id`). Nobody can
  subscribe to someone else's tasks, so a subscription never sees issue content its owner could not
  already read in Linear.
- **Approvers** can list every subscription (without secrets) and remove any of them, to cut off a
  misbehaving or departed person's endpoint. They cannot register one for someone else.
- A loopback operator on the host has approver authority, as today.

### API and CLI

| Endpoint | Inputs → outputs | Side effects | Who |
|---|---|---|---|
| `GET /v1/notifications` | → the caller's subscriptions (approvers: everyone's), never a secret: id, name, URL, events, quiet hours, created, and delivery health (§5) | — | team members |
| `POST /v1/notifications/subscribe` | `name`, `url`, `events?` (default all five), `quietHours?` (§6) → the subscription and its **secret, shown once** | stores the subscription with a fresh secret; replaces the caller's subscription of that name, with a new secret | team members, as themselves |
| `POST /v1/notifications/rotate` | `name` → the **new secret, shown once** | adds a second secret; both sign until `finish` or 7 days pass | the owner |
| `POST /v1/notifications/rotate/finish` | `name` → done | drops the older secret | the owner |
| `POST /v1/notifications/test` | `name` → the HTTP status the URL answered | sends one signed `ping` event (not one of the five, `replyOptions` empty) | the owner |
| `POST /v1/notifications/remove` | `name` (approvers: `id`) → `removed` | deletes the subscription and its secrets | the owner, or an approver |

```
sgt notify list
sgt notify subscribe <name> --url <https-url> [--events a,b] [--quiet-hours 07:00-19:00 --tz America/Los_Angeles]
sgt notify rotate <name> [--finish]
sgt notify test <name>
sgt notify remove <name>
```

Each changes durable state, so each is one action through the Gate, with keys
`notify:<userId>:<name>` (subscribe and remove) and `notify-rotate:<userId>:<name>:<n>`.

### Secrets: issuance, display, storage and rotation

- **Issuance.** Sergeant generates every secret: 32 random bytes, base64url, prefixed `sgn_`. Callers
  never choose one, so none is weak or reused from elsewhere, and each subscription's secret is its own,
  never shared with another subscription or with Sergeant's inbound webhook secrets.
- **Display.** A secret appears exactly once: in the `subscribe` or `rotate` response, which `sgt`
  prints to the person's terminal with a note to put it in their harness's secret store and nowhere
  else (never Linear or Slack). It is never in a list, a log, an error, the MCP, or Sergeant's
  Linear comments. A lost secret is replaced by rotating.
- **Storage.** One Secrets Manager secret, `sergeant/v2/notification-subscriptions`, holding
  `{"subscriptions":[…]}`. Like the registered-accounts secret, Terraform creates it, the host role alone
  may read and put it, and `serve` writes it one change at a time. `serve` keeps the parsed list in
  memory and reloads it after each of its own writes; nothing else writes it.
- **Rotation without downtime.** `rotate` adds a new secret beside the current one, and from then on
  every delivery carries two `v1` values. The person adds the new secret to their harness, then runs
  `rotate --finish` (or waits 7 days), which drops the old one. A harness that accepts any `v1`
  keeps working throughout.
- **Revocation.** `remove` takes effect on the next delivery. Undelivered events for the subscription
  are dropped.

### Authentication, both ways

- **Sergeant to subscriber:** the HMAC signature, over TLS, to the URL its owner registered.
- **Subscriber to Sergeant:** there is none. Subscribers never call Sergeant. Their only way back is
  a Linear comment written as a human, which Sergeant already attributes (`conversation.ts`: bot,
  integration and agent comments are never human input; 07 §4, "Who may answer"). Registration
  itself is done by the person, with their own `sgt login`.

So a leaked subscription secret lets someone forge notifications to that one harness. It cannot make
Sergeant do anything.

### Why this is safe to open up

Moving registration from operators to team members adds one real risk: Sergeant's host now makes
HTTPS requests to URLs any team member chooses. The transport rules in §3 (HTTPS only, no redirects,
public addresses only, checked at connect time) keep a URL from reaching the host's loopback API or
the instance metadata service. A team member can already read every task's issue in Linear, and a
subscription only ever receives its owner's own, so nothing is disclosed that they could not see.
Each person may hold at most 10 subscriptions.

## 5. Delivery, retries, idempotency and limits

**Idempotency.**

- `eventId` is the source comment's id, a pure function of its key (`commentIdFor`), so the same fact
  yields the same `eventId` across retries, restarts, holds and duplicate turns. A clarifying follow-up
  is a new comment, so a new event.
- Subscribers dedup on `eventId` for at least 7 days and treat a repeat as success (`2xx`).
- Delivery is at least once, never exactly once, with no ordering promise; `occurredAt` orders events
  within a task.

**What Sergeant keeps.** Each task's `state.json` gets a small `notifications` record: per `eventId`,
the event, and per subscription its `deliveredAt`, `gaveUp` or `dropped`. It is written when the event
is first derived and updated on each outcome; its keys are kept across releases by the TECH-5163 rule.
A finished task's record moves with it into its `state.completed-…json` file, which the sender still
reads for 24 h, so a `task.done` is not lost when the task completes. The "what if we lose it?" test
(00, 02): losing it costs at most one duplicate, which subscribers drop, or one missed notification,
which falls back to today: the question still sits in Linear, so no decision is abandoned. No new
ledger, queue or outbox.

**Retry policy.** Sergeant retries on a network error, a timeout, `408`, `429` (honoring `Retry-After`
up to 1 h) or `5xx`, after the first attempt:

| Retry | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Wait | 30 s | 2 min | 10 min | 30 min | 1 h | 2 h | 4 h | 8 h |

Each wait has ±20% jitter.

**Limits.**

- **Cap:** at most 9 attempts, and none later than 24 h after the first; then the event is `gaveUp`
  for that subscription.
- **Permanent failures:** any other `4xx` gives up at once. `410 Gone` also pauses the subscription
  until its owner runs `sgt notify test` successfully, so a removed endpoint is not hammered.
- **Staleness:** before each attempt Sergeant checks that the event is still current (§6, step 2). A
  stale event is dropped, not retried. `task.done` and `task.failed` never go stale.
- **Quiet hours:** a retry that falls inside the subscription's quiet hours waits for its window, and
  that wait does not count against the 24 h cap.
- **Restarts:** retry timers live in memory. After a restart, every undelivered, unexpired, still-current
  event in the state files is retried from attempt 1; a duplicate costs the subscriber one dedup.

**Isolation.** One service-wide sender, apart from the task loops, delivers everything, so a slow or
failing subscriber never delays a turn. At most 4 requests are in flight per subscription.

**Health.** `sgt notify list` shows each subscription's delivered, retrying and given-up counts and its
last error, and `sgt admin status` the service-wide totals, as for inbound webhooks
(`webhook-health.ts`). A give-up posts no Linear comment: Linear already holds the question.

## 6. Quiet hours

### What they are for

The agreed design held notifications outside 07:00–19:00 PT. Their purpose is **not to wake people**:
a harness that turns an event into a phone push or a Slack DM would otherwise ping someone at 02:00
because a budget window ran out overnight. A side effect is that a person's morning gets one current
notification per task, not a stale overnight trail.

### Are they still needed?

Not as a fixed, installation-wide rule. Two things changed since it was agreed:

- Subscriptions are personal (§4), so people are in different time zones and keep different hours.
  One Pacific window would be wrong for some of them.
- Many harnesses decide for themselves when to interrupt someone. Firstmate queues work; a Slack app
  can rely on Slack's own notification schedule and do-not-disturb. Holding in Sergeant then only
  delays the harness's own triage.

But some harnesses cannot hold: a routine with a webhook trigger typically acts the moment it is
called. For those people, Sergeant holding is the only quiet-hours option.

**Recommendation: keep quiet hours as an optional per-subscription setting, off by default.** A
subscription without them gets every event at once. One with them (`--quiet-hours 07:00-19:00 --tz
America/Los_Angeles`, any IANA zone, so daylight saving is handled) gets events only inside its window.
The extra cost is small, because the hold reuses what retries need anyway: the per-event record in
`state.json`, the staleness check, and "next attempt at time T". Per subscription rather than per
person, because one person may want their phone harness quiet overnight and Firstmate fed at once.
Dropping quiet hours entirely is the simpler alternative (D3).

### Behavior when a subscription has them

1. **Hold.** An event derived outside the window is recorded with `held.since` and not sent. Holding is
   a property of the clock: the sender checks the window before each attempt; there is no state machine.
2. **At window open, recheck staleness without new reads.** Sergeant does not wake every task loop
   then, which would recreate the TECH-5974 stampede. Every way a held event goes stale (a human
   answers in Linear, a PR is merged or reviewed, the issue is undelegated or canceled) is itself a
   webhook that wakes that task's loop when it happens, and the loop's pass marks the event stale. The
   sender uses only what the loops have recorded; the 15-minute safety-net polls cover a missed
   webhook, as for everything else. Stale means: a question a human has answered since, a budget
   question whose window was extended or accepted, a PR event whose head changed or whose PR closed,
   or any actionable event whose task has finished.
3. **Coalesce per task.** Send only the latest still-current actionable event per task, and the
   task's `task.done` or `task.failed` if it has one (§6, "`task.done`").
4. **Send**, spread over the first 5 minutes of the window by a stable hash of `eventId`, each carrying
   `held: { reason: "quiet_hours", since }`.

**Overnight restarts.** Held events reload from the state files. Each loop's first pass after a restart,
paced by the TECH-5974 owner-read pacer, recomputes whether its events are current. A held event whose
loop has not passed yet is still sent at window open, because it was current when last seen; at worst a
person gets one notification about a question they already answered, marked `held`, and an answer to
an already-answered thread is ignored as today.

Nothing bypasses a subscription's quiet hours in v1; an "urgent" override waits until someone asks.

### `task.done` during quiet hours

Recommendation: **hold it and deliver it at window open; once a task has a `task.done` (or
`task.failed`), drop that task's earlier held actionable events as stale.** Reasons:

- A finished task's questions are moot, so the morning gets one notification for the task, the outcome,
  not a question nobody needs to answer followed by "done".
- `task.done` is informational and never stale, so holding it loses nothing, and dropping it would
  leave a harness that tracks task state believing the task is still open.
- A person who does not want completion notifications leaves `task.done` out of the subscription's
  `events` instead.

## 7. The Slack-thread reply path (settled)

Settled: **the harness posts a Slack reply into the Linear question thread as the person who wrote
it.** Sergeant never reads Slack and stores no Slack-to-Linear mapping; the mapping key travels in
every payload (`reply.linearIssueId`, `reply.linearCommentId`), and the component that posted to Slack
is the one that knows the Slack thread.

1. The harness receives the event and posts it to Slack. It remembers `Slack thread → (linearIssueId,
   linearCommentId)` for as long as the thread lives: the harness's state, not Sergeant's.
2. A person replies in the Slack thread. The harness posts the reply text verbatim as a Linear reply in
   the question's thread (`parentId = linearCommentId`), **authored as that person**, with their own
   Linear OAuth token, as "Firstmate posting through the captain's account counts as the captain" (07
   §4).
3. Linear fires its `Comment` webhook. TECH-5942's handler wakes the task; since TECH-5974 a plain
   comment wakes the loop without a delegation-history reread. The next turn reads the reply as any
   human answer: options by number or label, free text, and the approver rule for budget extensions all
   apply unchanged.
4. If the harness cannot act as the replying person (no linked Linear identity, no token), it must not
   relay the reply as a bot. A bot or integration comment is deliberately not human input
   (`conversation.ts`); relaying as one would let anyone in the Slack channel answer, budget extensions
   included, as nobody in particular. The harness instead answers in Slack with the Linear link.

**Zero-code alternative:** Linear's own Slack integration with synced threads, where a Slack reply
becomes a Linear comment and the same webhook closes the loop. It counts only if Linear attributes the
comment to the replying person's linked Linear user; one carrying a `botActor`, or from an unlinked
external user, does not. That attribution has **not been verified** and must be checked on a test issue
before anyone relies on it.

**Rejected:** a Slack app inside Sergeant, with its own event endpoint and a stored thread map: a new
inbound surface, new persisted state, and a Slack-to-Linear identity mapping the harness relay avoids.

## 8. How this fits TECH-5942 and TECH-5974

- **TECH-5942 (#216, merged): webhooks primary, polling backup.** Outbound is its other half and
  changes nothing in it. Answers come back only through the existing `POST /webhooks/linear` (and `POST
  /webhooks/github` for PR events), verified and turned into wake reasons as today, and the 15-minute
  safety-net polls still catch a missed reply. Delivery health follows `webhook-health.ts`.
- **TECH-5974 (#217, merged as `a83aa4a`): ownership proof across restarts, narrow webhook rereads.**
  What landed: the ownership proof (`ownerProvenAt`) is persisted in `state.json`, so a restart does
  not reread a still-valid one; only a Linear webhook that may change delegation (a `delegateId` change
  or a new agent session) rereads the delegation history, while a plain comment only wakes the loop;
  and one service-wide pacer (`owner-pace.ts`: 4 at once, then one every 10 s) spreads the rereads that
  fall due. For notifications this means:
  - Sending costs **no** Linear or GitHub calls: events come from what the loop already has (the
    comment it just posted, its PR facts, `state.json`).
  - A reply, typed or relayed from Slack, is a plain `Comment` webhook, so it costs a wake and no
    history reread.
  - Window-open delivery of held events wakes no loops (§6), and restart redelivery reads only the
    state files; the loops' own post-restart passes go through the pacer as they already do.
  - Registration calls cost one Linear read each, the caller lookup every `sgt` call already makes.

  **Sequencing:** the agreed precondition, that TECH-5974 land first, is met. Implementation can start
  as soon as this design is approved.
- **Persistence charter (02):** the per-task `notifications` record is a convenience that passes "what
  if we lose it?" (§5). The subscription list is configuration people own, kept like registered model
  accounts; losing it means people subscribe again, and no decision is lost. Linear remains the record.

## 9. Decisions for the captain

1. **D1 — Registration through `sgt`, per person (recommended), or static config.** Recommended:
   `sgt notify …` as in §4, each person registering only their own, secrets issued by Sergeant and shown
   once, stored in one host-only Secrets Manager secret. Your reading was not a misunderstanding;
   static config is less code but harder to run, since every change needs an approver, a Terraform
   change and a restart.
2. **D2 — Team-wide harnesses.** v1 has only personal subscriptions, which receive their owner's tasks.
   Should anyone be able to subscribe to *every* task (a shared team channel bot)? Recommended: not in
   v1; if wanted, approvers only, through the same API.
3. **D3 — Quiet hours.** Recommended: optional per subscription, off by default (§6). Alternatives:
   drop them from Sergeant entirely (harnesses hold for themselves; the simplest), or keep one
   installation-wide 07:00–19:00 PT window as originally agreed. If kept: every day, or weekdays only?
   Recommended: every day, as written.
4. **D4 — `task.done` during quiet hours.** Recommended: hold it, deliver at window open, and let it
   supersede the task's held questions (§6). Alternative: drop it when held.
5. **D5 — Slack replies from people with no linked Linear identity.** Recommended: never count; the
   harness answers in Slack with the Linear link (§7). Also confirm Linear's Slack-sync attribution on a
   test issue before allowing that zero-code path.
