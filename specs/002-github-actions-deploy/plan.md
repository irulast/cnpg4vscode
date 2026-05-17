# Implementation Plan: GitHub Actions CI/CD on Self-Hosted Runners

**Branch**: `002-github-actions-deploy` | **Date**: 2026-05-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from [specs/002-github-actions-deploy/spec.md](spec.md)

## Summary

Land two production workflows + one recovery workflow under
`.github/workflows/` plus a small set of auxiliary Node scripts under
`scripts/ci/` that, together, enable the maintainer to ship a new
Marketplace release by performing only `bump → merge → push tag`. The
workflows execute on the project's existing self-hosted Kubernetes-backed
runner pool (provisioned out-of-tree in `k8s-setup`), refuse to run on
hosted GitHub runners (FR-004 / SC-008), gate the publish on the CI gate's
state on the tagged commit (FR-011, with the 30-minute wait policy from
Clarifications 2026-05-17), build all six per-platform VSIXs before the
first `vsce publish` invocation (FR-014), publish to the Marketplace
stable or pre-release channel based on the SemVer suffix (FR-010), and
surface a `workflow_dispatch` recovery entry-point when the publish stage
ends in a partial-success state (FR-017a).

The auxiliary scripts (`validate-tag`, `check-marketplace-version`,
`wait-for-ci-gate`, `publish-vsix`, `generate-release-notes`) live as
plain `.mjs` files matching the existing `scripts/*.mjs` convention and
are unit-tested in `test/unit/ci/` via the existing vitest harness. The
publish PAT is consumed exclusively from a single repository secret
(`VSCE_PAT`); the scripts never echo its value, and FR-016 / SC-005 are
defended by routing every `vsce` invocation through a wrapper that
treats the PAT as a `child_process` env var rather than an argv string.

## Technical Context

**Language/Version**: GitHub Actions YAML (currently at workflow schema
2024-11) + Node.js 22 LTS for auxiliary scripts (matches the
`engines.node` already declared in `package.json` and the version stock
`actions/setup-node@v4` defaults to).

**Primary Dependencies**:

- `@vscode/vsce@^2.24.0` — already a devDependency; drives `package` and
  `publish` per-platform.
- `pnpm@10.x` — already the project's package manager; pinned via
  `packageManager` field in `package.json`.
- `actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v3`,
  `actions/upload-artifact@v4`, `actions/download-artifact@v4` — stock
  GitHub-published actions, no third-party action repos required (keeps
  the supply chain narrow; satisfies Constitution Principle V).
- `gh` CLI (preinstalled on the `ghcr.io/actions/actions-runner:latest`
  base image used by both runner scale sets) — drives the CI-wait
  polling (`gh run list --commit`), GitHub Releases (`gh release
  create / upload`), and the partial-publish recovery summary
  (`gh workflow run`).
- `actionlint` — workflow YAML linter, run as the very first CI step
  before any other work so a malformed workflow file fails fast and
  cheap. Installed inline via the rhysd/actionlint installer script
  (single static binary).

**Storage**:

- **GitHub Actions cache** — pnpm store cached via `actions/setup-node@v4`'s
  built-in `cache: 'pnpm'` mode, keyed by `pnpm-lock.yaml`. Hits within
  the standard 7-day cache TTL satisfy SC-003's warm-cache budget.
- **Workflow artifacts** — the six per-platform VSIXs produced in the
  package stage upload as a single artifact named
  `vsix-bundle-${{ github.ref_name }}`; the publish stage downloads
  it. The recovery workflow re-uses the artifact when still available
  (artifact TTL is 90 days by default) and re-builds when not.
- **GitHub Releases** — the six VSIXs attach to a Release named after
  the tag (US3 / FR-020).
- **No external storage** — no S3, no third-party artifact registry. The
  Marketplace itself is the source of truth for published versions.

**Testing**:

- **Unit (vitest)** — each `scripts/ci/*.mjs` exposes a pure function
  surface that's covered in `test/unit/ci/`. The vitest runner is
  already wired (`pnpm test:unit`).
- **Workflow lint** — `actionlint` runs as the first CI job, catching
  YAML structure errors, expression typos, deprecated action versions,
  and stale shell-quoting before anything else executes.
- **Smoke end-to-end** — manual; the runbook (FR-041) names two
  artifacts to validate after the first publish: (a) a fresh
  `code --install-extension <vsix>` of each per-platform VSIX from the
  GitHub Release page, (b) a "Switch to Pre-Release Version" round-trip
  for the pre-release channel.

**Target Platform**: GitHub Actions hosted on the project's two
existing self-hosted runner scale sets, both under the `arc-runners`
namespace in the maintainer's Kubernetes cluster:

- `mke-default` — 1–5 always-warm runners on NVMe, 1–2 CPU / 2–4 GiB.
  Used by `ci.yml` for fast feedback on PRs (cache HITs dominate the
  PR feedback cycle; scale-from-zero would add 30–60s to the
  feedback loop).
