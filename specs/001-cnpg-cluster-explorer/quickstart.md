# Quickstart — cnpg4vscode local development

This is the path from a fresh clone to your first cluster appearing in
the tree and your first SELECT executing through the extension.

## Prerequisites

- **Node** 20.x (matches the VS Code engine runtime).
- **pnpm** 9.x (`corepack enable && corepack prepare pnpm@latest --activate`).
- **VS Code** ≥ 1.85 (Insiders is fine).
- **Docker** (for kind + testcontainers).
- **kind** ≥ 0.22 and **kubectl** ≥ 1.29 on PATH (kind is used only to
  bootstrap a local test cluster; the extension itself never shells to
  kubectl).
- **Helm** ≥ 3.14 (to install CNPG into the kind cluster).

## 1. Clone & install

```sh
git clone <repo-url> cnpg4vscode
cd cnpg4vscode
pnpm install
```

## 2. Bootstrap a local kind cluster with CNPG

```sh
kind create cluster --name cnpg-dev
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update
helm install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace
```

Wait for the operator to be ready:

```sh
kubectl -n cnpg-system rollout status deploy/cnpg-cloudnative-pg
```

Create a small test cluster (CR copied under `test/fixtures/k8s/`):

```sh
kubectl apply -f test/fixtures/k8s/cluster-app-db.yaml
kubectl -n default wait --for=condition=Ready cluster.postgresql.cnpg.io/app-db --timeout=5m
```

You should now see two Secrets in `default`: `app-db-app` and
`app-db-superuser`.

## 3. Build & launch the extension

From the repo root:

```sh
pnpm build:dev   # esbuild watch + tsc --noEmit watch in parallel
```

In VS Code, press **F5** to launch the Extension Development Host. The
"Run Extension" launch config in `.vscode/launch.json` opens a second
VS Code window with `cnpg4vscode` loaded.

In the Extension Development Host:

1. Open the **CNPG** activity bar item.
2. The tree should show your `kind-cnpg-dev` context, then `default`,
   then `app-db` with a green status indicator.
3. Click `app-db` (default-click → Connect, per FR-019). Accept the
   default `app-db-app` credential.
4. A `cnpg-sql` notebook opens with the cluster's controller
   pre-selected. The status bar reads `kind-cnpg-dev/app-db ⚙
   read-only`.
5. In the first cell, type `SELECT 1;` and press **Shift+Enter**. The
   result renders inline beneath the cell.
6. Click the status bar → **Switch to Write mode**. Add a new cell:
   `CREATE TABLE scratch (id int);` → Shift+Enter. The new table
   appears under `app-db / public` after a tree refresh.

## 4. Run the test suites

```sh
pnpm test           # all suites
pnpm test:unit      # Vitest, host Node only — fastest
pnpm test:contract  # nock fixtures + pg-mem
pnpm test:e2e       # @vscode/test-electron + testcontainers PG
```

To refresh the K8s contract fixtures from the kind cluster:

```sh
SPECKIT_RECORD=1 pnpm test:contract
```

(`SPECKIT_RECORD=1` switches the nock layer from replay to record;
recorded fixtures are scrubbed of auth headers before write.)

## 5. Lint & type-check

```sh
pnpm lint           # ESLint, incl. "no persistence outside state/history.ts" rule
pnpm typecheck      # tsc --noEmit
```

## 6. Package a VSIX

```sh
pnpm package        # runs vsce package per platform target via the per-platform matrix
```

Output: `dist/vsix/cnpg4vscode-<platform>-<version>.vsix`.

## 7. Tear down

```sh
kind delete cluster --name cnpg-dev
```

---

## Common dev workflows

### Add a new tree action

1. Add the command id to
   [contracts/commands.md](contracts/commands.md).
2. Add a unit test for any new SQL generation (Vitest).
3. Add the command registration to `src/commands/index.ts`.
4. Add a `package.json` `contributes.menus` entry referencing the
   `when` clause.
5. If the action is destructive, route it through `src/ui/confirm.ts`.

### Add a new pg_catalog introspection query

1. Add the query to
   [contracts/pg-introspection.md](contracts/pg-introspection.md).
2. Add a contract test under `test/contract/pg/introspect.test.ts`
   driven by `pg-mem`.
3. Implement in `src/pg/introspect.ts`.
4. Wire into `src/ui/tree-schema.ts`.

### Modify the redaction ruleset

1. Add the pattern to
   [research.md §10](research.md) and to `src/pg/redact.ts`.
2. Add fixture pairs under `test/fixtures/redaction/<pattern>.in.sql`
   / `.out.sql`.
3. The property test
   (`redact(redact(x)) === redact(x)` and idempotence) MUST pass
   without modification.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Tree shows "Cannot reach cluster" for `kind-cnpg-dev` | `kind` cluster stopped or Docker not running. `docker ps` and `kind get clusters`. |
| Credential picker shows raw key names | The Secret doesn't have standard `username`/`password` keys — likely a non-standard CNPG version. Edge case is intentional. |
| `Ctrl+Enter` does nothing | The active editor isn't `sql` (check the language indicator), or no connection is bound. Run `CNPG: Bind Connection to Editor`. |
| `better-sqlite3` fails to load | Native module mismatch with Electron's Node ABI. `pnpm rebuild better-sqlite3` and relaunch. |
| Webview shows wrong contrast | Theme tokens not applied. Reload the webview (`Developer: Reload Webviews`) and check that the snapshot test for the active theme passes. |
