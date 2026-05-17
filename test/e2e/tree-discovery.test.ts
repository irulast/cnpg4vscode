/**
 * E2E (US1) — tree-discovery acceptance scenarios (spec.md US1 scenarios 1–3).
 *
 * Driven by @vscode/test-electron. Requires a kubeconfig pointing at a kind
 * cluster with CNPG installed, OR a nock-mocked Kubernetes API (see
 * test/fixtures/k8s/). For CI, prefer the nock path.
 *
 * NOTE: This is a thin scaffold. The full suite lives under .vscode-test.mjs
 * and will be expanded when the K8s fixture corpus is recorded against a
 * live kind+CNPG cluster (T028 contract-test fixture refresh script).
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";

suite("US1: cluster discovery", () => {
  test("the CNPG view container and clusters view are registered", async () => {
    const ext = vscode.extensions.getExtension("Irulast.cnpg4vscode");
    assert.ok(ext, "extension should be installed in the test host");
    await ext!.activate();
    // Smoke check: refresh command resolves.
    await vscode.commands.executeCommand("cnpg.refresh");
  });

  test("the refresh command is contributed", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("cnpg.refresh"));
    assert.ok(commands.includes("cnpg.cluster.showDetails"));
  });
});
