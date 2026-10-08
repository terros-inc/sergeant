# Sergeant Operations Routine

This directory contains the `/sarge` routine for Sergeant operators: a structured review workflow that turns all of Sergeant's Linear activity, GitHub PRs, server state, and quota status into one short report plus batched decisions.

## Files

- **[SKILL.md](SKILL.md)** — Main entry point. The routine's workflow: gather stats, report status, review PRs in the background, present decision batches, and act on answers.
- **[references/](references/)** — Supporting documents:
  - `decision-batches.md` — How to present, rank, and batch decisions
  - `review-rubric.md` — Rubric for PR reviews (Sergeant-specific focus; links to general principles)
  - `reviews.md` — Background review sweep process
  - `answers.md` — How to act on operator decisions (budget asks, merges, cancels, incident checks)
- **[scripts/](scripts/)** — Operational scripts:
  - `snapshot.sh` — Gather non-Linear state (PRs, task events, server metrics, quota). **⚠️ Executes commands on production via AWS SSM.**
  - `quota-from-sergeant.py` — Extract quota readings from Sergeant's latest run

## Configuration

### Environment Variables

Set these before using the routine:

**For SKILL.md:**
- `SARGE_NOTES_PATH` — Path to your review ledger, calibration log, and check log (e.g., `~/sarge-notes.md` or `~/.config/sergeant/notes.md`)

**For snapshot.sh (all required, no defaults):**
- `SARGE_REPO` — GitHub repository (e.g., `terros-inc/sergeant`)
- `SARGE_AWS_PROFILE` — AWS profile name (e.g., `terros-sergeant`)
- `SARGE_REGION` — AWS region (e.g., `us-west-2`)
- `SARGE_INSTANCE_ID` — EC2 instance ID (e.g., `i-0abc123def456789`)
- `SARGE_LOG_GROUP` — CloudWatch log group (e.g., `/sergeant/v2`)
- `SARGE_SSO_SESSION` — AWS SSO session name (e.g., `terros`)

**For quota-from-sergeant.py (required):**
- `SGT_API_URL` — Sergeant API base URL (e.g., `https://sergeant.terros.com`)

### Example Configuration

Add to your shell profile or assistant configuration:

```bash
export SARGE_NOTES_PATH="$HOME/.config/sergeant/notes.md"
export SARGE_REPO="terros-inc/sergeant"
export SARGE_AWS_PROFILE="terros-sergeant"
export SARGE_REGION="us-west-2"
export SARGE_INSTANCE_ID="i-0abc123def456789"
export SARGE_LOG_GROUP="/sergeant/v2"
export SARGE_SSO_SESSION="terros"
export SGT_API_URL="https://sergeant.terros.com"
```

## Usage

From your AI assistant (Claude, Cursor, ChatGPT, etc.):

```
Run the /sarge routine
```

or

```
Check on Sergeant
```

The assistant will follow SKILL.md to gather state, report status, kick off background reviews, and present decision batches.

## Why Here

This routine is Terros operational material (Sergeant infrastructure, priority rubric, incident notes), so it belongs with Sergeant's code rather than in personal configuration repos. It's been made portable across assistants and operators.
