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
import type { ActiveConnection } from "../state/session.js";

interface GridTarget {
  readonly conn: ActiveConnection;
  readonly schema: string;
  readonly table: string;
  readonly initialFilters?: ReadonlyArray<{ column: string; op: "eq"; value: string }>;
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

function keyFor(target: GridTarget): string {
  return `${target.conn.id}|${target.schema}|${target.table}`;
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

export function disposeGridRegistry(): void {
  for (const host of hosts.values()) host.dispose();
  hosts.clear();
}
