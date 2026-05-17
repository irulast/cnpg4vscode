---
description: "Task list for spec 002: GitHub Actions CI/CD on Self-Hosted Runners"
---

# Tasks: GitHub Actions CI/CD on Self-Hosted Runners

**Input**: Design documents in [specs/002-github-actions-deploy/](./)

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: REQUIRED for every auxiliary `.mjs` script with logic (Constitution III). NOT required for workflow YAML — those are gated by `actionlint` (syntactic) + workflow run (semantic), per the plan's Constitution Check carve-out. Test-first cycle per script: failing vitest test → implementation → green.

**Organization**: Tasks grouped by user story. US1 + US2 are co-priority (both P1, MVP); US2 ships after US1 in this list because US2's `wait-for-ci-gate.mjs` polls for a CI run that US1's `ci.yml` produces. US3 is layered into US2's publish workflow (release-create stage). US4 is independent.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable — different files, no dependency on incomplete prior tasks
- **[Story]**: Owning user story (US1 / US2 / US3 / US4) — Setup / Foundational / Polish have NO story label
- Every task description names the exact file path it touches

## Path Conventions

- Workflow files: `.github/workflows/<name>.yml`
- Auxiliary scripts: `scripts/ci/<name>.mjs`
- Unit tests: `test/unit/ci/<name>.test.ts`
- Runbook: `docs/release-process.md`
- Security allowlist (US4): `.github/security-allowlist.json`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Carve out the directory structure the rest of the tasks fill in.

- [X] T001 Create the four new directories the spec needs: `.github/workflows/`, `scripts/ci/`, `test/unit/ci/`, and a `docs/` placeholder if absent (most exist already; this task is a `mkdir -p` + a `.gitkeep` in any empty leaf).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Verify the existing project infrastructure supports the new test files + script invocation pattern. No new dependencies; only sanity checks.

- [X] T002 Verify the existing `pnpm test:unit` glob (`vitest run test/unit`) picks up `test/unit/ci/**/*.test.ts` once they exist. Land a single sentinel test at `test/unit/ci/_smoke.test.ts` asserting `1 + 1 === 2`; run `pnpm test:unit` and confirm it executes. Delete the sentinel after the first real US2/US3 test lands (or absorb it into one).

**Checkpoint**: Foundation ready — user story work can begin.

---

## Phase 3: User Story 1 — Every PR runs the quality gate before it can merge (Priority: P1) 🎯 MVP

**Goal**: Land `.github/workflows/ci.yml` that runs the full quality gate (actionlint → typecheck → lint → test:unit → test:contract → build → audit:csp → audit:deps) on every PR and every push to main, on the self-hosted `mke-builds` pool. Branch protection gates merges on it.

**Independent Test**: Open a no-op PR; the workflow fires, each stage runs in order on `mke-builds`, and a single `CI Gate / summary` check appears as required on the PR. Open a second PR that breaks `pnpm typecheck`; the workflow fails at the typecheck stage and the merge button stays disabled.

### Implementation for User Story 1

