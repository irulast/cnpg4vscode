# Contract: Auxiliary Script CLI Surfaces

Pins the argv shape, stdin/stdout shape, exit-code semantics, and
env-var dependencies for each `scripts/ci/*.mjs`. Every workflow
step that invokes a script MUST match this contract. Exit codes are
stable across releases (semantic-versioned by file mtime in practice,
since changes here force workflow changes).

All scripts:

- Use Node.js 22 LTS native APIs (no `dotenv`, no transpilation).
- Read their config from argv + env vars; never from a config file.
- Write structured progress to stderr (`stderr` is captured into the
  workflow log) and write the "final answer" (if any) to stdout for
  shell capture.
- Exit non-zero on any failure with a numbered, documented code.
- Never write a credential-shaped string to either stdout or stderr.

---

## `scripts/ci/validate-tag.mjs`

**Argv**: `node scripts/ci/validate-tag.mjs <tag>`

**Env**: none

**Stdout**: a single line of the form
`channel=<stable|pre-release>;version=<semver>`. Workflows consume
via `$(node scripts/ci/validate-tag.mjs "$TAG")` for `$GITHUB_OUTPUT`
forwarding.

**Stderr**: progress lines, parse errors.

**Exit codes**:

| Code | Meaning |
|---|---|
| 0 | Tag is valid; channel + version printed to stdout |
| 1 | Tag does not match either of the two SemVer patterns |
| 2 | Tag's version does not match `package.json#version` |
| 3 | `package.json` could not be read / parsed |

**Reads**: `package.json` from `process.cwd()`.

**Side effects**: none (pure validator).

---

## `scripts/ci/check-marketplace-version.mjs`

**Argv**: `node scripts/ci/check-marketplace-version.mjs <publisher> <extension> <version> <channel>`

**Env**: none (uses anonymous `vsce show`).

**Stdout**: `collision=<true|false>` on success.

**Stderr**: `vsce show` output if it fails; otherwise quiet.

**Exit codes**:

| Code | Meaning |
|---|---|
| 0 | Check ran; result printed to stdout |
| 1 | `(version, channel)` already published — workflow MUST treat as fatal |
| 2 | `vsce show` invocation failed (network, malformed JSON) |
| 3 | Invalid argv (wrong arity, unknown channel) |

**Channel argument**: must be exactly `stable` or `pre-release`.
Anything else → exit 3.

**Note**: exit 1 is split from exit 0 deliberately — collision is a
specific outcome that callers route to a clear message, not a generic
"some failure" lump.

---

## `scripts/ci/wait-for-ci-gate.mjs`

**Argv**: `node scripts/ci/wait-for-ci-gate.mjs <sha> [--workflow ci.yml] [--timeout-seconds 1800] [--poll-seconds 15]`

**Env**:

- `GH_TOKEN` — required (the workflow's `${{ secrets.GITHUB_TOKEN }}`
  or `${{ github.token }}`). Passed via env so it's masked.

**Stdout**: `conclusion=<success>;run_id=<id>;run_url=<url>` on
success (exit 0); empty otherwise.

**Stderr**: poll progress (e.g. `[wait] queued… 30s elapsed`).

**Exit codes**:

| Code | Meaning |
|---|---|
| 0 | A completed run with `conclusion=success` exists for the SHA |
| 1 | A completed run with `conclusion ∈ {failure, cancelled, timed_out, neutral, action_required, skipped}` exists |
| 2 | Timeout: no `completed` run reached within `--timeout-seconds` |
| 3 | `gh` invocation failed (binary missing, API 5xx persistent) |
| 4 | Invalid argv (missing SHA, non-numeric timeout, etc.) |

**Polling**: invokes `gh run list --commit <sha> --workflow
<workflow> --event push --json conclusion,status,databaseId --limit
10` every `--poll-seconds`. Picks the latest `databaseId` for the
state evaluation.

---

## `scripts/ci/publish-vsix.mjs`

**Argv**: `node scripts/ci/publish-vsix.mjs --tag <tag> --channel <stable|pre-release> --artifacts-dir <dir> [--targets <comma-list>] [--max-retries 3]`

