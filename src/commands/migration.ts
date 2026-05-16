/**
 * Migration wizard — no-webview QuickPick + InputBox flow (US6; T112
 * scope variant). Host-glue half — the pure orchestration lives at
 * `src/sql/migration-flow.ts` so vitest can drive it without resolving
 * `vscode` or `pg`.
 *
 * Flow:
 *   1. Pick a connection (or auto-select if only one is active).
 *   2. Open an untitled `.sql` document seeded with a starter
 *      comment — the user authors statements there. We don't try to
 *      collect SQL through `showInputBox` because non-trivial
 *      migrations need real editor affordances (multi-line, history,
 *      vim mode, snippets — all freebies in a real document).
 *   3. The user invokes "CNPG: Run Migration (active SQL editor)" on
 *      the document; that command calls `runMigrationFromEditor()`.
 *   4. The pure flow at `src/sql/migration-flow.ts` splits, classifies,
 *      previews via a modal, executes via `withClient()`, and offers
 *      export to `.sql`.
 */

import * as vscode from "vscode";
import { PoolClient } from "pg";
import { ActiveConnection, getSession } from "../state/session.js";
import {
  executeMigration,
  type MigrationClient,
  type MigrationResult,
} from "../sql/migration.js";
import {
  runMigrationFlow,
  type MigrationPreview,
} from "../sql/migration-flow.js";
import { log } from "../logging/channel.js";

export async function openMigrationWizard(): Promise<void> {
  const session = getSession();
  if (session.connections.size === 0) {
    vscode.window.showInformationMessage(
      "No active CNPG connection. Connect to a cluster first.",
    );
    return;
  }
  const conn =
    session.connections.size === 1
      ? [...session.connections.values()][0]!
      : await pickConnection();
  if (!conn) return;

  // Author the migration in a real editor. The starter banner explains
  // the contract (one statement per `;`, run via the wizard not Shift+Enter).
  const starter = [
    `-- CNPG migration for ${conn.cluster.namespace}/${conn.cluster.clusterName}/${conn.database}`,
    `-- Connection mode: ${conn.connection.mode}`,
    `-- Statements separated by ';'. Run via 'CNPG: Run Migration (active SQL editor)'.`,
    "",
    "-- Example:",
    "-- CREATE TABLE example_t (id int PRIMARY KEY);",
    "-- ALTER TABLE example_t ADD COLUMN name text;",
    "",
  ].join("\n");
  const doc = await vscode.workspace.openTextDocument({
    language: "sql",
    content: starter,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
  log.info("migration.author.open", { connection: conn.id });
  vscode.window.showInformationMessage(
    "Edit the SQL, then run 'CNPG: Run Migration (active SQL editor)' from the command palette to execute.",
  );
}

/**
 * Pick up the SQL text from `editor` and drive it through the wizard.
 * Used by both `openMigrationWizard()` (deferred run path) and the
 * standalone `cnpg.migration.run` command.
 */
export async function runMigrationFromEditor(
  editor: vscode.TextEditor,
  conn: ActiveConnection,
): Promise<void> {
  const text = editor.document.getText();
  if (!text.trim()) {
    vscode.window.showInformationMessage("Document is empty.");
    return;
  }
  const result = await runMigrationFlow({
    conn,
    sqlBuffer: text,
    confirmRun: (preview) => confirmRunInModal(preview),
    askExport: () => askExportInModal(),
    writeExport: (relPath, body) => writeExportToWorkspace(relPath, body),
    executeViaClient: (statements) =>
      conn.connection.withClient((c) => executeViaPoolClient(c, statements)),
    logger: log,
  });

  switch (result.kind) {
    case "cancelled":
      vscode.window.showInformationMessage("Migration cancelled.");
      return;
    case "no-statements":
      vscode.window.showInformationMessage(
        "No SQL statements detected — add at least one statement and try again.",
      );
      return;
    case "ok":
    case "partiallyApplied":
    case "failed":
      await renderOutcomeDoc(conn, result);
      return;
  }
}

// ---------------------------------------------------------------------------
// VS Code-host glue (not unit-tested — exercised via the e2e suite once
// vscode-test-electron infrastructure is in place)
// ---------------------------------------------------------------------------

async function pickConnection(): Promise<ActiveConnection | undefined> {
  const session = getSession();
  const conns = [...session.connections.values()];
  const picked = await vscode.window.showQuickPick(
    conns.map((c) => ({
      label: `${c.cluster.clusterName}/${c.database}`,
      description: `${c.user} (${c.connection.mode})`,
      conn: c,
    })),
    { title: "Pick a connection for the migration", canPickMany: false },
  );
  return picked?.conn;
}

async function confirmRunInModal(preview: MigrationPreview): Promise<"confirmed" | "cancelled"> {
  const headline = `Run ${preview.statements.length} statement(s) against ${preview.target}?`;
  const modeBanner = preview.transactional
    ? "Mode: transactional (BEGIN/COMMIT — any failure rolls back the set)"
    : `Mode: non-transactional — ${preview.nonTransactionalIndexes.length} statement(s) cannot run inside a transaction. A mid-set failure will leave the already-applied prefix in place.`;
  const detail = `${modeBanner}\n\n${previewDetail(preview)}`;
  const choice = await vscode.window.showWarningMessage(
    headline,
    { modal: true, detail },
    "Run",
  );
  return choice === "Run" ? "confirmed" : "cancelled";
}

function previewDetail(preview: MigrationPreview): string {
  return preview.statements.map((s, i) => `${i + 1}. ${oneLiner(s)}`).join("\n");
}

function oneLiner(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

async function askExportInModal(): Promise<"yes" | "no"> {
  const choice = await vscode.window.showInformationMessage(
    "Migration applied. Export the assembled SQL to your workspace?",
    "Export",
  );
  return choice === "Export" ? "yes" : "no";
}

async function writeExportToWorkspace(
  relativePath: string,
  body: string,
): Promise<string | null> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showWarningMessage(
      "No workspace folder open — cannot export migration. Copy the markdown summary instead.",
    );
    return null;
  }
  const target = vscode.Uri.joinPath(ws.uri, relativePath);
  const dir = vscode.Uri.joinPath(target, "..");
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(body));
  await vscode.commands.executeCommand("vscode.open", target);
  return vscode.workspace.asRelativePath(target);
}

