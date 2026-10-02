// Manual isolation check for the runner zone (never run by CI). From v2/packages/runner, after
// `docker build -t sergeant-runner:local container`:
//
//   node src/live-check.ts [--image sergeant-runner:local]
//
// It starts a container exactly as a worker run is started, with placeholder credential values, and
// prints what a run can see: its user, its environment variable names, and whether host credential
// paths exist. Real worker and reviewer runs are exercised by the canary (packages/sergeant).
import { parseArgs } from "node:util";
import { execOk } from "./exec.ts";

const { values } = parseArgs({ options: { image: { type: "string", default: "sergeant-runner:local" } } });

const out = await execOk(
  "docker",
  ["run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--env", "CLAUDE_CODE_OAUTH_TOKEN", "--env", "GH_TOKEN", values.image, "sh", "-c",
    'echo "user: $(id -un)"; echo "env: $(env | cut -d= -f1 | sort | tr "\\n" " ")"; for p in /Users ~/.aws ~/.config/gh ~/.ssh ~/.codex ~/.claude/.credentials.json /var/run/docker.sock; do [ -e "$p" ] && echo "PRESENT $p" || echo "absent  $p"; done'],
  { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "placeholder", GH_TOKEN: "placeholder" } },
);
console.log(out);
