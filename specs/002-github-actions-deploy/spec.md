# Feature Specification: GitHub Actions CI/CD on Self-Hosted Runners

**Feature Branch**: `002-github-actions-deploy`

**Created**: 2026-05-16

**Status**: Implemented (2026-05-17) — 27 of 35 tasks complete. The remaining 8 are all manual / out-of-band: smoke-test PRs (T005, T018, T019, T020, T025, T031), branch protection configuration via `gh api` (T006), and the first real preview release (T035). These need a maintainer + the remote and are documented in [tasks.md](tasks.md) and [docs/release-process.md](../../docs/release-process.md). All workflow files, auxiliary scripts, and tests are landed and CI-gate-green.

**Input**: User description: "We've implemented everything in the current spec that we can without test-containers and infrastructure for them. I think this current spec is complete, just needs to be updated to show so. Let's make a new smaller spec for setting up GH actions to manage this deployment from the master branch. We should use our own runners (see /home/adam/WebstormProjects/k8s-setup). The PAT for the vscode marketplace is stored as a secret on the repo."

## Clarifications

### Session 2026-05-17

- Q: When a SemVer pre-release tag (`v0.2.0-beta.1`, `v0.2.0-rc.2`, etc.) is pushed, what should the publish workflow do? → A: Pre-release tags publish to the Marketplace **pre-release channel** (`vsce publish --pre-release`); stable tags (no SemVer suffix) publish to the stable channel. VS Code natively distinguishes the two and only auto-installs pre-releases for users who opted into "Switch to Pre-Release Version".
- Q: When the publish workflow fires for a commit whose CI gate hasn't yet reached a conclusion (tag pushed before post-merge CI finishes), what should it do? → A: **Wait** for the CI gate to conclude on the tagged commit, bounded by a 30-minute timeout. Green → proceed. Red → fail the publish. Timeout → fail the publish with a "CI did not complete within 30 minutes" message so the maintainer can investigate (no implicit silent retry).
- Q: When the per-platform publish set ends in partial-success (some VSIXs live on the Marketplace, some failed after retries), what does the workflow do? → A: **Build all six VSIXs up front, then publish in a separate stage.** On partial-publish failure after retries, the workflow fails loud, leaves the already-published platforms live (Marketplace versions are immutable — rollback is not an option), and exposes a `workflow_dispatch`-callable recovery entry-point that publishes only the missing platforms for the same tag. The maintainer doesn't bump-and-re-push the tag.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Every pull request runs the quality gate before it can merge (Priority: P1) 🎯 MVP

A contributor opens a pull request against `master`. Within a few minutes, the
PR shows status checks reporting whether the change passes type-checking,
lint, the unit and contract test suites, the production build, the
webview CSP audit, and the dependency-licence audit. The maintainer cannot
merge the PR until every check is green. A red check links straight to the
failing log line so the contributor can fix the issue without guessing what
broke.

**Why this priority**: The deployment pipeline (US2) is only safe if the
code being deployed is gate-tested. Without P1, any push to `master` could
ship broken code to every user of the extension on the Marketplace. CI on
PRs is the floor.

**Independent Test**: Open a PR that intentionally breaks a unit test (or
introduces a TypeScript error, or a lint violation); the merge button is
disabled and the failing check names which gate failed and links to the
exact line.

**Acceptance Scenarios**:

1. **Given** a PR with a clean change, **When** the PR opens, **Then** all
   quality checks pass within the budgeted time and the merge button
   becomes available.
2. **Given** a PR with a unit-test regression, **When** the PR opens,
   **Then** the test-stage check fails, the merge button stays disabled,
   and the check summary names the failing test file and line.
3. **Given** a PR with a TypeScript error, **When** the PR opens, **Then**
   the typecheck stage fails with the compiler's exact diagnostic.
4. **Given** a PR with a webview CSP escape (e.g., `unsafe-eval`), **When**
   the PR opens, **Then** the CSP-audit stage fails and names the offending
   HTML file.
5. **Given** a PR from a fork, **When** the PR opens, **Then** the same
   quality checks run, but no secret-bearing step ever executes.

---

### User Story 2 — A new version tag publishes the extension to the Marketplace automatically (Priority: P1) 🎯 MVP

