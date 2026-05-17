/**
 * Grid Editor host registry (US6 Phase 8.5 — T150d).
 *
 * Singleton store of open `GridEditorHost` instances keyed by
 * `(connectionId, schema, table)`. Reopening the same target reveals
 * the existing tab rather than creating a duplicate panel.
 *
 * Initialised once at activation with the extension URI + workspace
 * state Memento; commands open against the registry via `openGrid(node)`.
 */

import * as vscode from "vscode";
import { GridEditorHost } from "./host.js";
import { getSession, type ActiveConnection } from "../state/session.js";
import { log } from "../logging/channel.js";

interface GridTarget {
  readonly conn: ActiveConnection;
  readonly schema: string;
  readonly table: string;
  readonly initialFilters?: ReadonlyArray<{ column: string; op: "eq"; value: string }>;
}

/**
 * State the renderer persists via `vscode.setState()`. The
 * `WebviewPanelSerializer` (T158) reads this on workspace restore to
 * decide which connection + table to re-bind the rebuilt panel to.
 *
 * Versioned so a future schema migration can detect legacy payloads
 * and fall back to the placeholder. NEVER carries credentials, query
 * results, or layout state — layout lives in `workspaceState` keyed
 * by the 6-tuple grid state key (T147).
 */
export interface HibernatedGridState {
  readonly v: 1;
  readonly connectionId: string;
  readonly schema: string;
  readonly table: string;
}

let extensionUri: vscode.Uri | null = null;
let workspaceState: vscode.Memento | null = null;
const hosts = new Map<string, GridEditorHost>();

export function initGridRegistry(opts: {
  extensionUri: vscode.Uri;
  workspaceState: vscode.Memento;
}): void {
  extensionUri = opts.extensionUri;
  workspaceState = opts.workspaceState;
}

function keyFor(target: { conn: ActiveConnection; schema: string; table: string }): string {
  return `${target.conn.id}|${target.schema}|${target.table}`;
}

function registerHost(key: string, host: GridEditorHost): void {
  hosts.set(key, host);
  // Schedule registry cleanup when the host disposes. The host's
  // dispose method runs when the panel closes; we need to clear the
  // map entry so reopen creates a fresh host.
  const origDispose = host.dispose.bind(host);
  host.dispose = (): void => {
    hosts.delete(key);
    origDispose();
  };
}

export async function openGrid(target: GridTarget): Promise<void> {
  if (!extensionUri || !workspaceState) {
    void vscode.window.showErrorMessage(
      "Grid Editor not initialised. Reload the extension.",
    );
    return;
  }
  const key = keyFor(target);
  const existing = hosts.get(key);
  if (existing) {
    existing.reveal();
    return;
  }
  const host = GridEditorHost.create({
    extensionUri,
    workspaceState,
    conn: target.conn,
    schema: target.schema,
    table: target.table,
    ...(target.initialFilters ? { initialFilters: target.initialFilters } : {}),
    openReferenced: (t) => openGrid(t),
  });
  registerHost(key, host);
}

/**
 * Restore a hibernated Grid Editor tab (T158).
 *
 * Called by the `WebviewPanelSerializer` registered in `extension.ts`.
 * VS Code reconstructs the `WebviewPanel` shell (view-column, title,
 * visibility) and hands it to us with whatever `vscode.setState()` the
 * renderer last persisted. We:
 *
 *   1. Validate the persisted shape — bail to placeholder on missing
 *      fields or a future schema version we don't understand.
 *   2. Look up the active connection by ID. Connection IDs are
 *      deterministic (`<clusterKey>/<credential>/<database>`) so a
 *      re-established connection to the same target matches.
 *   3. If found → adopt the panel into a fresh `GridEditorHost` that
 *      re-runs the normal `init → ready → page` flow against it.
 *      If not found → render an in-panel placeholder explaining that
 *      the user needs to reconnect the cluster; the panel stays open
 *      so the user can see WHICH table it was, then close it manually.
 *
 * Never throws — the serializer is required to return a Thenable that
 * resolves; rejections crash the entire restore phase.
 */
export async function restoreGridPanel(
  panel: vscode.WebviewPanel,
  rawState: unknown,
): Promise<void> {
  if (!extensionUri || !workspaceState) {
    showPlaceholder(panel, "Grid Editor not initialised. Reload the extension.");
    return;
  }
  const state = parseHibernatedState(rawState);
  if (!state) {
    log.warn("grid.restore.badState", { rawState });
    showPlaceholder(panel, "Could not restore Grid Editor — saved state was missing or unrecognised.");
    return;
  }
  const conn = getSession().connections.get(state.connectionId);
  if (!conn) {
    log.info("grid.restore.connectionMissing", {
      connectionId: state.connectionId,
      target: `${state.schema}.${state.table}`,
    });
    showPlaceholder(
      panel,
      `Grid Editor for ${escapeHtml(state.schema)}.${escapeHtml(state.table)} requires the cluster connection ${escapeHtml(state.connectionId)} to be active. Expand the cluster in the CloudNativePG view to reconnect, then reopen the table from the schema tree.`,
    );
    return;
  }
  const key = keyFor({ conn, schema: state.schema, table: state.table });
  // If a host already exists for this key (e.g. user reopened the
  // same target via the menu between restore phases), dispose the
  // serialiser's panel so we don't end up with two tabs for one
  // target.
  if (hosts.has(key)) {
    panel.dispose();
    hosts.get(key)?.reveal();
    return;
  }
  const host = GridEditorHost.create({
    extensionUri,
    workspaceState,
    conn,
    schema: state.schema,
    table: state.table,
    existingPanel: panel,
    openReferenced: (t) => openGrid(t),
  });
  registerHost(key, host);
  log.info("grid.restore.adopted", { connectionId: conn.id, target: `${state.schema}.${state.table}` });
}

function parseHibernatedState(raw: unknown): HibernatedGridState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s["v"] !== 1) return null;
  const connectionId = s["connectionId"];
  const schema = s["schema"];
  const table = s["table"];
  if (
    typeof connectionId !== "string" ||
    typeof schema !== "string" ||
    typeof table !== "string"
  ) {
    return null;
  }
  return { v: 1, connectionId, schema, table };
}

function showPlaceholder(panel: vscode.WebviewPanel, message: string): void {
  // No nonce / no scripts — the placeholder is a static page. The
  // strictest CSP we can express ("default-src 'none'") is enough.
  panel.webview.options = { enableScripts: false };
  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
  <title>Grid Editor</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px; margin: 0; }
    h2 { margin-top: 0; }
    p { opacity: 0.85; line-height: 1.5; }
  </style>
</head>
<body>
  <h2>Grid Editor — connection unavailable</h2>
  <p>${message}</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function disposeGridRegistry(): void {
  for (const host of hosts.values()) host.dispose();
  hosts.clear();
}
