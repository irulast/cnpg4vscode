/**
 * In-memory session state (US4 notebook refactor; FR-012, FR-021, FR-035).
 *
 * Tracks active tunnels, database connections, and the cnpg-sql notebook
 * controllers that surface those connections to the user.
 *
 * Notebook-binding is owned by VS Code (each notebook records its
 * selected controller); we don't carry a parallel editor-binding map.
 *
 * NOTHING in this module is ever persisted to disk. The persistence
 * module (src/state/history.ts) covers redacted SQL only.
 */

import * as vscode from "vscode";
import { DatabaseConnection } from "../pg/connection.js";
import { TunnelController } from "../k8s/port-forward.js";

export interface ClusterKey {
  contextName: string;
  namespace: string;
  clusterName: string;
}

export function clusterKey(k: ClusterKey): string {
  return `${k.contextName}/${k.namespace}/${k.clusterName}`;
}

export interface ActiveTunnel {
  controller: TunnelController;
  key: string;
}

export interface ActiveConnection {
  id: string;
  cluster: ClusterKey;
  database: string;
  user: string;
  connection: DatabaseConnection;
}

/**
 * Listener hook for the controller layer. Registered by extension.ts at
 * activation; called whenever a connection is added or removed so the
 * controller registry can stay in sync.
 */
export interface ConnectionLifecycleListener {
  onConnectionAdded(conn: ActiveConnection): void;
  onConnectionRemoved(id: string): void;
}

class Session {
  readonly tunnels = new Map<string, ActiveTunnel>();
  readonly connections = new Map<string, ActiveConnection>();
  private readonly listeners = new Set<ConnectionLifecycleListener>();
  private readonly _onChanged = new vscode.EventEmitter<void>();
  readonly onChanged = this._onChanged.event;

  addLifecycleListener(l: ConnectionLifecycleListener): vscode.Disposable {
    this.listeners.add(l);
    // Replay current state so the listener sees what's already connected.
    for (const c of this.connections.values()) l.onConnectionAdded(c);
    return { dispose: () => this.listeners.delete(l) };
  }

  registerConnection(c: ActiveConnection): void {
    this.connections.set(c.id, c);
    for (const l of this.listeners) {
      try {
        l.onConnectionAdded(c);
      } catch {
        // ignore listener errors
      }
    }
    this._onChanged.fire();
  }

  async removeConnection(id: string): Promise<void> {
    const c = this.connections.get(id);
    if (!c) return;
    this.connections.delete(id);
    for (const l of this.listeners) {
      try {
        l.onConnectionRemoved(id);
      } catch {
        // ignore listener errors
      }
    }
    await c.connection.dispose();
    this._onChanged.fire();
  }

  /** Notify listeners that the connection's mode changed (controller label needs refresh). */
  emitChanged(): void {
    this._onChanged.fire();
  }

  registerTunnel(t: ActiveTunnel): void {
    this.tunnels.set(t.key, t);
    this._onChanged.fire();
  }

  async removeTunnel(key: string): Promise<void> {
    const t = this.tunnels.get(key);
    if (!t) return;
    this.tunnels.delete(key);
    // Close every connection that depends on this tunnel.
    const dependent = [...this.connections.values()].filter(
      (c) => clusterKey(c.cluster) === key,
    );
    for (const c of dependent) await this.removeConnection(c.id);
    await t.controller.close();
    this._onChanged.fire();
  }

  /** Best-effort cleanup at deactivation. */
  async disposeAll(): Promise<void> {
    for (const id of [...this.connections.keys()]) await this.removeConnection(id);
    for (const key of [...this.tunnels.keys()]) await this.removeTunnel(key);
    this._onChanged.dispose();
  }
}

let singleton: Session | null = null;

export function getSession(): Session {
  if (!singleton) singleton = new Session();
  return singleton;
}

export async function disposeSession(): Promise<void> {
  if (!singleton) return;
  await singleton.disposeAll();
  singleton = null;
}
