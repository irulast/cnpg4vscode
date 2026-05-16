/**
 * Visual editors — no-webview multi-step QuickPick + InputBox flows
 * (US6; T110 + T111 scope variant). Same playbook as the migration
 * wizard at `src/commands/migration.ts`: pure DDL builder in
 * `src/sql/*-builder.ts`, host glue here.
 *
 * Implemented:
 *   - openIndexEditor()         — CREATE INDEX wizard (T110)
 *   - openConstraintEditor()    — ALTER TABLE ADD CONSTRAINT wizard (T111)
 */

import * as vscode from "vscode";
import { SchemaNode } from "../ui/tree-schema.js";
import { Introspector } from "../pg/introspect.js";
import { ActiveConnection } from "../state/session.js";
import {
  buildCreateIndex,
  suggestIndexName,
  validateIndexSpec,
  type IndexSpec,
} from "../sql/index-builder.js";
import {
  buildAddConstraint,
  suggestConstraintName,
  validateConstraintSpec,
  type ConstraintSpec,
  type FkAction,
} from "../sql/constraint-builder.js";
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

// ---------------------------------------------------------------------------
// Constraint editor (T111)
// ---------------------------------------------------------------------------

/**
 * Visual ALTER TABLE ADD CONSTRAINT wizard. Invoked from the schema
 * tree's right-click menu on a TABLE node via
 * `cnpg.editor.constraint.create`.
 *
 * Flow:
 *   1. Validate the node is a table in a Write-mode connection.
 *   2. Pick a constraint kind (PK / UNIQUE / FK / CHECK).
 *   3. Kind-specific input collection:
 *        - PK / UNIQUE: multi-select columns
 *        - FK: multi-select local columns → pick referenced schema →
 *              pick referenced table → multi-select referenced columns →
 *              pick ON UPDATE action → pick ON DELETE action
 *        - CHECK: free-form predicate (semicolon-injection guarded)
 *   4. Confirm constraint name (auto-suggested).
 *   5. Validate via validateConstraintSpec().
 *   6. Modal preview of the full ALTER statement.
 *   7. Execute against the active Write-mode connection.
 */
export async function openConstraintEditor(node: SchemaNode): Promise<void> {
  if (node.kind !== "relation" || node.relation.kind !== "table") {
    vscode.window.showInformationMessage(
      "Pick a table in the Schema view to add a constraint.",
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
  log.info("editor.constraint.open", { connection: conn.id, target });

  const kind = await pickConstraintKind();
  if (!kind) return;

  // Fetch this table's columns up front — needed for PK/UNIQUE/FK.
  let columnLabels: string[] = [];
  if (kind !== "check") {
    try {
      const intros = new Introspector(conn.connection);
      const cols = await intros.columns(node.relation.oid);
      columnLabels = cols.map((c) => c.name);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `Failed to list columns for ${target}: ${reason}`,
      );
      log.error("editor.constraint.columns.failed", { target, reason });
      return;
    }
    if (columnLabels.length === 0) {
      vscode.window.showInformationMessage(`${target} has no columns to constrain.`);
      return;
    }
  }

  const spec = await collectSpec(conn, node, target, columnLabels, kind);
  if (!spec) return;

  const validation = validateConstraintSpec(spec);
  if (!validation.ok) {
    vscode.window.showErrorMessage(`Cannot create constraint: ${validation.reason}`);
    log.warn("editor.constraint.rejected", {
      target,
      code: validation.code,
      reason: validation.reason,
    });
    return;
  }

  // Modal preview.
  const stmt = buildAddConstraint(spec);
  const detail = describeForPreview(spec, stmt.text);
  const choice = await vscode.window.showWarningMessage(
    `Add ${humanKind(spec.kind)} constraint "${spec.name}" on ${target}?`,
    { modal: true, detail },
    "Create",
  );
  if (choice !== "Create") {
    log.info("editor.constraint.cancelled", { target });
    return;
  }

  log.info("editor.constraint.executing", {
    target,
    name: spec.name,
    kind: spec.kind,
  });
  try {
    await conn.connection.query(stmt.text);
    vscode.window.showInformationMessage(
      `Constraint ${spec.name} added on ${target}.`,
    );
    log.info("editor.constraint.created", { target, name: spec.name, kind: spec.kind });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`ADD CONSTRAINT failed: ${reason}`);
    log.error("editor.constraint.failed", { target, reason });
  }
}

