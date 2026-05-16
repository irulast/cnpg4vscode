/**
 * cnpg4vscode entrypoint. Wires up:
 *  - LogOutputChannel + redaction (Constitution §IV).
 *  - Configuration validation (FR-020 runtime invariant).
 *  - The Clusters tree view (US1).
 *  - Stub Schema + Saved Scripts views (US4 / US5 fill them in).
 *  - The status bar.
 *  - The command registry.
 *  - A refresh timer that polls visible contexts on
 *    `cnpg4vscode.refreshIntervalSeconds` (US3 fully refines this).
 */

import * as vscode from "vscode";
import { initLog, disposeLog, log } from "./logging/channel.js";
import { resolveConfig } from "./state/config.js";
import { ClustersTreeProvider } from "./ui/tree-clusters.js";
import { SchemaTreeProvider } from "./ui/tree-schema.js";
import { initStatusBar } from "./ui/status-bar.js";
import { registerCommands } from "./commands/index.js";
import { RefreshTimer } from "./ui/refresh-timer.js";
import {
  ActiveConnection,
  ConnectionLifecycleListener,
  disposeSession,
  getSession,
} from "./state/session.js";
import { initHistory } from "./state/history.js";
import { CnpgNotebookSerializer, CNPG_NOTEBOOK_TYPE } from "./notebook/host-serializer.js";
import { CnpgNotebookController } from "./notebook/controller.js";
import { disposeGridRegistry, initGridRegistry } from "./grid/registry.js";

const CONFIG_SECTION = "cnpg4vscode";

export function activate(context: vscode.ExtensionContext): void {
  initLog();
  log.info("extension.activate", { version: context.extension.packageJSON.version });

  // Validate configuration at activation; force-correct any invariant violations.
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const { resolved, warnings } = resolveConfig({
    get: <T,>(section: string): T | undefined => cfg.get<T>(section),
  });
  for (const w of warnings) log.warn("config.invariant.forced", { reason: w });
  log.debug("config.resolved", {
    refreshIntervalSeconds: resolved.refreshIntervalSeconds,
    historyEnabled: resolved.historyEnabled,
  });

  const clustersProvider = new ClustersTreeProvider();
  context.subscriptions.push(clustersProvider);
  const clustersView = vscode.window.createTreeView("cnpg.clusters", {
    treeDataProvider: clustersProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(clustersView);

  const schemaProvider = new SchemaTreeProvider();
  context.subscriptions.push(schemaProvider);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("cnpg.schema", schemaProvider),
  );
  // Tree-schema visibility is tied to the activeConnection context key
  // (see package.json views.cnpg[1].when); flip it whenever connections
  // change so the view appears/disappears reactively.
  context.subscriptions.push(
    getSession().onChanged(() => {
      const hasConn = getSession().connections.size > 0;
      void vscode.commands.executeCommand("setContext", "cnpg.activeConnection", hasConn);
    }),
  );

  initStatusBar(context);
  initHistory(context);
  initGridRegistry({
    extensionUri: context.extensionUri,
    workspaceState: context.workspaceState,
  });
  registerCommands(context, { clustersProvider, schemaProvider });

  // Notebook serializer for cnpg-sql files (FR-035).
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      CNPG_NOTEBOOK_TYPE,
      new CnpgNotebookSerializer(),
      { transientOutputs: true, transientCellMetadata: { editable: true } },
    ),
  );

  // Controller registry: one CnpgNotebookController per active connection.
  // Lifecycle is driven by the session's add/remove events; mode toggles
  // re-label the controllers via the session-change listener below.
  const controllers = new Map<string, CnpgNotebookController>();
  const lifecycle: ConnectionLifecycleListener = {
    onConnectionAdded(conn: ActiveConnection) {
      const c = new CnpgNotebookController(conn);
      controllers.set(conn.id, c);
      context.subscriptions.push(c);
      log.info("controller.registered", { connection: conn.id });
    },
    onConnectionRemoved(id: string) {
      const c = controllers.get(id);
      if (!c) return;
      controllers.delete(id);
      c.dispose();
      log.info("controller.disposed", { connection: id });
    },
  };
  context.subscriptions.push(getSession().addLifecycleListener(lifecycle));
  // Resync labels on session-change (mode toggles fire emitChanged).
  context.subscriptions.push(
    getSession().onChanged(() => {
      for (const c of controllers.values()) c.syncLabel();
    }),
  );

  // Initial context-key state (contracts/commands.md § Context keys). These
  // flip to true once US4 lands and connections exist.
  vscode.commands.executeCommand("setContext", "cnpg.activeConnection", false);
  vscode.commands.executeCommand("setContext", "cnpg.connection.writeMode", false);

  // Visibility-aware refresh timer (US3 / FR-006). Stops when the view is
  // hidden OR the window loses focus; resumes when both come back.
  let timer = new RefreshTimer(
    {
      intervalMs: resolved.refreshIntervalSeconds * 1000,
      onTick: () => {
        log.trace("refresh.tick", {});
        clustersProvider.refresh();
      },
    },
    {
      visible: clustersView.visible,
      focused: vscode.window.state.focused,
    },
  );
  context.subscriptions.push(
    clustersView.onDidChangeVisibility((e) => timer.setVisible(e.visible)),
    vscode.window.onDidChangeWindowState((s) => timer.setFocused(s.focused)),
    { dispose: () => timer.dispose() },
  );

  // React to live setting changes (no extension reload required).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) return;
      log.info("config.changed", {});
      // Re-create the timer with the new interval.
      timer.dispose();
      const updated = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const ms = (updated.get<number>("refreshIntervalSeconds") ?? 30) * 1000;
      timer = new RefreshTimer(
        {
          intervalMs: ms,
          onTick: () => {
            log.trace("refresh.tick", {});
            clustersProvider.refresh();
          },
        },
        { visible: clustersView.visible, focused: vscode.window.state.focused },
      );
    }),
  );
}

export async function deactivate(): Promise<void> {
  log.info("extension.deactivate", {});
  disposeGridRegistry();
  await disposeSession();
  disposeLog();
}
