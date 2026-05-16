/**
 * Helpers for appending cells to (or creating) a cnpg-sql notebook from
 * non-notebook command paths — Browse Rows, Count Rows, Insert Template,
 * Run-from-.sql-file (US4 notebook refactor; FR-036).
 */

import * as vscode from "vscode";
import { CNPG_NOTEBOOK_TYPE } from "./host-serializer.js";
import { ActiveConnection } from "../state/session.js";

/**
 * Append a code cell to the most-recently-active cnpg-sql notebook, or
 * create a new notebook bound to `conn` if none is open. Optionally runs
 * the cell.
 *
 * Returns the cell, or undefined if nothing could be done.
 */
export async function appendCellToActiveNotebook(opts: {
  conn: ActiveConnection;
  text: string;
  execute?: boolean;
}): Promise<vscode.NotebookCell | undefined> {
  const target = findActiveNotebookForConn(opts.conn);
  if (target) {
    return appendAndMaybeExecute(target, opts.text, opts.execute);
  }
  const nb = await openNewNotebookForConn(opts.conn, opts.text);
  if (!nb) return undefined;
  const cell = nb.cellAt(nb.cellCount - 1);
  if (opts.execute) await executeCells(nb, cell);
  return cell;
}

/** Create a fresh untitled cnpg-sql notebook bound to `conn`, optionally with an initial cell. */
export async function openNewNotebookForConn(
  conn: ActiveConnection,
  initialCellText?: string,
): Promise<vscode.NotebookDocument | undefined> {
  const cells: vscode.NotebookCellData[] = [];
  if (initialCellText && initialCellText.trim().length > 0) {
    cells.push(
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, initialCellText, "postgres"),
    );
  } else {
    cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "postgres"));
  }
  const data = new vscode.NotebookData(cells);
  data.metadata = { boundControllerId: conn.id };
  const nb = await vscode.workspace.openNotebookDocument(CNPG_NOTEBOOK_TYPE, data);
  await vscode.window.showNotebookDocument(nb);
  return nb;
}

function findActiveNotebookForConn(conn: ActiveConnection): vscode.NotebookDocument | undefined {
  // Prefer the active notebook editor's document if it matches.
  const active = vscode.window.activeNotebookEditor?.notebook;
  if (active && active.notebookType === CNPG_NOTEBOOK_TYPE) {
    if (notebookPrefers(active, conn.id)) return active;
  }
  // Otherwise, find any visible notebook of the right type with matching binding.
  for (const editor of vscode.window.visibleNotebookEditors) {
    const nb = editor.notebook;
    if (nb.notebookType !== CNPG_NOTEBOOK_TYPE) continue;
    if (notebookPrefers(nb, conn.id)) return nb;
  }
  return undefined;
}

function notebookPrefers(nb: vscode.NotebookDocument, connId: string): boolean {
  const bound = (nb.metadata as { boundControllerId?: unknown } | undefined)?.boundControllerId;
  return bound === connId || bound === undefined;
}

async function appendAndMaybeExecute(
  nb: vscode.NotebookDocument,
  text: string,
  execute?: boolean,
): Promise<vscode.NotebookCell> {
  const cellData = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, text, "postgres");
  const edit = new vscode.WorkspaceEdit();
  edit.set(nb.uri, [
    vscode.NotebookEdit.insertCells(nb.cellCount, [cellData]),
  ]);
  await vscode.workspace.applyEdit(edit);
  const cell = nb.cellAt(nb.cellCount - 1);
  if (execute) await executeCells(nb, cell);
  return cell;
}

async function executeCells(
  nb: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
): Promise<void> {
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: cell.index, end: cell.index + 1 }],
    document: nb.uri,
  });
}
