/**
 * CNPG Secret discovery + credential picker helpers (US4; FR-021).
 *
 * Secrets are listed via the standard Kubernetes API and filtered to those
 * the CNPG operator owns or whose name follows the standard naming
 * convention (`<cluster>-app`, `<cluster>-superuser`, plus any
 * `<cluster>-*` the user can read).
 *
 * Decoded passwords NEVER leave memory (FR-012). The summarize/select
 * helpers are pure and unit-tested without a Kubernetes host.
 */

import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { shapeK8sError, ShapedK8sError } from "./errors.js";

export type SecretKind = "app" | "superuser" | "other";

interface SecretLike {
  metadata?: { name?: string; namespace?: string; ownerReferences?: Array<{ name?: string; kind?: string }> };
  data?: Record<string, string>;
}

export interface CnpgSecretSummary {
  name: string;
  namespace: string;
  kind: SecretKind;
}

export interface CnpgCredential {
  name: string;
  namespace: string;
  kind: SecretKind;
  username: string;
  password: string;
  database: string | null;
}

export function summarizeSecret(secret: SecretLike, clusterName: string): CnpgSecretSummary {
  const name = secret.metadata?.name ?? "";
  const namespace = secret.metadata?.namespace ?? "";
  return {
    name,
    namespace,
    kind: classifyKind(name, clusterName),
  };
}

function classifyKind(name: string, clusterName: string): SecretKind {
  if (name === `${clusterName}-app`) return "app";
  if (name === `${clusterName}-superuser`) return "superuser";
  return "other";
}

export function selectDefaultSecret<T extends SecretLike>(
  secrets: ReadonlyArray<T>,
  clusterName: string,
): T | undefined {
  return secrets.find((s) => s.metadata?.name === `${clusterName}-app`);
}

function decodeBase64(s: string | undefined): string {
  if (!s) return "";
  return Buffer.from(s, "base64").toString("utf8");
}

export function decodeSecret(secret: SecretLike, clusterName: string): CnpgCredential {
  const name = secret.metadata?.name ?? "";
  const namespace = secret.metadata?.namespace ?? "";
  const data = secret.data ?? {};
  const username = decodeBase64(data["username"]);
  const password = decodeBase64(data["password"]);
  const databaseRaw = decodeBase64(data["dbname"]);
  return {
    name,
    namespace,
    kind: classifyKind(name, clusterName),
    username,
    password,
    database: databaseRaw.length > 0 ? databaseRaw : null,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ListResponseBody {
  items?: SecretLike[];
}

export type ListSecretsResult =
  | { kind: "ok"; secrets: SecretLike[] }
  | { kind: "error"; error: ShapedK8sError };

/**
 * Lists Secrets in the namespace and filters to those owned by — or named
 * after — the given CNPG cluster. The owner-reference filter catches any
 * Secret CNPG attaches via ownerReferences; the name filter catches the
 * standard `<cluster>-app` / `<cluster>-superuser` convention.
 */
export async function listClusterSecrets(
  kc: KubeConfig,
  namespace: string,
  clusterName: string,
): Promise<ListSecretsResult> {
  const api = kc.makeApiClient(CoreV1Api);
  try {
    const res = (await api.listNamespacedSecret(namespace)) as { body?: ListResponseBody };
    const items = res.body?.items ?? [];
    const filtered = items.filter((s) => {
      const name = s.metadata?.name ?? "";
      if (!name.startsWith(clusterName)) return false;
      const owners = s.metadata?.ownerReferences ?? [];
      const ownedByCluster = owners.some(
        (o) => o.kind === "Cluster" && o.name === clusterName,
      );
      // Either an explicit owner reference or the standard naming convention.
      return ownedByCluster || name === `${clusterName}-app` || name === `${clusterName}-superuser` || /^cluster-/.test(name) === false;
    });
    return { kind: "ok", secrets: filtered };
  } catch (err) {
    return { kind: "error", error: shapeK8sError(err) };
  }
}

/**
 * Reads the cluster's CA bundle (`<cluster>-ca` Secret, key `ca.crt`).
 * Returns null on any failure rather than throwing — the caller decides
 * whether absence is fatal (it is, for TLS).
 */
export async function loadClusterCABundle(
  kc: KubeConfig,
  namespace: string,
  clusterName: string,
): Promise<string | null> {
  const api = kc.makeApiClient(CoreV1Api);
  try {
    const res = (await api.readNamespacedSecret(`${clusterName}-ca`, namespace)) as {
      body?: SecretLike;
    };
    const ca = res.body?.data?.["ca.crt"];
    return ca ? decodeBase64(ca) : null;
  } catch {
    return null;
  }
}
