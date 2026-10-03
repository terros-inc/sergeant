#!/bin/sh
set -eu

hook_name=${0##*/}
git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir)

# Read only repository configuration, ignoring the command-scoped core.hooksPath that selected this
# dispatcher. A relative hooksPath is resolved from the directory where Git runs the hook.
configured_hooks=$(git config --local --path --get core.hooksPath || true)
case "$configured_hooks" in
  "") repository_hook=$git_common_dir/hooks/$hook_name ;;
  /*) repository_hook=$configured_hooks/$hook_name ;;
  *) repository_hook=$PWD/$configured_hooks/$hook_name ;;
esac

# Invoke the hook at its real path so basename-based runners such as Husky dispatch correctly.
# Preserve a failure exactly, and never alter the commit message when the repository rejects it.
if [ -x "$repository_hook" ]; then
  "$repository_hook" "$@" || exit $?
fi

if [ "$hook_name" = commit-msg ]; then
  # Codex CLI 0.160.0 emits this identity. Limit removal to that identity rather than human names.
  sed -i -E "/^[[:space:]]*Co-authored-by:[[:space:]]*Codex[[:space:]]*<noreply@openai\.com>[[:space:]]*$/Id" "$1"
fi