The maintainer bumps `package.json` to `0.2.0`, merges to `master`, then pushes
a `v0.2.0` tag. Within minutes, an automated pipeline builds the production
bundles, packages a per-platform VSIX for every supported VS Code target
(Linux x64/arm64, macOS x64/arm64, Windows x64/arm64), and publishes each one
to the VS Code Marketplace under the maintainer's existing publisher
account, using the Personal Access Token already stored as a repository
secret. The maintainer never runs `vsce` locally; they never hand the PAT
to anyone; and the workflow logs never contain the PAT or any other
credential-shaped value.

**Why this priority**: Manual publishing was already a release-friction
hazard (FR-031 in spec 001 calls it out — the per-platform packaging step
is six invocations of `vsce package --target` plus six of `vsce publish`).
Automating it removes the most error-prone manual step in the release flow
and is a precondition for shipping frequently.

**Independent Test**: Bump the version, push the tag, observe the Marketplace
listing's version field update without any local `vsce` invocation. Confirm
the workflow log contains no occurrences of the PAT literal or any
credential-shaped string.

**Acceptance Scenarios**:

1. **Given** `package.json` at `0.2.0` and tag `v0.2.0` pushed to `master`,
   **When** the workflow runs, **Then** all six per-platform VSIXs are
   published and the Marketplace listing reflects version `0.2.0` within
   the budgeted time.
2. **Given** a tag whose version does not match `package.json` (e.g.,
   pushing `v0.2.0` when `package.json` says `0.1.9`), **When** the
   workflow runs, **Then** it fails fast on the mismatch BEFORE any
   `vsce publish` call.
3. **Given** a tag whose version is already published on the Marketplace,
   **When** the workflow runs, **Then** it fails fast with a clear "already
   published" message rather than retrying or silently no-opping.
4. **Given** a tag pushed against a commit that fails the CI quality gate,
   **When** the publish workflow runs, **Then** it refuses to publish
   until the gate is green.
5. **Given** any workflow run (success or failure), **When** the maintainer
   inspects the workflow logs, **Then** the Personal Access Token literal
   never appears in any captured output.

---

### User Story 3 — Per-platform VSIXs are attached to a GitHub Release for the same tag (Priority: P2)

When a `v*` tag publishes successfully (US2), the workflow also creates a
GitHub Release for that tag with all six per-platform VSIXs attached as
release assets and an auto-generated changelog from the commits since the
previous tag. A user who needs to sideload the extension into an air-gapped
VS Code (or who prefers VSIX-from-Releases over the Marketplace) can
download the VSIX matching their platform without ever logging into the
Marketplace.

**Why this priority**: Important but not blocking. The Marketplace is the
primary distribution channel for 95% of users; GitHub Releases are the
fallback for air-gapped / corporate-firewalled / pre-release-testing
audiences. P1 ships the primary channel; P2 layers on the fallback.

**Independent Test**: Push a `v*` tag, observe a GitHub Release appear for
that tag with six VSIX assets and a changelog summarizing commits since
the previous tag. Verify each VSIX installs cleanly via
`code --install-extension <file>.vsix` on the matching platform.

**Acceptance Scenarios**:

1. **Given** a successful Marketplace publish, **When** the workflow
   completes, **Then** a GitHub Release exists for the same tag with six
   VSIX assets named consistently (`cnpg4vscode-<platform>-<version>.vsix`).
2. **Given** a release-asset upload failure (e.g., transient API error),
   **When** the workflow retries, **Then** the upload completes
   idempotently — the workflow can be re-run and converges without
   duplicating assets.

---

### User Story 4 — Dependency security scanning blocks vulnerable dependencies on PRs (Priority: P3)

Every PR also runs a dependency vulnerability scan against the
production dependency tree. If a known vulnerability with a CVSS score
above the project threshold is introduced (or a transitive dep upgrade
brings one in), the PR's status check fails and names the offending
package + advisory link. The maintainer can dismiss specific advisories
with an explicit allowlist file kept in-repo (audit-trail visible to
reviewers).

**Why this priority**: Good hygiene, not release-blocking. The existing
`audit-deps.mjs` already runs in CI for licence checking; extending it for
CVE coverage is a small add but lower urgency than getting the basic
publish pipeline live.