async function pickConstraintKind(): Promise<ConstraintSpec["kind"] | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "PRIMARY KEY", value: "primaryKey" as const, description: "Uniquely identifies each row" },
      { label: "UNIQUE", value: "unique" as const, description: "Enforces uniqueness over one or more columns" },
      { label: "FOREIGN KEY", value: "foreignKey" as const, description: "References columns in another table" },
      { label: "CHECK", value: "check" as const, description: "Arbitrary boolean predicate over column values" },
    ],
    { title: "Constraint kind", canPickMany: false, ignoreFocusOut: true },
  );
  return picked?.value;
}

async function collectSpec(
  conn: ActiveConnection,
  node: SchemaNode,
  target: string,
  columnLabels: string[],
  kind: ConstraintSpec["kind"],
): Promise<ConstraintSpec | undefined> {
  if (node.kind !== "relation") return undefined;
  const schema = node.schema.name;
  const table = node.relation.name;

  if (kind === "check") {
    const expression = await vscode.window.showInputBox({
      title: `CHECK predicate for ${target}`,
      prompt: "Expression that must evaluate to true for every row (no semicolons).",
      placeHolder: "e.g. price > 0",
      ignoreFocusOut: true,
    });
    if (expression === undefined || expression.trim().length === 0) return undefined;
    const suggested = suggestConstraintName({ kind: "check", table });
    const name = await askName(suggested);
    if (!name) return undefined;
    return { kind: "check", schema, table, name, expression: expression.trim() };
  }

  // PK / UNIQUE / FK all start with local-column selection.
  const cols = await pickColumns(`Local columns for ${humanKind(kind)} on ${target}`, columnLabels);
  if (!cols || cols.length === 0) return undefined;

  if (kind === "primaryKey") {
    const suggested = suggestConstraintName({ kind: "primaryKey", table, columns: cols });
    const name = await askName(suggested);
    if (!name) return undefined;
    return { kind: "primaryKey", schema, table, name, columns: cols };
  }
  if (kind === "unique") {
    const suggested = suggestConstraintName({ kind: "unique", table, columns: cols });
    const name = await askName(suggested);
    if (!name) return undefined;
    return { kind: "unique", schema, table, name, columns: cols };
  }
  // foreignKey
  const refSchema = await pickReferencedSchema(conn);
  if (!refSchema) return undefined;
  const refTable = await pickReferencedTable(conn, refSchema);
  if (!refTable) return undefined;
  const refCols = await pickReferencedColumns(conn, refSchema, refTable, cols.length);
  if (!refCols) return undefined;
  const onUpdate = await pickFkAction("ON UPDATE action");
  if (onUpdate === undefined) return undefined;
  const onDelete = await pickFkAction("ON DELETE action");
  if (onDelete === undefined) return undefined;
  const suggested = suggestConstraintName({
    kind: "foreignKey",
    table,
    columns: cols,
    referencedTable: refTable.name,
  });
  const name = await askName(suggested);
  if (!name) return undefined;
  return {
    kind: "foreignKey",
    schema,
    table,
    name,
    columns: cols,
    references: {
      schema: refSchema.name,
      table: refTable.name,
      columns: refCols,
      onUpdate,
      onDelete,
    },
  };
}

async function pickReferencedSchema(
  conn: ActiveConnection,
): Promise<{ name: string; oid: number } | undefined> {
  const intros = new Introspector(conn.connection);
  const schemas = await intros.schemas();
  const picked = await vscode.window.showQuickPick(
    schemas.map((s) => ({ label: s.name, schema: s })),
    { title: "Referenced schema", canPickMany: false, ignoreFocusOut: true },
  );
  return picked ? { name: picked.schema.name, oid: picked.schema.oid } : undefined;
}

