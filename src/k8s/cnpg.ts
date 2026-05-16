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

/* -------------------------------------------------------------------------
 * Per-pod status enrichment (cluster-detail polish).
 *
 * Loading the Pod list for a cluster lets the detail surface show real
 * per-instance state — which pod is primary, which are running, restart
 * counts, age — beyond what the operator publishes on the Cluster CR's
 * .status. Useful for live diagnostics ("the primary just restarted").
 * ----------------------------------------------------------------------- */

export interface PodSummary {
  name: string;
  phase: string;
  role: "primary" | "replica";
  ready: boolean;
  containersReady: string; // e.g. "2/2"
  restartCount: number;
  age: string; // human-readable relative age
  terminating: boolean;
}

interface PodLike {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
  };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      restartCount?: number;
    }>;
  };
}

export function derivePodSummary(raw: unknown): PodSummary {
  const p = (raw ?? {}) as PodLike;
  const name = p.metadata?.name ?? "(unnamed)";
  const phase = p.status?.phase ?? "Unknown";
  const labels = p.metadata?.labels ?? {};
  const roleLabel = labels["cnpg.io/instanceRole"];
  const role: PodSummary["role"] = roleLabel === "primary" ? "primary" : "replica";
  const statuses = p.status?.containerStatuses ?? [];
  const total = statuses.length;
  const readyCount = statuses.filter((s) => s.ready === true).length;
  const restartCount = statuses.reduce((acc, s) => acc + (s.restartCount ?? 0), 0);
  const ready = total > 0 && readyCount === total;
  const age = relativeAge(p.metadata?.creationTimestamp);
  return {
    name,
    phase,
    role,
    ready,
    containersReady: `${readyCount}/${total}`,
    restartCount,
    age,
    terminating: typeof p.metadata?.deletionTimestamp === "string",
  };
}

function relativeAge(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

export type PodListResult =
  | { kind: "ok"; pods: PodSummary[] }
  | { kind: "error"; error: import("./errors.js").ShapedK8sError };

export async function listClusterPods(
  kc: import("@kubernetes/client-node").KubeConfig,
  namespace: string,
  clusterName: string,
): Promise<PodListResult> {
  const { CoreV1Api } = await import("@kubernetes/client-node");
  const { shapeK8sError } = await import("./errors.js");
  const api = kc.makeApiClient(CoreV1Api);
  try {
    const res = (await api.listNamespacedPod(
      namespace,
      undefined, // pretty
      undefined, // allowWatchBookmarks
      undefined, // continue
      undefined, // fieldSelector
      `cnpg.io/cluster=${clusterName}`,
    )) as { body?: { items?: unknown[] } };
    const items = res.body?.items ?? [];
    const pods = items
      .map(derivePodSummary)
      .sort((a, b) => {
        // primary first, then by name
        if (a.role !== b.role) return a.role === "primary" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { kind: "ok", pods };
  } catch (err) {
    return { kind: "error", error: shapeK8sError(err) };
  }
}
