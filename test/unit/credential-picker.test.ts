import { describe, expect, it } from "vitest";
import { selectDefaultSecret, summarizeSecret } from "../../src/k8s/secrets.js";

const sample = {
  appSecret: {
    metadata: { name: "app-db-app", namespace: "default" },
    data: { username: "dXNlcg==", password: "cGFzcw==" },
  },
  superSecret: {
    metadata: { name: "app-db-superuser", namespace: "default" },
    data: { username: "cG9zdGdyZXM=", password: "c3VwZXI=" },
  },
  otherSecret: {
    metadata: { name: "app-db-replication", namespace: "default" },
    data: { username: "cmVwbA==", password: "cmVwbHBhc3M=" },
  },
};

describe("selectDefaultSecret()", () => {
  it("preselects the <cluster>-app secret when present", () => {
    const chosen = selectDefaultSecret(
      [sample.appSecret, sample.superSecret, sample.otherSecret] as never,
      "app-db",
    );
    expect(chosen?.metadata?.name).toBe("app-db-app");
  });

  it("returns undefined when no <cluster>-app secret exists, forcing an explicit pick", () => {
    const chosen = selectDefaultSecret(
      [sample.superSecret, sample.otherSecret] as never,
      "app-db",
    );
    expect(chosen).toBeUndefined();
  });

  it("matches only on the cluster's own secret prefix, not on substrings", () => {
    const otherClusterApp = {
      metadata: { name: "other-app", namespace: "default" },
      data: { username: "x", password: "y" },
    };
    const chosen = selectDefaultSecret([otherClusterApp] as never, "app-db");
    expect(chosen).toBeUndefined();
  });
});

describe("summarizeSecret()", () => {
  it("classifies the kind based on the suffix", () => {
    expect(summarizeSecret(sample.appSecret as never, "app-db").kind).toBe("app");
    expect(summarizeSecret(sample.superSecret as never, "app-db").kind).toBe("superuser");
    expect(summarizeSecret(sample.otherSecret as never, "app-db").kind).toBe("other");
  });

  it("never returns the raw password in the summary", () => {
    const s = summarizeSecret(sample.appSecret as never, "app-db");
    expect(JSON.stringify(s)).not.toContain("cGFzcw==");
    expect(JSON.stringify(s)).not.toContain("pass");
  });
});
