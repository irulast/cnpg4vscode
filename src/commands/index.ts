/**
 * Central command registry. Per-feature command modules wire themselves
 * in here so activation can register them all in one pass.
 *
 * In the notebook architecture (FR-035) the active surface is the
 * notebook editor, not a text editor with per-tab binding. The
 * status-bar item tracks the active notebook's selected controller via
 * `vscode.window.onDidChangeActiveNotebookEditor`. `cnpg.runFromSqlFile`
 * supports the legacy "run from a workspace .sql file" path by routing
 * through the most-recently-active notebook's controller (FR-036).
 */

import * as vscode from "vscode";
import { ClustersTreeProvider } from "../ui/tree-clusters.js";
import { SchemaTreeProvider, SchemaNode } from "../ui/tree-schema.js";
import { CnpgCluster } from "../k8s/cnpg.js";
import { showClusterDetail } from "../ui/cluster-detail.js";
import { setStatusBar } from "../ui/status-bar.js";
import { connectToCluster, disconnectFromCluster } from "./connect.js";
import { ActiveConnection, getSession } from "../state/session.js";
import { statementAtOffset, splitStatements } from "../sql/statement-split.js";
import {
  appendCellToActiveNotebook,
  openNewNotebookForConn,
} from "../notebook/append-cell.js";
import {
  normalizeNotebookName,
  resolveClusterFolder,
  validateNotebookName,
} from "../notebook/per-cluster.js";
import { CnpgNotebookSerializer } from "../notebook/host-serializer.js";
import {
  alterScaffold,
  browseRows,
  copyName,
  countRows,
  dropNode,
  insertTemplate,
  openDefinition,
  reindexNode,
  truncateRelation,
} from "./schema-actions.js";
import { CNPG_NOTEBOOK_TYPE } from "../notebook/host-serializer.js";
import { log, snapshotRecentLog } from "../logging/channel.js";

export interface CommandDeps {
  clustersProvider: ClustersTreeProvider;
  schemaProvider: SchemaTreeProvider;
}

interface ClusterArg {
  contextName: string;
  cluster: CnpgCluster;
}

function asClusterArg(arg: unknown): ClusterArg | null {
  if (!arg || typeof arg !== "object") return null;
  const a = arg as Partial<ClusterArg>;
  if (!a.contextName || !a.cluster) return null;
  return { contextName: a.contextName, cluster: a.cluster };
}

/** Resolve the connection currently surfaced by the active notebook editor, if any. */
function activeNotebookConnection(): ActiveConnection | undefined {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor) return undefined;
  const nb = editor.notebook;
  if (nb.notebookType !== CNPG_NOTEBOOK_TYPE) return undefined;
  const bound = (nb.metadata as { boundControllerId?: unknown } | undefined)?.boundControllerId;
  if (typeof bound !== "string") return undefined;
  return getSession().connections.get(bound);
}

