/**
 * Pure markdown renderer for the cluster detail surface (US2).
 *
 * Kept separate from cluster-detail.ts so the unit tests can import it
 * without pulling in the `vscode` runtime module.
 */

import { CnpgCluster } from "../k8s/cnpg.js";

export function renderDetailMarkdown(contextName: string, c: CnpgCluster): string {
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
  lines.push(
    "",
    "---",
    "",
    "_This view is read-only. Mutating Kubernetes operations are out of scope " +
      "for this feature (see spec.md § Assumptions)._",
  );
  return lines.join("\n");
}