async function renderOutcomeDoc(
  conn: ActiveConnection,
  outcome:
    | { kind: "ok"; statements: ReadonlyArray<string>; exportedTo: string | null }
    | {
        kind: "failed";
        statements: ReadonlyArray<string>;
        failedIndex: number;
        error: Error;
        rolledBack: boolean;
      }
    | {
        kind: "partiallyApplied";
        statements: ReadonlyArray<string>;
        failedIndex: number;
        completedIndexes: ReadonlyArray<number>;
        error: Error;
      },
): Promise<void> {
  const lines: string[] = [
    `# Migration outcome — ${conn.cluster.namespace}/${conn.cluster.clusterName}/${conn.database}`,
    "",
    `**Result**: ${outcome.kind}`,
  ];
  if (outcome.kind === "ok") {
    lines.push(
      `**Statements**: ${outcome.statements.length} applied`,
      "",
      outcome.exportedTo
        ? `**Exported to**: \`${outcome.exportedTo}\``
        : "_Not exported._",
    );
  }
  if (outcome.kind === "failed") {
    lines.push(
      `**Failed at**: statement ${outcome.failedIndex + 1} of ${outcome.statements.length}`,
      `**Rolled back**: ${outcome.rolledBack ? "yes" : "no (ROLLBACK itself failed)"}`,
      "",
      "```sql",
      outcome.statements[outcome.failedIndex] ?? "(unknown)",
      "```",
      "",
      `**Error**: ${outcome.error.message}`,
    );
  }
  if (outcome.kind === "partiallyApplied") {
    lines.push(
      `**Failed at**: statement ${outcome.failedIndex + 1} of ${outcome.statements.length}`,
      `**Completed before failure**: ${outcome.completedIndexes.length}`,
      "",
      "_The prefix that ran successfully has been committed and cannot be automatically rolled back (the statement set contains non-transactional DDL)._",
      "",
      "```sql",
      outcome.statements[outcome.failedIndex] ?? "(unknown)",
      "```",
      "",
      `**Error**: ${outcome.error.message}`,
    );
  }
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: lines.join("\n"),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function executeViaPoolClient(
  client: PoolClient,
  statements: ReadonlyArray<string>,
): Promise<MigrationResult> {
  const adapter: MigrationClient = {
    async query(sql, values) {
      const r = await client.query(sql, values as unknown[] | undefined);
      return { rowCount: r.rowCount ?? 0 };
    },
  };
  return executeMigration(adapter, statements);
}