- `mke-builds` — 0–10 scale-to-zero runners on SAN, 2–4 CPU / 4–8 GiB,
  excluded from `r720-lower` via node-affinity (iSCSI loopback
  avoidance, irrelevant to this spec but inherited from the pool
  definition). Used by `publish.yml` and `publish-recover.yml` —
  packaging six VSIXs needs the CPU/memory and is acceptable on
  scale-from-zero latency because the maintainer just pushed a tag
  and is happy to wait a minute for runners to come up.

Both pools host the runner under labels:
- `mke-default`
- `mke-builds`

Workflows target by the scale-set name (`mke-default` / `mke-builds`)
plus `self-hosted` (defensive — defeats any future hosted-runner
fallback that GitHub might add to `runs-on:` semantics).

**Project Type**: CI/CD configuration + small auxiliary Node CLI
scripts. No application source code changes; this spec is purely
release engineering plumbing.

**Performance Goals**:

- SC-002: cold-cache CI gate run ≤ **10 min** (no pnpm store cache,
  fresh runner pod).
- SC-003: warm-cache CI gate run ≤ **5 min** (pnpm store cache hit,
  warm runner pod).
- SC-004: `git push <tag>` → Marketplace listing reflects new version ≤
  **15 min** (cold) / ≤ **10 min** (warm), including all six
  per-platform builds + publishes.
- SC-010: contributor PR feedback (warm cache, clean change) ≤ **5
  min**.

**Constraints**:

- SC-005: 0 occurrences of the PAT literal (or any decoded form longer
  than 8 chars) in any captured workflow log line, status summary, or
  artifact across an entire workflow run.
- SC-008: 0 workflow runs ever execute on a hosted GitHub runner.
- SC-009: 0 publishing-related steps ever execute in a fork-PR context.
- Workflow files MUST be human-readable (FR-040) — no generated YAML,
  no `${{ env.X }}` indirection that obscures what's actually being
  run.

**Scale/Scope**:

- 1 repository (`cnpg4vscode`).
- Expected release cadence: 1–10 releases / year initially (pre-1.0).
- 6 per-platform VSIXs per release.
- ~1–4 concurrent PRs in flight at peak (single-maintainer project today).
- 3 workflow files (ci, publish, publish-recover); 5 auxiliary
  scripts; ~15 unit tests across the scripts.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1
