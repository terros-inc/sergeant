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
  event id is that comment's id**. That one choice gives a stable dedup key across retries and
  restarts; the key for mapping a Slack reply back; a guarantee that a notification never says more
  than the record; and no new Linear or GitHub reads.
- **Linear stays the system of record.** Answers come back only as Linear comments, typed there or
  relayed from Slack by the harness as the person who wrote them (§6). The existing Linear webhook
  (TECH-5942) then wakes the task.
- **Each person registers their own subscriptions through the authenticated `sgt` API** (§4), as
  they register model accounts today. Sergeant issues each subscription its own HMAC secret, shows
  it once, and keeps it in one Secrets Manager secret that only the host reads and writes.
- **Every event goes out at once, at any hour** (§5). Quiet hours were considered and dropped by the
  project owner's decision.

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
| `task.failed` | The task has ended, not done and not accepted, and Sergeant will do no more on it until a human starts it again | `task-failed:<issue>:<revision>`, a terminal-failure comment the implementation adds (see below) | `[]` (informational) |

Each source comment maps to exactly one event. A human handoff that failed twice (`humanFailure` in
`handoff.ts`) posts under the same `merge-handoff:` key, so it is a `pr.ready_for_human`: the PR is ready
and a human finishes the handoff by hand. `task.failed` is for **terminal** failures only. On `main`
today no comment marks one: a failure that needs a human is already a blocking question
(`task.needs_decision`) or a handoff (`pr.ready_for_human`). So the implementation adds one keyed comment
at the point where a task ends that way, and `task.failed` announces it. Until such an ending exists,
the event is defined but never sent.

Not events: stops a human caused (undelegation, cancel, `sgt task cancel`), progress comments, the
edit-noted comment, rate-limit pauses (they resume by themselves), non-blocking questions, and
model-login failures (`codex-auth-failure:<issue>:<run>`, `auth-alert.ts`). A login failure is not
terminal: Sergeant runs on the provider's next account for the next hour, and the comment asks the
account's holder to register it again, which is not the task's assignee's decision. The rule is **no
comment, no notification**: a future failure that has no comment today gets one first.

## 2. Payload schema (`sergeant-notify/1`)

`Content-Type: application/json; charset=utf-8`. The body is UTF-8 JSON, at most 16 KiB, built once
per subscription and identical on every attempt; only the headers change.

