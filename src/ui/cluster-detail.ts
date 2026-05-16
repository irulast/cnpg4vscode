/**
 * Read-only cluster detail surface (US2; FR-008, FR-009).
 *
 * Renders a Markdown preview document describing the five required spec
 * fields plus the most-recent operator condition. The surface itself is
 * strictly read-only — no edit affordances, no write buttons.
 *
 * The pure render function lives in cluster-detail-render.ts so unit tests
 * can exercise it without a VS Code host.
 */

import * as vscode from "vscode";
import { KubeConfig } from "@kubernetes/client-node";
import { CnpgCluster, listClusterPods, PodSummary } from "../k8s/cnpg.js";
import { renderDetailMarkdown } from "./cluster-detail-render.js";
import { log } from "../logging/channel.js";

const previewedDocs = new Map<string, vscode.Uri>();

export interface ShowClusterDetailOptions {
  /** Optional kubeconfig for live per-pod enrichment. When omitted the surface omits the Pods section. */
  kubeConfig?: KubeConfig;
}

export async function showClusterDetail(
  contextName: string,
  cluster: CnpgCluster,
  opts: ShowClusterDetailOptions = {},
): Promise<void> {
  const key = `${contextName}/${cluster.namespace}/${cluster.name}`;
  // Re-use a previously opened preview when the same cluster is selected
  // again so we don't accumulate untitled buffers.
  const existing = previewedDocs.get(key);
  if (existing) {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === existing.toString(),
    );
    if (doc) {
      await vscode.commands.executeCommand("markdown.showPreview", existing);
      return;
    }
    previewedDocs.delete(key);
  }

  let pods: PodSummary[] | undefined;
  let podsError: string | undefined;
  if (opts.kubeConfig) {
    // Switch the current context so the generated CoreV1Api targets the
    // right cluster. Restored in finally to avoid leaking the change
    // back into other tree-view queries.
    const kc = opts.kubeConfig;
    const previous = kc.getCurrentContext();
    kc.setCurrentContext(contextName);
    try {
      const res = await listClusterPods(kc, cluster.namespace, cluster.name);
      if (res.kind === "ok") {
        pods = res.pods;
      } else {
        podsError = res.error.message;
        log.warn("cluster.detail.pods.failed", {
          context: contextName,
          cluster: `${cluster.namespace}/${cluster.name}`,
          kind: res.error.kind,
        });
      }
    } finally {
      kc.setCurrentContext(previous);
    }
  }

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: renderDetailMarkdown(contextName, cluster, {
      ...(pods !== undefined ? { pods } : {}),
      ...(podsError !== undefined ? { podsError } : {}),
    }),
  });
  previewedDocs.set(key, doc.uri);
  await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
}
