/**
 * cnpg-sql notebook controller (US4 notebook refactor; FR-035).
 *
 * One controller per active `DatabaseConnection`. The controller's id
 * MATCHES the connection's id so notebook metadata can re-select the
 * controller after a restart.
 *
 * The pure execution logic lives in `controller-core.ts` so it can be
 * unit-tested without the VS Code host; this file wires it into the
 * platform.
 */

import * as vscode from "vscode";
import { CNPG_NOTEBOOK_TYPE } from "./host-serializer.js";
import { controllerLabel, executeCellSql, ExecuteResult } from "./controller-core.js";
import { formatErrorOutput, formatSuccessOutput, OutputItem } from "./output.js";
import { redact } from "../pg/redact.js";
import { ActiveConnection } from "../state/session.js";
import { recordExecution } from "../state/history.js";
import { log } from "../logging/channel.js";

export class CnpgNotebookController implements vscode.Disposable {
  readonly controller: vscode.NotebookController;
  private executionOrder = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly conn: ActiveConnection) {
    this.controller = vscode.notebooks.createNotebookController(
      conn.id,
      CNPG_NOTEBOOK_TYPE,
      controllerLabel(conn),
    );
    // Accept both our own `postgres` language and the generic `sql` language
    // so cells authored under either grammar execute correctly.
    this.controller.supportedLanguages = ["postgres", "sql"];
    this.controller.supportsExecutionOrder = true;
    this.controller.description = `${conn.cluster.namespace}/${conn.cluster.clusterName}`;
    this.controller.detail = `${conn.user}`;
    this.controller.executeHandler = (cells, _nb, _ctrl) => this.executeAll(cells);
  }

  /** Re-render the controller label after a mode toggle. */
  syncLabel(): void {
    this.controller.label = controllerLabel(this.conn);
  }

  /** Mark the controller preferred for a freshly-opened notebook so VS Code auto-selects it. */
  setPreferredFor(notebook: vscode.NotebookDocument): void {
    this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.controller.dispose();
  }

  private async executeAll(cells: vscode.NotebookCell[]): Promise<void> {
    for (const cell of cells) {
      await this.executeOne(cell);
    }
  }

  private async executeOne(cell: vscode.NotebookCell): Promise<void> {
    const exec = this.controller.createNotebookCellExecution(cell);
    exec.executionOrder = ++this.executionOrder;
    exec.start(Date.now());

    const sql = cell.document.getText();
    const startedAt = Date.now();
    log.info("notebook.cell.start", {
      connection: this.conn.id,
      mode: this.conn.connection.mode,
      sql,
    });

    const result = await executeCellSql(this.conn, sql);
    const durationMs = Date.now() - startedAt;
    const success = await applyResultToExecution(exec, result);
    log.info(success ? "notebook.cell.ok" : "notebook.cell.failed", {
      connection: this.conn.id,
      durationMs,
      kind: result.kind,
    });
    // Record to per-workspace history (T072 + T129). recordExecution() is
    // a no-op when history is disabled or no workspace is open. The SQL
    // is redacted inside recordExecution() — never persisted raw.
    const rows = result.kind === "ok" ? (result.result.rowCount ?? null) : null;
    const errorClass = result.kind === "error" ? result.sqlstate : undefined;
    void recordExecution({
      clusterId: `${this.conn.cluster.contextName}/${this.conn.cluster.namespace}/${this.conn.cluster.clusterName}`,
      database: this.conn.database,
      user: this.conn.user,
      sql,
      durationMs,
      rows,
      ok: success,
      ...(errorClass ? { errorClass } : {}),
    });
    exec.end(success, Date.now());
  }
}

async function applyResultToExecution(
  exec: vscode.NotebookCellExecution,
  result: ExecuteResult,
): Promise<boolean> {
  const items: OutputItem[] = [];
  let success = false;

  if (result.kind === "ok") {
    items.push(...formatSuccessOutput(result.result));
    success = true;
  } else if (result.kind === "rejected") {
    items.push(formatErrorOutput(`[read-only] ${redact(result.reason)} (${result.code})`));
  } else {
    items.push(formatErrorOutput(redact(result.message), result.sqlstate));
  }

  await exec.replaceOutput(
    new vscode.NotebookCellOutput(
      items.map((it) => {
        if (it.mime === "application/vnd.code.notebook.error") {
          return vscode.NotebookCellOutputItem.error(new Error(it.text));
        }
        // Preserve the original mime type — VS Code uses it to pick the
        // renderer (our `cnpg-result-renderer` claims
        // `application/x-cnpg-result+json`; `text/markdown` and
        // `text/plain` fall through to built-in renderers).
        return vscode.NotebookCellOutputItem.text(it.text, it.mime);
      }),
    ),
  );
  return success;
}
