# Contract — VS Code settings

Every configuration key the extension contributes via
`package.json` `contributes.configuration`. All keys are namespaced
`cnpg4vscode.*` and have safe defaults that work for a fresh CNPG
install on a local kind cluster (constitution §V).

| Key | Type | Default | Description |
|---|---|---|---|
| `cnpg4vscode.log.level` | enum `off`,`error`,`warn`,`info`,`debug`,`trace` | `info` | Verbosity of the `cnpg4vscode` LogOutputChannel. `trace` includes K8s URLs (auth headers always stripped). |
| `cnpg4vscode.refreshIntervalSeconds` | number ≥ 5 | `30` | Cluster-tree auto-refresh cadence (FR-006). |
| `cnpg4vscode.tunnel.bindAddress` | enum `127.0.0.1` (only valid value at this time) | `127.0.0.1` | Local interface for port-forwards. Exposed as a setting only to allow auditors to verify the binding is loopback-only. |
| `cnpg4vscode.tunnel.maxRetries` | integer 0–10 | `5` | Reconnect attempts before transitioning to `error`. |
| `cnpg4vscode.tunnel.probeIntervalSeconds` | number 5–300 | `30` | Liveness `SELECT 1` cadence. |
| `cnpg4vscode.connection.defaultMode` | enum `readonly`, `write` (`readonly` only valid at this time per FR-020) | `readonly` | Reserved; the spec requires `readonly` and the setting exists for future change control. Setting to `write` is rejected and logged. |
| `cnpg4vscode.connection.defaultDatabase` | string | (empty → use Secret's `dbname` then `postgres`) | Fallback database name when the chosen secret omits `dbname`. |
| `cnpg4vscode.results.pageSize` | integer 100–10000 | `1000` | Rows per page for `pg-cursor`-backed result grids. |
| `cnpg4vscode.results.maxInMemoryRows` | integer 1000–100000 | `10000` | Hard cap on retained rows in the grid (SC-011). |
| `cnpg4vscode.history.enabled` | boolean | `true` | Master switch for per-workspace query history (FR-033). |
| `cnpg4vscode.history.retentionDays` | integer 1–3650 or `0` (forever) | `90` | Auto-prune entries older than N days at activation time. |
| `cnpg4vscode.history.maxEntries` | integer ≥ 1000 | `100000` | Hard cap on retained entries; oldest pruned first. |
| `cnpg4vscode.notebooks.location` | string (workspace-relative) | `.cnpg/notebooks` | Root for the per-cluster notebook convention path used by `cnpg.notebook.saveToCluster` and the cluster-tree's saved-notebook child nodes (FR-037). Resolved against the first workspace folder. |
| `cnpg4vscode.redaction.extraPatterns` | array<string> (regex source) | `[]` | Additional regex patterns appended to the credential-literal ruleset. Each pattern MUST contain at least one capture group; the full match is replaced by `'***REDACTED***'`. |

*(Removed: `cnpg4vscode.scripts.location` — the Saved Scripts sidebar it configured was removed in the notebook refactor; `.cnpg-sql` notebooks live anywhere the user saves them via standard VS Code Save / Save As. See spec.md § Clarifications 2026-05-15 and amended `FR-032`.)*
| `cnpg4vscode.confirmation.requireTypedName` | boolean | `true` | When false, destructive tree actions still require a confirmation modal but skip the typed-name input. **Disabling this is logged at WARN on every destructive action**, and the setting MUST NOT be silently suppressible. |
| `cnpg4vscode.er.warnOverTables` | integer 50–1000 | `100` | Show the "large schema" warning before rendering an ER diagram beyond this size (edge case). |
| `cnpg4vscode.er.layout` | enum `layered`,`force`,`stress` | `layered` | ELK.js layout algorithm. |
| `cnpg4vscode.theme.honorEditorFont` | boolean | `true` | If true, webviews pick up `editor.fontFamily` and `editor.fontSize`. |

## Scope policy

- Keys default to `window` scope (per-workspace overridable).
- `cnpg4vscode.log.level` is `application`-scoped (global preference).
- `cnpg4vscode.scripts.location` is `resource`-scoped (per-folder for
  multi-root workspaces).

## Validation

- Numeric ranges enforced via JSON schema in the manifest.
- `cnpg4vscode.tunnel.bindAddress` enum is single-valued for now; the
  enum form is intentional so any future change goes through schema
  review.
- `cnpg4vscode.connection.defaultMode = 'write'` is rejected at
  activation with a user-visible error AND the setting is forced back
  to `readonly` in-memory. This implements FR-020's "MUST open in
  read-only mode by default" as a runtime invariant.

## Telemetry stance

There is no `cnpg4vscode.telemetry.*` key. The extension MUST NOT
contribute one until the constitution amendment that introduces opt-in
telemetry lands (currently blocked by §IV).