**Env**:

- `VSCE_PAT` — required. The Marketplace PAT. NEVER passed via argv.

**Stdout**: a final summary table (also written to
`$GITHUB_STEP_SUMMARY` by the workflow step). The recovery dispatch
command is written to stdout when at least one target failed
terminally.

**Stderr**: per-target progress + retry diagnostics. NEVER contains
`VSCE_PAT`. NEVER contains the raw `vsce` argv beyond a redacted
form (`vsce publish --pre-release --target … --packagePath … [PAT
via env]`).

**Exit codes**:

| Code | Meaning |
|---|---|
| 0 | All targets published successfully |
| 1 | One or more targets failed terminally after retries (partial-success state; recovery dispatch line in stdout) |
| 2 | All targets failed terminally (full-failure state) |
| 3 | Pre-flight error (missing artifact, bad argv, missing PAT) |
| 4 | Internal error (script bug, unexpected exception) |

**`--targets` argument**:

- Absent → default to all six known targets
  (`linux-x64,linux-arm64,darwin-x64,darwin-arm64,win32-x64,win32-arm64`).
- Present → only those targets are attempted (used by
  `publish-recover.yml` to retry just the missing ones).

**Recovery dispatch line format** (printed to stdout AND
`$GITHUB_STEP_SUMMARY` when exit code = 1):

```text
Recovery: gh workflow run publish-recover.yml -f tag=v0.2.0 -f targets=darwin-arm64,win32-x64
```

**PAT-leak invariant**:

- `VSCE_PAT` is read from `process.env.VSCE_PAT` once at startup;
  the script clears `process.env.VSCE_PAT` from the inherited env
  for all OTHER `child_process.spawn` calls (the only one allowed to
  see it is `vsce publish` itself).
- Every `spawn` call's argv is sanitised against a regex that
  matches the PAT's first 8 characters before being logged.
- A defensive end-of-run scan walks all captured output lines and
  asserts no substring of `VSCE_PAT` (length ≥ 8) appears. Failure
  trips exit code 4 (so a PAT leak fails the workflow, drawing
  attention to it).

---

## `scripts/ci/generate-release-notes.mjs`

**Argv**: `node scripts/ci/generate-release-notes.mjs --from <prev-tag> --to <current-tag>`

**Env**: none.

**Stdout**: the rendered markdown body of the release notes (consumed
by `gh release create --notes-file` after the workflow writes it to
disk).

**Stderr**: progress lines.

**Exit codes**:

| Code | Meaning |
|---|---|
| 0 | Notes rendered to stdout |
| 1 | `git log` invocation failed (bad refs, repo state) |
| 2 | Invalid argv |

**Rendering rules**:

- Read commits via `git log <from>..<to> --pretty=format:"%H|%s"`.
- Group by Conventional Commits prefix
  (`feat|fix|docs|chore|refactor|test|ci|build|perf|revert`).
- Non-conforming lines bucket into `Other`.
- Empty range → render a body that says
  `_No commits between <from> and <to>._` and exits 0 (valid empty
  notes body).
- Always append a `Full Changelog: <compare-url>` link.

---

## Cross-cutting: error message contract

All scripts MUST write error messages to stderr in this shape:

```text
[<script-name>] <SEVERITY>: <message>
```

- `<SEVERITY>` ∈ `WARN | ERROR | FATAL`.
- `FATAL` precedes a non-zero exit.
- `ERROR` is recoverable (script continues, may still exit 0 if the
  error doesn't trip a contractual failure).
- `WARN` is informational.

Workflows MUST set `--annotate-on-failure` shell pattern so GitHub
Actions surfaces each `ERROR`/`FATAL` line in the run summary's
annotations panel:

```yaml
- name: Run script
  run: node scripts/ci/<script>.mjs
  shell: bash
  # GitHub Actions auto-annotates lines matching `::error::` and
  # `::warning::`; scripts emit those forms in addition to the
  # human-readable `[script] FATAL: …` shape.
```