async function pickReferencedTable(
  conn: ActiveConnection,
  refSchema: { name: string; oid: number },
): Promise<{ name: string; oid: number } | undefined> {
  const intros = new Introspector(conn.connection);
  const rels = await intros.relations(refSchema.oid);
  const tables = rels.filter((r) => r.kind === "table");
  if (tables.length === 0) {
    vscode.window.showInformationMessage(
      `Schema ${refSchema.name} has no tables to reference.`,
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    tables.map((t) => ({ label: t.name, rel: t })),
    { title: `Referenced table in ${refSchema.name}`, canPickMany: false, ignoreFocusOut: true },
  );
  return picked ? { name: picked.rel.name, oid: picked.rel.oid } : undefined;
}

async function pickReferencedColumns(
  conn: ActiveConnection,
  refSchema: { name: string },
  refTable: { name: string; oid: number },
  expectedCount: number,
): Promise<string[] | undefined> {
  const intros = new Introspector(conn.connection);
  const cols = await intros.columns(refTable.oid);
  if (cols.length === 0) {
    vscode.window.showInformationMessage(
      `${refSchema.name}.${refTable.name} has no columns.`,
    );
    return undefined;
  }
  const picked = await pickColumns(
    `Referenced columns in ${refSchema.name}.${refTable.name} (must pick exactly ${expectedCount})`,
    cols.map((c) => c.name),
  );
  if (!picked) return undefined;
  if (picked.length !== expectedCount) {
    vscode.window.showErrorMessage(
      `Picked ${picked.length} referenced column(s) but the local side has ${expectedCount}; counts must match.`,
    );
    return undefined;
  }
  return picked;
}

async function pickFkAction(title: string): Promise<FkAction | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "NO ACTION (default)", value: "NO ACTION" as const },
      { label: "RESTRICT", value: "RESTRICT" as const },
      { label: "CASCADE", value: "CASCADE" as const },
      { label: "SET NULL", value: "SET NULL" as const },
      { label: "SET DEFAULT", value: "SET DEFAULT" as const },
    ],
    { title, canPickMany: false, ignoreFocusOut: true },
  );
  return picked?.value;
}

async function askName(suggested: string): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: "Constraint name",
    prompt: "Identifier for the new constraint (≤63 chars).",
    value: suggested,
    ignoreFocusOut: true,
  });
  if (name === undefined || name.trim() === "") return undefined;
  return name.trim();
}

function humanKind(k: ConstraintSpec["kind"]): string {
  return k === "primaryKey"
    ? "PRIMARY KEY"
    : k === "unique"
      ? "UNIQUE"
      : k === "foreignKey"
        ? "FOREIGN KEY"
        : "CHECK";
}

function describeForPreview(spec: ConstraintSpec, ddl: string): string {
  const lines: string[] = [`Target: ${spec.schema}.${spec.table}`, `Kind: ${humanKind(spec.kind)}`];
  if (spec.kind === "primaryKey" || spec.kind === "unique") {
    lines.push(`Columns: ${spec.columns.join(", ")}`);
  }
  if (spec.kind === "foreignKey") {
    lines.push(`Local columns: ${spec.columns.join(", ")}`);
    lines.push(
      `References: ${spec.references.schema}.${spec.references.table} (${spec.references.columns.join(", ")})`,
    );
    if (spec.references.onUpdate) lines.push(`ON UPDATE: ${spec.references.onUpdate}`);
    if (spec.references.onDelete) lines.push(`ON DELETE: ${spec.references.onDelete}`);
  }
  if (spec.kind === "check") {
    lines.push(`Predicate: ${spec.expression}`);
  }
  lines.push("", "DDL:", ddl);
  return lines.join("\n");
}
