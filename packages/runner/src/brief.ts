// Briefs for the walking skeleton, after 05 §2–4 and 06 §2–4, trimmed to what this runner supports.
// The Task section is the issue and every human comment verbatim; no comment is ever dropped
// (the 48 KB inline bound with `sergeant-thread.md` is not built yet). Linked issues (TECH-5149) get
// their own background section outside it, never part of what was asked.
//
// The worker's brief is in brief-worker.ts, the reviewer's in brief-reviewer.ts, and what both share in
// brief-common.ts.
export { renderTask } from "./brief-common.ts";
export { reviewerBrief, REVIEWER_RULES_VERSION, type ReviewSubject } from "./brief-reviewer.ts";
export { workerBrief, WORKER_RULES_VERSION } from "./brief-worker.ts";
