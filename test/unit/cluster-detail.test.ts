import { describe, expect, it } from "vitest";
import { deriveClusterDetail } from "../../src/k8s/cnpg.js";
import { renderDetailMarkdown } from "../../src/ui/cluster-detail-render.js";

describe("deriveClusterDetail()", () => {
  it("extracts the five required spec fields", () => {
    const d = deriveClusterDetail({
      metadata: { name: "app-db", namespace: "default", uid: "u" },
      spec: { instances: 3, storage: { size: "10Gi" }, imageName: "ghcr.io/cloudnative-pg/postgresql:16.2" },
      status: { phase: "Cluster in healthy state", currentPrimary: "app-db-1", pgVersion: "16" },
    });
    expect(d).not.toBeNull();
    expect(d!.instances).toBe(3);
    expect(d!.primary).toBe("app-db-1");
    expect(d!.pgMajorVersion).toBe(16);
    expect(d!.storageSize).toBe("10Gi");
    expect(d!.phase).toBe("Cluster in healthy state");
  });

  it("silently ignores fields it does not recognise (forward compatibility)", () => {
    const d = deriveClusterDetail({
      metadata: { name: "x", namespace: "default" },
      spec: { instances: 1, storage: { size: "1Gi" } },
      status: {
        phase: "Cluster in healthy state",
        // Hypothetical unknown future field — should not throw.
        ...({ futureField: { complex: true } } as Record<string, unknown>),
      } as never,
    });
    expect(d).not.toBeNull();
    expect(d!.phase).toBe("Cluster in healthy state");
  });

  it("selects the most-recent condition by lastTransitionTime", () => {
    const d = deriveClusterDetail({
      metadata: { name: "x", namespace: "default" },
      status: {
        phase: "Cluster in healthy state",
        conditions: [
          { type: "Ready", status: "True", message: "older", lastTransitionTime: "2026-05-14T00:00:00Z" },
          { type: "Ready", status: "True", message: "newer", lastTransitionTime: "2026-05-15T00:00:00Z" },
        ],
      },
    });
    expect(d!.lastCondition?.message).toBe("newer");
  });

  it("returns null when the metadata is missing identity", () => {
    const d = deriveClusterDetail({ metadata: { namespace: "default" } });
    expect(d).toBeNull();
  });
});

describe("renderDetailMarkdown()", () => {
  const sample = {
    name: "app-db",
    namespace: "default",
    uid: "u",
    phase: "Cluster in healthy state",
    instances: 3,
    primary: "app-db-1",
    pgMajorVersion: 16,
    storageSize: "10Gi",
    lastCondition: null,
    readWriteService: "app-db-rw",
    caSecretName: "app-db-ca",
  } as const;

  it("renders the five required fields plus identifiers", () => {
    const out = renderDetailMarkdown("kind-dev", sample);
    expect(out).toContain("# default/app-db");
    expect(out).toContain("**Phase**: Cluster in healthy state");
    expect(out).toContain("**Instances**: 3");
    expect(out).toContain("**Primary**: `app-db-1`");
    expect(out).toContain("**PostgreSQL**: 16");
    expect(out).toContain("**Storage**: 10Gi");
    expect(out).toContain("**Read-write service**: `app-db-rw`");
  });

  it("includes the most-recent condition when present", () => {
    const out = renderDetailMarkdown("kind-dev", {
      ...sample,
      lastCondition: {
        type: "Ready",
        status: "False",
        message: "one replica failing",
        lastTransitionTime: "2026-05-15T00:00:00Z",
      },
    });
    expect(out).toContain("## Last condition");
    expect(out).toContain("one replica failing");
  });

  it("notes the surface is read-only", () => {
    const out = renderDetailMarkdown("kind-dev", sample);
    expect(out).toContain("read-only");
  });

  it("renders a Pods table when pod summaries are supplied", () => {
    const out = renderDetailMarkdown("kind-dev", sample, {
      pods: [
        {
          name: "app-db-1",
          phase: "Running",
          role: "primary",
          ready: true,
          containersReady: "1/1",
          restartCount: 0,
          age: "1h",
          terminating: false,
        },
        {
          name: "app-db-2",
          phase: "Running",
          role: "replica",
          ready: false,
          containersReady: "0/1",
          restartCount: 3,
          age: "1h",
          terminating: false,
        },
      ],
    });
    expect(out).toContain("## Pods");
    expect(out).toContain("| Role | Name | Phase | Ready | Restarts | Age |");
    expect(out).toContain("`app-db-1`");
    expect(out).toContain("primary");
    expect(out).toContain("3"); // restart count for the replica
  });

  it("marks terminating pods in the Pods table", () => {
    const out = renderDetailMarkdown("kind-dev", sample, {
      pods: [
        {
          name: "app-db-3",
          phase: "Running",
          role: "replica",
          ready: true,
          containersReady: "1/1",
          restartCount: 0,
          age: "5m",
          terminating: true,
        },
      ],
    });
    expect(out).toContain("_(terminating)_");
  });

  it("surfaces a pod-listing error in place of the table", () => {
    const out = renderDetailMarkdown("kind-dev", sample, {
      podsError: "forbidden: cannot list pods in namespace \"default\"",
    });
    expect(out).toContain("## Pods");
    expect(out).toContain("Could not list pods:");
    expect(out).toContain("forbidden");
  });

  it("renders a friendly empty-state when pods is an empty array", () => {
    const out = renderDetailMarkdown("kind-dev", sample, { pods: [] });
    expect(out).toContain("## Pods");
    expect(out).toContain("No pods found");
  });

  it("omits the Pods section entirely when no pods option is supplied", () => {
    const out = renderDetailMarkdown("kind-dev", sample);
    expect(out).not.toContain("## Pods");
  });
});
