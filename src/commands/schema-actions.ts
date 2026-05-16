/**
 * Schema-tree per-node action commands (US5; FR-023, FR-024).
 *
 * In the notebook architecture (FR-035), every executing action appends a
 * cell to the active cnpg-sql notebook (or creates one bound to the
 * relation's connection) and runs the cell — results render inline. The
 * non-executing actions (copy name, open definition, scaffold ALTER)
 * either copy to the clipboard, open a read-only doc, or insert text
 * into the active editor.
 */

import * as vscode from "vscode";
import {
  SchemaNode,
  SchemaTreeProvider,
  nodeFullyQualifiedName,
} from "../ui/tree-schema.js";
import { qualifyIdent, quoteIdent, Introspector } from "../pg/introspect.js";
import { ActiveConnection } from "../state/session.js";
import { appendCellToActiveNotebook } from "../notebook/append-cell.js";
import { confirmDestructive } from "../ui/confirm.js";
import { log } from "../logging/channel.js";

function requireWriteMode(conn: ActiveConnection): boolean {
  if (conn.connection.mode !== "write") {
    vscode.window.showWarningMessage(
      `${conn.cluster.namespace}/${conn.cluster.clusterName}/${conn.database} is in read-only mode. Toggle Write mode first.`,
    );
    return false;
  }
  return true;
}

export async function copyName(node: SchemaNode): Promise<void> {
  const fq = nodeFullyQualifiedName(node);
  if (!fq) return;
  await vscode.env.clipboard.writeText(fq);
  vscode.window.showInformationMessage(`Copied: ${fq}`);
}

export async function browseRows(node: SchemaNode, treeProvider: SchemaTreeProvider): Promise<void> {
  if (node.kind !== "relation") return;
  const fq = qualifyIdent(node.schema.name, node.relation.name);
  log.info("schema.browseRows", { connection: node.conn.id, target: fq });
  await appendCellToActiveNotebook({
    conn: node.conn,
    text: `SELECT * FROM ${fq} LIMIT 100`,
    execute: true,
  });
  void treeProvider;
}

export async function countRows(node: SchemaNode): Promise<void> {
  if (node.kind !== "relation") return;
  const fq = qualifyIdent(node.schema.name, node.relation.name);
  log.info("schema.countRows", { connection: node.conn.id, target: fq });
  await appendCellToActiveNotebook({
    conn: node.conn,
    text: `SELECT count(*) FROM ${fq}`,
    execute: true,
  });
}

export async function openDefinition(node: SchemaNode): Promise<void> {
  const sql = await renderDefinition(node);
  if (sql === null) {
    vscode.window.showInformationMessage("No definition available for this node.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ language: "sql", content: sql });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function renderDefinition(node: SchemaNode): Promise<string | null> {
  const conn = "conn" in node ? node.conn : null;
  if (!conn) return null;
  if (node.kind === "relation") {
    const fq = qualifyIdent(node.schema.name, node.relation.name);
    if (node.relation.kind === "view" || node.relation.kind === "materializedView") {
      const r = await conn.connection.query(
        `SELECT pg_get_viewdef($1::regclass, true) AS d`,
        [fq],
      );
      return `-- View definition for ${fq}\nCREATE OR REPLACE VIEW ${fq} AS\n${(r.rows[0] as Record<string, unknown>)["d"]};\n`;
    }
    const colsRes = await conn.connection.query(
      `
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum
    `,
      [fq],
    );
    const cols = colsRes.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const colDef =
        `  ${quoteIdent(String(r["name"]))} ${String(r["type"])}` +
        (r["default_expr"] ? ` DEFAULT ${r["default_expr"]}` : "") +
        (r["not_null"] ? " NOT NULL" : "");
      return colDef;
    });
    const cons = await conn.connection.query(
      `SELECT conname AS name, pg_get_constraintdef(oid, true) AS def
         FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY contype, conname`,
      [fq],
    );
    const lines = [`-- Table definition for ${fq}`, `CREATE TABLE ${fq} (`, cols.join(",\n")];
    for (const row of cons.rows) {
      const r = row as Record<string, unknown>;
      lines.push(`,  CONSTRAINT ${quoteIdent(String(r["name"]))} ${String(r["def"])}`);
    }
    lines.push(");");
    return lines.join("\n");
  }
  if (node.kind === "function") {
    const fq = qualifyIdent(node.schema.name, node.function.name);
    const r = await conn.connection.query(
      `SELECT pg_get_functiondef($1::regprocedure) AS d`,
      [`${fq}(${node.function.args})`],
    );
    return `-- Function definition for ${fq}\n${(r.rows[0] as Record<string, unknown>)["d"]};\n`;
  }
  if (node.kind === "index") {
    const r = await conn.connection.query(
      `SELECT pg_get_indexdef($1::oid) AS d`,
      [node.index.oid],
    );
    return `${(r.rows[0] as Record<string, unknown>)["d"]};\n`;
  }
  if (node.kind === "trigger") {
    return `${node.trigger.definition};\n`;
  }
  if (node.kind === "constraint") {
    return `-- ${node.constraint.kind} constraint ${node.constraint.name}\n${node.constraint.definition};\n`;
  }
  return null;
}

