import { describe, expect, it } from "vitest";
import { listClustersClusterWide, listClustersNamespaced } from "../../../src/k8s/cnpg.js";

function makeKc(opts: {
  listCluster?: () => Promise<unknown> | never;
  listNamespaced?: () => Promise<unknown> | never;
}): unknown {
  return {
    makeApiClient: () => ({
      listClusterCustomObject:
        opts.listCluster ?? (() => Promise.resolve({ body: { items: [] } })),
      listNamespacedCustomObject:
        opts.listNamespaced ?? (() => Promise.resolve({ body: { items: [] } })),
    }),
  };
}

const oneCluster = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  metadata: { name: "app-db", namespace: "default", uid: "abc-123" },
  spec: { instances: 3, storage: { size: "10Gi" }, imageName: "ghcr.io/cloudnative-pg/postgresql:16.2" },
  status: {
    phase: "Cluster in healthy state",
    currentPrimary: "app-db-1",
    pgVersion: "16",
    conditions: [
      { type: "Ready", status: "True", message: "ok", lastTransitionTime: "2026-05-15T00:00:00Z" },
    ],
  },
};

describe("listClustersClusterWide()", () => {
  it("maps CR fields to the CnpgCluster shape", async () => {
    const kc = makeKc({
      listCluster: () => Promise.resolve({ body: { items: [oneCluster] } }),
    });
    const res = await listClustersClusterWide(kc as never);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const [c] = res.clusters;
    expect(c?.name).toBe("app-db");
    expect(c?.namespace).toBe("default");
    expect(c?.instances).toBe(3);
    expect(c?.primary).toBe("app-db-1");
    expect(c?.pgMajorVersion).toBe(16);
    expect(c?.storageSize).toBe("10Gi");
    expect(c?.readWriteService).toBe("app-db-rw");
    expect(c?.caSecretName).toBe("app-db-ca");
    expect(c?.lastCondition?.type).toBe("Ready");
  });

  it("returns a 'forbidden' shape on 403", async () => {
    const kc = makeKc({
      listCluster: () =>
        Promise.reject({ statusCode: 403, body: { message: "forbidden" } }),
    });
    const res = await listClustersClusterWide(kc as never);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error.kind).toBe("forbidden");
  });

  it("returns a 'unreachable' shape on network errors", async () => {
    const kc = makeKc({
      listCluster: () =>
        Promise.reject(Object.assign(new Error("net"), { code: "ETIMEDOUT" })),
    });
    const res = await listClustersClusterWide(kc as never);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error.kind).toBe("unreachable");
  });
});

describe("listClustersNamespaced()", () => {
  it("falls back to namespace-scoped listing successfully", async () => {
    const kc = makeKc({
      listNamespaced: () => Promise.resolve({ body: { items: [oneCluster] } }),
    });
    const res = await listClustersNamespaced(kc as never, "default");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.clusters.length).toBe(1);
  });
});
