import { commentIdFor, type AgentComment, type LinearPort, type RunRecord } from "@terros/sergeant-contracts";

/**
 * Once per failed run; Linear derives the comment id from this key across retries and restarts. The
 * key predates Claude's auth failures (TECH-5113) and is kept so no earlier alert is posted twice.
 */
export const authAlertKey = (issueId: string, runId: string) => `codex-auth-failure:${issueId}:${runId}`;

export function authAlertComment(run: RunRecord): string {
  const codex = run.provider === "openai/codex";
  const provider = codex ? "codex" : "claude";
  const account = run.account;
  // A registered account's id is `person:<Linear user id>:<account name>` (accounts.ts).
  const name = account?.id.split(":").at(-1) ?? provider;
  const fix =
    account?.group === "registered"
      ? `It is ${account.holder}'s registered account: they can register it again with \`sgt account register ${provider}${name === provider ? "" : ` --name ${name}`}\` or remove it with \`sgt account remove ${name}\`.`
      : codex
        ? "Log in again as the installation's ChatGPT account and replace its configured Secrets Manager secret, or switch `codex-local` to an OpenAI API key."
        : "Create a new token with `claude setup-token` as the installation's Claude account and replace its configured Secrets Manager secret.";
  return [
    `**${codex ? "Codex" : "Claude"} authentication failed**`,
    "",
    `Run \`${run.runId}\` could not authenticate with ${account ? `model account \`${account.id}\` (${account.holder})` : `the installation's ${codex ? "Codex" : "Claude"} credential`}. No token value was recorded.`,
    "",
    `${fix} Sergeant will not repair or overwrite the credential automatically; for the next hour it runs on the provider's next account, if there is one.`,
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
    await linear.postComment({ issueId, key, body: authAlertComment(run) }).then(
      () => log(`${run.runId}: posted model authentication alert`),
      (e: Error) => log(`${run.runId}: model authentication alert not posted: ${e.message}`),
    );
  }
}
