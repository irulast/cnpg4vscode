/**
 * ClustersTreeProvider (US1).
 *
 * Renders kubeconfig context → namespace → CNPG Cluster. Each branch loads
 * lazily: contexts are fetched once on activation (refreshable on demand);
 * operator presence is probed per context on first expand; clusters are
 * listed once the operator is confirmed present.
 *
 * Errors surface verbatim on the affected node and never break sibling
 * contexts (FR-007).
 */

import * as vscode from "vscode";
import { KubeConfig } from "@kubernetes/client-node";
import {
  KubeconfigContextInfo,
  loadContexts,
  watchKubeconfig,
} from "../k8s/kubeconfig.js";
import {
  CnpgCluster,
  detectOperator,
  listClustersClusterWide,
  listClustersNamespaced,
  OperatorPresence,
} from "../k8s/cnpg.js";
import { ShapedK8sError } from "../k8s/errors.js";
import { log } from "../logging/channel.js";
import { resolveClusterFolder } from "../notebook/per-cluster.js";

type Node = ContextNode | NamespaceNode | ClusterNode | NotebookNode | InfoNode;

interface NotebookNode {
  kind: "notebook";
  contextName: string;
  cluster: CnpgCluster;
  uri: vscode.Uri;
}

interface ContextNode {
  kind: "context";
  context: KubeconfigContextInfo;
}

interface NamespaceNode {
  kind: "namespace";
  contextName: string;
  namespace: string;
  clusters: CnpgCluster[];
}

interface ClusterNode {
  kind: "cluster";
  contextName: string;
  cluster: CnpgCluster;
}

/**
 * A leaf used for "no kubeconfig", "CNPG not installed", and verbatim
 * upstream errors. Carries an optional code so the test suite can assert
 * on the exact state rendered.
 */
interface InfoNode {
  kind: "info";
  parent: string; // contextName or sentinel
  label: string;
  description?: string;
  iconId: string;
  code: "no-kubeconfig" | "cnpg-absent" | "cnpg-forbidden" | "unreachable" | "unauthenticated" | "other-error" | "empty";
}

