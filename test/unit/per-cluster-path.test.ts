import { describe, expect, it } from "vitest";
import {
  encodeClusterSegment,
  resolveClusterFolder,
} from "../../src/notebook/per-cluster.js";

describe("encodeClusterSegment()", () => {
  it("leaves filesystem-safe identifiers untouched", () => {
    expect(encodeClusterSegment("app-db")).toBe("app-db");
    expect(encodeClusterSegment("default")).toBe("default");
  });

  it("URL-encodes path-traversal and reserved characters", () => {
    expect(encodeClusterSegment("foo/bar")).toBe("foo%2Fbar");
    expect(encodeClusterSegment("eks:prod")).toBe("eks%3Aprod");
    expect(encodeClusterSegment("..")).toBe("%2E%2E");
    expect(encodeClusterSegment(".")).toBe("%2E");
  });
});

describe("resolveClusterFolder()", () => {
  const base = "/home/u/work";

  it("composes <workspaceRoot>/<base>/<context>/<namespace>/<cluster>", () => {
    const result = resolveClusterFolder({
      workspaceRoot: base,
      base: ".cnpg/notebooks",
      contextName: "kind-dev",
      namespace: "default",
      clusterName: "app-db",
    });
    expect(result).toBe(`${base}/.cnpg/notebooks/kind-dev/default/app-db`);
  });

  it("URL-encodes context segments containing / or :", () => {
    const result = resolveClusterFolder({
      workspaceRoot: base,
      base: ".cnpg/notebooks",
      contextName: "arn:aws:eks:us-east-1:123/foo",
      namespace: "ns",
      clusterName: "c",
    });
    expect(result).not.toContain("aws:eks");
    expect(result).toContain("arn%3Aaws%3Aeks%3Aus-east-1%3A123%2Ffoo");
  });

  it("returns null when workspaceRoot is null", () => {
    expect(
      resolveClusterFolder({
        workspaceRoot: null,
        base: ".cnpg/notebooks",
        contextName: "c",
        namespace: "n",
        clusterName: "x",
      }),
    ).toBeNull();
  });

  it("honors a custom base setting", () => {
    const result = resolveClusterFolder({
      workspaceRoot: base,
      base: "saved/notebooks",
      contextName: "c",
      namespace: "n",
      clusterName: "x",
    });
    expect(result).toBe(`${base}/saved/notebooks/c/n/x`);
  });

  it("refuses base values that escape the workspace via ..", () => {
    expect(
      resolveClusterFolder({
        workspaceRoot: base,
        base: "../escape",
        contextName: "c",
        namespace: "n",
        clusterName: "x",
      }),
    ).toBeNull();
    expect(
      resolveClusterFolder({
        workspaceRoot: base,
        base: "/etc",
        contextName: "c",
        namespace: "n",
        clusterName: "x",
      }),
    ).toBeNull();
  });

  it("produces a stable folder for the same identifier across calls", () => {
    const args = {
      workspaceRoot: base,
      base: ".cnpg/notebooks",
      contextName: "ctx",
      namespace: "ns",
      clusterName: "cluster",
    };
    expect(resolveClusterFolder(args)).toBe(resolveClusterFolder(args));
  });
});
