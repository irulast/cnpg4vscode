# Release process

The end-to-end release flow for `cnpg4vscode`. Designed to be read by
a single human, executed in under 10 minutes of wall-clock time on the
maintainer's side, and self-explanatory enough that a fresh
co-maintainer can ship a release without prior context.

If you're reading this for the first time, the **one-time setup** in
§1 needs to happen once per maintainer, per machine. After that, every
release goes through §2 (stable) or §3 (pre-release).

This runbook is the operational sibling of
[specs/002-github-actions-deploy/spec.md](../specs/002-github-actions-deploy/spec.md)
and inherits the contracts in
[specs/002-github-actions-deploy/contracts/](../specs/002-github-actions-deploy/contracts/).

---

## §1 — One-time setup

Per maintainer, per machine.

1. **Install `gh` CLI** and authenticate against the repo:

   ```bash
   gh auth login           # browser flow, scope: repo + workflow
   gh repo set-default irulast/cnpg4vscode
   ```

2. **Verify the `VSCE_PAT` repository secret exists**:

   ```bash
   gh secret list -R irulast/cnpg4vscode
   # Expected single row:
   # VSCE_PAT  Updated <date>
   ```

   If absent, see §7 (PAT rotation) for how to mint and install one.

3. **Verify branch protection on `master`**:

   ```bash
   gh api repos/irulast/cnpg4vscode/branches/master/protection \
     --jq '.required_status_checks.contexts'
   # Expected list contains: "CI Gate / summary"
   ```

   If absent, see §8 (branch protection setup).

---

## §2 — Shipping a stable release

The happy path. Maintainer time-on-task: ~5 minutes (the rest is the
workflow doing work).

1. **Bump the version on a fresh branch**:

   ```bash
   git checkout -b release-v0.2.0
   # Edit package.json: "version": "0.2.0"
   git add package.json
   git commit -m "chore: release v0.2.0"
   git push -u origin release-v0.2.0
   ```

2. **Open and merge the bump PR**:

   ```bash
   gh pr create --base master --title "chore: release v0.2.0" --body "Marketplace release."
   # Wait for CI to go green (under 5 min for a clean change, warm cache).
   gh pr merge --squash --delete-branch
   ```

3. **Tag the merged commit and push**:

   ```bash
   git checkout master
   git pull --ff-only
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. **Watch the publish run**:

   ```bash
   gh run watch --workflow publish.yml
   # 8–12 min cold, 5–8 min warm.
   ```

5. **Verify the listing**:

   - Browse to <https://marketplace.visualstudio.com/items?itemName=cnpg4vscode.cnpg4vscode>.
   - Version field should show `0.2.0`.
   - The Release at
     <https://github.com/irulast/cnpg4vscode/releases/tag/v0.2.0>
     should have six VSIX assets and an auto-generated changelog.

That's it. Six per-platform VSIXs live on the Marketplace stable
channel; a GitHub Release exists with the same artefacts.

---

## §3 — Shipping a pre-release

Same flow as §2 with two changes:

1. The version string carries a SemVer suffix:
   `"version": "0.2.0-beta.1"` in `package.json`.
2. The tag carries the same suffix: `git tag v0.2.0-beta.1`.

The workflow auto-detects the suffix and publishes to the Marketplace
**pre-release channel** via `vsce publish --pre-release`. Stable users
won't see the update; pre-release-channel-opt-in users will.

To verify the channel split:

```bash
npx @vscode/vsce show cnpg4vscode.cnpg4vscode --json \
  | jq '.versions[] | {version, preRelease, lastUpdated}'
# Look for the new version with "preRelease": true.
```

---

## §4 — Recovering from a partial publish

If the publish run completes with `failure` and the run summary shows
"4 of 6 published, 2 failed", the summary line ends with the exact
recovery dispatch:

```text
Recovery: gh workflow run publish-recover.yml -f tag=v0.2.0 -f targets=darwin-arm64,win32-x64
```

Copy that line and run it. The recovery workflow:

1. Validates the tag still exists and points to the same SHA.
2. Re-checks the Marketplace — any of the listed targets that
   succeeded in the interim are skipped with a `WARN: already
   published, skipping` log line (idempotent).
3. Re-uses the existing VSIX artifact bundle if still in retention
   (90 days); otherwise re-builds.
4. Publishes only the listed targets.

When the recovery completes, repeat §2 step 5 (verify the listing
shows all six targets up to date).

---

## §5 — Dealing with a tag pushed before CI completed

This is normal. `publish.yml`'s preflight stage runs
`wait-for-ci-gate.mjs` which polls the CI gate's status on the tagged
SHA for up to 30 minutes. You'll see the workflow's first job sitting
on the wait step. No action required from you; the publish proceeds
automatically when CI reports green.

If you see the wait time out (30-minute timeout fires), CI hasn't
completed in 30 minutes. Investigate why CI is slow / stuck, then once
it's green re-trigger publish via:

```bash
gh workflow run publish.yml --ref v0.2.0
```

(`publish.yml` accepts `workflow_dispatch` for exactly this re-trigger
case.)

---

## §6 — Workflow audit (post-implementation sanity check)

Run after the spec is implemented and before the first release to
confirm every workflow contract is met. Should pass in under 30
seconds.

```bash
# 1. Workflow YAML linter passes
# Install actionlint (https://github.com/rhysd/actionlint/releases) or
# `brew install actionlint`, then:
actionlint -color

# 2. Exactly one secret exists
gh secret list -R irulast/cnpg4vscode | wc -l
# Expected: 1 (just VSCE_PAT)

# 3. CI gate is a required check on master
gh api repos/irulast/cnpg4vscode/branches/master/protection \
  --jq '.required_status_checks.contexts | contains(["CI Gate / summary"])'
# Expected: true

