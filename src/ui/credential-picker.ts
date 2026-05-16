/**
 * Credential picker UI (US4; FR-021).
 *
 * Lists CNPG-issued Secrets for a cluster, pre-selects `<cluster>-app`, and
 * returns the user's choice. When the expected `username`/`password` keys
 * are missing from the chosen Secret, surface the raw key names so the user
 * sees what the operator actually provided (Edge Case — "CNPG secret format
 * changes across operator versions").
 *
 * NEVER persists the selection beyond the in-memory `session` map (FR-021).
 */

import * as vscode from "vscode";
import {
  CnpgCredential,
  decodeSecret,
  listClusterSecrets,
  selectDefaultSecret,
  summarizeSecret,
} from "../k8s/secrets.js";
import { KubeConfig } from "@kubernetes/client-node";

export async function pickCredential(
  kc: KubeConfig,
  namespace: string,
  clusterName: string,
): Promise<CnpgCredential | undefined> {
  const listed = await listClusterSecrets(kc, namespace, clusterName);
  if (listed.kind === "error") {
    vscode.window.showErrorMessage(
      `Failed to list secrets for ${clusterName}: ${listed.error.message}`,
    );
    return undefined;
  }
  if (listed.secrets.length === 0) {
    vscode.window.showWarningMessage(
      `No usable Secrets found for cluster ${clusterName}.`,
    );
    return undefined;
  }

  const defaultSecret = selectDefaultSecret(listed.secrets, clusterName);
  const items = listed.secrets.map((s) => {
    const summary = summarizeSecret(s, clusterName);
    return {
      label: summary.name,
      description: summary.kind,
      detail: describeSecretShape(s),
      picked: defaultSecret ? s === defaultSecret : false,
      secret: s,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `Select credential for ${namespace}/${clusterName}`,
    placeHolder: defaultSecret ? `Default: ${defaultSecret.metadata?.name}` : "Select a secret",
    canPickMany: false,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;

  const decoded = decodeSecret(picked.secret, clusterName);
  if (decoded.username.length === 0 || decoded.password.length === 0) {
    vscode.window.showWarningMessage(
      `Secret ${decoded.name} is missing the expected 'username' / 'password' keys.`,
    );
  }
  return decoded;
}

function describeSecretShape(s: { data?: Record<string, string> }): string {
  const keys = Object.keys(s.data ?? {}).sort();
  return `keys: ${keys.join(", ") || "(none)"}`;
}