```ts
type Notification = {
  schemaVersion: "sergeant-notify/1";
  /** The source Linear comment's id: stable forever, the same for every subscription. The dedup key. */
  eventId: string; // UUID
  eventType: "pr.ready_for_human" | "task.needs_decision" | "task.budget_exhausted" | "task.done" | "task.failed";
  /** When the source comment was posted (ISO 8601, UTC). */
  occurredAt: string;
  /** The subscription this delivery is for (§4), so one harness can serve several. */
  subscriptionId: string;
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
subscription that lists it (§4).

**Test deliveries are not events.** `sgt notify test` (§4) sends a different, smaller body, so a
harness can check its URL and secret without a task. It is signed and sent exactly like an event, with
`Sergeant-Event-Type: test`, but carries no task fields and is never retried or recorded:

```ts
type TestDelivery = {
  schemaVersion: "sergeant-notify/1";
  test: true;
  deliveryId: string; // UUID, fresh per test
  subscriptionId: string;
  sentAt: string; // ISO 8601, UTC
};
```

A harness tells the two apart by `test: true` (or the header) and answers `2xx` without acting. Whether
to keep it at all is D4 (§8).

### Signed example

The secrets are placeholders. The event id is `commentIdFor("budget-question:9b1d6c2e-4a7f-4d3b-8e5a-2c6f1b0d9e74:2026-10-13T19:02:40.000Z:0")`.
The body is the single line below, with no trailing newline (1041 bytes):

```
{"schemaVersion":"sergeant-notify/1","eventId":"0b5edfd1-890d-4d65-b4c6-98503c429a28","eventType":"task.budget_exhausted","occurredAt":"2026-10-13T21:05:12.000Z","subscriptionId":"sub_7Q2mX9","issue":{"id":"9b1d6c2e-4a7f-4d3b-8e5a-2c6f1b0d9e74","identifier":"ENG-123","url":"https://linear.app/example-org/issue/ENG-123/example-task","title":"Example task"},"pullRequest":{"repo":"example-org/example-repo","number":42,"url":"https://github.com/example-org/example-repo/pull/42","headSha":"0123456789abcdef0123456789abcdef01234567"},"needed":"Budget window used up ($25.00 of $25.00): reply Extend to continue or Accept as-is to stop here.","replyOptions":[{"label":"Extend","reply":"Extend"},{"label":"Accept as-is","reply":"Accept as-is"}],"reply":{"linearIssueId":"9b1d6c2e-4a7f-4d3b-8e5a-2c6f1b0d9e74","linearCommentId":"0b5edfd1-890d-4d65-b4c6-98503c429a28","url":"https://linear.app/example-org/issue/ENG-123/example-task#comment-0b5edfd1"},"recipient":{"linearUserId":"5e8a2b7c-1d4f-4c9e-a3b6-7f0e9d2c8a15","name":"Example Assignee"}}
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
Sergeant-Signature: t=1791925513,v1=13adcd015d26e1ddd8a3d01fce4a37c6d69e4a3fdf99100d41f0a5ef517f860e,v1=159d56d2f1887f21a2eb8efe3a155055a6ddf5544d7ab7674a7bafebca4e9705
```

The first `v1` is HMAC-SHA256 with the key `example-secret-current-do-not-use` over `1791925513.`
followed by the body; the second uses `example-secret-next-do-not-use`, a secret being rotated in. Both
were computed from the exact body above, and the pair is the test vector for the reference verifier in
§3.

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

Reference verifier (Node; checked against the test vector in §2):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/** True when `header` (Sergeant-Signature) signs `rawBody` with one of `secrets`, within 300 s of `now`. */
export function verifySergeant(rawBody: Buffer, header: string, secrets: string[], now = Date.now()): boolean {
  const parts = header.split(",").map((p) => p.split("=", 2) as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  if (!t || !/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const received = parts.filter(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v)).map(([, v]) => Buffer.from(v, "hex"));
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
    return received.some((r) => timingSafeEqual(r, expected));
  });
}
```

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
| `GET /v1/notifications` | → the caller's subscriptions (approvers: everyone's), never a secret: id, name, URL, events, created, and delivery health (§5) | — | team members |
| `POST /v1/notifications/subscribe` | `name`, `url`, `events?` (default all five) → the subscription and its **secret, shown once** | stores the subscription with a fresh secret; replaces the caller's subscription of that name, with a new secret | team members, as themselves |
| `POST /v1/notifications/rotate` | `name` → the **new secret, shown once** | adds a second secret; both sign until `finish` or 7 days pass | the owner |
| `POST /v1/notifications/rotate/finish` | `name` → done | drops the older secret | the owner |
| `POST /v1/notifications/test` | `name` → the HTTP status the URL answered | sends one signed test delivery (§2): no task fields, not one of the five events, not retried or recorded | the owner |
| `POST /v1/notifications/remove` | `name` (approvers: `id`) → `removed` | deletes the subscription and its secrets | the owner, or an approver |

