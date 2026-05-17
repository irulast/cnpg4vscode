# Phase 0 Research — GitHub Actions CI/CD on Self-Hosted Runners

Companion to [plan.md](plan.md). Resolves the technical-context items
that needed a concrete decision before Phase 1 design could land.

---

## §1 — CI-wait mechanism (FR-011)

**Decision**: Poll the GitHub Checks API for the tagged commit's CI
gate status using the preinstalled `gh` CLI, from
`scripts/ci/wait-for-ci-gate.mjs`. Poll interval: 15 s. Hard timeout:
30 min (matches the spec's clarification). Match the CI run by
workflow file path (`.github/workflows/ci.yml`) and event source
(push), not by run name (which can be edited).

```bash
gh run list \
  --commit "$SHA" \
  --workflow "ci.yml" \
  --event push \
  --json conclusion,status,databaseId,event \
  --limit 5
```

The script reads the JSON output, picks the most recent eligible run
(latest `databaseId`), and:
- `conclusion: "success"` → exit 0 (publish proceeds)
- `conclusion: "failure" | "cancelled" | "timed_out"` → exit 1 (publish
  fails fast)
- `status: "queued" | "in_progress"` → continue polling
- `status: "completed"` with any other conclusion (`neutral`,
  `action_required`, etc.) → exit 1 (treat as not-green)
- No matching run found after 30 min → exit 2 (timeout)

**Rationale**:

- `gh run list` is preinstalled on the
  `ghcr.io/actions/actions-runner:latest` base image both scale sets
  run, so no additional install step / dependency.
- The GitHub Checks REST API (`/repos/{owner}/{repo}/commits/{sha}/check-runs`)
  is what `gh` calls under the hood — same data, lower-friction CLI
  surface.
- Polling at 15 s gives a sub-30 s detection latency once CI completes,
  cheap on API quota (well under the 5000 req/hr authenticated limit).
- 30 min ceiling is a sane upper bound: cold-cache CI (SC-002) is
  10 min worst-case; tripling that absorbs runner cold-start, queue
  backlog from concurrent PRs, and one full retry of a flaky stage.

**Alternatives considered**:

- **`workflow_run` trigger** — chain the publish workflow's start
  off the CI workflow's completion. Rejected because `workflow_run`
  fires on EVERY CI run, so we'd have to filter by tag-presence on
  the SHA inside the publish workflow — adds latency (the publish
  workflow has to start, look at the SHA, decide it's not a tagged
  release, exit) and conceals the trigger semantics from a casual
  reader of the workflow file.
- **`actions/github-script@v7`** with octokit — pulls a third-party
  action and a JS runtime; same data via a heavier surface than `gh`.
  Rejected on Constitution Principle V.
- **GitHub Webhooks → external queue → poll** — over-engineered for a
  1-repo project. Rejected.

---

## §2 — Self-hosted runner label selection + ARC kubernetes mode

**Decision**:

| Workflow | Runner label | Why |
|---|---|---|
| `ci.yml` (PR + push-to-master quality gate) | `mke-builds` | Builds pool has up to 10 concurrent runners (handles peak PR fan-out). Has the CPU/memory to run vitest + tsc + esbuild without contention. |
| `publish.yml` (tag-triggered release) | `mke-builds` | Six per-platform packages are CPU-heavy; the +1 GiB headroom of `mke-builds` vs `mke-default` matters. Scale-from-zero is acceptable here because the user has just pushed a tag and is fine with a minute of warmup. |
| `publish-recover.yml` (workflow_dispatch recovery) | `mke-builds` | Same workload as `publish.yml` (just with a narrower platform list); same pool. |

`mke-default` is reserved for non-CI workloads (other repos in the
maintainer's org) — its 1–5 warm pool is sized for that, not for
multi-PR fan-out on a single project.

**Critical: ARC Runner Scale Sets uses a single label, NOT the
standard self-hosted triple.** The conventional GitHub Actions form
`runs-on: [self-hosted, linux, X64, mke-builds]` does NOT match — ARC
registers runners with the scale-set name as their sole label. The
correct form is `runs-on: mke-builds` (string, not array). The first
deploy attempt of this spec used the triple form and the job sat
queued indefinitely with no runner ever picking it up. The labrant-
datawarehouse and other in-org workflows use the single-label form
universally.

**Critical: ARC kubernetes mode requires `container:` on every job.**
The runner pod itself runs the actions-runner agent; per-job work
happens in a child pod whose image must be specified by the workflow.
Omitting `container:` causes jobs to fail at startup. The standard
in-org image for Node work is `node:22-bookworm` (Node + apt for
extra tooling install). Per-job tooling beyond Node (git, gh,
actionlint) is installed in the first step via `apt-get install`.

**Hosted-runner refusal**: dropped. The `runs-on: mke-builds` label
literally cannot match a hosted runner (GitHub's hosted pool doesn't
advertise `mke-builds`), so the previous belt-and-braces
`RUNNER_ENVIRONMENT` shell check is now redundant. SC-008 is enforced
by the label alone.

**Rationale**: the spec's runner-pool entity acknowledges both pools
exist; the choice between them is purely a sizing tradeoff and stays
out of `spec.md` so the pool's lifecycle stays an out-of-tree
concern. Documented here so the runbook can repeat it without
re-deriving.

---

## §3 — `vsce publish` pre-release channel mechanics

**Decision**: Pre-release vs stable is purely a `--pre-release` flag on
`vsce publish`. The flag composes with `--target <triple>` and
`--packagePath <vsix>`. Concrete invocations:

```bash
# Stable channel, Linux x64:
vsce publish --no-dependencies --target linux-x64 --packagePath cnpg4vscode-linux-x64-0.2.0.vsix

# Pre-release channel, macOS arm64:
vsce publish --no-dependencies --pre-release --target darwin-arm64 --packagePath cnpg4vscode-darwin-arm64-0.2.0-beta.1.vsix
```

The publisher's PAT is passed via the `VSCE_PAT` env var (built-in to
vsce since 2.15.x); no `--pat` argv flag means `ps` cannot observe it
and GitHub Actions' secret masking covers it natively.

**Edge case — pre-release VSIX must have its own version**: VS Code's
Marketplace treats `0.2.0-beta.1` as a separate version from `0.2.0`
ONLY when the publisher uses pre-release semantics natively. `vsce
publish --pre-release` injects the right metadata; the VSIX itself
must have `version: "0.2.0-beta.1"` in its packaged `package.json`.
Implementation: `validate-tag.mjs` and the pre-package step both
ensure `package.json#version` matches the tag's SemVer string
(suffix included).

**Verification**: `vsce show cnpg4vscode.cnpg4vscode --json` returns
all versions with their `preview` and `preRelease` flags so the
collision check (FR-013) can compare on the
`(version, preRelease)` tuple.

**Alternatives considered**: shipping pre-releases via a SEPARATE
Marketplace listing (e.g. `cnpg4vscode-pre`). Rejected — splits the
user audience, defeats the "Switch to Pre-Release Version" UX
affordance, doubles the publisher account paperwork.

---

## §4 — Marketplace "is this version already published?" check

**Decision**: Use `vsce show <publisher>.<ext> --json` (built into the
`@vscode/vsce` package the project already depends on). It hits the
public Marketplace gallery endpoint and returns every version with
its channel flags:

```json
{
  "versions": [
    {
      "version": "0.2.0",
      "lastUpdated": "...",
      "preRelease": false
    },
    {
      "version": "0.2.0-beta.1",
      "lastUpdated": "...",
      "preRelease": true
    }
  ]
}
```

`scripts/ci/check-marketplace-version.mjs` parses the JSON and exits
0 when the `(tag-version, channel)` tuple is NOT present, exits 1
when it IS (collision per FR-013).

**Rationale**: `vsce show` is authenticated-anonymous (no PAT needed),
so this check runs in any context including fork PRs (though fork PRs
never reach the publish workflow). Same data the Marketplace REST API
(`/_apis/public/gallery/extensionquery`) exposes, but via the same
CLI we're already using for publish — one fewer tool surface.

**Alternatives considered**:

- Direct REST API call with `curl + jq`. Functional but adds
  jq-version-portability surface. Rejected.
- `vsce ls-publishers` / `vsce search` — these target different
  Marketplace endpoints; rejected for not returning per-version
  channel flags.

---

## §5 — Fork-PR secret isolation (SC-009)

**Decision**: Use the `pull_request` trigger (NOT `pull_request_target`)
in `ci.yml`. GitHub's documented behaviour: `pull_request` triggers
for fork-PR contexts run with `secrets.*` evaluated to empty strings;
`pull_request_target` would expose secrets and is a known CWE pattern
for untrusted-code execution.

Concretely:

```yaml
# ci.yml
on:
  pull_request:
    branches: [master]
  push:
    branches: [master]
```

The publish workflow uses `push: { tags: ['v*'] }` exclusively — fork
PRs cannot push tags to the upstream repository, so the publish
workflow is structurally unreachable from a fork.

**Defensive guard inside publish.yml**:

```yaml
jobs:
  preflight:
    if: github.repository == 'irulast/cnpg4vscode' && github.event_name == 'push'
```

Belt-and-braces — even if someone configures a fork to mirror tag
pushes, the `github.repository` check refuses to run for the
upstream-namespaced publish.

**Rationale**: Combines platform-level isolation (the trigger
selection) with workflow-level isolation (the `if:` guard). Two
layers per Constitution §V's pattern of preferring layered defences
to a single perfect check.

---

## §6 — Workflow concurrency control

**Decision**:

```yaml
# ci.yml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true   # cancel stale PR runs on force-push

# publish.yml
concurrency:
  group: publish-${{ github.ref_name }}   # tag name, not ref
  cancel-in-progress: false  # serialise; never cancel a publish mid-flight

# publish-recover.yml
concurrency:
  group: publish-${{ inputs.tag }}        # share lock with the original publish
  cancel-in-progress: false
```

**Rationale**:

- CI on PRs benefits from cancel-on-force-push: if the contributor
  pushes a fix while a previous CI run is still going, the previous
  run is now stale and burning runner-minutes for nothing.
- Publish must NEVER be cancelled mid-flight — a half-published set is
  exactly the partial-success state FR-017a covers, and we don't want
  the platform itself to create one accidentally.
- Recovery workflow shares the publish workflow's lock (same group
  name) so a maintainer can't accidentally fire recovery WHILE the
  original publish is still attempting retries.

