# The laptop runner zone (09 §4, 10 §5): workers and reviewers run here, never as the captain's own
# user. Nothing from the host is mounted except the run's workspace; the only credentials a run gets
# are its agent's model credential (Claude Code's or Codex's), a read-only worker-App token for the
# enrolled repositories (GH_READ_TOKEN) and, for a worker, its scoped worker-App GitHub token, passed by name.
FROM eclipse-temurin:17.0.20.1_1-jdk AS temurin

FROM node:24-bookworm-slim

COPY --from=temurin /opt/java/openjdk /opt/java/openjdk

ENV JAVA_HOME=/opt/java/openjdk \
  ANDROID_HOME=/opt/android-sdk \
  ANDROID_SDK_ROOT=/opt/android-sdk \
  PATH=/opt/java/openjdk/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}

ARG TERRAFORM_VERSION=1.16.5
ARG ANDROID_COMMAND_LINE_TOOLS_VERSION=15859902
ARG ANDROID_AAPT2_VERSION=9.3.2-15703166

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq python3 make g++ unzip shellcheck \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && if [ "$(dpkg --print-architecture)" = arm64 ]; then \
    dpkg --add-architecture amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends qemu-user libc6:amd64 libgcc-s1:amd64; \
  fi \
  && case "$(dpkg --print-architecture)" in \
    amd64) terraform_arch=amd64; terraform_sha256=2bc2fcfff033265c9e02ca0351f01794eb122f62a9b2a49a3294b9e49eaab5e4 ;; \
    arm64) terraform_arch=arm64; terraform_sha256=61a50b00485ee4810cf20581ef080fc54d34d666e175c58d9a10501c65c1ccde ;; \
    *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac \
  && curl -fsSLo /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${terraform_arch}.zip" \
  && echo "${terraform_sha256}  /tmp/terraform.zip" | sha256sum -c - \
  && unzip -q /tmp/terraform.zip terraform -d /usr/local/bin \
  && install -d /opt/android-sdk/cmdline-tools \
  && curl -fsSLo /tmp/android-command-line-tools.zip "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_COMMAND_LINE_TOOLS_VERSION}_latest.zip" \
  && echo "040d3996a65543d22ec4bf73e4c37aa37a8d4af4  /tmp/android-command-line-tools.zip" | sha1sum -c - \
  && unzip -q /tmp/android-command-line-tools.zip -d /opt/android-sdk/cmdline-tools \
  && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
  && yes | sdkmanager --licenses >/dev/null \
  && sdkmanager "platform-tools" "platforms;android-37.0" "build-tools;36.0.0" \
  && if [ "$(dpkg --print-architecture)" = arm64 ]; then \
    install -d /opt/android-sdk/aapt2 \
    && curl -fsSLo /tmp/aapt2.jar "https://dl.google.com/dl/android/maven2/com/android/tools/build/aapt2/${ANDROID_AAPT2_VERSION}/aapt2-${ANDROID_AAPT2_VERSION}-linux.jar" \
    && echo "e772a3dae8354764f1b0793903218427f483982445207f2e4ffc8c2026755bd4  /tmp/aapt2.jar" | sha256sum -c - \
    && unzip -q /tmp/aapt2.jar aapt2 -d /opt/android-sdk/aapt2 \
    && mv /opt/android-sdk/aapt2/aapt2 /opt/android-sdk/aapt2/aapt2.x86_64 \
    && printf '%s\n' '#!/bin/sh' 'exec /usr/bin/qemu-x86_64 /opt/android-sdk/aapt2/aapt2.x86_64 "$@"' \
      > /opt/android-sdk/aapt2/aapt2 \
    && chmod 0755 /opt/android-sdk/aapt2/aapt2 /opt/android-sdk/aapt2/aapt2.x86_64 \
    && install -d -o node -g node /home/node/.gradle \
    && printf '%s\n' 'android.aapt2FromMavenOverride=/opt/android-sdk/aapt2/aapt2' \
      > /home/node/.gradle/gradle.properties \
    && chown node:node /home/node/.gradle/gradle.properties; \
  fi \
  && rm -f /tmp/terraform.zip /tmp/android-command-line-tools.zip /tmp/aapt2.jar \
  && rm -rf /var/lib/apt/lists/*

# Fail the image build if any requested tool is absent or cannot start. Android's Linux AAPT2 is
# x86-64-only, so the arm64 image runs it explicitly under QEMU; that costs about 115 MB for QEMU and
# the x86-64 runtime. Gradle dependencies are not baked in: repository clones arrive after this image
# is built, and their large, version-specific caches would add hundreds of MB, make every image build
# slower, and quickly go stale.
RUN java -version \
  && sdkmanager --version \
  && if [ "$(dpkg --print-architecture)" = arm64 ]; then \
    /opt/android-sdk/aapt2/aapt2 version; \
  else \
    /opt/android-sdk/build-tools/36.0.0/aapt2 version; \
  fi \
  && terraform version \
  && shellcheck --version

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
