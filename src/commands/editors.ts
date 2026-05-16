/**
 * Visual editors — no-webview multi-step QuickPick + InputBox flows
 * (US6; T110 + T111 scope variant). Same playbook as the migration
 * wizard at `src/commands/migration.ts`: pure DDL builder in
 * `src/sql/*-builder.ts`, host glue here.
 *
 * Currently implemented:
 *   - openIndexEditor()         — CREATE INDEX wizard (T110)
 *
 * To be added by subsequent rounds:
 *   - openConstraintEditor()    — ALTER TABLE ADD CONSTRAINT wizard (T111)
 */

import * as vscode from "vscode";
import { SchemaNode } from "../ui/tree-schema.js";
import { Introspector } from "../pg/introspect.js";
import {
  buildCreateIndex,
  suggestIndexName,
  validateIndexSpec,
  type IndexSpec,
} from "../sql/index-builder.js";
import { log } from "../logging/channel.js";

/**
 * Visual CREATE INDEX wizard. Invoked from the schema tree's
 * right-click menu on a TABLE node (the menu wiring lives in
 * `src/commands/index.ts` via `cnpg.editor.index.create`).
 *
 * Flow:
 *   1. Validate the node is a table in a Write-mode connection.
 *   2. Fetch the table's columns via the cached introspector.
 *   3. Multi-select column QuickPick (order = selection order).
 *   4. UNIQUE? CONCURRENTLY? (two yes/no QuickPicks).
 *   5. Optional WHERE clause (InputBox, blank = non-partial).
 *   6. Index name (InputBox, defaulted via suggestIndexName()).
 *   7. Validate via validateIndexSpec().
 *   8. Modal preview of the DDL.
 *   9. Execute via the active connection's pool query.
 */
export async function openIndexEditor(node: SchemaNode): Promise<void> {
  if (node.kind !== "relation" || node.relation.kind !== "table") {
    vscode.window.showInformationMessage(
      "Pick a table in the Schema view to add an index.",
    );
    return;
  }
  if (node.conn.connection.mode !== "write") {
    vscode.window.showWarningMessage(
      `${node.conn.cluster.namespace}/${node.conn.cluster.clusterName}/${node.conn.database} is read-only. Toggle Write mode first.`,
    );
    return;
  }
  const conn = node.conn;
  const target = `${node.schema.name}.${node.relation.name}`;
  log.info("editor.index.open", { connection: conn.id, target });

  // Fetch columns up front; the user can't pick what they can't see.
  let columnLabels: string[];
  try {
    const intros = new Introspector(conn.connection);
    const cols = await intros.columns(node.relation.oid);
    columnLabels = cols.map((c) => c.name);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      `Failed to list columns for ${target}: ${reason}`,
    );
    log.error("editor.index.columns.failed", { target, reason });
    return;
  }
  if (columnLabels.length === 0) {
    vscode.window.showInformationMessage(
      `${target} has no columns to index.`,
    );
    return;
  }

  // Step 1 — pick columns (multi-select, order preserved).
  const picked = await pickColumns(target, columnLabels);
  if (!picked || picked.length === 0) return;

  // Step 2 — UNIQUE?
  const unique = await pickYesNo("UNIQUE index?", "No (default)", "Yes — enforce uniqueness");
  if (unique === undefined) return;

  // Step 3 — CONCURRENTLY?
  const concurrent = await pickYesNo(
    "Build CONCURRENTLY?",
    "No (default — blocks writes briefly)",
    "Yes — non-transactional, no write lock",
  );
  if (concurrent === undefined) return;

  // Step 4 — optional WHERE (partial index).
  const where = await vscode.window.showInputBox({
    title: `Optional WHERE clause for partial index (blank = full index)`,
    prompt: `Predicate filtering which rows go into the index. No semicolons.`,
    placeHolder: "e.g. active = true",
    ignoreFocusOut: true,
  });
  if (where === undefined) return; // user dismissed
  const wherePart = where.trim();

  // Step 5 — name (suggest, allow override).
  const suggested = suggestIndexName({
    table: node.relation.name,
    columns: picked,
    unique,
  });
  const name = await vscode.window.showInputBox({
    title: "Index name",
    prompt: "Identifier for the new index (≤63 chars).",
    value: suggested,
    ignoreFocusOut: true,
  });
  if (name === undefined || name.trim() === "") return;

  const spec: IndexSpec = {
    schema: node.schema.name,
    table: node.relation.name,
    name: name.trim(),
    columns: picked,
    unique,
    ...(wherePart.length > 0 ? { where: wherePart } : {}),
    concurrent,
  };

  // Step 6 — validate.
  const validation = validateIndexSpec(spec);
  if (!validation.ok) {
    vscode.window.showErrorMessage(`Cannot create index: ${validation.reason}`);
    log.warn("editor.index.rejected", {
      target,
      code: validation.code,
      reason: validation.reason,
    });
    return;
  }

  // Step 7 — modal preview.
  const stmt = buildCreateIndex(spec);
  const detail = [
    `Target: ${target}`,
    `Columns: ${picked.join(", ")}`,
    `Unique: ${unique ? "yes" : "no"}    Concurrently: ${concurrent ? "yes" : "no"}`,
    wherePart ? `WHERE: ${wherePart}` : "Full index (no WHERE clause)",
    "",
    "DDL:",
    stmt.text,
  ].join("\n");
  const choice = await vscode.window.showWarningMessage(
    `Create ${unique ? "UNIQUE " : ""}INDEX "${spec.name}" on ${target}?`,
    { modal: true, detail },
    "Create",
  );
  if (choice !== "Create") {
    log.info("editor.index.cancelled", { target });
    return;
  }

  // Step 8 — execute.
  log.info("editor.index.executing", {
    target,
    name: spec.name,
    concurrent,
    unique,
  });
  try {
    await conn.connection.query(stmt.text);
    vscode.window.showInformationMessage(
      `Index ${spec.name} created on ${target}.`,
    );
    log.info("editor.index.created", { target, name: spec.name });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`CREATE INDEX failed: ${reason}`);
    log.error("editor.index.failed", { target, reason });
  }
}

// ---------------------------------------------------------------------------
// QuickPick helpers
// ---------------------------------------------------------------------------

async function pickColumns(
  target: string,
  columns: ReadonlyArray<string>,
): Promise<string[] | undefined> {
  const items: vscode.QuickPickItem[] = columns.map((c) => ({ label: c }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `Pick columns for the new index on ${target}`,
    placeHolder:
      "Multi-select — order matters. Use Space to toggle, Enter to confirm.",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  // VS Code preserves the user's selection order; map back to label strings.
  return picked.map((p) => p.label);
}

async function pickYesNo(
  title: string,
  noLabel: string,
  yesLabel: string,
): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: noLabel, value: false },
      { label: yesLabel, value: true },
    ],
    { title, canPickMany: false, ignoreFocusOut: true },
  );
  return picked?.value;
}
