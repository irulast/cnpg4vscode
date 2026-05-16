/**
 * Pure markdown renderer for the cluster detail surface (US2).
 *
 * Kept separate from cluster-detail.ts so the unit tests can import it
 * without pulling in the `vscode` runtime module.
 */

import { CnpgCluster, PodSummary } from "../k8s/cnpg.js";

export interface RenderDetailOptions {
  pods?: PodSummary[];
  podsError?: string;
}

export function renderDetailMarkdown(
  contextName: string,
  c: CnpgCluster,
  opts: RenderDetailOptions = {},
): string {
  // Each identifier appears in inline code so the user can double-click to
  // copy it without selecting punctuation; mirrors FR-010 for the detail surface.
  const lines = [
    `# ${c.namespace}/${c.name}`,
    "",
    `**Context**: \`${contextName}\``,
    `**Namespace**: \`${c.namespace}\``,
    `**Cluster**: \`${c.name}\``,
    "",
    `**Phase**: ${c.phase}`,
    `**Instances**: ${c.instances}`,
  ];
  if (c.primary) lines.push(`**Primary**: \`${c.primary}\``);
  if (c.pgMajorVersion !== null) lines.push(`**PostgreSQL**: ${c.pgMajorVersion}`);
  if (c.storageSize) lines.push(`**Storage**: ${c.storageSize}`);
  lines.push("", `**Read-write service**: \`${c.readWriteService}\``);
  lines.push(`**CA secret**: \`${c.caSecretName}\``);
  if (c.lastCondition) {
    lines.push(
      "",
      "## Last condition",
      "",
      `- **type**: ${c.lastCondition.type}`,
      `- **status**: ${c.lastCondition.status}`,
      `- **message**: ${c.lastCondition.message}`,
      `- **at**: ${c.lastCondition.lastTransitionTime}`,
    );
  }
  if (opts.pods && opts.pods.length > 0) {
    lines.push("", "## Pods", "");
    lines.push("| Role | Name | Phase | Ready | Restarts | Age |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const p of opts.pods) {
      const role = p.role === "primary" ? "🟢 primary" : "replica";
      const nameCell = p.terminating ? `${p.name} _(terminating)_` : p.name;
      const ready = p.ready ? `${p.containersReady} ✓` : p.containersReady;
      lines.push(
        `| ${role} | \`${nameCell}\` | ${p.phase} | ${ready} | ${p.restartCount} | ${p.age} |`,
      );
    }
  } else if (opts.pods && opts.pods.length === 0) {
    lines.push("", "## Pods", "", "_No pods found for this cluster._");
  } else if (opts.podsError) {
    lines.push("", "## Pods", "", `_Could not list pods: ${opts.podsError}_`);
  }
  lines.push(
    "",
    "---",
    "",
    "_This view is read-only. Mutating Kubernetes operations are out of scope " +
      "for this feature (see spec.md § Assumptions)._",
  );
  return lines.join("\n");
}
