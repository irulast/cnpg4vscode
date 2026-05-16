import { describe, expect, it } from "vitest";
import { detectOperator } from "../../../src/k8s/cnpg.js";

function makeKc(response: () => Promise<unknown> | never): { makeApiClient: () => { readCustomResourceDefinition: () => Promise<unknown> } } {
  return {
    makeApiClient: () => ({
      readCustomResourceDefinition: response,
    }),
  };
}

describe("detectOperator()", () => {
  it("returns 'present' when the CNPG CRD exists", async () => {
    const kc = makeKc(() =>
      Promise.resolve({
        body: { spec: { versions: [{ name: "v1" }] } },
      }),
    );
    const presence = await detectOperator(kc as never);
    expect(presence.kind).toBe("present");
    if (presence.kind === "present") {
      expect(presence.crdVersion).toBe("v1");
    }
  });

  it("returns 'absent' on 404", async () => {
    const kc = makeKc(() =>
      Promise.reject({
        statusCode: 404,
        body: { reason: "NotFound", message: "not found" },
      }),
    );
    const presence = await detectOperator(kc as never);
    expect(presence.kind).toBe("absent");
  });

  it("returns 'forbidden' on 403, preserving the upstream message", async () => {
    const kc = makeKc(() =>
      Promise.reject({
        statusCode: 403,
        body: {
          reason: "Forbidden",
          message: "customresourcedefinitions.apiextensions.k8s.io is forbidden",
        },
      }),
    );
    const presence = await detectOperator(kc as never);
    expect(presence.kind).toBe("forbidden");
    if (presence.kind === "forbidden") {
      expect(presence.message).toMatch(/forbidden/);
    }
  });

  it("returns 'unknown' for unreachable clusters", async () => {
    const kc = makeKc(() =>
      Promise.reject(Object.assign(new Error("net"), { code: "ENOTFOUND" })),
    );
    const presence = await detectOperator(kc as never);
    expect(presence.kind).toBe("unknown");
    if (presence.kind === "unknown") {
      expect(presence.error.kind).toBe("unreachable");
    }
  });
});