export async function insertTemplate(node: SchemaNode): Promise<void> {
  if (node.kind !== "relation") return;
  const intros = new Introspector(node.conn.connection);
  const cols = await intros.columns(node.relation.oid);
  const fq = qualifyIdent(node.schema.name, node.relation.name);
  const writable = cols.filter((c) => c.default === null);
  const colsList = writable.map((c) => quoteIdent(c.name)).join(", ");
  const placeholders = writable.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `INSERT INTO ${fq} (${colsList}) VALUES (${placeholders})`;
  // Insert as a new cell but don't auto-execute — user fills in the
  // values first.
  await appendCellToActiveNotebook({ conn: node.conn, text: sql, execute: false });
}

export async function alterScaffold(node: SchemaNode): Promise<void> {
  const conn = (node as unknown as { conn?: ActiveConnection }).conn;
  if (!conn) return;
  if (!requireWriteMode(conn)) return;
  const fq = nodeFullyQualifiedName(node);
  if (!fq) return;
  const sql = `-- Scaffolded ALTER. Edit before running.\nALTER ${alterKindKeyword(node)} ${fq} `;
  await appendCellToActiveNotebook({ conn, text: sql, execute: false });
}

function alterKindKeyword(node: SchemaNode): string {
  switch (node.kind) {
    case "relation":
      return node.relation.kind === "view" || node.relation.kind === "materializedView" ? "VIEW" : "TABLE";
    case "index":
      return "INDEX";
    case "sequence":
      return "SEQUENCE";
    case "function":
      return "FUNCTION";
    case "type":
      return "TYPE";
    case "schema":
      return "SCHEMA";
    default:
      return "OBJECT";
  }
}

export async function dropNode(node: SchemaNode): Promise<void> {
  const conn = (node as unknown as { conn?: ActiveConnection }).conn;
  if (!conn) return;
  if (!requireWriteMode(conn)) return;
  const fq = nodeFullyQualifiedName(node);
  if (!fq) return;
  const kind = dropKindKeyword(node);
  const requireTyped = vscode.workspace
    .getConfiguration("cnpg4vscode")
    .get<boolean>("confirmation.requireTypedName") ?? true;
  const ok = await confirmDestructive({
    operation: `DROP ${kind}`,
    target: fq,
    requireTypedName: requireTyped,
  });
  if (!ok) return;
  await appendCellToActiveNotebook({
    conn,
    text: `DROP ${kind} ${fq}`,
    execute: true,
  });
}

export async function truncateRelation(node: SchemaNode): Promise<void> {
  if (node.kind !== "relation" || node.relation.kind !== "table") return;
  if (!requireWriteMode(node.conn)) return;
  const fq = qualifyIdent(node.schema.name, node.relation.name);
  const requireTyped = vscode.workspace
    .getConfiguration("cnpg4vscode")
    .get<boolean>("confirmation.requireTypedName") ?? true;
  const ok = await confirmDestructive({
    operation: "TRUNCATE",
    target: fq,
    requireTypedName: requireTyped,
  });
  if (!ok) return;
  await appendCellToActiveNotebook({
    conn: node.conn,
    text: `TRUNCATE ${fq}`,
    execute: true,
  });
}

export async function reindexNode(node: SchemaNode): Promise<void> {
  const conn = (node as unknown as { conn?: ActiveConnection }).conn;
  if (!conn || !requireWriteMode(conn)) return;
  let target: string | null = null;
  let kw = "TABLE";
  if (node.kind === "relation" && node.relation.kind === "table") {
    target = qualifyIdent(node.schema.name, node.relation.name);
    kw = "TABLE";
  } else if (node.kind === "index") {
    target = qualifyIdent(node.schema.name, node.index.name);
    kw = "INDEX";
  }
  if (!target) return;
  const requireTyped = vscode.workspace
    .getConfiguration("cnpg4vscode")
    .get<boolean>("confirmation.requireTypedName") ?? true;
  const ok = await confirmDestructive({
    operation: `REINDEX ${kw}`,
    target,
    requireTypedName: requireTyped,
  });
  if (!ok) return;
  await appendCellToActiveNotebook({
    conn,
    text: `REINDEX ${kw} ${target}`,
    execute: true,
  });
}

function dropKindKeyword(node: SchemaNode): string {
  switch (node.kind) {
    case "relation":
      switch (node.relation.kind) {
        case "table":
          return "TABLE";
        case "view":
          return "VIEW";
        case "materializedView":
          return "MATERIALIZED VIEW";
        case "foreign":
          return "FOREIGN TABLE";
      }
      return "TABLE";
    case "index":
      return "INDEX";
    case "sequence":
      return "SEQUENCE";
    case "function":
      return "FUNCTION";
    case "type":
      return "TYPE";
    case "schema":
      return "SCHEMA";
    default:
      return "OBJECT";
  }
}
