# The laptop runner zone (09 §4, 10 §5): workers and reviewers run here, never as the captain's own
# user. Nothing from the host is mounted except the run's workspace; the only credentials a run gets
# are its agent's model credential (Claude Code's or Codex's) and, for a worker, its scoped worker-App
# GitHub token, passed by name.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq python3 make g++ \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=2.1.287
ARG CODEX_VERSION=0.160.0
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" && corepack enable

USER node
WORKDIR /workspace
# No git identity here: the runner sets the installation's human identity through GIT_AUTHOR_* and
# GIT_COMMITTER_*, and Claude Code adds no agent co-author trailer or attribution line. Codex has no
# setting for its co-author trailer, so a global commit-msg hook removes it (a repository that sets
# its own core.hooksPath bypasses the hook; the brief still forbids the trailer). git pushes to
# GitHub with the run's GH_TOKEN (`gh` reads it directly); a reviewer has none.
RUN git config --global init.defaultBranch main \
  && git config --global credential.https://github.com.helper \
    '!f() { test "$1" = get && test -n "$GH_TOKEN" && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f' \
  && mkdir -p /home/node/.config/git/hooks \
  && printf '#!/bin/sh\nsed -i "/^Co-authored-by: Codex <noreply@openai.com>\\s*$/Id" "$1"\n' > /home/node/.config/git/hooks/commit-msg \
  && chmod +x /home/node/.config/git/hooks/commit-msg \
  && git config --global core.hooksPath /home/node/.config/git/hooks \
  && mkdir -p /home/node/.claude \
  && echo '{"includeCoAuthoredBy": false, "attribution": {"commit": "", "pr": ""}}' > /home/node/.claude/settings.json