# 4. No workflow references hosted-runner labels
grep -rn 'runs-on:' .github/workflows/
# Every match should be `runs-on: mke-builds`
# NOT `runs-on: ubuntu-latest` etc.

# 5. No workflow uses pull_request_target (CWE pattern)
grep -rn 'pull_request_target' .github/workflows/
# Expected: no matches.

# 6. Publish workflow's secret exposure is per-step only
grep -B1 -A2 'VSCE_PAT' .github/workflows/publish*.yml
# VSCE_PAT lines should ALL appear under a per-step `env:` block,
# NEVER under a top-level `env:` or job-level `env:`.

# 7. Unit tests for the auxiliary scripts pass
pnpm vitest run test/unit/ci
```

If any check fails, the implementation drifted from the contract;
diff against
[specs/002-github-actions-deploy/contracts/](../specs/002-github-actions-deploy/contracts/)
to find the divergence.

---

## §7 — PAT rotation

Quarterly task (or whenever the maintainer's Azure DevOps account
state changes). Time on task: ~5 min.

1. **Mint a new PAT in Azure DevOps**:
   - Browse to <https://dev.azure.com/_usersSettings/tokens>
   - **+ New Token**
   - Name: `cnpg4vscode-marketplace-YYYYMMDD`
   - Organization: All accessible organizations
   - Expiration: 90 days (or shorter per your security policy)
   - Scopes: **Marketplace → Manage** (and only that)
   - Create → copy the token (52 chars, base32-ish). You will not see
     it again.

2. **Update the repository secret**:

   ```bash
   gh secret set VSCE_PAT -R irulast/cnpg4vscode
   # Paste the PAT at the prompt; press Ctrl+D.
   ```

3. **Smoke-test by triggering recovery for an existing release**
   (idempotent no-op — the recovery workflow's collision check will
   skip already-published targets, but the auth round-trip happens):

   ```bash
   gh workflow run publish-recover.yml \
     -f tag=v0.1.0 \
     -f targets=linux-x64 \
     -R irulast/cnpg4vscode
   gh run watch --workflow publish-recover.yml
   ```

4. **Invalidate the old PAT** in Azure DevOps (delete the previous
   token from the tokens list).

---

## §8 — Branch protection setup

One-time configuration. The workflow files don't manage GitHub
repository settings; this is the manual procedure.

```bash
gh api -X PUT repos/irulast/cnpg4vscode/branches/master/protection \
  -F required_status_checks.strict=true \
  -F required_status_checks.contexts[]="CI Gate / summary" \
  -F enforce_admins=true \
  -F required_pull_request_reviews.required_approving_review_count=0 \
  -F required_pull_request_reviews.dismiss_stale_reviews=true \
  -F restrictions=
```

Notes on the knobs:

- `required_approving_review_count=0`: single-maintainer project; no
  one else to approve. Bump to 1+ when contributor pool grows.
- `enforce_admins=true`: maintainer is also subject to the CI gate.
  Without this, a maintainer push could ship un-tested code.
- `strict=true`: PRs must be up-to-date with `master` before merge
  (catches "the PR's CI was green but `master` moved underneath it").

---

## §9 — Adding a dependency-security allowlist entry

When `pnpm audit` flags a HIGH or CRITICAL advisory that you've
decided not to fix immediately, add an entry to
[`.github/security-allowlist.json`](../.github/security-allowlist.json):

```json
{
  "version": 1,
  "allowed": [
    {
      "advisoryId": 1234,
      "justification": "Vulnerable code path is unreachable — extension only consumes the library's pure-function surface.",
      "reviewedBy": "your-github-login",
      "reviewedAt": "2026-01-15"
    }
  ]
}
```

Commit the allowlist change in the same PR that adds (or fails to
update) the dependency. Reviewers see the diff and can challenge it.

When the vulnerable dependency is upgraded out, **remove the
allowlist entry in the same PR** — the gate will otherwise trip exit
code 3 ("stale allowlist entry").

---

## §10 — Troubleshooting

### `publish.yml` run failed at "wait-for-ci-gate" with exit 1

CI ran on the tagged SHA and concluded non-green. Open the CI run
(linked in the publish workflow's failing step), fix the failure on a
new PR, merge, then **move the tag** to the new fix commit:

```bash
git tag -d v0.2.0
git push origin :v0.2.0
git checkout master && git pull
git tag v0.2.0
git push origin v0.2.0
```

The new tag push re-triggers `publish.yml`.

### `publish.yml` run failed with exit 1 and "collision" in the summary

The version you're trying to publish is already on the Marketplace at
the same channel. Marketplace versions are immutable; pick a fresh
version:

```bash
git checkout master && git pull
git checkout -b release-v0.2.1
# edit package.json → "0.2.1"
git commit -am "chore: release v0.2.1"
gh pr create --fill && gh pr merge --squash --delete-branch
git checkout master && git pull
git tag v0.2.1
git push origin v0.2.1
```

### Runner pool is empty / jobs queue forever

The self-hosted scale set might be down. Check the runner pool's
health in the k8s-setup cluster:

```bash
kubectl get pods -n arc-runners
kubectl logs -n arc-runners -l app.kubernetes.io/instance=arc-runner-set-builds --tail=100
```

If the controller is unhealthy, the fix lives in the `k8s-setup`
repo; this spec's workflows just wait for runners.

### "PAT leak detected" exit code 4 from `publish-vsix.mjs`

A defensive scan at end-of-run found a PAT substring in captured
output. This should never happen if the script's contract holds; it
indicates a bug in the script or in a downstream `vsce` version that
started echoing arguments. Open an issue with the workflow run URL
attached; do NOT re-run the publish until investigated (the leaked
PAT is in the workflow log, which has 90-day retention — rotate it
per §7 immediately).