**Independent Test**: Add a dependency known to have a high-severity CVE;
the PR's security check fails and names the advisory. Add the advisory to
the allowlist file; the check passes.

**Acceptance Scenarios**:

1. **Given** a PR adding a vulnerable dependency, **When** the PR opens,
   **Then** the security-audit check fails and names the advisory + CVSS.
2. **Given** a PR that adds the advisory to the allowlist file with a
   justification comment, **When** the PR opens, **Then** the security
   check passes for that advisory but continues to fail for any other.

---

### Edge Cases

- **Self-hosted runner offline** — what happens when the entire
  Kubernetes runner pool is unavailable (cluster outage, ARC controller
  crash)? Jobs MUST queue with a clear "waiting for runner" status, not
  silently fail; queued jobs MUST resume when runners come back.
- **Tag pushed without merging the version bump** — e.g., maintainer
  tags `v0.2.0` on an older commit. The mismatch detector (scenario 2)
  catches this before publishing.
- **Marketplace API down** — publish stage MUST retry with backoff
  (transient `vsce publish` failures are common when the Marketplace is
  under load), but MUST surface a clear final failure after exhausting
  retries rather than appearing successful. If the Marketplace API
  comes back online mid-set (e.g. macOS arm64 publish fails terminally
  but Linux x64–arm64 + macOS x64 + Windows x64–arm64 succeeded), the
  workflow ends in a partial-success state per FR-017a and surfaces
  the recovery `workflow_dispatch` invocation in the summary.
- **PAT rotated** — maintainer rotates the Marketplace PAT and forgets
  to update the repository secret. The next publish MUST fail with a
  clear "authentication failed — secret may be stale" message, not a
  generic 401.
- **PR from a fork** — fork PRs MUST run the CI gate (so contributors
  get feedback) but MUST NOT have access to secrets. Publishing-related
  jobs MUST be gated by the event source so a fork PR can never trigger
  a publish.
- **Concurrent tag pushes** — two `v*` tags pushed within seconds of
  each other (race during a maintainer's release session). The publish
  workflow MUST serialize so the two runs don't both attempt to publish
  the same artifact, but each MUST run to completion.
- **Branch protection bypass attempted** — admin merges to `master`
  without waiting for checks (technically possible). The publish
  workflow's "is the CI gate green on this commit?" check (US2
  scenario 4) is the second-tier defense.
- **Self-hosted runner job spans more than one runner pod** — the
  workspace volume scheme means a job's working directory MUST land on
  durable storage so a runner restart mid-job doesn't lose state, OR
  the job MUST be small enough to restart cleanly.

## Requirements *(mandatory)*

### Functional Requirements

#### CI gate (US1)

- **FR-001**: System MUST run typecheck, lint (with `--max-warnings 0`),
  unit test suite, contract test suite, production build, webview CSP
  audit, and dependency-licence audit on every pull request targeting
  `master`.
- **FR-002**: System MUST surface a single PR-blocking status check
  summarising the gate result (green if every stage passes; red
  otherwise) so branch protection can hinge on one rule rather than
  one per stage.
- **FR-003**: System MUST cache the package manager's dependency store
  across runs so the gate's wall-clock time on a cache hit is dominated
  by build + test, not dependency installation.
- **FR-004**: System MUST run all CI work on the project's self-hosted
  Kubernetes-backed runner pool, never on hosted GitHub runners. The
  workflow MUST refuse to run on a hosted runner (defensive guard
  against accidental misconfiguration billing the project for hosted
  minutes).
- **FR-005**: System MUST allow contributors from forks to run the CI
  gate against their PR, but MUST NOT expose any repository secret to
  fork-originated workflow runs.
- **FR-006**: When the gate fails, the failing-check summary MUST link
  directly to the failing log line / test name / diagnostic so the
  contributor can locate the failure without scrolling.

#### Publish (US2)

- **FR-010**: System MUST trigger the Marketplace-publish workflow on
  the push of a SemVer-shaped tag to the repository. Two tag classes
  trigger the workflow:
  - **Stable tag** (`v<major>.<minor>.<patch>` with NO suffix, e.g.
    `v0.2.0`) → publishes to the Marketplace **stable** channel.
  - **Pre-release tag** (`v<major>.<minor>.<patch>-<suffix>`, e.g.
    `v0.2.0-beta.1`, `v0.2.0-rc.2`) → publishes to the Marketplace
    **pre-release** channel (`vsce publish --pre-release`).

  Tags that match neither pattern (e.g. `release-2026-05`, `foo-bar`)
  MUST NOT trigger the workflow.
