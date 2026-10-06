// The post-deploy smoke check (TECH-5279): every live Linear and GitHub read Sergeant added since V2,
// through the production adapters, and the version the host serves. Never run by tests or CI. It
// writes nothing to Linear or GitHub (minting the control-plane App's installation token is the only
// call that is not a read; live-check.ts mints the same), costs no model spend, and prints no secret.
// From packages/sergeant, on the host after `sergeant-update` (docs/live-verification.md):
//
//   node src/smoke.ts [--config <installation.json> [--repo owner/name] [--issue TECH-123] [--pr 45]
//                     [--upload https://uploads.linear.app/...]]
//                     [--status-url http://127.0.0.1:8080/status | --no-status] [--api https://<host>]
//
// Each line is PASS, FAIL, or SKIP for one check; the last line is the overall result. Exit code 0
// when nothing failed, 1 when a check failed, 2 on a usage error.
import { parseArgs } from "node:util";
import { apiClient, RepoSlug } from "@terros/sergeant-contracts";
import { currentToken } from "@terros/sergeant-contracts/credentials";
import { sergeantVersion } from "@terros/sergeant-contracts/version";
import { cachedToken, githubReadProbes } from "@terros/sergeant-github";
import { connect, loadConfig } from "./config.ts";
import { apiChecks, githubChecks, hostChecks, linearChecks, report, runChecks, type SmokeCheck } from "./smoke-checks.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    repo: { type: "string" },
    issue: { type: "string" },
    pr: { type: "string" },
    upload: { type: "string" },
    "status-url": { type: "string", default: "http://127.0.0.1:8080/status" },
    "no-status": { type: "boolean", default: false },
    api: { type: "string" },
  },
});
if (!values.config && !values.api && values["no-status"]) fail("nothing to check: give --config, --api, or leave the /status check on");
if (!values.config && (values.repo || values.issue || values.pr || values.upload)) fail("--repo, --issue, --pr, and --upload need --config");
const pr = values.pr === undefined ? undefined : Number(values.pr);
if (pr !== undefined && !(Number.isInteger(pr) && pr > 0)) fail("--pr must be a pull request number");
if (pr !== undefined && !values.repo) fail("--pr needs --repo");

const { version } = sergeantVersion();
const checks: SmokeCheck[] = [];
if (!values["no-status"]) checks.push(...hostChecks({ statusUrl: values["status-url"], localVersion: version }));

if (values.config) {
  const config = await loadConfig(values.config);
  const enrolled = Object.keys(config.repositories);
  const repo = RepoSlug.parse(values.repo ?? enrolled[0] ?? fail("the installation config enrolls no repository; give --repo"));
  // `connect` resolves the secrets and checks the Linear token acts as the configured agent; without it
  // no Linear or GitHub check can run.
  const installation = await connect(config, [repo]).catch((e: Error) => {
    console.log(`FAIL installation connects: ${JSON.stringify(e.message)}\nSMOKE FAIL: cannot connect with the installation config`);
    return process.exit(1);
  });
  checks.push(
    ...linearChecks(installation.linear, { agentUserId: installation.agentUserId, issue: values.issue, retroProjectId: config.retro?.projectId, upload: values.upload }),
    ...githubChecks(installation.github, githubReadProbes({ token: cachedToken(() => installation.controlPlaneApp.mint({ repositories: [repo] })) }), {
      repo,
      mergePolicy: config.repositories[repo]?.mergePolicy ?? "human",
      pr,
      issue: values.issue,
    }),
  );
}

if (values.api) {
  const api = values.api.replace(/\/$/, "");
  const token = await currentToken(process.env, api, globalThis.fetch);
  if (!token) fail(`no sgt login for ${api} on this machine: run \`sgt login\` first`);
  checks.push(...apiChecks(apiClient({ api, token, version })));
}

const { text, exitCode } = report(await runChecks(checks), `Sergeant smoke check ${new Date().toISOString()}, this checkout ${version}`);
console.log(text);
process.exit(exitCode);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
