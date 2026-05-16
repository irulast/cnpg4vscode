import { describe, expect, it } from "vitest";
import { validateConnectionMode } from "../../src/state/config.js";

describe("validateConnectionMode()", () => {
  it("accepts 'readonly' unchanged", () => {
    expect(validateConnectionMode("readonly")).toEqual({ value: "readonly", warning: null });
  });

  it("rejects 'write' and forces back to 'readonly' with a warning", () => {
    const result = validateConnectionMode("write");
    expect(result.value).toBe("readonly");
    expect(result.warning).not.toBeNull();
    expect(result.warning).toMatch(/FR-020/);
  });

  it("accepts unknown values by forcing to 'readonly' with a warning", () => {
    const result = validateConnectionMode("nonsense" as never);
    expect(result.value).toBe("readonly");
    expect(result.warning).not.toBeNull();
  });
});