- **FR-011**: System MUST refuse to publish unless the commit the tag
  points to has the CI gate (FR-001) green on it. Three timing cases
  for the CI gate's status on the tagged commit:
  - **Green** → proceed with publish.
  - **Red / cancelled** → fail the publish immediately with a link to
    the failing CI run.
  - **Not yet concluded** (queued or in-flight; common when the
    maintainer pushes the tag immediately after merging the
    release-bump PR) → **wait** for the CI gate to reach a
    conclusion on the tagged commit, polling/subscribing with a
    bounded **30-minute timeout**. Conclusion-becomes-green proceeds;
    conclusion-becomes-red fails; timeout fails with a clear "CI did
    not complete within 30 minutes — investigate and re-trigger via
    `workflow_dispatch`" message (no silent retry).
- **FR-012**: System MUST validate that the tag's version (the `v`
  prefix stripped) matches `package.json#version` exactly, and fail
  fast on mismatch BEFORE any `vsce` invocation.
- **FR-013**: System MUST validate that the target version is NOT
  already published to the Marketplace BEFORE attempting to publish,
  and fail fast with a clear message on collision (rather than
  retrying or silently no-opping). The collision check MUST consider
  the channel — a `v0.2.0-beta.1` already on the pre-release channel
  is a collision for another `v0.2.0-beta.1` publish; a stable
  `v0.2.0` and a pre-release `v0.2.0-beta.1` are NOT collisions
  (different versions, different channels).
- **FR-014**: System MUST package and publish six per-platform VSIXs
  (Linux x64, Linux arm64, macOS x64, macOS arm64, Windows x64,
  Windows arm64) — the same set the local `scripts/package.mjs`
  produces. The workflow MUST stage the work as **build-then-
  publish**: all six VSIXs are produced and validated as workflow
  artifacts in a packaging stage that completes BEFORE any
  `vsce publish` invocation in the subsequent publish stage. A
  packaging-stage failure aborts before any platform is published; a
  publish-stage failure may leave the set partially published (see
  FR-017a).
- **FR-015**: System MUST authenticate to the Marketplace using a
  Personal Access Token stored as a repository secret. The secret name
  MUST be documented in the workflow file.
- **FR-016**: System MUST never write the PAT (or any
  credential-shaped string) to any captured log line, workflow
  artifact, or status check summary. GitHub Actions' built-in secret
  masking is the floor; the workflow MUST NOT defeat masking (e.g., by
  printing arguments to `vsce publish` raw).
- **FR-017**: System MUST retry transient `vsce publish` failures with
  exponential backoff up to a documented retry count, then surface a
  clear final failure rather than declaring success.