export class ClustersTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._emitter.event;

  private kubeConfig: KubeConfig | null = null;
  private contexts: KubeconfigContextInfo[] = [];
  private resolvedPaths: string[] = [];
  private kubeconfigError: string | null = null;
  private disposeWatch: (() => void) | null = null;
  private notebooksWatcher: vscode.FileSystemWatcher | null = null;

  /** Per-context lazy-loaded state. */
  private operatorByContext = new Map<string, OperatorPresence>();
  private listingByContext = new Map<
    string,
    { kind: "ok"; namespaces: Map<string, CnpgCluster[]> } | { kind: "error"; error: ShapedK8sError }
  >();
  /** Cached notebook URIs per cluster folder. Invalidated on FS event. */
  private notebooksByFolder = new Map<string, vscode.Uri[]>();

  constructor() {
    this.reload();
    this.setupNotebookWatcher();
  }

  dispose(): void {
    this._emitter.dispose();
    this.disposeWatch?.();
    this.notebooksWatcher?.dispose();
  }

  private setupNotebookWatcher(): void {
    // Watch any *.cnpg-sql file anywhere in the workspace. The watcher only
    // fires when a file is created/deleted/renamed under a folder we list
    // (VS Code optimises). On any event we invalidate the matching cluster
    // folder cache and emit a tree-change event; the affected cluster node
    // re-queries the folder on next expansion.
    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders || wsFolders.length === 0) return;
    const pattern = new vscode.RelativePattern(wsFolders[0]!, "**/*.cnpg-sql");
    this.notebooksWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const invalidate = () => {
      this.notebooksByFolder.clear();
      this._emitter.fire();
    };
    this.notebooksWatcher.onDidCreate(invalidate);
    this.notebooksWatcher.onDidDelete(invalidate);
    this.notebooksWatcher.onDidChange(invalidate);
  }

  /** Exposes the currently-loaded KubeConfig so commands can target it. */
  getKubeConfig(): KubeConfig | null {
    return this.kubeConfig;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "context": {
        const item = new vscode.TreeItem(
          node.context.name,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = "context";
        item.description = node.context.server;
        item.iconPath = new vscode.ThemeIcon("server");
        item.tooltip = `Auth: ${node.context.authMode}`;
        return item;
      }
      case "namespace": {
        const item = new vscode.TreeItem(
          node.namespace,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = "namespace";
        item.iconPath = new vscode.ThemeIcon("symbol-namespace");
        return item;
      }
      case "cluster": {
        // Cluster rows are collapsible only when at least one saved notebook
        // exists under the per-cluster folder (FR-037). Collapsibility is
        // computed from the cached folder listing; no FS hit during render.
        const notebookCount = this.cachedNotebookCountFor(node);
        const item = new vscode.TreeItem(
          node.cluster.name,
          notebookCount > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.contextValue = "cluster";
        item.description =
          notebookCount > 0
            ? `${node.cluster.phase} · ${notebookCount} notebook${notebookCount === 1 ? "" : "s"}`
            : node.cluster.phase;
        item.iconPath = iconForPhase(node.cluster.phase);
        item.tooltip = clusterTooltip(node.cluster);
        // Default click → connect (idempotent: if a connection already exists
        // for this cluster, the command opens a new console bound to it
        // rather than re-running the full open-tunnel flow).
        item.command = {
          command: "cnpg.cluster.connect",
          title: "Connect",
          arguments: [
            {
              contextName: node.contextName,
              cluster: node.cluster,
            },
          ],
        };
        return item;
      }
      case "notebook": {
        const item = new vscode.TreeItem(
          basename(node.uri),
          vscode.TreeItemCollapsibleState.None,
        );
        item.contextValue = "notebook";
        item.resourceUri = node.uri;
        item.iconPath = new vscode.ThemeIcon("notebook");
        item.tooltip = node.uri.fsPath;
        item.command = {
          command: "vscode.open",
          title: "Open Notebook",
          arguments: [node.uri],
        };
        return item;
      }
      case "info": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = `info:${node.code}`;
        if (node.description) item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.iconId);
        item.tooltip = node.description ?? node.label;
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.rootChildren();
    switch (node.kind) {
      case "context":
        return this.contextChildren(node.context);
      case "namespace": {
        const clusters = node.clusters.slice().sort((a, b) => a.name.localeCompare(b.name));
        // Pre-warm the notebook-folder cache for each cluster so the count
        // appears in the cluster description on the first render.
        void Promise.all(
          clusters.map((c) =>
            this.notebooksFor({
              kind: "cluster",
              contextName: node.contextName,
              cluster: c,
            }),
          ),
        ).then((results) => {
          // Only fire a refresh if we actually discovered notebooks (cache
          // entries are now populated; the cluster description recomputes
          // on the next getTreeItem call).
          if (results.some((arr) => arr.length > 0)) this._emitter.fire();
        });
        return clusters.map((c) => ({
          kind: "cluster" as const,
          contextName: node.contextName,
          cluster: c,
        }));
      }
      case "cluster": {
        const notebooks = await this.notebooksFor(node);
        return notebooks.map((uri) => ({
          kind: "notebook" as const,
          contextName: node.contextName,
          cluster: node.cluster,
          uri,
        }));
      }
      case "notebook":
      case "info":
        return [];
    }
  }

  private cachedNotebookCountFor(node: ClusterNode): number {
    const folder = this.folderFor(node);
    if (!folder) return 0;
    return this.notebooksByFolder.get(folder)?.length ?? 0;
  }

  private folderFor(node: ClusterNode): string | null {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return null;
    const base =
      vscode.workspace.getConfiguration("cnpg4vscode").get<string>("notebooks.location") ??
      ".cnpg/notebooks";
    return resolveClusterFolder({
      workspaceRoot: ws.uri.fsPath,
      base,
      contextName: node.contextName,
      namespace: node.cluster.namespace,
      clusterName: node.cluster.name,
    });
  }

  /** Lazily list `.cnpg-sql` files in the cluster's folder; cache the result. */
  private async notebooksFor(node: ClusterNode): Promise<vscode.Uri[]> {
    const folder = this.folderFor(node);
    if (!folder) return [];
    const cached = this.notebooksByFolder.get(folder);
    if (cached) return cached;
    const folderUri = vscode.Uri.file(folder);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folderUri);
    } catch {
      this.notebooksByFolder.set(folder, []);
      return [];
    }
    const notebooks = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".cnpg-sql"))
      .map(([name]) => vscode.Uri.joinPath(folderUri, name))
      .sort((a, b) => a.path.localeCompare(b.path));
    this.notebooksByFolder.set(folder, notebooks);
    return notebooks;
  }

  /** Public so the save-to-cluster command can pre-warm the cache after writing a new file. */
  invalidateNotebookCache(): void {
    this.notebooksByFolder.clear();
    this._emitter.fire();
  }

  /**
   * Full refresh — clears every cache (operator presence + cluster
   * listing) and re-loads kubeconfig. Used by the explicit
   * `cnpg.refresh` command and the kubeconfig file watcher (the user
   * might have just installed the operator or switched accounts, so
   * everything is suspect).
   */
  refresh(): void {
    this.operatorByContext.clear();
    this.listingByContext.clear();
    this.reload();
    this._emitter.fire();
  }

  /**
   * Soft refresh — only invalidate the cluster listing. Operator
   * presence rarely changes (install / uninstall is a deliberate
   * operator action), so re-probing it on every 30s tick is wasted
   * kube API load. Used by the auto-refresh timer.
   */
  refreshClustersOnly(): void {
    this.listingByContext.clear();
    this._emitter.fire();
  }

  private reload(): void {
    try {
      const result = loadContexts();
      this.kubeConfig = result.kubeConfig;
      this.contexts = result.contexts;
      this.resolvedPaths = result.resolvedPaths;
      this.kubeconfigError = null;
      this.disposeWatch?.();
      this.disposeWatch = watchKubeconfig(this.resolvedPaths, () => {
        log.info("kubeconfig.changed", { paths: this.resolvedPaths.join(",") });
        this.refresh();
      });
      log.info("kubeconfig.loaded", {
        contexts: this.contexts.length,
        paths: this.resolvedPaths.join(","),
      });
    } catch (err) {
      this.kubeConfig = null;
      this.contexts = [];
      this.kubeconfigError = err instanceof Error ? err.message : String(err);
      log.warn("kubeconfig.load.failed", { reason: this.kubeconfigError });
    }
  }

  private rootChildren(): Node[] {
    if (this.kubeconfigError !== null || this.contexts.length === 0) {
      return [
        {
          kind: "info",
          parent: "<root>",
          label: "No kubeconfig found",
          description:
            this.kubeconfigError ??
            "Set $KUBECONFIG or create ~/.kube/config to discover clusters.",
          iconId: "warning",
          code: "no-kubeconfig",
        },
      ];
    }
    return this.contexts.map((c) => ({ kind: "context", context: c }));
  }

  private async contextChildren(ctx: KubeconfigContextInfo): Promise<Node[]> {
    const kc = this.kubeConfig;
    if (!kc) return [];
    // Switch the underlying KubeConfig's current context per query so the
    // generated API clients hit the right cluster. Reverted after each call.
    const previous = kc.getCurrentContext();
    kc.setCurrentContext(ctx.name);
    try {
      let presence = this.operatorByContext.get(ctx.name);
      if (!presence) {
        // Cache miss → actually hit the kube API. Log the result.
        // Cache hits stay silent (the result hasn't changed and we
        // shouldn't spam the output channel on every refresh tick).
        presence = await detectOperator(kc);
        this.operatorByContext.set(ctx.name, presence);
        log.info("cnpg.operator.probed", { context: ctx.name, kind: presence.kind });
      }

      if (presence.kind === "absent") {
        return [
          {
            kind: "info",
            parent: ctx.name,
            label: "CNPG not installed",
            description: "Install the cloudnative-pg operator to manage clusters here.",
            iconId: "info",
            code: "cnpg-absent",
          },
        ];
      }
      if (presence.kind === "forbidden") {
        return [
          {
            kind: "info",
            parent: ctx.name,
            label: "Forbidden",
            description: presence.message,
            iconId: "lock",
            code: "cnpg-forbidden",
          },
        ];
      }
      if (presence.kind === "unknown") {
        return [
          {
            kind: "info",
            parent: ctx.name,
            label: errorLabel(presence.error),
            description: presence.error.message,
            iconId: errorIcon(presence.error),
            code: errorCode(presence.error),
          },
        ];
      }

      let listing = this.listingByContext.get(ctx.name);
      let listingWasFresh = false;
      if (!listing) {
        listingWasFresh = true;
        const res = await listClustersClusterWide(kc);
        if (res.kind === "ok") {
          listing = { kind: "ok", namespaces: groupByNamespace(res.clusters) };
        } else if (res.error.kind === "forbidden" && ctx.namespace) {
          const nsRes = await listClustersNamespaced(kc, ctx.namespace);
          listing =
            nsRes.kind === "ok"
              ? { kind: "ok", namespaces: groupByNamespace(nsRes.clusters) }
              : { kind: "error", error: nsRes.error };
        } else {
          listing = { kind: "error", error: res.error };
        }
        this.listingByContext.set(ctx.name, listing);
      }

      if (listing.kind === "error") {
        // Always log listing failures — they're actionable.
        log.warn("cnpg.list.failed", { context: ctx.name, kind: listing.error.kind });
        return [
          {
            kind: "info",
            parent: ctx.name,
            label: errorLabel(listing.error),
            description: listing.error.message,
            iconId: errorIcon(listing.error),
            code: errorCode(listing.error),
          },
        ];
      }

      // Only log successful list results when an actual API call ran
      // (cache miss). Cache hits stay silent so the auto-refresh
      // doesn't spam the output channel.
      if (listingWasFresh) {
        log.info("cnpg.list.ok", {
          context: ctx.name,
          namespaces: listing.namespaces.size,
          clusters: [...listing.namespaces.values()].reduce((n, l) => n + l.length, 0),
        });
      }

      if (listing.namespaces.size === 0) {
        return [
          {
            kind: "info",
            parent: ctx.name,
            label: "No CNPG clusters",
            iconId: "circle-slash",
            code: "empty",
          },
        ];
      }

      const out: Node[] = [];
      for (const [namespace, clusters] of [...listing.namespaces.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        out.push({ kind: "namespace", contextName: ctx.name, namespace, clusters });
      }
      return out;
    } finally {
      kc.setCurrentContext(previous);
    }
  }
}

