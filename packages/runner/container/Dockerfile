# The laptop runner zone (09 §4, 10 §5): workers and reviewers run here, never as the captain's own
# user. Nothing from the host is mounted except the run's workspace; the only credentials a run gets
# are its agent's model credential (Claude Code's or Codex's), a read-only worker-App token for the
# enrolled repositories (GH_READ_TOKEN) and, for a worker, its scoped worker-App GitHub token, passed by name.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq python3 make g++ \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Both agent CLIs, always: a run takes whichever provider its owner's registered accounts and quota
# choose, with no installation setting (TECH-5390).
ARG CLAUDE_CODE_VERSION=2.1.287
ARG CODEX_VERSION=0.160.0
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" && corepack enable

# Owned by node: the local runner bind-mounts a run's workspace here, but a Fargate task (TECH-5237)
# clones into the image's own directory, which WORKDIR alone may leave root-owned.
RUN install -d -o node -g node /workspace
# Node sizes its default heap from the container's memory: about 2 GiB in a worker (8 GiB on Fargate),
# where a developer laptop gets 4 GiB. A large type-check (a web app's `tsc`) needs more than 2 GiB and
# ran out of memory (TECH-6222). 4 GiB is what a 16 GiB machine defaults to and what repository CI sets;
# it is a ceiling, not an allocation. A repository script that sets NODE_OPTIONS replaces it.
ENV NODE_OPTIONS=--max-old-space-size=4096
USER node
WORKDIR /workspace
# The public-data check every worker push runs (TECH-5914): git copies the template's pre-push hook
# into each clone made here, and the local runner clones on the host with the same template.
COPY check-public-data.mjs /usr/local/lib/sergeant/check-public-data.mjs
COPY git-template /usr/local/share/sergeant/git-template
# No git identity here: the runner sets the installation's human identity through GIT_AUTHOR_* and
# GIT_COMMITTER_*, and Claude Code adds no agent co-author trailer or attribution line. Repository
# hooks run normally; the image does not override core.hooksPath (a repository that sets it replaces
# the template's pre-push hook with its own, and a repository's `.githooks/pre-push` that a clone has
# not turned on runs from the template's hook). git pushes to GitHub with the run's GH_TOKEN (`gh` reads
# it directly); a reviewer has none.
RUN git config --global init.defaultBranch main \
  && git config --global init.templateDir /usr/local/share/sergeant/git-template \
  && git config --global credential.https://github.com.helper \
    '!f() { test "$1" = get && test -n "$GH_TOKEN" && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f' \
  && mkdir -p /home/node/.claude \
  && echo '{"includeCoAuthoredBy": false, "attribution": {"commit": "", "pr": ""}}' > /home/node/.claude/settings.json
