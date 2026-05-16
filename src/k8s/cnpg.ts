/**
 * CNPG-specific Kubernetes operations: operator-presence detection and
 * Cluster CR listing.
 *
 * Contracts: contracts/k8s-api.md § Discovery + § Cluster discovery.
 * Data shape: data-model.md § CNPG Cluster.
 */

import {
  ApiextensionsV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";
import { shapeK8sError, ShapedK8sError } from "./errors.js";

export const CNPG_GROUP = "postgresql.cnpg.io";
export const CNPG_VERSION = "v1";
export const CNPG_PLURAL = "clusters";
export const CNPG_CRD_NAME = "clusters.postgresql.cnpg.io";

export type OperatorPresence =
  | { kind: "present"; crdVersion: string }
  | { kind: "absent" }
  | { kind: "forbidden"; message: string }
  | { kind: "unknown"; error: ShapedK8sError };

export async function detectOperator(kc: KubeConfig): Promise<OperatorPresence> {
  const api = kc.makeApiClient(ApiextensionsV1Api);
  try {
    const res = await api.readCustomResourceDefinition(CNPG_CRD_NAME);
    const body = (res as { body?: { spec?: { versions?: Array<{ name?: string }> } } }).body;
    const version =
      body?.spec?.versions?.find((v) => v?.name === CNPG_VERSION)?.name ??
      body?.spec?.versions?.[0]?.name ??
      CNPG_VERSION;
    return { kind: "present", crdVersion: version };
  } catch (err) {
    const shaped = shapeK8sError(err);
    if (shaped.kind === "not-found") return { kind: "absent" };
    if (shaped.kind === "forbidden") return { kind: "forbidden", message: shaped.message };
    return { kind: "unknown", error: shaped };
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface CnpgClusterCR {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; uid?: string };
  spec?: {
    instances?: number;
    imageName?: string;
    storage?: { size?: string };
  };
  status?: {
    phase?: string;
    currentPrimary?: string;
    pgVersion?: string;
    conditions?: Array<{
      type?: string;
      status?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
  };
}

export interface CnpgCluster {
  name: string;
  namespace: string;
  uid: string;
  phase: string;
  instances: number;
  primary: string | null;
  pgMajorVersion: number | null;
  storageSize: string;
  lastCondition: {
    type: string;
    status: string;
    message: string;
    lastTransitionTime: string;
  } | null;
  readWriteService: string;
  caSecretName: string;
}

function parsePgMajor(spec: CnpgClusterCR["spec"], status: CnpgClusterCR["status"]): number | null {
  const versionString = status?.pgVersion;
  if (versionString) {
    const m = versionString.match(/^(\d+)/);
    if (m) return Number(m[1]);
  }
  const image = spec?.imageName;
  if (image) {
    const m = image.match(/:(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

function mapCluster(cr: CnpgClusterCR): CnpgCluster | null {
  const name = cr.metadata?.name;
  const namespace = cr.metadata?.namespace;
  if (!name || !namespace) return null;
  const conditions = cr.status?.conditions ?? [];
  // Most-recent condition by lastTransitionTime; falls back to last in array.
  const sorted = [...conditions].sort((a, b) => {
    const ta = Date.parse(a.lastTransitionTime ?? "");
    const tb = Date.parse(b.lastTransitionTime ?? "");
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return tb - ta;
  });
  const last = sorted[0];
  return {
    name,
    namespace,
    uid: cr.metadata?.uid ?? `${namespace}/${name}`,
    phase: cr.status?.phase ?? "Unknown",
    instances: cr.spec?.instances ?? 0,
    primary: cr.status?.currentPrimary ?? null,
    pgMajorVersion: parsePgMajor(cr.spec, cr.status),
    storageSize: cr.spec?.storage?.size ?? "",
    lastCondition: last
      ? {
          type: last.type ?? "",
          status: last.status ?? "",
          message: last.message ?? "",
          lastTransitionTime: last.lastTransitionTime ?? "",
        }
      : null,
    readWriteService: `${name}-rw`,
    caSecretName: `${name}-ca`,
  };
}

export type ListResult =
  | { kind: "ok"; clusters: CnpgCluster[] }
  | { kind: "error"; error: ShapedK8sError };

export async function listClustersClusterWide(kc: KubeConfig): Promise<ListResult> {
  const api = kc.makeApiClient(CustomObjectsApi);
  try {
    const res = (await api.listClusterCustomObject(
      CNPG_GROUP,
      CNPG_VERSION,
      CNPG_PLURAL,
    )) as { body?: { items?: CnpgClusterCR[] } };
    const items = res.body?.items ?? [];
    return {
      kind: "ok",
      clusters: items.map(mapCluster).filter((c): c is CnpgCluster => c !== null),
    };
  } catch (err) {
    return { kind: "error", error: shapeK8sError(err) };
  }
}

export async function listClustersNamespaced(kc: KubeConfig, namespace: string): Promise<ListResult> {
  const api = kc.makeApiClient(CustomObjectsApi);
  try {
    const res = (await api.listNamespacedCustomObject(
      CNPG_GROUP,
      CNPG_VERSION,
      namespace,
      CNPG_PLURAL,
    )) as { body?: { items?: CnpgClusterCR[] } };
    const items = res.body?.items ?? [];
    return {
      kind: "ok",
      clusters: items.map(mapCluster).filter((c): c is CnpgCluster => c !== null),
    };
  } catch (err) {
    return { kind: "error", error: shapeK8sError(err) };
  }
}

export async function getCluster(
  kc: KubeConfig,
  namespace: string,
  name: string,
): Promise<{ kind: "ok"; cluster: CnpgCluster } | { kind: "error"; error: ShapedK8sError } | { kind: "not-found" }> {
  const api = kc.makeApiClient(CustomObjectsApi);
  try {
    const res = (await api.getNamespacedCustomObject(
      CNPG_GROUP,
      CNPG_VERSION,
      namespace,
      CNPG_PLURAL,
      name,
    )) as { body?: CnpgClusterCR };
    if (!res.body) return { kind: "not-found" };
    const cluster = mapCluster(res.body);
    if (!cluster) return { kind: "not-found" };
    return { kind: "ok", cluster };
  } catch (err) {
    const shaped = shapeK8sError(err);
    if (shaped.kind === "not-found") return { kind: "not-found" };
    return { kind: "error", error: shaped };
  }
}

/** Exported for the cluster-detail derivation tests (T039). */
export function deriveClusterDetail(cr: CnpgClusterCR): CnpgCluster | null {
  return mapCluster(cr);
}
