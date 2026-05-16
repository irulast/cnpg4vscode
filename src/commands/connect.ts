/**
 * cnpg.cluster.connect orchestrator (US4; FR-019, FR-035).
 *
 * Flow: cluster context → load CA → resolve primary pod → open tunnel →
 * pick credential → open pg connection in read-only mode → open a
 * cnpg-sql notebook with the new connection's controller pre-selected.
 *
 * Idempotent: if a connection to the cluster already exists, opens a
 * new notebook bound to the existing controller without re-tunneling.
 *
 * Every step that can fail surfaces the verbatim upstream error to the
 * user via vscode.window.showErrorMessage and logs a KV line through
 * the redact() chokepoint. No credentials reach the channel.
 */

import * as vscode from "vscode";
import { KubeConfig } from "@kubernetes/client-node";
import { CnpgCluster } from "../k8s/cnpg.js";
import { loadClusterCABundle } from "../k8s/secrets.js";
import { resolvePrimaryPod } from "../k8s/services.js";
import { TunnelController, createPortForwardDriver } from "../k8s/port-forward.js";
import { DatabaseConnection } from "../pg/connection.js";
import { pickCredential } from "../ui/credential-picker.js";
import { setStatusBar } from "../ui/status-bar.js";
import {
  ActiveConnection,
  clusterKey,
  getSession,
} from "../state/session.js";
import { openNewNotebookForConn } from "../notebook/append-cell.js";
import { log } from "../logging/channel.js";

export interface ConnectContext {
  kubeConfig: KubeConfig;
  contextName: string;
  cluster: CnpgCluster;
}

export async function connectToCluster(ctx: ConnectContext): Promise<void> {
  const session = getSession();
  const key = clusterKey({
    contextName: ctx.contextName,
    namespace: ctx.cluster.namespace,
    clusterName: ctx.cluster.name,
  });

  // Idempotent: if any connection already exists for this cluster, open a
  // fresh notebook bound to it instead of re-running the full open flow.
  const existing = [...session.connections.values()].find(
    (c) =>
      c.cluster.contextName === ctx.contextName &&
      c.cluster.namespace === ctx.cluster.namespace &&
      c.cluster.clusterName === ctx.cluster.name,
  );
  if (existing) {
    log.info("connect.reuse", { cluster: key, connection: existing.id });
    await openNewNotebookForConn(existing);
    setStatusBarForConn(existing);
    return;
  }

  const previousContext = ctx.kubeConfig.getCurrentContext();
  ctx.kubeConfig.setCurrentContext(ctx.contextName);

  try {
    log.info("connect.start", { cluster: key });

    // 1. Load CA bundle.
    const caBundle = await loadClusterCABundle(
      ctx.kubeConfig,
      ctx.cluster.namespace,
      ctx.cluster.name,
    );
    if (!caBundle) {
      vscode.window.showErrorMessage(
        `Cannot load CA bundle from ${ctx.cluster.namespace}/${ctx.cluster.caSecretName}.`,
      );
      return;
    }

    // 2. Resolve primary pod via the -rw service endpoints.
    const podRes = await resolvePrimaryPod(
      ctx.kubeConfig,
      ctx.cluster.namespace,
      ctx.cluster.readWriteService,
    );
    if (podRes.kind === "error") {
      vscode.window.showErrorMessage(`Failed to resolve primary pod: ${podRes.error.message}`);
      return;
    }
    log.info("connect.pod.resolved", { cluster: key, pod: podRes.podName });

    // 3. Open / reuse a tunnel.
    let tunnel = session.tunnels.get(key)?.controller;
    if (!tunnel) {
      tunnel = new TunnelController(
        {
          clusterId: key,
          maxRetries: 3,
          backoffMs: (attempt) => Math.min(30_000, 1000 * 2 ** attempt),
        },
        createPortForwardDriver({
          kc: ctx.kubeConfig,
          namespace: ctx.cluster.namespace,
          podName: podRes.podName,
          targetPort: 5432,
        }),
      );
      tunnel.onStateChange((s) => log.info("tunnel.state", { cluster: key, state: s }));
      await tunnel.open();
      if (tunnel.state !== "open") {
        vscode.window.showErrorMessage(
          `Failed to open port-forward tunnel for ${key}.`,
        );
        return;
      }
      session.registerTunnel({ controller: tunnel, key });
    }

    // 4. Pick credentials.
    const credential = await pickCredential(
      ctx.kubeConfig,
      ctx.cluster.namespace,
      ctx.cluster.name,
    );
    if (!credential) return; // User cancelled.

    // 5. Open pg connection in read-only mode.
    const databaseName =
      credential.database ??
      vscode.workspace
        .getConfiguration("cnpg4vscode")
        .get<string>("connection.defaultDatabase") ??
      "postgres";

    const connection = new DatabaseConnection({
      clusterId: key,
      host: "127.0.0.1",
      port: tunnel.localPort!,
      user: credential.username,
      password: credential.password,
      database: databaseName.length > 0 ? databaseName : "postgres",
      serverName: `${ctx.cluster.readWriteService}.${ctx.cluster.namespace}.svc`,
      caBundle,
      mode: "readonly",
    });

    // 6. Smoke-check the connection so we fail fast on bad credentials.
    try {
      await connection.query("SELECT 1");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Connection test failed: ${message}`);
      await connection.dispose();
      return;
    }

    const connId = `${key}/${credential.name}/${databaseName}`;
    const active: ActiveConnection = {
      id: connId,
      cluster: {
        contextName: ctx.contextName,
        namespace: ctx.cluster.namespace,
        clusterName: ctx.cluster.name,
      },
      database: databaseName,
      user: credential.username,
      connection,
    };
    session.registerConnection(active);

    // 7. Open a new cnpg-sql notebook with the new controller pre-selected.
    await openNewNotebookForConn(active);

    // 8. Update status bar + context keys.
    setStatusBarForConn(active);
    await vscode.commands.executeCommand("setContext", "cnpg.activeConnection", true);
    await vscode.commands.executeCommand("setContext", "cnpg.connection.writeMode", false);

    log.info("connect.ok", { cluster: key, db: databaseName, user: credential.username });
    vscode.window.showInformationMessage(
      `Connected to ${ctx.cluster.name}/${databaseName} as ${credential.username} (read-only).`,
    );
  } finally {
    ctx.kubeConfig.setCurrentContext(previousContext);
  }
}

export async function disconnectFromCluster(
  contextName: string,
  cluster: CnpgCluster,
): Promise<void> {
  const session = getSession();
  const key = clusterKey({
    contextName,
    namespace: cluster.namespace,
    clusterName: cluster.name,
  });
  await session.removeTunnel(key);

  if (session.connections.size === 0) {
    setStatusBar(null);
    await vscode.commands.executeCommand("setContext", "cnpg.activeConnection", false);
    await vscode.commands.executeCommand("setContext", "cnpg.connection.writeMode", false);
  }
  log.info("disconnect.ok", { cluster: key });
}

function setStatusBarForConn(conn: ActiveConnection): void {
  setStatusBar(
    `CNPG: ${conn.cluster.clusterName}/${conn.database} ⚙ ${conn.connection.mode === "write" ? "write" : "read-only"}`,
    {
      writeMode: conn.connection.mode === "write",
      tooltip: `Connected to ${conn.cluster.namespace}/${conn.cluster.clusterName} as ${conn.user}`,
    },
  );
}
