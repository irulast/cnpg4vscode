import { describe, expect, it } from "vitest";
import { shapeK8sError } from "../../src/k8s/errors.js";

describe("shapeK8sError()", () => {
  it("classifies HTTP 403 as forbidden and preserves the upstream message", () => {
    const shaped = shapeK8sError({
      statusCode: 403,
      body: {
        kind: "Status",
        status: "Failure",
        message:
          "clusters.postgresql.cnpg.io is forbidden: User \"u\" cannot list resource",
        reason: "Forbidden",
      },
    });
    expect(shaped.kind).toBe("forbidden");
    expect(shaped.message).toContain("forbidden");
  });

  it("classifies HTTP 401 as unauthenticated", () => {
    const shaped = shapeK8sError({ statusCode: 401, body: { message: "Unauthorized" } });
    expect(shaped.kind).toBe("unauthenticated");
  });

  it("classifies HTTP 404 against a CRD as crd-not-found", () => {
    const shaped = shapeK8sError({
      statusCode: 404,
      body: { kind: "Status", reason: "NotFound", message: "the server could not find the requested resource" },
    });
    expect(shaped.kind).toBe("not-found");
  });

  it("classifies ECONNREFUSED / ENOTFUND / ETIMEDOUT as unreachable", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]) {
      const err = Object.assign(new Error("net"), { code });
      const shaped = shapeK8sError(err);
      expect(shaped.kind).toBe("unreachable");
    }
  });

  it("flags SPDY upgrade-stripping proxy errors distinctly", () => {
    const err = Object.assign(new Error("Unexpected server response: 200"), {
      // Typical signal when Upgrade headers are stripped — the server replies 200 with no
      // upgrade negotiation; the SPDY layer surfaces this verbatim.
      isProxyStripsUpgrade: true,
    });
    const shaped = shapeK8sError(err);
    expect(shaped.kind).toBe("proxy-strips-upgrade");
  });

  it("falls back to 'other' with the verbatim original message", () => {
    const err = new Error("some unexpected thing");
    const shaped = shapeK8sError(err);
    expect(shaped.kind).toBe("other");
    expect(shaped.message).toContain("some unexpected thing");
  });

  it("never logs auth headers — the shaper does not include them in the message", () => {
    const shaped = shapeK8sError({
      statusCode: 401,
      body: { message: "Unauthorized" },
      request: { headers: { Authorization: "Bearer abc123" } },
    });
    expect(shaped.message).not.toContain("Bearer");
    expect(shaped.message).not.toContain("abc123");
  });
});
