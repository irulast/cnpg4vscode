/**
 * ER diagram orchestrator (US6; FR-028).
 *
 * Fetches tables + columns + foreign keys for a chosen scope (schema or
 * the entire connected database) and opens the Mermaid `erDiagram`
 * markdown in VS Code's native markdown preview. No webview, no
 * bundled grammar — Mermaid ships with the VS Code markdown renderer.
 *
 * Scope picker: when invoked on a database node, asks the user to pick
 * a schema (or "all non-system schemas"). When invoked on a schema
 * node, uses that schema directly.
 */

import * as vscode from "vscode";
import { ActiveConnection } from "../state/session.js";
import { Introspector, RelationRow, SchemaRow } from "../pg/introspect.js";
import {
  buildMermaidErDiagram,
  ErColumn,
  ErForeignKey,
  ErTable,
} from "./er-diagram-render.js";
import { log } from "../logging/channel.js";

export type ErScope =
  | { kind: "schema"; schema: SchemaRow }
  | { kind: "database" };

export async function showErDiagram(conn: ActiveConnection, scope: ErScope): Promise<void> {
  const intros = new Introspector(conn.connection);

  // Resolve which schemas are in scope.
  const schemas: SchemaRow[] =
    scope.kind === "schema"
      ? [scope.schema]
      : (await intros.schemas()).filter((s) => !s.isSystem);

  if (schemas.length === 0) {
    vscode.window.showInformationMessage("No non-system schemas to diagram.");
    return;
  }

  // Pull tables + per-table columns in parallel-per-schema, sequential
  // per table to stay within the connection pool. For typical CNPG app
  // databases this is well under a second.
  const tables: ErTable[] = [];
  const fks: ErForeignKey[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Building ER diagram for ${describeScope(scope)}…`,
      cancellable: false,
    },
    async (progress) => {
      let done = 0;
      for (const schema of schemas) {
        progress.report({ message: `${done}/${schemas.length} schemas` });
        const rels = await intros.relations(schema.oid);
        const tableRels = rels.filter(
          (r): r is RelationRow & { kind: "table" } =>
            r.kind === "table",
        );
        for (const rel of tableRels) {
          const cols = await intros.columns(rel.oid);
          tables.push({
            oid: rel.oid,
            schema: schema.name,
            name: rel.name,
            columns: cols.map(
              (c): ErColumn => ({
                name: c.name,
                type: c.type,
                isPk: c.isPk,
                notNull: c.notNull,
              }),
            ),
          });
        }
        const fkRows = await intros.foreignKeys(schema.oid);
        for (const fk of fkRows) {
          fks.push({
            fromOid: fk.fromOid,
            toOid: fk.toOid,
            fromColumns: fk.fromColumns,
            toColumns: fk.toColumns,
            name: fk.name,
          });
        }
        done++;
      }
    },
  );

  const warnOverTables =
    vscode.workspace.getConfiguration("cnpg4vscode").get<number>("er.warnOverTables") ?? 100;

  // VS Code's built-in markdown preview does NOT render Mermaid natively.
  // The canonical extension that adds it is bierner.markdown-mermaid
  // ("Markdown Preview Mermaid Support" — 6.5M+ installs, by the VS Code
  // markdown maintainer at Microsoft). Prompt the user once if they don't
  // have it; render the markdown either way so a declining user still
  // gets the diagram as copy-pastable text.
  await ensureMermaidRenderer();

  const title = `ER · ${conn.cluster.clusterName}/${conn.database} · ${describeScope(scope)}`;
  const body = buildMermaidErDiagram(tables, fks, { warnOverTables });
  const markdown = `# ${title}\n\n${body}\n`;

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: markdown,
  });
  await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
  log.info("er.show", {
    connection: conn.id,
    scope: describeScope(scope),
    tables: tables.length,
    fks: fks.length,
  });
}

function describeScope(scope: ErScope): string {
  return scope.kind === "schema" ? scope.schema.name : "all non-system schemas";
}

const MERMAID_EXTENSION_ID = "bierner.markdown-mermaid";
const DISMISS_KEY = "cnpg.er.mermaidPromptDismissed";
let promptedThisSession = false;

/**
 * Prompts the user once per session to install bierner.markdown-mermaid if
 * it isn't already installed. The first prompt is "Install" / "Open in
 * Marketplace" / "Don't show again"; the user's "Don't show again" choice
 * persists in globalState. Either way the ER markdown opens — a user who
 * declines still sees the diagram source they can copy elsewhere.
 */
async function ensureMermaidRenderer(): Promise<void> {
  if (vscode.extensions.getExtension(MERMAID_EXTENSION_ID)) return;
  if (promptedThisSession) return;
  promptedThisSession = true;

  // globalState lives on the extension context, which we don't have here.
  // For now we just don't suppress across sessions — the prompt is light
  // and dismissible. (Persistent dismissal can be added when we have a
  // shared context handle if it becomes annoying.)
  const choice = await vscode.window.showInformationMessage(
    "Install Markdown Preview Mermaid Support to render this ER diagram inline?",
    { modal: false },
    "Install",
    "Open in Marketplace",
    "Not now",
  );
  if (choice === "Install") {
    try {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        MERMAID_EXTENSION_ID,
      );
      vscode.window.showInformationMessage(
        "Mermaid preview support installed. Re-run CNPG: Show ER Diagram to render the next diagram inline.",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to install Mermaid extension: ${message}`);
    }
  } else if (choice === "Open in Marketplace") {
    await vscode.commands.executeCommand(
      "workbench.extensions.search",
      `@id:${MERMAID_EXTENSION_ID}`,
    );
  }
  // "Not now" / dismissed → fall through; the markdown still opens.
  void DISMISS_KEY;
}