---

## §7 — GitHub Releases idempotency (FR-022)

**Decision**: Use `gh release create` with the `--clobber` flag to
make asset upload idempotent. The `gh release upload --clobber`
subcommand replaces an existing asset with the same name; absent
`--clobber` it errors. For releases themselves, `gh release create`
errors when the release exists, so the workflow checks first:

```bash
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG exists; uploading assets idempotently"
  gh release upload "$TAG" *.vsix --clobber
else
  gh release create "$TAG" *.vsix --notes-file "release-notes.md" --title "$TAG"
fi
```

**Rationale**: a re-run of the publish workflow (or the recovery
workflow) converges to the same end state regardless of how partial
the previous run was. Maintainer can re-fire safely.

---

## §8 — Conventional Commits changelog generation (FR-021)

**Decision**: Write a small `generate-release-notes.mjs` that uses
`git log <prev-tag>..<current-tag> --pretty=format:"%H %s"` and
groups by Conventional Commits prefix (`feat:`, `fix:`, `docs:`,
`chore:`, `refactor:`, `test:`, `ci:`, `build:`, `perf:`, `revert:`).
Unknown prefixes / non-conforming messages fall into "Other".

Sample output:

```markdown
## What's Changed in v0.2.0

### feat
- 3a4b5c6 add Grid Editor cell editing
- 1d2e3f4 add per-cluster notebook save

### fix
- 9876543 grid: dirty edits revert on Apply

### docs
- abc1234 update README for Grid Editor

### Other
- def5678 typo fix in CLAUDE.md

**Full Changelog**: https://github.com/irulast/cnpg4vscode/compare/v0.1.0...v0.2.0
```