- **FR-017a**: When the publish stage ends in a partial-success state
  (some platforms published successfully, others failed terminally
  after retries — see FR-014's build-then-publish staging), the
  workflow MUST:
  1. Fail loud (workflow conclusion = failure; the failing-stage
     summary names the platforms that did NOT publish).
  2. Leave the already-published platforms live on the Marketplace
     (Marketplace versions are immutable — rollback is not a
     mechanism the workflow can invoke).
  3. Expose a `workflow_dispatch`-callable recovery entry-point that
     accepts a tag name + platform list and publishes ONLY those
     platforms for that tag, re-using the already-built VSIX
     artifacts when still available (re-building when not).
  4. Surface in the failing run's summary the exact
     `workflow_dispatch` invocation the maintainer should run to
     complete the publish (concrete platform list, not a generic
     "see runbook" pointer).
- **FR-018**: System MUST only fire the publish workflow on tags from
  the `master` branch (or from a tag whose merge-base history includes
  `master`). Tags from feature branches MUST NOT publish.
- **FR-019**: System MUST NOT publish from a fork PR's event context
  under any circumstance.

#### Release artefacts (US3)

- **FR-020**: System MUST create a GitHub Release for each successfully
  published version tag, attaching the six per-platform VSIXs as
  release assets with consistent naming.
- **FR-021**: System MUST auto-generate the release's changelog body
  from the commits between the previous published tag and the current
  one, organised by conventional-commit category (feat / fix / docs /
  etc.) when commit messages support it; otherwise a flat commit list.
- **FR-022**: System MUST handle re-runs of the release-assets step
  idempotently — a partial upload that's retried converges without
  duplicating assets.

#### Security scanning (US4)

- **FR-030**: System MUST run a vulnerability scan against the
  production dependency tree on every PR, failing the PR-blocking
  status check on any advisory above the documented severity
  threshold.
- **FR-031**: System MUST honour an in-repo allowlist file for
  specific advisories (with mandatory justification comment field);
  changes to the allowlist MUST appear in the PR diff so reviewers see
  them.

#### Documentation & maintenance

- **FR-040**: Workflow files MUST live under `.github/workflows/` in
  the repository and be readable as code review artefacts (i.e., not
  generated from an external source).
- **FR-041**: Repository MUST document the publish runbook (which
  secret to set, how to rotate the PAT, which runner pool labels the
  workflows target, expected wall-clock budgets) in
  `docs/release-process.md` or equivalent.
- **FR-042**: Branch protection on `master` MUST be configured to
  require the CI gate's status check before merge (this configuration
  itself is not a workflow file but a GitHub repository setting; the
  runbook MUST describe how to set it).

### Key Entities

- **CI gate run**: a workflow execution triggered by a PR or by a push
  to `master`. Carries the commit SHA, the workflow conclusion (success /
  failure / cancelled), the per-stage results, and a link to the logs.
- **Publish run**: a workflow execution triggered by a `v*.*.*` tag.
  Carries the tag name, the SHA the tag points at, the resolved
  `package.json` version, the per-platform publish results, and any
  retry history.
- **Marketplace PAT**: a credential stored as a GitHub repository
  secret. Accessed only by publish-stage steps. Never echoed into
  logs. Rotated periodically (see runbook).