design (see [Re-evaluation](#post-design-constitution-recheck) below).*

The cnpg4vscode constitution (v1.0.0) defines five principles. This
spec is release-engineering plumbing — it doesn't ship user-facing
extension behavior, so several principles apply only obliquely.
Explicit translation per principle:

### I. VS Code UX Consistency

**Applicability**: N/A — no user-facing UI ships. The maintainer's
"UI" is the GitHub Actions UI, which is not the extension's surface.

### II. Kubernetes-Native Integration

**Applicability**: N/A — workflows do not talk to user clusters or to
CNPG. The workflows DO run on Kubernetes (the self-hosted runner
pool), but that's runtime infrastructure consumed via the GitHub
Actions abstraction; we don't directly speak the K8s API from any
workflow step.

### III. Test-First Development (NON-NEGOTIABLE)

**Applicability**: APPLIES to the auxiliary `scripts/ci/*.mjs` modules
that contain logic (tag parsing, version comparison, retry-policy
evaluation, changelog rendering). Each script is delivered TDD:
failing vitest test in `test/unit/ci/*.test.ts` first, implementation
second.

**Applicability NOT extended to workflow YAML itself**: the principle
covers "behaviour that ships to users"; a workflow file is glue, not
behaviour, and is gated by `actionlint` (syntactic + structural) and
by the workflow's own runtime green-vs-red signal (semantic). End-to-
end "does this actually publish to the Marketplace" testing is
inherently a one-shot event-driven concern that doesn't fit
unit-test gating; the runbook smoke checklist (FR-041) catches it.

**Gate decision**: ✅ PASS — every script with logic gets a
failing-test-first cycle; workflow YAML is gated by `actionlint` +
runtime check.

### IV. Observability & Diagnostics

**Applicability**: APPLIES. Workflow runs are inherently observable
through the GitHub Actions UI, but several FRs raise the bar:

- FR-006: failing checks link to the failing log line.
- FR-016 / SC-005: PAT never in any log line.
- FR-017a #4: partial-publish failure summary names the exact
  `workflow_dispatch` invocation the maintainer should run to
  finish.

These mirror Principle IV's "include a stable command identifier" +
"surface the most recent log lines in a form the user can copy"
requirements at the workflow level.

**Gate decision**: ✅ PASS — observability requirements are spec-level
and have unit tests for the bits that aren't trivially visible
(`generate-release-notes`, `publish-vsix` error formatting).

### V. Simplicity & YAGNI

**Applicability**: APPLIES. The plan deliberately:

- Uses only stock GitHub-published actions; no third-party action
  repos that would expand the supply chain.
- Uses plain `.mjs` scripts (matching existing
  `scripts/{package,audit-*,*}.mjs` convention) rather than building a
  TypeScript subproject for what amounts to ~500 LOC of glue.
- Doesn't introduce a release-automation framework (release-please,
  semantic-release, etc.) — those are deferred per the spec's
  Out-of-Scope section.
- Doesn't introduce a workflow-orchestration framework — the three
  workflow files are flat and self-contained.

**Gate decision**: ✅ PASS — no abstractions introduced ahead of a
second consumer.

### Cross-cutting: Security & Operational Constraints

The constitution's Security section says credentials MUST NEVER be
written to extension state, workspace storage, or log output. Applied
to the workflow domain:

- **VSCE_PAT** is consumed via `env: VSCE_PAT: ${{ secrets.VSCE_PAT }}`
  scoped per-step (only the publish step sees it). GitHub Actions'
  built-in secret masking applies.
- The publish-vsix script reads the PAT from `process.env.VSCE_PAT`
  and passes it to `vsce` via `--pat -` (stdin) where supported, or
  via `process.env.VSCE_PAT` for the inherited-env case. NEVER
  embedded in argv (where Linux `ps` could surface it).
- Fork PRs use the `pull_request` (NOT `pull_request_target`) trigger
  so `secrets.*` is unavailable to the fork's execution context by
  GitHub's design — defends SC-009 at the platform level rather than
  relying on `if:` conditions.

**Cross-cutting gate decision**: ✅ PASS.

## Project Structure

### Documentation (this feature)

```text
specs/002-github-actions-deploy/
├── spec.md              # Feature specification (already authored)
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output (this run)
├── data-model.md        # Phase 1 output (this run)
├── quickstart.md        # Phase 1 output (this run — maintainer release runbook)
├── contracts/
│   ├── workflow-triggers.md   # Trigger event → workflow contract
│   ├── script-cli.md          # Auxiliary script CLI signatures + exit codes
│   └── secrets.md             # Repository-secret contract
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
.github/workflows/
├── ci.yml                  # US1 — PR + push-to-master quality gate
├── publish.yml             # US2 + US3 — tag-triggered publish + release
└── publish-recover.yml     # FR-017a — workflow_dispatch partial-publish recovery

scripts/ci/
├── validate-tag.mjs              # FR-012: tag SemVer vs package.json#version
├── check-marketplace-version.mjs # FR-013: collision check against Marketplace
├── wait-for-ci-gate.mjs          # FR-011: poll the Checks API for the SHA's CI conclusion
├── publish-vsix.mjs              # FR-014 + FR-017 + FR-017a: per-platform publish with retry
└── generate-release-notes.mjs    # FR-021: changelog from commit log between tags

test/unit/ci/
├── validate-tag.test.ts
├── check-marketplace-version.test.ts
├── wait-for-ci-gate.test.ts
├── publish-vsix.test.ts
└── generate-release-notes.test.ts

docs/
└── release-process.md       # FR-041: the maintainer runbook
```

**Structure Decision**: Single project (no new sub-packages). Workflow
files live where GitHub Actions expects them (`.github/workflows/`).
Auxiliary scripts live alongside the existing
`scripts/{package,audit-*}.mjs` family (same `.mjs` convention, same
runtime, same test setup). Tests slot into the existing
`test/unit/` tree under a `ci/` subfolder for discoverability. The
runbook lives under `docs/` next to the existing
`{quickstart,features,troubleshooting}.md`.

## Complexity Tracking

No constitution violations to justify. The plan introduces:

- 3 workflow YAML files (release-engineering plumbing, not application logic)
- 5 small (~50–200 LOC each) `.mjs` scripts (matching existing convention)
- 5 vitest unit test files (matching existing test convention)
- 1 documentation file (the runbook)

Total net new LOC: ~1500 (scripts + tests + docs), well within
Constitution V's "smallest scope that delivers user value" bound.

---

## Phase 0 Output

See [research.md](research.md) for the resolved technical decisions
behind each "needs research" item identified in the Technical Context.

## Phase 1 Output

See [data-model.md](data-model.md), [contracts/](contracts/), and
[quickstart.md](quickstart.md).

## Post-Design Constitution Re-check

Phase 1 design preserves the gate decisions above:

- Principle III: every script in `scripts/ci/` has a corresponding
  `test/unit/ci/*.test.ts` planned (see data-model.md "Script ↔ Test
  matrix").
- Principle IV: the contracts/script-cli.md exit-code table makes the
  observability surface explicit (every script's failure modes have a
  numbered exit code documented for the runbook to reference).
- Principle V: contracts/secrets.md mandates exactly ONE repository
  secret (`VSCE_PAT`); no additional Marketplace-related secrets are
  introduced. The runbook stays at a single page.

✅ Re-check PASS — proceed to `/speckit-tasks`.
