# ADR-0023: Static musl release binary for the deployed aarch64 target (UNF-259)

## Status

Accepted.

## Context

UNF-206's CI (`.github/workflows/ci.yml`) built the aarch64 release artifact for
`aarch64-unknown-linux-gnu` on GitHub's `ubuntu-24.04-arm` hosted runner. ADR-0016 deploys that
artifact to an Amazon Linux 2023 arm64 EC2 instance
(`deploy/terraform/data.tf`'s `data.aws_ami.al2023_arm64`, `most_recent = true` — not pinned to a
specific AMI version). A dynamically-linked gnu binary inherits its build runner's exact glibc
version as a hard minimum; nothing before this ticket ever verified that version against the
deployment target's glibc.

The first real deployment of a fresh build since the pipeline was set up (2026-09-12) crash-looped
production with:

```
/opt/sergeant/bin/sergeant: /lib64/libc.so.6: version `GLIBC_2.38' not found (required by /opt/sergeant/bin/sergeant)
/opt/sergeant/bin/sergeant: /lib64/libc.so.6: version `GLIBC_2.39' not found (required by /opt/sergeant/bin/sergeant)
```

The deployed AMI ships glibc 2.34; `ubuntu-24.04-arm`'s glibc had drifted to 2.39 since the
pipeline was originally built (both confirmed directly — see the PR's proof). Firstmate rolled the
instance back to the last known-working release to restore service. This was not a regression from
any specific PR: it was a standing, silent gap between the build environment and the deployment
target that nothing in CI ever checked.

Two other approaches were considered and rejected:

- **Matched build environment** (build inside an `amazonlinux:2023` container/action instead of
  the bare Ubuntu runner): would fix today's mismatch, but doesn't fix the underlying hazard —
  `data.aws_ami.al2023_arm64` isn't pinned to a version either, so the AMI's own glibc can advance
  over time too. Two independently-moving glibc versions (runner image, deployed AMI) staying in
  sync by coincidence is exactly the assumption that just failed.
- **Newer AMI**: bumping the deployed AMI to a newer AL2023 release only re-synchronizes the two
  versions at a point in time; GitHub's runner images update independently and could drift ahead
  again with no warning.

## Decision

Build the deployed aarch64 target as `aarch64-unknown-linux-musl` instead of
`aarch64-unknown-linux-gnu` — a fully static binary with **no runtime glibc dependency at all**,
immune to any future divergence between the build runner's glibc and the deployment AMI's. This
was verified against this workspace's actual dependency tree (not assumed): the full workspace,
including the AWS SDK crates, `aws-lc-rs`/`aws-lc-sys` (the rustls crypto backend actually in use —
see `Cargo.lock`), and `rusqlite`'s bundled/vendored SQLite, cross-compiles cleanly to
`aarch64-unknown-linux-musl` on a native aarch64 Linux host with only `musl-tools` (for
`musl-gcc`), `cmake`, and `clang` installed — no `cross` tool or custom sysroot needed. The
resulting binary was confirmed statically linked (`file`/`ldd` report "statically linked" / "not a
dynamic executable") and proven to run inside an `amazonlinux:2023` (arm64) container — the same
image family and confirmed glibc version (2.34) as the deployed AMI. A gnu-target binary rebuilt
against `ubuntu:24.04`'s actual glibc 2.39 (matching `ubuntu-24.04-arm`, the real CI runner image)
reproduced the exact reported crash inside that same container, confirming both the diagnosis and
that the fix addresses it.

x86_64 stays on `aarch64-unknown-linux-gnu`'s sibling, `x86_64-unknown-linux-gnu` — it isn't
deployed anywhere (local dev / a possible future non-Graviton target only), so it has no
deployment-target glibc to match. Per the ticket's own non-goal, this is not general multi-distro
support — it targets exactly the one AMI `deploy/terraform/ec2.tf` deploys.

Implementation:

- `.github/workflows/ci.yml`'s `build` matrix builds `aarch64-unknown-linux-musl` on
  `ubuntu-24.04-arm`, installing `musl-tools` first.
- `.cargo/config.toml` sets `aarch64-unknown-linux-musl`'s linker to `musl-gcc` and pins
  `-C target-feature=+crt-static` explicitly (musl targets already default to static linking, but
  the whole point of this target is a binary with zero runtime glibc dependency, so that default
  isn't left to a future toolchain to silently change).
- `scripts/build-release-artifact.sh` exports `CC_aarch64_unknown_linux_musl=musl-gcc` for cc-rs
  (used by `aws-lc-sys` and `rusqlite`'s bundled C builds), which reads a separate env var from
  Cargo's own linker config.
- `scripts/smoke-test.sh` now runs any `aarch64-*` artifact's `--version` inside an
  `amazonlinux:2023` (arm64) container as part of the build/smoke-test job — proving the exact
  deployment scenario before a release is published, not after a real deployment. This is
  deliberately keyed on *architecture*, not on today's exact `musl` triple: keying on the triple
  would silently stop catching a future regression the moment someone reverted the build target
  back to gnu. Keying on architecture means that exact revert would fail this check with the same
  `GLIBC_*` error the real deployment hit, before the artifact ever reaches a release.

## Consequences

- The deployed aarch64 artifact has no runtime dependency on the deployment AMI's glibc version at
  all, so this specific class of drift (runner glibc advancing past the AMI's) cannot recur for
  this target, regardless of how either side's base image evolves going forward.
- Reverting the build target back to a dynamically-linked gnu binary is still possible, but
  `scripts/smoke-test.sh`'s architecture-keyed AL2023 check now fails the build/smoke-test job
  loudly if that binary can't actually run in an environment matching the deployment AMI, rather
  than staying silent until the next real deployment surfaces it in production.
- `docker` is now a hard requirement of the `build` job for the aarch64 leg (GitHub's hosted
  `ubuntu-24.04-arm` runner ships Docker by default); if that ever stops being true, the smoke test
  fails loudly (`command -v docker` check) rather than silently skipping the AMI-compatibility
  proof.
- x86_64 is unaffected — it stays dynamically linked against glibc, since it isn't the artifact
  deployed anywhere and has no specific deployment-AMI glibc to match.
