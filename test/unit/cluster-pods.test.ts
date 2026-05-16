import { describe, expect, it } from "vitest";
import { derivePodSummary } from "../../src/k8s/cnpg.js";

function podLike(over: Record<string, unknown> = {}): unknown {
  return {
    metadata: {
      name: "app-db-1",
      creationTimestamp: "2026-05-15T00:00:00Z",
      labels: {
        "cnpg.io/cluster": "app-db",
        "cnpg.io/instanceRole": "primary",
      },
      ...(over.metadata as Record<string, unknown> ?? {}),
    },
    status: {
      phase: "Running",
      containerStatuses: [
        { name: "postgres", ready: true, restartCount: 0 },
      ],
      ...(over.status as Record<string, unknown> ?? {}),
    },
  };
}

describe("derivePodSummary()", () => {
  it("extracts name, phase, role, restart count, and readiness for a healthy pod", () => {
    const s = derivePodSummary(podLike());
    expect(s.name).toBe("app-db-1");
    expect(s.phase).toBe("Running");
    expect(s.role).toBe("primary");
    expect(s.restartCount).toBe(0);
    expect(s.ready).toBe(true);
    expect(s.containersReady).toBe("1/1");
  });

  it("marks a pod as not ready when any container is not ready", () => {
    const s = derivePodSummary(
      podLike({
        status: {
          phase: "Running",
          containerStatuses: [
            { name: "postgres", ready: true, restartCount: 0 },
            { name: "sidecar", ready: false, restartCount: 3 },
          ],
        },
      }),
    );
    expect(s.ready).toBe(false);
    expect(s.containersReady).toBe("1/2");
    expect(s.restartCount).toBe(3); // sums across containers
  });

  it("falls back to 'replica' when the role label is missing", () => {
    const s = derivePodSummary(
      podLike({ metadata: { labels: { "cnpg.io/cluster": "app-db" } } }),
    );
    expect(s.role).toBe("replica");
  });

  it("recognises the cnpg.io/instanceRole values (primary | replica)", () => {
    expect(
      derivePodSummary(
        podLike({
          metadata: { labels: { "cnpg.io/instanceRole": "replica" } },
        }),
      ).role,
    ).toBe("replica");
    expect(
      derivePodSummary(
        podLike({
          metadata: { labels: { "cnpg.io/instanceRole": "primary" } },
        }),
      ).role,
    ).toBe("primary");
  });

  it("renders a human-friendly relative age", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const s = derivePodSummary(
      podLike({ metadata: { creationTimestamp: oneHourAgo } }),
    );
    expect(s.age).toMatch(/h$|hour|1h/);
  });

  it("handles a Pending pod with no container statuses yet", () => {
    const s = derivePodSummary(
      podLike({ status: { phase: "Pending", containerStatuses: undefined } }),
    );
    expect(s.phase).toBe("Pending");
    expect(s.ready).toBe(false);
    expect(s.containersReady).toBe("0/0");
    expect(s.restartCount).toBe(0);
  });

  it("returns 'Unknown' for entirely missing status block", () => {
    const s = derivePodSummary({ metadata: { name: "x" } });
    expect(s.phase).toBe("Unknown");
    expect(s.name).toBe("x");
  });

  it("recognises a Terminating pod (deletionTimestamp set)", () => {
    const s = derivePodSummary(
      podLike({
        metadata: { deletionTimestamp: "2026-05-15T00:01:00Z" },
        status: { phase: "Running", containerStatuses: [] },
      }),
    );
    expect(s.terminating).toBe(true);
  });
});
