#!/bin/sh
set -eu

# Install only for Codex runs, after the host has cloned their repositories. Do not set
# core.hooksPath: that would hide every other hook in the repository. rev-parse honors a
# repository's configured hooks path as well as the default .git/hooks directory.
workspace_root=${SERGEANT_WORKSPACE_ROOT:-/workspace}

find "$workspace_root" -type d -name .git -prune -exec sh -eu -c '
  for git_dir do
    repository=${git_dir%/.git}
    hook_dir=$(git -C "$repository" rev-parse --path-format=absolute --git-path hooks)
    hook=$hook_dir/commit-msg
    repository_hook=$hook.sergeant-repository
    mkdir -p "$hook_dir"

    if [ -f "$hook" ] && grep -q "sergeant-codex-commit-msg" "$hook"; then
      continue
    fi
    if [ -e "$hook" ] || [ -L "$hook" ]; then
      mv "$hook" "$repository_hook"
    fi

    cat > "$hook" <<"EOF"
#!/bin/sh
# sergeant-codex-commit-msg
set -eu

repository_hook=$0.sergeant-repository
if [ -x "$repository_hook" ]; then
  "$repository_hook" "$@"
fi

# Codex identities have changed, so match its name and trailer syntax rather than one email.
sed -i -E "/^[[:space:]]*Co-authored-by:[[:space:]]*Codex([[:space:]].*)?$/Id" "$1"
EOF
    chmod +x "$hook"
  done
' sh {} +
