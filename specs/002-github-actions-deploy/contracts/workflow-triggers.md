# Contract: Workflow Triggers

Pins the event → workflow mapping. Each workflow's `on:` block MUST
match this contract exactly; deviations are caught by the workflow
audit in `quickstart.md` §6.

---

## `ci.yml`

```yaml
on:
  pull_request:
    branches: [master]
  push:
    branches: [master]
  workflow_dispatch:        # manual re-trigger (e.g. flaky cache)
```

**Trigger semantics**:

| Event | Source | Secrets exposed? | Required check on PR merge? |
|---|---|---|---|
| `pull_request` from upstream branch | Maintainer / collaborator | ✅ (but no publish-stage steps in this workflow) | ✅ |
| `pull_request` from fork | External contributor | ❌ (GitHub platform guarantee — see research §5) | ✅ |
| `push` to `master` | Merge of a PR / direct admin push | ✅ | n/a |
| `workflow_dispatch` | Maintainer manual via Actions UI | ✅ | n/a |

**Explicitly NOT triggered by**:

- `pull_request_target` — opens the secrets-in-fork-context CWE.
  Banned by the contract; `actionlint` catches the keyword.
- `schedule` — no cron triggers (the CI gate is event-driven; nightly
  runs add cost without signal).
- Tag pushes — handled by `publish.yml`.

**Concurrency**:

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

PR force-push cancels the in-flight run for that ref. Push-to-master
events get their own group (`refs/heads/master`) so they never cancel
PR runs.

---

## `publish.yml`

```yaml
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'           # stable: v0.2.0
      - 'v[0-9]+.[0-9]+.[0-9]+-*'         # pre-release: v0.2.0-beta.1
```

**Trigger semantics**:

| Tag form | Channel | Example | Triggers workflow? |
|---|---|---|---|
| `v<major>.<minor>.<patch>` | stable | `v0.2.0` | ✅ |
| `v<major>.<minor>.<patch>-<suffix>` | pre-release | `v0.2.0-beta.1`, `v0.2.0-rc.2` | ✅ |
| `release-2026-05` | n/a | — | ❌ (matches neither pattern) |
| `v0.2` (missing patch) | n/a | — | ❌ |
| `0.2.0` (no `v` prefix) | n/a | — | ❌ |
| Any tag on a non-master branch | n/a | — | Triggered, but `preflight` step fails before any publish work via the `merge-base ↔ master` check (FR-018) |

**Defensive guard inside the workflow**:

```yaml
jobs:
  preflight:
    runs-on: mke-builds
    if: github.repository == 'irulast/cnpg4vscode' && github.event_name == 'push'
    steps:
      - name: Refuse hosted runners
        run: |
          if [[ "${RUNNER_ENVIRONMENT:-self-hosted}" != "self-hosted" ]]; then
            echo "::error::This workflow requires self-hosted runners."
            exit 1
          fi
      - name: Refuse tags not reachable from master (FR-018)
        run: |
          git fetch --depth=1 origin master:refs/remotes/origin/master
          if ! git merge-base --is-ancestor "${{ github.sha }}" refs/remotes/origin/master; then
            echo "::error::Tag ${{ github.ref_name }} points at a commit not reachable from master."
            exit 1
          fi
```

**Concurrency**:

```yaml
concurrency:
  group: publish-${{ github.ref_name }}
  cancel-in-progress: false
```

Two `git push` of the same tag (rare, but possible after a force-tag)
serialise. Different tags publish concurrently. NEVER cancel a
publish — partial-success state is what FR-017a covers.

---

## `publish-recover.yml`

```yaml
on:
  workflow_dispatch:
    inputs:
      tag:
        description: "Tag to recover (e.g. v0.2.0 or v0.2.0-beta.1)"
        required: true
        type: string
      targets:
        description: "Comma-separated platform list (e.g. darwin-arm64,win32-x64)"
        required: true
        type: string
```

**Trigger semantics**: maintainer-only. `workflow_dispatch` requires
write access to the repo, so no fork-PR concern.

**Validation inside the workflow**:

| Input | Validation | Error → exit code |
|---|---|---|
| `tag` | Must exist as a git tag in the repo | Hard fail, summary names the tag |
| `tag` | Must match the same SemVer patterns as `publish.yml` | Hard fail |
| `targets` | Each comma-separated entry must be one of the six known triples | Hard fail, summary lists the bad ones |
| `targets` | Each entry must not already be published at `(tag, channel)` per `check-marketplace-version.mjs` | Skip with a warning (idempotent recovery) |

**Concurrency**: shares `publish-${{ inputs.tag }}` group with the
main publish workflow so a maintainer can't trigger recovery WHILE
the original publish is still attempting per-target retries.

---

## What's NOT a trigger

The contract explicitly excludes:

- **`release` events** — we use `gh release create` from inside
  `publish.yml`; we don't listen for Releases-created events to
  trigger downstream work. Keeps the trigger graph acyclic.
- **`repository_dispatch`** — no external system pokes our workflows.
- **`registry_package`** — we don't publish container images from
  this repo.
- **`check_run` / `check_suite`** — we read these via the `gh` API in
  `wait-for-ci-gate.mjs`; we don't trigger workflows on them.