- **Release artefact**: a per-platform VSIX file (`cnpg4vscode-<target>-<version>.vsix`) attached to a GitHub Release for the same tag.
- **Self-hosted runner pool**: a Kubernetes-backed scale set
  (provisioned out-of-tree in the maintainer's `k8s-setup` repo) that
  executes the workflow jobs. Two pools exist in that environment: a
  small always-warm default pool, and a larger scale-to-zero builds
  pool. The workflow targets the appropriate pool per job size.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A maintainer can ship a new version to the Marketplace
  by performing **only** these manual actions: edit `package.json`
  version, commit + merge that PR through normal review, push a `v*`
  tag. Zero local `vsce` invocations, zero local builds, zero
  manual VSIX uploads.
- **SC-002**: Cold-cache CI gate run (no dependency cache) completes
  in under **10 minutes** on the project's self-hosted pool.
- **SC-003**: Warm-cache CI gate run (dependency cache hit) completes
  in under **5 minutes** on the project's self-hosted pool.
- **SC-004**: From `git push <tag>` to the Marketplace listing
  reflecting the new version: under **15 minutes** end-to-end (cold
  cache; warm cache: under **10 minutes**), including all six
  per-platform builds and publishes.
- **SC-005**: 0 (zero) occurrences of the Marketplace PAT literal,
  decoded form, or substring (longer than 8 characters) appear in
  any workflow log line, status summary, or artifact file across the
  whole workflow run.
- **SC-006**: 100% of pull requests merged to `master` carry a green
  CI gate status check (i.e., branch protection is configured and
  effective). Audited by sampling the last 20 merges to `master`.
- **SC-007**: 100% of publish-workflow runs that complete
  "successful" result in the Marketplace listing actually reflecting
  the new version within 10 minutes of the workflow's success time.
  No "the workflow said it shipped but the listing didn't update"
  ghost successes.
- **SC-008**: 0 (zero) workflow runs ever execute on a hosted
  GitHub runner (the defensive guard from FR-004 holds). Audited by
  reviewing the runner labels on the most recent 50 workflow runs.
- **SC-009**: 0 (zero) publishing-related steps execute in the
  context of a fork PR. Audited by reviewing job-level conditions
  on the workflow files.
- **SC-010**: A contributor's time-to-feedback on a typical PR
  (clean change, warm cache) is under **5 minutes**, measured from
  push to status-check resolution.

## Assumptions

- **Self-hosted runner pool already exists and is healthy.** The
  Kubernetes-backed Actions Runner Controller scale sets are
  provisioned and operated out-of-tree (see
  `/home/adam/WebstormProjects/k8s-setup/infrastructure/mke/arc/`).
  This spec consumes that pool by label; it does not own the pool's
  lifecycle, scaling configuration, or node-affinity rules.
- **The Marketplace PAT is already created and stored as a
  repository secret.** This spec consumes it by name; it does not
  describe how to mint a new PAT or which Marketplace publisher
  account it belongs to (those are runbook-level concerns).
- **Publish trigger is version tags, not every push to `master`.** The
  user description says "manage this deployment from the main
  branch", which we interpret as "publish from master-derived state,
  triggered by an explicit release gesture". Tagging is that
  gesture. Rationale: Marketplace versions are immutable, so a
  trivial commit to master shouldn't bump the listing.
- **The maintainer is the sole publisher.** Multi-maintainer
  publishing flows (e.g., release captains, rotating roles) are not
  in scope — if the user grows the contributor pool, a follow-up
  spec for "release management roles" can layer on.
- **Per-platform packaging stays at six targets** (Linux x64/arm64,
  macOS x64/arm64, Windows x64/arm64) matching the existing
  `scripts/package.mjs`. If VS Code adds new platforms or the
  project drops one, the workflow needs an update — but the shape
  stays the same.
- **Conventional-commit messages are the changelog substrate.** The
  project doesn't currently enforce conventional commits in CI; the
  auto-changelog (FR-021) falls back gracefully to a flat list when
  messages don't follow the convention. A future "enforce
  conventional commits" rule is out of scope for this spec.
- **Branch protection configuration is set by the maintainer
  manually via the GitHub UI / API.** This spec documents the
  required configuration (FR-042) but does not encode it as
  infrastructure-as-code; the project doesn't currently use a
  GitHub-settings IaC layer (e.g., Terraform / Pulumi) and adding
  one is out of scope.
- **Pre-release and stable Marketplace channels are both first-class
  publish targets** distinguished by SemVer tag suffix (see
  Clarifications 2026-05-17 and FR-010). A user on stable VS Code's
  default install settings will only see stable-tag publishes; users
  who opted into "Switch to Pre-Release Version" see pre-release
  publishes too. The `"preview": true` flag in `package.json`
  (orthogonal — it badges the listing as preview-quality regardless
  of channel) stays as-is.
- **The dependency vulnerability scanner (FR-030)** uses a publicly
  available CVE database (e.g., GitHub Advisory Database via
  `npm audit` or `pnpm audit`). No commercial scanner subscription
  is assumed.
- **Wall-clock budgets in SC-002/SC-003/SC-004/SC-010** assume the
  self-hosted pool has adequate capacity (no cold-start node-pool
  scale-up between job dispatch and execution). If runner
  cold-starts become measurable, those budgets either widen or the
  pool's `minRunners` setting needs raising (out-of-tree concern).

## Out of Scope

- **The end-to-end test harness** (`@vscode/test-electron` +
  testcontainers + a kind cluster with CNPG installed) — that's a
  separate spec. This workflow runs the existing unit + contract
  suites, not the blocked-on-infrastructure e2e suites from spec 001.
- **Performance budget enforcement** (SC-002/SC-007 from spec 001) —
  those are gated on the same e2e harness and live in the e2e-harness
  spec.
- **Telemetry / extension usage analytics** — the extension ships zero
  telemetry by Constitution §V, and this spec doesn't change that.
- **Auto-bumping `package.json` from CI** — version bumps remain a
  manual PR gesture so they go through code review. Automating version
  bumps (e.g., release-please, semantic-release) is a separate
  decision.
- **Pull-request quality bots beyond the gate** (size labellers, stale
  closers, auto-assigners) — out of scope; can be added later as small
  individual workflows.
- **Notifications** (Slack/Discord/email on publish success or
  failure) — GitHub's built-in email notifications and the PR/Actions
  UI cover the baseline; integrating a chat notifier is a follow-up.