**Rationale**:

- Stays under ~80 LOC; no new dependency.
- Falls back gracefully on a non-conforming commit set (everything
  buckets into "Other" and the release notes are still a complete
  commit list).
- Matches what `git-cliff` / `conventional-changelog-cli` produce
  for the simple-no-config case without pulling either tool in.

**Alternatives considered**:

- `git-cliff` (Rust binary) — single static binary, would work fine
  on the runner. Rejected because the script is small enough not to
  warrant a new tool; reviewers can read the .mjs faster than they
  can read git-cliff's config.
- GitHub-native auto-generated release notes (`gh release create
  --generate-notes`) — uses PR titles + labels, requires labels to
  be set consistently, doesn't pull arbitrary direct-to-master
  commits cleanly. Could revisit if the project enforces
  PR-only-merges and a label taxonomy. Out of scope today.

---

## §9 — `actionlint` workflow-YAML linter

**Decision**: Install `actionlint` inline at the start of the CI
workflow (and the publish workflow's preflight), then run it against
`.github/workflows/*.yml`:

```yaml
- name: Lint workflow YAML
  run: |
    bash <(curl -sSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash)
    ./actionlint -color
```

`download-actionlint.bash` is the maintainer-provided installer that
downloads a pinned static binary for the host's arch. Pinning the
version (override the script's default) is a defence against supply-
chain drift:

```yaml
- name: Lint workflow YAML (actionlint v1.7.7)
  run: |
    bash <(curl -sSL https://raw.githubusercontent.com/rhysd/actionlint/v1.7.7/scripts/download-actionlint.bash) 1.7.7
    ./actionlint -color
```

**Rationale**:

- Single static binary; no Node/Python runtime needed for the linter.
- Catches a long-tail of mistakes (wrong action versions, expression
  typos, shellcheck-flagged shell snippets, deprecated keywords)
  that would otherwise only surface on workflow run.
- Inline install + pinned version is simpler than maintaining a
  Docker image or running ARC pre-images.

---

## §10 — pnpm dependency cache strategy

**Decision**: Use `actions/setup-node@v4`'s built-in `cache: 'pnpm'`
mode. It auto-detects `pnpm-lock.yaml`, derives a cache key from its
hash, and restores/saves the pnpm store path:

```yaml
- uses: pnpm/action-setup@v3
  with:
    version: 10
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: 'pnpm'
- run: pnpm install --frozen-lockfile
```

**Cache hit on warm runs**: `pnpm install --frozen-lockfile` resolves
in <10 s when the store cache hits (vs ~60–90 s cold). This is the
core of SC-003's 5-minute warm budget.

**Cache key invalidation**: any `pnpm-lock.yaml` change triggers a
fresh store download. Matches the contract — a dep upgrade SHOULD
re-test against the new tree.

**Rationale**: minimal config (one `cache:` field), no manual
`actions/cache` configuration drift, maintained by GitHub.

**Alternatives considered**:

- Manual `actions/cache@v4` with explicit `path: ~/.local/share/pnpm/store`
  + key derivation. Equivalent functional behaviour, more config
  surface, easier to mis-tune. Rejected.
- Runner image with pnpm dependencies pre-installed. Couples the
  runner image to the project's dep set; expensive to maintain when
  deps change. Rejected.

---

## Summary

10 technical-context items resolved. No NEEDS CLARIFICATION markers
carry forward. Plan is unblocked for Phase 1 design.
