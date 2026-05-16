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
import { CnpgCluster } from "../k8s/cnpg.js";
import { renderDetailMarkdown } from "./cluster-detail-render.js";

const previewedDocs = new Map<string, vscode.Uri>();

export async function showClusterDetail(
  contextName: string,
  cluster: CnpgCluster,
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

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: renderDetailMarkdown(contextName, cluster),
  });
  previewedDocs.set(key, doc.uri);
  await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
}