/** Find any open cnpg-sql notebook, preferring the active one. */
function mostRecentNotebookConnection(): ActiveConnection | undefined {
  return (
    activeNotebookConnection() ??
    [...vscode.window.visibleNotebookEditors]
      .map((e) => e.notebook)
      .filter((nb) => nb.notebookType === CNPG_NOTEBOOK_TYPE)
      .map((nb) => {
        const id = (nb.metadata as { boundControllerId?: unknown } | undefined)?.boundControllerId;
        return typeof id === "string" ? getSession().connections.get(id) : undefined;
      })
      .find((c) => c !== undefined)
  );
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("cnpg.refresh", () => {
    log.info("cmd.refresh", {});
    deps.clustersProvider.refresh();
  });

  reg("cnpg.cluster.showDetails", async (arg: unknown) => {
    const parsed = asClusterArg(arg);
    if (!parsed) {
      vscode.window.showInformationMessage("Select a CNPG cluster in the tree first.");
      return;
    }
    log.info("cmd.cluster.showDetails", {
      context: parsed.contextName,
      cluster: `${parsed.cluster.namespace}/${parsed.cluster.name}`,
    });
    const kc = deps.clustersProvider.getKubeConfig();
    await showClusterDetail(parsed.contextName, parsed.cluster, {
      ...(kc ? { kubeConfig: kc } : {}),
    });
  });

  reg("cnpg.cluster.connect", async (arg: unknown) => {
    const parsed = asClusterArg(arg);
    if (!parsed) {
      vscode.window.showInformationMessage("Select a CNPG cluster in the tree first.");
      return;
    }
    const kc = deps.clustersProvider.getKubeConfig();
    if (!kc) {
      vscode.window.showErrorMessage("No kubeconfig loaded.");
      return;
    }
    await connectToCluster({
      kubeConfig: kc,
      contextName: parsed.contextName,
      cluster: parsed.cluster,
    });
  });

  reg("cnpg.cluster.disconnect", async (arg: unknown) => {
    const parsed = asClusterArg(arg);
    if (!parsed) {
      vscode.window.showInformationMessage("Select a CNPG cluster in the tree first.");
      return;
    }
    await disconnectFromCluster(parsed.contextName, parsed.cluster);
  });

  reg("cnpg.connection.toggleWriteMode", async () => {
    const session = getSession();
    const target =
      activeNotebookConnection() ??
      (session.connections.size === 1 ? [...session.connections.values()][0] : await pickConnection());
    if (!target) {
      vscode.window.showInformationMessage("No active connection.");
      return;
    }
    const newMode = target.connection.mode === "readonly" ? "write" : "readonly";
    if (newMode === "write") {
      const confirmed = await vscode.window.showWarningMessage(
        `Switch ${target.cluster.namespace}/${target.cluster.clusterName}/${target.database} to Write mode? Destructive operations will be permitted.`,
        { modal: true },
        "Switch to Write mode",
      );
      if (confirmed !== "Switch to Write mode") return;
    }
    target.connection.setMode(newMode);
    session.emitChanged();
    setStatusBar(
      `CNPG: ${target.cluster.clusterName}/${target.database} ⚙ ${newMode === "write" ? "write" : "read-only"}`,
      {
        writeMode: newMode === "write",
        tooltip: `${target.cluster.namespace}/${target.cluster.clusterName} (${newMode})`,
      },
    );
    await vscode.commands.executeCommand("setContext", "cnpg.connection.writeMode", newMode === "write");
    log.info("cmd.toggleWriteMode", { connection: target.id, mode: newMode });
  });

  reg("cnpg.connection.actions", async () => {
    const session = getSession();
    if (session.connections.size === 0) {
      vscode.window.showInformationMessage(
        "No active connection. Connect to a cluster first.",
      );
      return;
    }
    const target =
      activeNotebookConnection() ??
      (session.connections.size === 1 ? [...session.connections.values()][0] : await pickConnection());
    if (!target) return;

    type ActionId =
      | "toggleMode"
      | "openNotebook"
      | "saveToCluster"
      | "switch"
      | "disconnect";
    const items: Array<vscode.QuickPickItem & { id: ActionId }> = [
      {
        id: "toggleMode",
        label:
          target.connection.mode === "readonly"
            ? "$(unlock) Switch to Write mode"
            : "$(lock) Switch to Read-only mode",
        description: `${target.cluster.clusterName}/${target.database}`,
      },
      {
        id: "openNotebook",
        label: "$(notebook) Open new notebook with this controller",
        description: `${target.cluster.clusterName}/${target.database}`,
      },
    ];
    // Offer save-to-cluster only when the active editor IS a cnpg-sql notebook
    // bound to this connection (the command itself will refuse otherwise, but
    // hiding the menu item avoids the dead-action surprise).
    const activeNb = vscode.window.activeNotebookEditor;
    if (
      activeNb &&
      activeNb.notebook.notebookType === "cnpg-sql" &&
      activeNotebookConnection()?.id === target.id
    ) {
      items.push({
        id: "saveToCluster",
        label: "$(save) Save notebook to cluster...",
        description: "Writes to .cnpg/notebooks/<context>/<ns>/<cluster>/",
      });
    }
    if (session.connections.size > 1) {
      items.push({ id: "switch", label: "$(arrow-swap) Switch connection..." });
    }
    items.push({
      id: "disconnect",
      label: "$(debug-disconnect) Disconnect",
      description: `${target.cluster.clusterName}/${target.database}`,
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: `${target.cluster.namespace}/${target.cluster.clusterName} (${target.connection.mode})`,
      placeHolder: "Connection actions",
    });
    if (!picked) return;

    switch (picked.id) {
      case "toggleMode":
        await vscode.commands.executeCommand("cnpg.connection.toggleWriteMode");
        return;
      case "openNotebook":
        await openNewNotebookForConn(target);
        return;
      case "saveToCluster":
        await vscode.commands.executeCommand("cnpg.notebook.saveToCluster");
        return;
      case "switch": {
        const chosen = await pickConnection();
        if (chosen) await openNewNotebookForConn(chosen);
        return;
      }
      case "disconnect":
        await session.removeConnection(target.id);
        if (session.connections.size === 0) {
          setStatusBar(null);
          await vscode.commands.executeCommand("setContext", "cnpg.activeConnection", false);
          await vscode.commands.executeCommand("setContext", "cnpg.connection.writeMode", false);
        }
        return;
    }
  });

  reg("cnpg.notebook.new", async () => {
    const session = getSession();
    if (session.connections.size === 0) {
      vscode.window.showInformationMessage("Connect to a cluster first.");
      return;
    }
    const chosen =
      session.connections.size === 1 ? [...session.connections.values()][0] : await pickConnection();
    if (!chosen) return;
    await openNewNotebookForConn(chosen);
  });

  reg("cnpg.notebook.saveToCluster", async () => {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor || editor.notebook.notebookType !== "cnpg-sql") {
      vscode.window.showInformationMessage(
        "Open a CNPG SQL notebook first.",
      );
      return;
    }
    const conn = activeNotebookConnection();
    if (!conn) {
      vscode.window.showInformationMessage(
        "The active notebook has no bound CNPG connection. Pick a controller first.",
      );
      return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage(
        "Open a workspace folder to save notebooks per cluster.",
      );
      return;
    }
    const base =
      vscode.workspace.getConfiguration("cnpg4vscode").get<string>("notebooks.location") ??
      ".cnpg/notebooks";
    const folder = resolveClusterFolder({
      workspaceRoot: ws.uri.fsPath,
      base,
      contextName: conn.cluster.contextName,
      namespace: conn.cluster.namespace,
      clusterName: conn.cluster.clusterName,
    });
    if (!folder) {
      vscode.window.showErrorMessage(
        `Invalid 'cnpg4vscode.notebooks.location' setting: '${base}'. Must be a workspace-relative path that does not escape the workspace.`,
      );
      return;
    }
    const name = await vscode.window.showInputBox({
      title: `Save notebook to ${conn.cluster.namespace}/${conn.cluster.clusterName}`,
      prompt: "Notebook name (.cnpg-sql extension added if omitted)",
      placeHolder: "analysis",
      validateInput: (v) => validateNotebookName(v) ?? "",
    });
    if (!name) return;
    const target = vscode.Uri.file(`${folder}/${normalizeNotebookName(name)}`);
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(folder));
      const serialized = await new CnpgNotebookSerializer().serializeNotebook(
        {
          metadata: editor.notebook.metadata,
          cells: editor.notebook.getCells().map((c) => ({
            kind: c.kind,
            value: c.document.getText(),
            languageId: c.document.languageId,
            metadata: c.metadata,
          })) as never,
        } as never,
        new vscode.CancellationTokenSource().token,
      );
      await vscode.workspace.fs.writeFile(target, serialized);
      // Open the freshly-saved file so the user's subsequent edits land
      // there (and the untitled original can be closed).
      await vscode.commands.executeCommand("vscode.open", target);
      vscode.window.showInformationMessage(
        `Saved notebook to ${vscode.workspace.asRelativePath(target)}.`,
      );
      log.info("notebook.saveToCluster.ok", {
        connection: conn.id,
        target: target.fsPath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to save notebook: ${message}`);
      log.error("notebook.saveToCluster.failed", { reason: message });
    }
  });

  reg("cnpg.notebook.openSaved", async (arg: unknown) => {
    if (arg instanceof vscode.Uri) {
      await vscode.commands.executeCommand("vscode.open", arg);
    }
  });

  reg("cnpg.runFromSqlFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "sql") {
      vscode.window.showInformationMessage("Open a .sql file first.");
      return;
    }
    const buffer = editor.document.getText();
    const offset = editor.document.offsetAt(editor.selection.active);
    const stmt = editor.selection.isEmpty
      ? statementAtOffset(buffer, offset)?.text ?? splitStatements(buffer)[0]
      : editor.document.getText(editor.selection);
    if (!stmt) {
      vscode.window.showInformationMessage("No SQL under the cursor.");
      return;
    }
    let target = mostRecentNotebookConnection();
    if (!target) {
      const session = getSession();
      if (session.connections.size === 0) {
        vscode.window.showInformationMessage(
          "No active CNPG connection. Connect to a cluster first.",
        );
        return;
      }
      target =
        session.connections.size === 1 ? [...session.connections.values()][0] : await pickConnection();
      if (!target) return;
    }
    await appendCellToActiveNotebook({ conn: target, text: stmt, execute: true });
  });

  // Schema-tree action commands (US5).
  const asSchemaNode = (arg: unknown): SchemaNode | null => {
    if (!arg || typeof arg !== "object") return null;
    if (typeof (arg as { kind?: unknown }).kind !== "string") return null;
    return arg as SchemaNode;
  };
  const withNode = (cb: (n: SchemaNode) => Promise<void> | void) => async (arg: unknown) => {
    const node = asSchemaNode(arg);
    if (!node) {
      vscode.window.showInformationMessage("Right-click a schema-tree node.");
      return;
    }
    await cb(node);
  };
  reg("cnpg.tree.copyName", withNode(copyName));
  reg("cnpg.tree.openDefinition", withNode(openDefinition));
  reg(
    "cnpg.tree.browseRows",
    withNode((n) => browseRows(n, deps.schemaProvider)),
  );
  reg("cnpg.tree.countRows", withNode(countRows));
  reg("cnpg.tree.insertTemplate", withNode(insertTemplate));
  reg("cnpg.tree.alterScaffold", withNode(alterScaffold));
  reg(
    "cnpg.tree.drop",
    withNode(async (n) => {
      await dropNode(n);
      deps.schemaProvider.refresh();
    }),
  );
  reg(
    "cnpg.tree.truncate",
    withNode(async (n) => {
      await truncateRelation(n);
      deps.schemaProvider.refresh();
    }),
  );
  reg(
    "cnpg.tree.reindex",
    withNode(async (n) => {
      await reindexNode(n);
      deps.schemaProvider.refresh();
    }),
  );

  reg("cnpg.reportProblem", async () => {
    const lines = snapshotRecentLog();
    const header = [
      "# CNPG: Problem Report",
      "",
      "Copy this entire document into a GitHub issue or support thread.",
      "All credential-shaped tokens have been redacted before display.",
      "",
      "## Environment",
      "",
      `- VS Code: ${vscode.version}`,
      `- Extension: cnpg4vscode ${context.extension.packageJSON.version}`,
      `- Platform: ${process.platform} (${process.arch})`,
      `- Node: ${process.versions.node}`,
      `- Active connections: ${getSession().connections.size}`,
      `- Active tunnels: ${getSession().tunnels.size}`,
      "",
      `## Recent log (${lines.length} of last 200 lines, oldest first)`,
      "",
      "```",
    ];
    const body = lines.map((entry) => {
      const ts = new Date(entry.ts).toISOString();
      return `${ts} [${entry.level.padEnd(5, " ")}] ${entry.line}`;
    });
    const footer = ["```", ""];
    const content = [...header, ...body, ...footer].join("\n");
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    log.info("cmd.reportProblem", { lines: lines.length });
  });

  reg("cnpg.er.open", async (arg: unknown) => {
    const node = asSchemaNode(arg);
    if (!node) {
      vscode.window.showInformationMessage(
        "Right-click a database or schema in the Schema view to show its ER diagram.",
      );
      return;
    }
    let conn: ActiveConnection | undefined;
    let scope: import("../ui/er-diagram.js").ErScope | undefined;
    if (node.kind === "connection") {
      conn = node.conn;
      scope = { kind: "database" };
    } else if (node.kind === "schema") {
      conn = node.conn;
      scope = { kind: "schema", schema: node.schema };
    } else {
      vscode.window.showInformationMessage(
        "ER diagram is available on database or schema nodes.",
      );
      return;
    }
    const { showErDiagram } = await import("../ui/er-diagram.js");
    await showErDiagram(conn, scope);
  });

  reg("cnpg.history.open", async () => {
    const { showHistoryPicker } = await import("../state/history.js");
    await showHistoryPicker();
  });

  reg("cnpg.history.clear", async () => {
    const { clearHistory } = await import("../state/history.js");
    await clearHistory();
  });

  reg("cnpg.migration.open", async () => {
    const { openMigrationWizard } = await import("./migration.js");
    await openMigrationWizard();
  });

  reg("cnpg.migration.run", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "sql") {
      vscode.window.showInformationMessage(
        "Open a .sql document (or run 'CNPG: Open Migration Wizard') first.",
      );
      return;
    }
    const target = activeNotebookConnection() ?? mostRecentNotebookConnection();
    if (!target) {
      vscode.window.showInformationMessage(
        "No active CNPG connection. Connect to a cluster first.",
      );
      return;
    }
    const { runMigrationFromEditor } = await import("./migration.js");
    await runMigrationFromEditor(editor, target);
  });

  reg("cnpg.editor.index.create", async (arg: unknown) => {
    const node = asSchemaNode(arg);
    if (!node) {
      vscode.window.showInformationMessage(
        "Right-click a table in the Schema view to add an index.",
      );
      return;
    }
    const { openIndexEditor } = await import("./editors.js");
    await openIndexEditor(node);
  });

  // Placeholders for commands pending later user stories.
  const futureCommands: ReadonlyArray<string> = [
    "cnpg.editor.constraint.create",
  ];
  for (const id of futureCommands) {
    reg(id, () => {
      vscode.window.showInformationMessage(
        `${id} is not implemented yet (planned for a later release).`,
      );
    });
  }

  // Keep the status bar in sync with the active notebook editor's
  // selected controller. The Schema view visibility is managed by the
  // session-change listener in extension.ts (NEVER by editor focus).
  const updateStatusBarForActiveNotebook = () => {
    const conn = activeNotebookConnection();
    if (conn) {
      setStatusBar(
        `CNPG: ${conn.cluster.clusterName}/${conn.database} ⚙ ${conn.connection.mode === "write" ? "write" : "read-only"}`,
        { writeMode: conn.connection.mode === "write" },
      );
      void vscode.commands.executeCommand(
        "setContext",
        "cnpg.connection.writeMode",
        conn.connection.mode === "write",
      );
    } else if (getSession().connections.size > 0) {
      const any = [...getSession().connections.values()][0]!;
      setStatusBar(
        `CNPG: ${any.cluster.clusterName}/${any.database} (no active notebook)`,
        { writeMode: false, tooltip: "Click to open or pick a notebook." },
      );
      void vscode.commands.executeCommand("setContext", "cnpg.connection.writeMode", false);
    } else {
      setStatusBar(null);
      void vscode.commands.executeCommand("setContext", "cnpg.connection.writeMode", false);
    }
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor(() => updateStatusBarForActiveNotebook()),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBarForActiveNotebook()),
    getSession().onChanged(() => updateStatusBarForActiveNotebook()),
  );
}

async function pickConnection(): Promise<ActiveConnection | undefined> {
  const session = getSession();
  const conns = [...session.connections.values()];
  if (conns.length === 0) return undefined;
  if (conns.length === 1) return conns[0];
  const picked = await vscode.window.showQuickPick(
    conns.map((c) => ({
      label: `${c.cluster.clusterName}/${c.database}`,
      description: `${c.user} (${c.connection.mode})`,
      conn: c,
    })),
    { title: "Pick a connection", canPickMany: false, ignoreFocusOut: true },
  );
  return picked?.conn;
}
