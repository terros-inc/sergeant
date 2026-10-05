// Manual isolation check for the runner zone (never run by CI). From packages/runner, after
// `docker build -t sergeant-runner:local container`:
//
//   node src/live-check.ts [--image sergeant-runner:local] [--adapter claude-code-local|codex-local]
//
// It starts a container exactly as a worker run of that adapter is started, with placeholder credential
// values, and prints what a run can see: its user, its environment variable names, whether host
// credential paths exist, and the agent CLI's version. Real worker and reviewer runs, on their task
// owner's registered accounts, are exercised by the canary (packages/sergeant).
import { parseArgs } from "node:util";
import { ADAPTERS, AGENTS, type Adapter } from "./agents.ts";
import { execOk } from "./exec.ts";

const { values } = parseArgs({
  options: { image: { type: "string", default: "sergeant-runner:local" }, adapter: { type: "string", default: "claude-code-local" } },
});
if (!ADAPTERS.includes(values.adapter as Adapter)) throw new Error(`--adapter must be one of ${ADAPTERS.join(", ")}`);
const adapter = values.adapter as Adapter;
const { credentialEnv } = AGENTS[adapter];
const version = adapter === "codex-local" ? "codex --version" : "claude --version";

const out = await execOk(
  "docker",
  ["run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--env", credentialEnv, "--env", "GH_TOKEN", values.image, "sh", "-c",
    `echo "user: $(id -un)"; echo "env: $(env | cut -d= -f1 | sort | tr "\\n" " ")"; for p in /Users ~/.aws ~/.config/gh ~/.ssh ~/.codex ~/.claude/.credentials.json /var/run/docker.sock; do [ -e "$p" ] && echo "PRESENT $p" || echo "absent  $p"; done; echo "agent: $(${version})"`],
  { env: { ...process.env, [credentialEnv]: "placeholder", GH_TOKEN: "placeholder" } },
);
console.log(out);
