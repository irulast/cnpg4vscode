# Phase 1 Data Model — GitHub Actions CI/CD on Self-Hosted Runners

Companion to [plan.md](plan.md). Translates the spec's Key Entities into
concrete runtime shapes, ownership, and state transitions. There is no
traditional database in this spec — the "data" is the workflow run
state surface that the auxiliary scripts read from and write to via
the GitHub Actions runtime + the Marketplace API.

---

## Entity 1 — CI gate run

A single execution of `.github/workflows/ci.yml`.

| Field | Type | Source | Notes |
|---|---|---|---|
| `id` | int | GitHub Actions assigns | Stable URL key: `…/actions/runs/{id}` |
| `commit_sha` | string (40 hex) | Trigger event payload | The SHA the gate ran against |
| `workflow_path` | string | Constant `.github/workflows/ci.yml` | Used by `wait-for-ci-gate.mjs` to filter |
| `event` | enum | Trigger event | `pull_request`, `push` (to `master`), `workflow_dispatch` |
| `status` | enum | GitHub | `queued`, `in_progress`, `completed` |
| `conclusion` | enum (nullable) | GitHub | `success`, `failure`, `cancelled`, `skipped`, `timed_out`, `neutral`, `action_required` |
| `started_at` | timestamp | GitHub | |
| `completed_at` | timestamp (nullable) | GitHub | Populated when `status = completed` |
| `head_branch` | string | Trigger event | `master` for push, PR head for PR events |
| `actor` | string | Trigger event | GitHub login that triggered |

**Identity**: `(workflow_path, commit_sha)` is **not** unique — manual
reruns or `workflow_dispatch` can produce multiple runs for the same
SHA. `wait-for-ci-gate.mjs` resolves ambiguity by picking the **latest
`id`** (highest `databaseId` in `gh run list` output) for a given
`(workflow_path, commit_sha, event)` triple.

**Stage results**: each CI run has child Job runs (typecheck, lint,
test:unit, test:contract, build, audit:csp, audit:deps,
actionlint). Each Job has its own `(status, conclusion)` pair. The
gate's overall `conclusion` is `success` iff every required Job is
`success`. Skipped jobs (e.g. when a path filter excludes a stage)
don't break the gate.

**State machine**:

```
   queued ──► in_progress ──► completed { conclusion ∈ enum above }
                                                │
                                                ▼
                                  publish.yml.wait-for-ci-gate
                                  decides proceed / fail
```

The gate run has **no failure recovery**: if it fails, the contributor
opens a new commit (push) which creates a new gate run. The previous
gate run stays in history immutable.

---

## Entity 2 — Publish run

A single execution of `.github/workflows/publish.yml`.

| Field | Type | Source | Notes |
|---|---|---|---|
| `id` | int | GitHub Actions | |
| `tag_name` | string | `github.ref_name` | e.g. `v0.2.0` or `v0.2.0-beta.1` |
| `tag_sha` | string (40 hex) | `github.sha` | The SHA the tag points to |
| `channel` | enum | Derived from `tag_name` | `stable` if no SemVer suffix, `pre-release` otherwise |
| `package_json_version` | string | Read from `package.json` at preflight | MUST equal `tag_name` minus the `v` prefix (FR-012) |
| `ci_gate_conclusion` | enum | `wait-for-ci-gate.mjs` resolution | `success` proceeds; anything else fails the publish |
| `vsix_artifacts` | list[VsixArtifact] | Produced in the packaging stage | Six entries (one per target) |
| `published_targets` | list[Target] | Tracked across publish stage's per-platform retries | Populated as each platform's publish completes |
| `unpublished_targets` | list[Target] | Derived: targets minus published_targets | Empty on success; non-empty triggers FR-017a recovery summary |
| `release_url` | string (nullable) | Populated by Release-create stage | The `https://github.com/.../releases/tag/<tag>` URL |
| `started_at`, `completed_at`, `actor` | (as CI run) | | |

**Identity**: unique by `id`. Multiple publish runs CAN exist for the
same `tag_name` (a tag rerun after FR-017a recovery, or a tag deleted
and re-pushed) — each is a distinct historical record.

**State machine**:

```
   queued ──► preflight ──► wait-for-ci-gate ──► package (build all 6)
                                                       │
                                                       ▼
                                          publish (per-target, with retries)
                                                       │
                              ┌────────────────────────┼────────────────────────┐
                              ▼                        ▼                        ▼
                       all 6 succeeded          1–5 succeeded            0 succeeded
                              │                        │                        │
                              ▼                        ▼                        ▼
                       release-create        FR-017a recovery prompt    workflow conclusion
                              │                        │                        = failure
                              ▼                        ▼
                      workflow conclusion       workflow conclusion
                          = success                  = failure
```

**State transitions** are observable through:

- The GitHub Actions UI (per-job status badges).
- The workflow run's **job summary** (the markdown surface set via
  `$GITHUB_STEP_SUMMARY`) — `publish-vsix.mjs` appends a final
  per-target status table, and on partial failure also writes the
  exact `gh workflow run publish-recover.yml -f tag=v0.2.0 -f
  targets=darwin-arm64,win32-x64` command for the maintainer to copy.

---

## Entity 3 — Marketplace PAT

A single repository secret named `VSCE_PAT`.

| Field | Value |
|---|---|
| Name | `VSCE_PAT` (constant) |
| Source | GitHub repository secret (set by maintainer) |
| Audience | `vsce` CLI in publish + publish-recover workflows |
| Lifecycle | Manual rotation via GitHub repository settings UI |
| Logging exposure | NONE — passed via `env:` per-step; never argv |
| Format | Azure DevOps PAT, 52 chars |

