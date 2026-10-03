#!/bin/sh
set -eu

# This directory is part of the runner user's image, never a cloned repository. Git sees it only
# through the Codex process environment; Claude Code and the host keep their normal hook paths.
hook_dir=${SERGEANT_CODEX_HOOK_DIR:-/home/node/.config/git/codex-hooks}
dispatcher=${SERGEANT_CODEX_HOOK_DISPATCHER:-/home/node/codex-git-hook-dispatcher.sh}

test -x "$dispatcher"
mkdir -p "$hook_dir"

# core.hooksPath replaces the whole hook directory, so dispatch every hook Git currently supports.
# ln -sf makes startup safe to repeat and also repairs a partially populated image-owned directory.
for hook in \
  applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit \
  prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push \
  pre-receive update proc-receive post-receive post-update reference-transaction \
  push-to-checkout pre-auto-gc post-rewrite sendemail-validate fsmonitor-watchman \
  p4-changelist p4-prepare-changelist p4-post-changelist p4-pre-submit
do
  ln -sf "$dispatcher" "$hook_dir/$hook"
done

test -x "$hook_dir/commit-msg"
