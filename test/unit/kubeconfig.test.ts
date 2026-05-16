import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadContexts, classifyAuthMode } from "../../src/k8s/kubeconfig.js";

const fixturePath = path.resolve(
  process.cwd(),
  "test/fixtures/kubeconfig/multi-context.yaml",
);

describe("loadContexts()", () => {
  it("parses every context from the kubeconfig file", () => {
    const { contexts } = loadContexts({ kubeconfig: fixturePath });
    expect(contexts.map((c) => c.name).sort()).toEqual(["kind-dev", "prod-eks"]);
  });

  it("classifies auth mode per context", () => {
    const { contexts } = loadContexts({ kubeconfig: fixturePath });
    const byName = Object.fromEntries(contexts.map((c) => [c.name, c]));
    expect(byName["kind-dev"]!.authMode).toBe("cert");
    expect(byName["prod-eks"]!.authMode).toBe("exec");
  });

  it("exposes the kubeconfig path used so the watcher can subscribe", () => {
    const result = loadContexts({ kubeconfig: fixturePath });
    expect(result.resolvedPaths).toContain(fixturePath);
  });
});

describe("classifyAuthMode()", () => {
  it("returns 'token' for a bearer-token user", () => {
    expect(classifyAuthMode({ token: "abc" })).toBe("token");
  });
  it("returns 'cert' for client-cert auth", () => {
    expect(classifyAuthMode({ "client-certificate-data": "...", "client-key-data": "..." })).toBe("cert");
  });
  it("returns 'exec' for exec plugins", () => {
    expect(classifyAuthMode({ exec: { command: "aws" } })).toBe("exec");
  });
  it("returns 'authProvider' for auth-provider plugins", () => {
    expect(classifyAuthMode({ "auth-provider": { name: "gcp" } })).toBe("authProvider");
  });
  it("returns 'basic' for username/password", () => {
    expect(classifyAuthMode({ username: "u", password: "p" })).toBe("basic");
  });
});