function groupByNamespace(clusters: CnpgCluster[]): Map<string, CnpgCluster[]> {
  const m = new Map<string, CnpgCluster[]>();
  for (const c of clusters) {
    const arr = m.get(c.namespace);
    if (arr) arr.push(c);
    else m.set(c.namespace, [c]);
  }
  return m;
}

function iconForPhase(phase: string): vscode.ThemeIcon {
  if (/healthy/i.test(phase)) {
    return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  }
  if (/setting up|creating|recover/i.test(phase)) {
    return new vscode.ThemeIcon("sync", new vscode.ThemeColor("testing.iconQueued"));
  }
  if (/fail|error/i.test(phase)) {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
  }
  return new vscode.ThemeIcon("circle-large-outline");
}

function clusterTooltip(c: CnpgCluster): string {
  const lines = [
    `**${c.namespace}/${c.name}**`,
    `Phase: ${c.phase}`,
    `Instances: ${c.instances}`,
  ];
  if (c.primary) lines.push(`Primary: ${c.primary}`);
  if (c.pgMajorVersion !== null) lines.push(`PostgreSQL: ${c.pgMajorVersion}`);
  if (c.storageSize) lines.push(`Storage: ${c.storageSize}`);
  if (c.lastCondition) lines.push(`Last condition: ${c.lastCondition.message}`);
  return lines.join("\n");
}

function errorLabel(err: ShapedK8sError): string {
  switch (err.kind) {
    case "forbidden":
      return "Forbidden";
    case "unauthenticated":
      return "Authentication failed";
    case "unreachable":
      return "Cannot reach cluster";
    case "proxy-strips-upgrade":
      return "Tunnel unsupported by proxy";
    case "not-found":
      return "Not found";
    case "other":
      return "Error";
  }
}

function errorIcon(err: ShapedK8sError): string {
  switch (err.kind) {
    case "forbidden":
      return "lock";
    case "unauthenticated":
      return "key";
    case "unreachable":
      return "debug-disconnect";
    case "proxy-strips-upgrade":
      return "shield";
    case "not-found":
      return "circle-slash";
    case "other":
      return "warning";
  }
}

function errorCode(err: ShapedK8sError): InfoNode["code"] {
  switch (err.kind) {
    case "forbidden":
      return "cnpg-forbidden";
    case "unauthenticated":
      return "unauthenticated";
    case "unreachable":
      return "unreachable";
    case "proxy-strips-upgrade":
      return "unreachable";
    case "not-found":
      return "cnpg-absent";
    case "other":
      return "other-error";
  }
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] ?? uri.path;
}