```
sgt notify list
sgt notify subscribe <name> --url <https-url> [--events a,b]
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
  yields the same `eventId` across retries, restarts and duplicate turns. A clarifying follow-up
  is a new comment, so a new event.
- Subscribers dedup on `eventId` for at least 7 days and treat a repeat as success (`2xx`).
- Delivery is at least once, never exactly once, with no ordering promise; `occurredAt` orders events
  within a task.

**What Sergeant keeps.** Each task directory (`tasks/<issue>/`) gets a small `notifications.json`,
beside `state.json` rather than inside it. Endings move `state.json` aside under another name: an
accepted or self-closed task at once (`state.accepted-…`, `accepted.ts`), a stopped one at once
(`state.stopped-…`, `cancel.ts`), and a merged one when its issue is reopened (`state.completed-…`,
`task-state.ts`). A record kept inside `state.json` would leave the sender's view exactly when a
`task.done` for an accepted or self-closed task still needs delivering. `notifications.json` is never renamed by an
ending, so there is one place to scan whatever happened to the task. It holds, per `eventId`, the
payload and, per subscription:

- `firstAttemptAt` and `attempts`: when the first attempt began, and how many have begun;
- `nextAttemptAt`: when the next one is due;
- the outcome, once there is one: `deliveredAt`, `gaveUp` or `dropped` (stale or revoked).

The sender is its only writer. A task loop hands the sender a new event, or a mark that an event went
stale, and the sender records it, so the loop and the sender never race on the file. It is written when
an event is first derived, and **before** each attempt starts (`attempts` incremented, `nextAttemptAt`
set from the schedule), so an attempt cut off by a crash still counts. An event is pruned 7 days after
every subscription has an outcome, and the file is deleted when it is empty. Its keys are kept across
releases by the TECH-5163 rule.

The "what if we lose it?" test (00, 02): losing it costs at most one duplicate, which subscribers drop,
or one missed notification, which falls back to today: the question still sits in Linear, so no
decision is abandoned. No new ledger, queue or outbox.

**Retry policy.** Sergeant retries on a network error, a timeout, `408`, `429` (honoring `Retry-After`
up to 1 h) or `5xx`, after the first attempt:

| Retry | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Wait | 30 s | 2 min | 10 min | 30 min | 1 h | 2 h | 4 h | 8 h |

Each wait has ±20% jitter.

**Limits.**

- **Cap:** at most 9 attempts, and none later than 24 h after `firstAttemptAt`; then the event is
  `gaveUp` for that subscription. Both are checked against the persisted record, so the cap holds
  across restarts.
- **Permanent failures:** any other `4xx` gives up at once. `410 Gone` also pauses the subscription
  until its owner runs `sgt notify test` successfully, so a removed endpoint is not hammered.
- **Staleness:** before each attempt Sergeant checks that the event is still current, using only what
  the task loops have recorded, with no new reads. Stale means: a question a human has answered since,
  a budget question whose window was extended or accepted, a PR event whose head changed or whose PR
  closed, or any actionable event whose task has finished. Each of those arrives as a webhook that
  wakes that task's loop, whose pass marks the event stale; the 15-minute safety-net polls cover a
  missed webhook, as for everything else. A stale event is dropped, not retried. `task.done` and
  `task.failed` never go stale.
- **Restarts:** retry timers live in memory; the schedule does not. After a restart the sender scans
  every `tasks/*/notifications.json` and resumes each event that has no outcome yet where it stopped:
  attempt `attempts + 1`, at `nextAttemptAt` or at once if that has passed, unless it is stale or the
  cap is already reached, in which case it is marked `gaveUp`. A restart never resets an event to
  attempt 1. An attempt in flight at the crash may arrive twice; that costs the subscriber one dedup.

**Isolation.** One service-wide sender, apart from the task loops, delivers everything, so a slow or
failing subscriber never delays a turn. At most 4 requests are in flight per subscription.

**Health.** `sgt notify list` shows each subscription's delivered, retrying and given-up counts and its
last error, and `sgt admin status` the service-wide totals, as for inbound webhooks
(`webhook-health.ts`). A give-up posts no Linear comment: Linear already holds the question.

**No quiet hours.** Sergeant sends every event the moment it is derived, at any hour, and never holds
one for a time of day. Quiet hours (holding delivery outside 07:00–19:00 PT, as first agreed, later
proposed as an optional per-subscription setting) were considered and dropped by the project owner's
decision. A harness that should not wake someone overnight holds or routes events itself.

## 6. The Slack-thread reply path (settled)

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

## 7. How this fits TECH-5942 and TECH-5974

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
  - Restart redelivery reads only the `notifications.json` files; the loops' own post-restart passes go
    through the pacer as they already do.
  - Registration calls cost one Linear read each, the caller lookup every `sgt` call already makes.

  **Sequencing:** the agreed precondition, that TECH-5974 land first, is met. Implementation can start
  as soon as this design is approved.
- **Persistence charter (02):** the per-task `notifications.json` is a convenience that passes "what
  if we lose it?" (§5). The subscription list is configuration people own, kept like registered model
  accounts; losing it means people subscribe again, and no decision is lost. Linear remains the record.

## 8. Decisions for the captain

1. **D1 — Registration through `sgt`, per person (recommended), or static config.** Recommended:
   `sgt notify …` as in §4, each person registering only their own, secrets issued by Sergeant and shown
   once, stored in one host-only Secrets Manager secret. Your reading was not a misunderstanding;
   static config is less code but harder to run, since every change needs an approver, a Terraform
   change and a restart.
2. **D2 — Team-wide harnesses.** v1 has only personal subscriptions, which receive their owner's tasks.
   Should anyone be able to subscribe to *every* task (a shared team channel bot)? Recommended: not in
   v1; if wanted, approvers only, through the same API.
3. **D3 — Slack replies from people with no linked Linear identity.** Recommended: never count; the
   harness answers in Slack with the Linear link (§6). Also confirm Linear's Slack-sync attribution on a
   test issue before allowing that zero-code path.
4. **D4 — Test deliveries.** `sgt notify test` sends a test delivery (§2) that is not one of the five
   agreed events: no task fields, never retried or recorded. Keep it, or drop the command and its body?
   Recommended: keep it. It is the only way a person can check a new URL and secret before a real task
   needs them, and the only way to resume a subscription paused by `410 Gone` (§5). Without it, they
   would remove and subscribe again.
