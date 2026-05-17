# Contract: Repository Secrets

This spec consumes exactly ONE repository secret. Documented here so
the runbook (`docs/release-process.md`) can reference it without
re-deriving the contract, and so the audit checklist (`quickstart.md`
§6) can compare reality to the contract.

---

## `VSCE_PAT`

| Field | Value |
|---|---|
| **Secret name** | `VSCE_PAT` (exact case) |
| **Scope** | Repository-level (NOT environment-scoped, NOT organisation-level) |
| **Format** | Azure DevOps Personal Access Token, 52 characters, base32-ish |
| **Granted to** | The publisher account that owns the `cnpg4vscode` Marketplace listing |
| **AZ DevOps scope** | `Marketplace → Manage` (and only that) |
| **Lifecycle** | Created by maintainer in Azure DevOps; rotated quarterly per runbook |
| **Workflow exposure** | ONLY `publish.yml` and `publish-recover.yml`, ONLY in the per-step `env:` of the publish step |

**Wiring example** (the only legal shape):

```yaml
# publish.yml — publish step
- name: Publish per-platform VSIXs
  env:
    VSCE_PAT: ${{ secrets.VSCE_PAT }}     # per-step env scope, not job-level
  run: node scripts/ci/publish-vsix.mjs --tag "${{ github.ref_name }}" --channel "${{ steps.preflight.outputs.channel }}" --artifacts-dir ./vsix-bundle
```

**ILLEGAL shapes** (`actionlint` + workflow audit reject these):

```yaml
# WRONG: job-level env leaks PAT to every step in the job
jobs:
  publish:
    env:
      VSCE_PAT: ${{ secrets.VSCE_PAT }}

# WRONG: argv leak — visible to `ps`, may end up in process accounting
- run: node scripts/ci/publish-vsix.mjs --pat "${{ secrets.VSCE_PAT }}" …

# WRONG: echo to logs (even with masking, the masker can be bypassed by
# transformations like base64; the rule is "never echo")
- run: echo "VSCE_PAT=${{ secrets.VSCE_PAT }}" >> $GITHUB_ENV
```

---

## What is NOT a secret in this spec

The spec deliberately introduces no other secrets. The following are
provided by GitHub Actions automatically and do NOT need maintainer
configuration:

| Provided value | Used by | Notes |
|---|---|---|
| `github.token` / `secrets.GITHUB_TOKEN` | `wait-for-ci-gate.mjs`, `gh release create/upload` | Auto-issued per workflow run; scope limited to the repo it runs against |
| `GH_TOKEN` env var | All `gh` CLI calls | Set per-step to `${{ secrets.GITHUB_TOKEN }}` so `gh` doesn't prompt for auth |
| `RUNNER_ENVIRONMENT` | Hosted-runner guard | Built-in GitHub env var; not a secret |

If a future spec needs additional secrets (e.g. a Sentry DSN, a chat
notifier webhook), this contract gets a new section — but until then,
the principle of minimal exposure stands.

---

## Verification

A documented invariant: `gh secret list -R irulast/cnpg4vscode` (run
by the maintainer) should return exactly one row whose name is
`VSCE_PAT`. The runbook's smoke test §3 includes this command.
