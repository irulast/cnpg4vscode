/**
 * Resolve the primary Pod backing a CNPG cluster's read/write service so
 * we can target the port-forward at it (contracts/k8s-api.md §
 * Port-forward).
 */

import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { shapeK8sError, ShapedK8sError } from "./errors.js";

export type PrimaryPodResult =
  | { kind: "ok"; podName: string }
  | { kind: "error"; error: ShapedK8sError };

/* eslint-disable @typescript-eslint/no-explicit-any */
interface EndpointsBody {
  subsets?: Array<{
    addresses?: Array<{ targetRef?: { name?: string } }>;
    ports?: Array<{ port?: number }>;
  }>;
}

export async function resolvePrimaryPod(
  kc: KubeConfig,
  namespace: string,
  serviceName: string,
): Promise<PrimaryPodResult> {
  const api = kc.makeApiClient(CoreV1Api);
  try {
    const res = (await api.readNamespacedEndpoints(serviceName, namespace)) as {
      body?: EndpointsBody;
    };
    for (const subset of res.body?.subsets ?? []) {
      for (const addr of subset.addresses ?? []) {
        const ref = addr.targetRef?.name;
        if (ref) return { kind: "ok", podName: ref };
      }
    }
    return { kind: "error", error: { kind: "not-found", message: `No ready endpoints for ${serviceName}`, raw: res.body } };
  } catch (err) {
    return { kind: "error", error: shapeK8sError(err) };
  }
}