- [X] T003 [US1] Author `.github/workflows/ci.yml` with the workflow contract from [contracts/workflow-triggers.md](contracts/workflow-triggers.md): triggers `pull_request` (branches: [master]) + `push` (branches: [master]) + `workflow_dispatch`; concurrency group `ci-${{ github.ref }}` with `cancel-in-progress: true`; jobs: `preflight` (hosted-runner refusal guard from research §2 + actionlint via the pinned v1.7.7 installer from research §9), `gate` (pnpm install with `actions/setup-node@v4`'s `cache: 'pnpm'` + the eight stage steps in order), `summary` (a single zero-step job that depends on `gate` and exists purely to give branch protection a stable check name `"CI Gate / summary"`). `runs-on: mke-builds` on every job. NO `pull_request_target` — `actionlint` rejects it by config, but the contract also forbids it.
- [X] T004 [US1] Validate `ci.yml` locally with `actionlint`: download the v1.7.7 binary via the installer script in research §9 and run `./actionlint .github/workflows/ci.yml`. Fix any reported issues before the PR opens; iteration cost is zero.
- [ ] T005 [US1] Open a smoke-test PR (any tiny no-op change — a typo fix in a markdown file is ideal) and confirm: (a) all eight stage steps execute in order on `mke-builds`; (b) cold-cache duration ≤ 10 min (SC-002); (c) warm-cache duration on a follow-up commit ≤ 5 min (SC-003); (d) the failing-stage-fails-the-summary path: push a deliberately broken commit and confirm `CI Gate / summary` flips red.
- [ ] T006 [US1] Configure branch protection on `master` per [quickstart.md](quickstart.md) §8 (single `gh api -X PUT` call). Required check: `CI Gate / summary`. After landing, verify with `gh api repos/irulast/cnpg4vscode/branches/master/protection --jq '.required_status_checks.contexts'` (must include the check name).

**Checkpoint**: User Story 1 fully functional. Every PR runs the gate; failing checks block merge; SC-002, SC-003, SC-006, SC-008 are observable.

---

## Phase 4: User Story 2 — A new version tag publishes the extension to the Marketplace automatically (Priority: P1) 🎯 MVP

**Goal**: Land `.github/workflows/publish.yml` + four auxiliary scripts (`validate-tag.mjs`, `check-marketplace-version.mjs`, `wait-for-ci-gate.mjs`, `publish-vsix.mjs`) + `.github/workflows/publish-recover.yml`. Pushing `v0.2.0` or `v0.2.0-beta.1` to main publishes the right channel; the PAT never leaks; partial-publish failures route to a one-line recovery dispatch.

**Independent Test**: Bump `package.json` to a fresh version on a dummy fork or a `pre-release` channel test, push the matching tag, observe: (a) the publish workflow runs on `mke-builds`; (b) wait-for-ci-gate exits 0 once CI is green on the SHA; (c) the package stage produces six VSIX artifacts that upload as a workflow artifact bundle; (d) the publish stage publishes all six (or fails the workflow and prints the recovery dispatch). Confirm `VSCE_PAT` literal appears nowhere in the workflow log via `gh run view <id> --log | grep -F "$VSCE_PAT"` returning empty (SC-005).

### Tests for User Story 2 (failing-first per Constitution III)

- [X] T007 [P] [US2] Write failing vitest tests at `test/unit/ci/validate-tag.test.ts` for `validate-tag.mjs` covering the [contracts/script-cli.md](contracts/script-cli.md) exit-code matrix: stable tag (`v0.2.0`) → exit 0 + stdout `channel=stable;version=0.2.0`; pre-release tag (`v0.2.0-beta.1`) → exit 0 + `channel=pre-release;version=0.2.0-beta.1`; missing `v` prefix → exit 1; SemVer-violating tag (`v0.2`) → exit 1; tag-version mismatch with a fixture `package.json#version` → exit 2; unreadable `package.json` (fixture path missing) → exit 3.
- [X] T008 [P] [US2] Write failing vitest tests at `test/unit/ci/check-marketplace-version.test.ts` for `check-marketplace-version.mjs`: mock `vsce show --json` to return a fixture version list; assert `(version, channel)` collision → exit 1; same version different channel → exit 0; absent version → exit 0; `vsce show` non-zero → exit 2; malformed JSON → exit 2; unknown channel argv → exit 3.
- [X] T009 [P] [US2] Write failing vitest tests at `test/unit/ci/wait-for-ci-gate.test.ts` for `wait-for-ci-gate.mjs`: mock `gh run list` JSON output across the polling lifecycle: immediate `success` → exit 0 + stdout `conclusion=success;run_id=…;run_url=…`; `failure`/`cancelled`/`timed_out`/`neutral`/`action_required` each → exit 1; `queued → in_progress → success` sequence with stubbed clock → exit 0 within 3 polls; 30-min timeout (stubbed clock advances past `--timeout-seconds`) → exit 2; `gh` non-zero → exit 3; missing SHA argv → exit 4; multiple eligible runs → picks highest `databaseId`.
- [X] T010 [P] [US2] Write failing vitest tests at `test/unit/ci/publish-vsix.test.ts` for `publish-vsix.mjs`: happy path (mock `vsce publish` to succeed for all six targets) → exit 0; per-target transient failure that succeeds on retry → exit 0 + retry visible in stderr; per-target terminal failure after `--max-retries` → exit 1 + the exact `Recovery: gh workflow run publish-recover.yml -f tag=… -f targets=…` line on stdout; all six terminal failures → exit 2; missing `VSCE_PAT` env → exit 3; defensive end-of-run PAT-substring scan over captured output (use a sentinel PAT in the fixture; assert NO substring of length ≥ 8 appears in captured stdout/stderr) → if any substring found, script exits 4; pre-release flag wiring (the spawned `vsce` argv contains `--pre-release` exactly when `--channel pre-release` is passed); build-then-publish staging invariant (no `vsce publish` spawn observed before the package stage emits the artifact bundle — assert against the spawn-call order in the mock).

### Implementation for User Story 2

- [X] T011 [P] [US2] Implement `scripts/ci/validate-tag.mjs` matching the contract from T007. Read `package.json` from `process.cwd()` (matches existing `scripts/package.mjs` convention). SemVer regex: `^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$`. Run `pnpm test:unit -- test/unit/ci/validate-tag.test.ts` to green.
- [X] T012 [P] [US2] Implement `scripts/ci/check-marketplace-version.mjs` matching the contract from T008. Spawn `npx --no @vscode/vsce show <pub>.<ext> --json`, parse stdout JSON, walk `versions[]` matching `(version, preRelease)` against the requested `(version, channel)` tuple (`channel === "pre-release"` maps to `preRelease === true`). Run tests to green.
- [X] T013 [P] [US2] Implement `scripts/ci/wait-for-ci-gate.mjs` matching the contract from T009. Use `child_process.spawnSync` to invoke `gh run list --commit "$SHA" --workflow ci.yml --event push --json conclusion,status,databaseId --limit 10`. Read `GH_TOKEN` from env so `gh` doesn't prompt. Polling loop with `setTimeout` (use `setInterval` for testability — pass a clock-injector for tests). Run tests to green.
- [X] T014 [US2] Implement `scripts/ci/publish-vsix.mjs` matching the contract from T010. **Build stage first**: invoke `pnpm package -- --target <triple>` (existing `scripts/package.mjs`) for each of the six targets, accumulating built VSIX paths. Bail before any publish call if any target's build fails. **Publish stage**: per-target `vsce publish --no-dependencies --target <triple> [--pre-release] --packagePath <vsix>` with `VSCE_PAT` passed via `process.env` (NEVER argv) and `child_process.spawn` env-cleared for other spawns. Per-target retry on stderr-classified transient errors (HTTP 5xx, ECONNRESET, ETIMEDOUT) with exponential backoff: 5s, 15s, 45s, give up. Append per-target results to a summary table in `process.env.GITHUB_STEP_SUMMARY` if set. End-of-run PAT-leak scan over the captured output buffer; exit 4 if any substring ≥ 8 chars of `VSCE_PAT` appears. Run tests to green.
- [X] T015 [US2] Author `.github/workflows/publish.yml` per [contracts/workflow-triggers.md](contracts/workflow-triggers.md) and [contracts/secrets.md](contracts/secrets.md). Trigger: `push: { tags: ['v[0-9]+.[0-9]+.[0-9]+', 'v[0-9]+.[0-9]+.[0-9]+-*'] }`. Concurrency: `publish-${{ github.ref_name }}`, `cancel-in-progress: false`. Jobs: `preflight` (hosted-runner refusal + merge-base-from-main check + `validate-tag.mjs` to derive `channel` + `version`); `wait-ci` (depends on `preflight`; runs `wait-for-ci-gate.mjs` with the tagged SHA and 30-min timeout); `collision-check` (depends on `wait-ci`; runs `check-marketplace-version.mjs`); `package` (depends on `collision-check`; builds all six VSIXs via `publish-vsix.mjs --dry-run` or just `pnpm package`; uploads as workflow artifact `vsix-bundle-${{ github.ref_name }}`); `publish` (depends on `package`; downloads the artifact; runs `publish-vsix.mjs --tag … --channel … --artifacts-dir ./vsix-bundle` with `VSCE_PAT` exposed in per-step `env:` ONLY). `runs-on: mke-builds` on every job.
- [X] T016 [US2] Author `.github/workflows/publish-recover.yml` per [contracts/workflow-triggers.md](contracts/workflow-triggers.md). Trigger: `workflow_dispatch` with `tag` (string, required) + `targets` (string, required, comma-list) inputs. Concurrency: `publish-${{ inputs.tag }}`, `cancel-in-progress: false` (shares lock with publish.yml). Jobs: `preflight` (validates `tag` exists in git + matches SemVer + re-runs `validate-tag.mjs`); `recover` (re-uses the existing artifact via `actions/download-artifact@v4` if present in the 90-day window — otherwise re-runs the build for the listed targets only; then runs `publish-vsix.mjs --tag … --channel … --artifacts-dir ./vsix-bundle --targets <inputs.targets>`).
- [X] T017 [US2] Validate both workflows with the pinned `actionlint`: `./actionlint .github/workflows/publish.yml .github/workflows/publish-recover.yml`. Fix any reported issues.
- [ ] T018 [US2] Smoke-test on a throwaway pre-release tag: bump `package.json` to `0.0.1-test.1`, push tag `v0.0.1-test.1`, observe the workflow runs end-to-end on `mke-builds`, publishes to the pre-release channel under the publisher account, and the final summary table shows six green targets. After verification, unpublish via `vsce unpublish irulast.cnpg4vscode@0.0.1-test.1` (Marketplace allows unpublishing if no installs occurred within minutes of publish) OR leave it visible only to opt-in pre-release users.
- [ ] T019 [US2] Smoke-test the PAT-leak invariant (SC-005): after the T018 smoke run, fetch the workflow log via `gh run view <id> --log` and confirm `grep -F "$VSCE_PAT" <log>` returns empty. Also confirm via `grep -E '(pat|token|secret)=[A-Za-z0-9]{8,}' <log>` returns empty (no credential-shaped substrings).
- [ ] T020 [US2] Smoke-test partial-publish recovery: simulate by temporarily breaking one platform's publish (e.g., set `--max-retries 0` and inject an env var the `publish-vsix.mjs` mock recognises as "fail this target"). Confirm the workflow ends in `failure`, the run summary contains the exact `Recovery: gh workflow run publish-recover.yml -f tag=… -f targets=…` line, and copy-pasting it into the terminal completes the publish.

**Checkpoint**: User Story 2 fully functional. Tagged pushes publish; partial failures recover; PAT never leaks. SC-001, SC-004, SC-005, SC-007, SC-009, SC-010 are observable.

---

## Phase 5: User Story 3 — Per-platform VSIXs are attached to a GitHub Release (Priority: P2)

**Goal**: Add a `release-create` stage to `publish.yml` (NOT a new workflow file) that, after the publish stage succeeds, creates a GitHub Release for the tag, attaches all six VSIX artifacts, and embeds the auto-generated changelog. Re-runs are idempotent via `--clobber`.

**Independent Test**: Push a fresh stable tag, observe the GitHub Releases page now has an entry for the tag with six VSIX assets and a changelog body grouped by Conventional Commit prefix. Re-run the workflow (`gh workflow run publish.yml --ref <tag>`); confirm no duplicate assets, no duplicate Release.

### Tests for User Story 3 (failing-first per Constitution III)

- [X] T021 [P] [US3] Write failing vitest tests at `test/unit/ci/generate-release-notes.test.ts` for `generate-release-notes.mjs`: feed a fixture commit list (mock `git log` via the `--git-log-stdin` flag the script exposes for testability, or via a fixture file argument); assert Conventional Commits grouping (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`, `revert`); assert non-conforming commits bucket into `Other`; assert empty commit range renders the literal "_No commits between &lt;from&gt; and &lt;to&gt;._" body and exits 0; assert the trailing `**Full Changelog**: <compare-url>` line uses `https://github.com/irulast/cnpg4vscode/compare/<from>...<to>` shape; assert SHA-link rendering uses 7-char short SHA.

### Implementation for User Story 3

- [X] T022 [P] [US3] Implement `scripts/ci/generate-release-notes.mjs` matching the contract from T021. Pure stdin/stdout module; reads commits via `git log <from>..<to> --pretty=format:"%H|%s"` (spawned) or from a `--git-log-stdin` fixture (for tests). Group by prefix via a frozen regex map. Run tests to green.
- [X] T023 [US3] Extend `.github/workflows/publish.yml` (NOT a new file — same workflow as T015) with a new `release-create` job that depends on `publish` succeeding. Steps: derive previous tag via `git describe --tags --abbrev=0 HEAD^` (or "first tag" fallback); run `generate-release-notes.mjs --from <prev> --to <current>` and capture to `release-notes.md`; download the VSIX artifact bundle from the package stage; check Release existence via `gh release view "$TAG"` (silent on absence) and either `gh release create "$TAG" *.vsix --notes-file release-notes.md --title "$TAG"` (when absent) OR `gh release upload "$TAG" *.vsix --clobber` (when present) per research §7's idempotency pattern. `runs-on: mke-builds`.
- [X] T024 [US3] Re-run `actionlint` on the updated `publish.yml`.
- [ ] T025 [US3] Smoke-test: re-tag the T018 smoke version (or pick a fresh pre-release version) and confirm a GitHub Release appears at `https://github.com/irulast/cnpg4vscode/releases/tag/<tag>` with six VSIX assets and the changelog body. Re-run via `gh workflow run publish.yml --ref <tag>` and confirm no duplicate assets / no duplicate Release.

**Checkpoint**: User Story 3 fully functional. Every published tag has a corresponding GitHub Release with per-platform sideload-ready VSIXs. FR-020, FR-021, FR-022 satisfied.

---

## Phase 6: User Story 4 — Dependency security scanning blocks vulnerable dependencies on PRs (Priority: P3)

**Goal**: Add a `security-scan` stage to `ci.yml` that runs `pnpm audit` against the production dependency tree, parses the JSON output, compares against an in-repo allowlist file, and fails the gate on un-allowlisted advisories at or above HIGH severity.

**Independent Test**: Add a dependency known to have a HIGH-severity advisory; PR fails at the security-scan stage with the advisory ID + CVSS in the summary. Add an entry for that advisory to `.github/security-allowlist.json` with a justification comment; PR passes the scan but still flags any OTHER advisory.

### Tests for User Story 4 (failing-first per Constitution III)

- [X] T026 [P] [US4] Write failing vitest tests at `test/unit/ci/scan-advisories.test.ts` for a new `scripts/ci/scan-advisories.mjs`. Feed a fixture `pnpm audit --json` payload: assert no advisories → exit 0; one HIGH advisory not in allowlist → exit 1 + the advisory ID + CVSS in stderr; one HIGH advisory in allowlist with justification → exit 0; one HIGH advisory in allowlist WITHOUT justification (empty justification string) → exit 2 (refuse silent allowlist entries); allowlist entry whose advisory is no longer in the audit output → exit 3 (refuse stale allowlist entries — they accumulate and weaken the gate); MODERATE / LOW advisories ignored regardless of allowlist (the gate is HIGH+ only per the assumption in spec.md FR-030 + research §1 documented severity).

### Implementation for User Story 4

- [X] T027 [P] [US4] Implement `scripts/ci/scan-advisories.mjs`. Argv: `node scripts/ci/scan-advisories.mjs --audit-json <path> --allowlist .github/security-allowlist.json`. Read both files; walk `audit.advisories` (or the `metadata.vulnerabilities.{high,critical}` summary, depending on pnpm audit's exact shape — fixture-driven from T026); compare against allowlist entries; emit a markdown summary to stderr; exit per the matrix above. Run tests to green.
- [X] T028 [P] [US4] Create `.github/security-allowlist.json` as an empty allowlist with documented schema: `{ "$schema": "./security-allowlist.schema.json", "version": 1, "allowed": [] }` (where `allowed[].advisoryId`, `allowed[].justification` (non-empty), `allowed[].reviewedBy`, `allowed[].reviewedAt` are required). Land an inline `<!-- … -->` comment block at the top explaining: "Adding an entry here weakens the security gate. Justification field is mandatory and surfaces in the PR diff so reviewers can challenge it. Stale entries (allowlisted advisory no longer in the dependency tree) trip exit code 3 and must be pruned in the same PR that removes the dependency."
- [X] T029 [US4] Extend `.github/workflows/ci.yml` (NOT a new file — same workflow as T003) with a `security-scan` step inside the `gate` job: `pnpm audit --prod --json > audit.json || true` (audit returns non-zero on findings; the `|| true` lets us hand the JSON to our parser instead), then `node scripts/ci/scan-advisories.mjs --audit-json audit.json --allowlist .github/security-allowlist.json`. The stage's exit code propagates to the gate's success/failure.
- [X] T030 [US4] Re-run `actionlint` on the updated `ci.yml`.
- [ ] T031 [US4] Smoke-test: open a PR adding a dependency known to have a HIGH-severity advisory (e.g., a deliberately old version of a familiar package); confirm the gate fails with the advisory ID surfaced; add the advisory ID to `.github/security-allowlist.json` with a justification; confirm the gate passes; remove the dependency entirely and confirm the gate now fails with exit-code 3 (stale allowlist entry).

**Checkpoint**: User Story 4 fully functional. Vulnerable dependencies block merges; allowlist entries are auditable in PR diffs; stale entries are detected.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, smoke-test runbook validation, and the post-implementation workflow audit.

- [X] T032 Author `docs/release-process.md` as a near-duplicate of [quickstart.md](quickstart.md) (the runbook lives in the repo, not just in this spec dir). Link from the README's roadmap / contributing section so contributors can find it. Diffs from quickstart.md: drop the spec-internal commentary, keep the procedural sections (§1 setup, §2 stable release, §3 pre-release, §4 partial recovery, §5 CI-race, §7 PAT rotation, §8 branch protection, §9 troubleshooting). The §6 workflow audit is the post-implementation T034 smoke task.
- [X] T033 [P] Update the project [README.md](../../README.md) "Roadmap" section to mention "Automated CI/CD via GitHub Actions on self-hosted runners — see [docs/release-process.md](docs/release-process.md)" (one bullet, points at the runbook).
- [X] T034 Run the post-implementation workflow audit from [quickstart.md](quickstart.md) §6 end-to-end on the integrated branch. Every check must pass: `actionlint` clean; `gh secret list` returns exactly `VSCE_PAT`; branch protection requires `CI Gate / summary`; every `runs-on:` is `mke-builds`; no `pull_request_target` anywhere; `VSCE_PAT` references are all per-step `env:` only; `pnpm test:unit -- test/unit/ci` passes.
- [ ] T035 Tag a real preview release once T034 passes — `v0.1.0-preview.1` or similar. Confirm the full pipeline lands the pre-release on the Marketplace, a GitHub Release exists, the changelog is reasonable. This is the spec's SC-001 end-to-end validation ("maintainer can ship by performing only edit + merge + tag").

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No prereqs.
- **Foundational (Phase 2)**: Depends on Setup.
- **US1 (Phase 3)**: Depends on Foundational. Independent of US2/US3/US4 functionally (but US2's wait-for-ci-gate needs US1's workflow to actually be present for end-to-end smoke).
- **US2 (Phase 4)**: Depends on Foundational. The publish workflow can technically be authored before US1 (no source-code dependency on `ci.yml`), but the end-to-end smoke (T018) requires US1's `ci.yml` to exist so the wait-for-ci-gate poll finds a green run.
- **US3 (Phase 5)**: Depends on US2 — extends `publish.yml` with a new job (T023 edits the file US2 created at T015).
- **US4 (Phase 6)**: Depends on US1 — extends `ci.yml` with a new step (T029 edits the file US1 created at T003).
- **Polish (Phase 7)**: Depends on US1+US2+US3+US4. T035 is the load-bearing end-to-end validation.

### Per-Story Internal Order

Each user story follows: tests (failing) → script implementation → workflow wiring → actionlint → smoke. Constitution III's test-first discipline applies to every `.mjs` script:

- T007–T010 (US2 tests) MUST go red before T011–T014 (US2 impls).
- T021 (US3 test) MUST go red before T022 (US3 impl).
- T026 (US4 test) MUST go red before T027 (US4 impl).

### Parallel Opportunities

- T007, T008, T009, T010 [P] [US2]: four script tests, four different files, no inter-dependencies — write them in one sitting.
- T011, T012, T013 [P] [US2]: three script impls, three different files. T014 (publish-vsix) is intentionally sequential because it composes the others' contracts implicitly.
- T021 [P] [US3] + T026 [P] [US4]: cross-story parallelism — different files, different stories.
- T032 + T033 [P]: docs work in parallel.

### Sequential Bottlenecks

- T015 (publish.yml) waits on T011–T014 (the scripts it wires).
- T023 (release-create stage in publish.yml) waits on T015 (the file it edits) AND T022 (the script it invokes).
- T029 (security-scan step in ci.yml) waits on T003 (the file it edits) AND T027 (the script it invokes).
- T034 (workflow audit) waits on T003, T015, T016, T023, T029 (the audit scans all workflows).
- T035 (real preview release) waits on EVERYTHING — it's the final SC-001 validation.

---

## Parallel Example: User Story 2 Test-First Wave

```bash
# Four script tests in parallel (T007-T010):
Task: "Write failing tests at test/unit/ci/validate-tag.test.ts"
Task: "Write failing tests at test/unit/ci/check-marketplace-version.test.ts"
Task: "Write failing tests at test/unit/ci/wait-for-ci-gate.test.ts"
Task: "Write failing tests at test/unit/ci/publish-vsix.test.ts"

# Once those land, three script impls in parallel (T011-T013):
Task: "Implement scripts/ci/validate-tag.mjs"
Task: "Implement scripts/ci/check-marketplace-version.mjs"
Task: "Implement scripts/ci/wait-for-ci-gate.mjs"

# T014 (publish-vsix) waits for the above to settle since the
# contract draws on conventions established in T011-T013.
```

---

## Implementation Strategy

### MVP First (US1 + US2 — both P1)

US1 and US2 are co-priority. Implement in order:

1. Complete Phase 1 + Phase 2 (Setup + Foundational, ~5 min of work).
2. Complete Phase 3 (US1): land `ci.yml`, smoke-test on a real PR, configure branch protection.
3. Complete Phase 4 (US2): land the four scripts + two workflow files, smoke-test on a pre-release version.
4. **STOP & VALIDATE**: confirm SC-001 holds for a stable release (bump → merge → tag → Marketplace update). This is the MVP demo gate.

### Incremental Delivery

Picking up from the MVP gate, layer the optional stories in priority order:

1. Add Phase 5 (US3): GitHub Releases layer. Smoke-test re-tag.
2. Add Phase 6 (US4): dependency security scan. Smoke-test the allowlist round-trip.
3. Add Phase 7 (Polish): docs + audit + real preview release.

Each story adds value without breaking previous stories. US3 and US4 are genuinely optional for the first release — the MVP can ship the Marketplace publish path without GitHub Releases, and can ship without CVE scanning (the existing license-audit script in `audit-deps.mjs` is unrelated and stays).

### Parallel Team Strategy

Single-maintainer project today (per spec assumption), so parallelism is one-developer parallel (i.e., the [P] tasks in the same file-domain can be batched in a single editing session). When the contributor pool grows, the cross-story parallelism (T021 alongside T026) maps cleanly to two developers.

---

## Notes

- Constitution III applies to scripts, not workflow YAML. Workflow YAML is gated by `actionlint` + runtime check (T004, T017, T024, T030).
- Constitution V is preserved: no third-party action repos, no new dependency frameworks, no shared composite-action library until a third workflow demands it.
- Constitution IV is preserved: `publish-vsix.mjs`'s end-of-run PAT-scan + the `$GITHUB_STEP_SUMMARY` recovery-dispatch surface (FR-017a #4) are the observability load-bearers.
- Every workflow YAML edit must be followed by `./actionlint` BEFORE pushing — fixing actionlint failures in PR review is slower than fixing them locally.
- Smoke tests (T005, T018, T019, T020, T025, T031, T035) are MANUAL by nature — automated workflow E2E testing is a separate spec (mirrors spec 001's blocked-on-test-infra tasks).

---

## Summary

| Metric                                            | Value |
| ------------------------------------------------- | ----- |
| Total tasks                                       | 35    |
| Setup + Foundational                              | 2     |
| US1 (CI gate)                                     | 4     |
| US2 (Publish: 5 tests + 4 scripts + 2 yml + smoke) | 14   |
| US3 (GitHub Releases)                             | 5     |
| US4 (Dep scan)                                    | 6     |
| Polish                                            | 4     |
| Parallel-marked tasks                             | 13    |
| Required-test tasks (one per script with logic)   | 5     |

MVP scope: T001 → T020 (Phases 1–4). Everything past T020 layers onto the working pipeline incrementally.
