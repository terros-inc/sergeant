import { commentIdFor, type AgentComment, type LinearPort, type RunRecord } from "@terros/sergeant-contracts";

/** Once per failed run; Linear derives the comment id from this key across retries and restarts. */
export const authAlertKey = (issueId: string, runId: string) => `codex-auth-failure:${issueId}:${runId}`;

export function authAlertComment(runId: string): string {
  return [
    "**Codex authentication failed**",
    "",
    `Run \`${runId}\` could not authenticate with the installation's Codex credential. No token value was recorded.`,
    "",
    "Log in again as the installation's ChatGPT account and replace its configured Secrets Manager secret, or switch `codex-local` to an OpenAI API key. Sergeant will not repair or overwrite the credential automatically.",
  ].join("\n");
}

/** Posts each actionable auth failure once, retrying on later polls if Linear is unavailable. */
export async function postAuthAlerts(
  issueId: string,
  runs: RunRecord[],
  agentComments: AgentComment[],
  linear: Pick<LinearPort, "postComment">,
  log: (line: string) => void,
): Promise<void> {
  for (const run of runs) {
    if (run.failureReason !== "authentication") continue;
    const key = authAlertKey(issueId, run.runId);
    if (agentComments.some((comment) => comment.id === commentIdFor(key))) continue;
    await linear.postComment({ issueId, key, body: authAlertComment(run.runId) }).then(
      () => log(`${run.runId}: posted Codex authentication alert`),
      (e: Error) => log(`${run.runId}: Codex authentication alert not posted: ${e.message}`),
    );
  }
}
