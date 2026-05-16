/**
 * VS Code-host wrapper around HistoryStore (US4 deferred T072 + T129).
 *
 * Singleton — initialized at activation with the resolved per-workspace
 * file path and the user's `cnpg4vscode.history.maxEntries` setting.
 * The notebook controller calls `recordExecution()` after every cell
 * runs; the `cnpg.history.open` command surfaces a Quick Pick over the
 * stored entries.
 *
 * This is one of TWO modules (along with `src/state/tabs.ts`) where the
 * `cnpg-local/no-state-write-outside-history` ESLint rule permits
 * writes to persistent state. Other modules MUST route through here.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import { HistoryEntry, HistoryStore } from "./history-store.js";
import { redact } from "../pg/redact.js";
import { log } from "../logging/channel.js";

let store: HistoryStore | null = null;
let enabled = false;

export function initHistory(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("cnpg4vscode");
  enabled = cfg.get<boolean>("history.enabled") ?? true;
  if (!enabled) {
    log.info("history.disabled", {});
    store = null;
    return;
  }
  const maxEntries = cfg.get<number>("history.maxEntries") ?? 1000;
  // context.storageUri is per-workspace; null when no workspace is open.
  const storageUri = context.storageUri ?? context.globalStorageUri;
  const filePath = path.join(storageUri.fsPath, "history.json");
  store = new HistoryStore({ filePath, maxEntries });
  log.info("history.init", { filePath, maxEntries });
}

export interface RecordOpts {
  clusterId: string;
  database: string;
  user: string;
  sql: string;
  durationMs: number | null;
  rows: number | null;
  ok: boolean;
  errorClass?: string;
}

/** Append an execution to history. The SQL is redacted here unconditionally. */
export async function recordExecution(opts: RecordOpts): Promise<void> {
  if (!store) return;
  const entry: HistoryEntry = {
    ts: Date.now(),
    clusterId: opts.clusterId,
    database: opts.database,
    user: opts.user,
    redactedSql: redact(opts.sql),
    durationMs: opts.durationMs,
    rows: opts.rows,
    ok: opts.ok,
    ...(opts.errorClass !== undefined ? { errorClass: opts.errorClass } : {}),
  };
  try {
    await store.append(entry);
  } catch (err) {
    log.warn("history.append.failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Show a Quick Pick over recent history entries. On pick, append the
 * SQL as a new cell to the active cnpg-sql notebook (or open one if
 * none is open).
 */
export async function showHistoryPicker(): Promise<void> {
  if (!store) {
    vscode.window.showInformationMessage(
      "Query history is disabled. Enable `cnpg4vscode.history.enabled` to use this feature.",
    );
    return;
  }
  const entries = await store.search("", { reversed: true, limit: 200 });
  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      "No history entries yet. Run some queries in a cnpg-sql notebook first.",
    );
    return;
  }

  type Item = vscode.QuickPickItem & { entry: HistoryEntry };
  const items: Item[] = entries.map((e) => {
    const when = relativeTime(e.ts);
    const status = e.ok ? "✓" : "✗";
    const rows = e.rows !== null ? `${e.rows}r` : "—";
    const dur = e.durationMs !== null ? `${e.durationMs}ms` : "—";
    return {
      label: e.redactedSql.split("\n")[0]!.slice(0, 100),
      description: `${status}  ${rows}  ${dur}  ·  ${e.clusterId}/${e.database}`,
      detail: when,
      entry: e,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `CNPG Query History (${entries.length} recent · type to filter)`,
    placeHolder: "Pick a query to insert into the active notebook",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  // Insert into the active notebook as a new cell. If no notebook is
  // open, fall back to opening a new untitled markdown buffer with the
  // SQL so the user can copy it.
  const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
  if (activeNotebook && activeNotebook.notebookType === "cnpg-sql") {
    const cellData = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      picked.entry.redactedSql,
      "postgres",
    );
    const edit = new vscode.WorkspaceEdit();
    edit.set(activeNotebook.uri, [
      vscode.NotebookEdit.insertCells(activeNotebook.cellCount, [cellData]),
    ]);
    await vscode.workspace.applyEdit(edit);
    log.info("history.insert.notebook", { ts: picked.entry.ts });
  } else {
    const doc = await vscode.workspace.openTextDocument({
      language: "sql",
      content: picked.entry.redactedSql,
    });
    await vscode.window.showTextDocument(doc);
    log.info("history.insert.fallback", { ts: picked.entry.ts });
  }
}

export async function clearHistory(): Promise<void> {
  if (!store) {
    vscode.window.showInformationMessage("Query history is disabled.");
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    "Clear all CNPG query history for this workspace? This cannot be undone.",
    { modal: true },
    "Clear",
  );
  if (confirmed !== "Clear") return;
  await store.clear();
  vscode.window.showInformationMessage("CNPG query history cleared.");
  log.info("history.cleared", {});
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