**Access rules**:

- ONLY exposed to two workflows: `publish.yml`, `publish-recover.yml`.
- ONLY exposed to the specific step that invokes `vsce publish`
  (per-step `env:` scope, not job-level `env:`).
- NEVER passed via argv — `vsce publish` reads it from
  `process.env.VSCE_PAT` exclusively.
- NEVER echoed by any shell snippet (no `echo $VSCE_PAT`, no `set -x`
  in steps that have it in scope).

**Rotation runbook** (referenced by `docs/release-process.md`):

1. Generate a new PAT in Azure DevOps (`User Settings → Personal
   Access Tokens → New Token`, scope: Marketplace → Manage).
2. Update the `VSCE_PAT` repository secret via `Settings → Secrets and
   variables → Actions → VSCE_PAT → Update`.
3. Trigger a no-op publish-recover workflow_dispatch as a smoke test.
4. Invalidate the old PAT in Azure DevOps.

---

## Entity 4 — Release artefact

A per-platform VSIX file produced by the packaging stage.

| Field | Type | Notes |
|---|---|---|
| `filename` | string | `cnpg4vscode-<target>-<version>.vsix` where `<target>` is one of `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64` |
| `target` | enum (Target) | Same six values |
| `version` | string | SemVer, matches `package.json#version` and the tag minus `v` |
| `size_bytes` | int | Captured for the summary table |
| `sha256` | string (64 hex) | Computed in the packaging stage; appears in the GitHub Release notes |
| `channel` | enum | `stable` or `pre-release` (matches parent Publish run's channel) |

**Storage**:

1. **Workflow artifact** — uploaded as `vsix-bundle-${{
   github.ref_name }}` via `actions/upload-artifact@v4`. 90-day TTL.
   Consumed by the publish stage in the same workflow run, and by
   `publish-recover.yml` if invoked within the TTL window.
2. **GitHub Release asset** — attached to the
   `https://github.com/.../releases/tag/<tag>` Release by
   `release-create` stage. Long-lived (until the maintainer manually
   deletes the Release).
3. **VS Code Marketplace** — uploaded by `vsce publish`. Immutable.

---

## Entity 5 — Self-hosted runner pool

Out-of-tree entity (defined in `k8s-setup/infrastructure/mke/arc/`),
consumed by this spec via labels.

| Pool | Labels | Min / Max | Use |
|---|---|---|---|
| `mke-default` | `self-hosted, linux, X64, mke-default` | 1 / 5 | Other repos in the org (NOT consumed by this spec) |
| `mke-builds` | `self-hosted, linux, X64, mke-builds` | 0 / 10 | All three workflows in this spec |

**Identity**: pool name is the canonical reference. Labels are the
runtime addressing.

**Spec-side requirement**: every workflow file's `runs-on:` MUST
specify `[self-hosted, linux, X64, mke-builds]` exactly. The
defensive `RUNNER_ENVIRONMENT` check (research §2) is a second layer
in case the label list changes upstream.

**Lifecycle**: owned entirely by the k8s-setup repository. This spec
does not provision, scale, or upgrade the pool. If the pool's name
or labels change, the workflows in this spec need to be updated;
that's a one-line YAML change per workflow file.

---

## Script ↔ Test matrix (Constitution III, post-design re-check)

Every auxiliary script with logic has a corresponding test file. The
workflow YAML files themselves are NOT in this matrix — they're
gated by `actionlint` + workflow runtime.

| Script | Test file | Coverage targets |
|---|---|---|
| `scripts/ci/validate-tag.mjs` | `test/unit/ci/validate-tag.test.ts` | Stable tag accepted; pre-release tag accepted with correct channel inference; tag without `v` prefix rejected; SemVer-violating tag rejected; tag-version mismatch with `package.json` rejected; quoted/embedded-character edge cases on the tag string. |
| `scripts/ci/check-marketplace-version.mjs` | `test/unit/ci/check-marketplace-version.test.ts` | Same `(version, channel)` already present → collision; same version different channel → not a collision; version absent → not a collision; `vsce show` failure → script fails loud (not silent success); malformed JSON → script fails loud. |
| `scripts/ci/wait-for-ci-gate.mjs` | `test/unit/ci/wait-for-ci-gate.test.ts` | `success` → exit 0; `failure`/`cancelled`/`timed_out` → exit 1; `queued → success` poll sequence → exit 0; 30-min timeout → exit 2; multiple eligible runs → picks latest `id`; no eligible run for the SHA → exit 1 after timeout. |
| `scripts/ci/publish-vsix.mjs` | `test/unit/ci/publish-vsix.test.ts` | Happy path (all 6 succeed); per-target retry on transient 5xx; terminal failure after N retries surfaces the recovery dispatch line; PAT never written to any captured log line (regex assertion over the captured output); pre-release flag wiring; build-then-publish staging contract (no `vsce publish` invoked before packaging completes for ALL platforms). |
| `scripts/ci/generate-release-notes.mjs` | `test/unit/ci/generate-release-notes.test.ts` | Conventional-commits grouping (feat/fix/docs/etc.); non-conforming commits bucket into "Other"; empty range (no commits between tags) renders a valid empty-changelog body; SHA-link rendering; compare-URL rendering. |

Five scripts → five test files → estimated ~50–80 assertions total
across the matrix. Matches the existing `test/unit/` density per
script in the rest of the project (e.g. `update-builder.test.ts` is
28 assertions for ~250 LOC of `src/sql/update-builder.ts`).
