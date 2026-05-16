import { describe, expect, it } from "vitest";
import { validateTypedName, formatConfirmationPrompt } from "../../src/ui/confirm-validate.js";

describe("validateTypedName()", () => {
  it("accepts an exact match", () => {
    expect(validateTypedName("public.scratch", "public.scratch")).toBeNull();
  });

  it("rejects an empty input", () => {
    const e = validateTypedName("", "public.scratch");
    expect(e).not.toBeNull();
    expect(e!.toLowerCase()).toContain("type");
  });

  it("rejects a wrong name", () => {
    expect(validateTypedName("scratch", "public.scratch")).not.toBeNull();
    expect(validateTypedName("public.SCRATCH", "public.scratch")).not.toBeNull();
  });

  it("rejects whitespace-only input", () => {
    expect(validateTypedName("   ", "public.scratch")).not.toBeNull();
  });

  it("is case-sensitive (PostgreSQL identifiers are case-sensitive when quoted)", () => {
    expect(validateTypedName("Public.Scratch", "public.scratch")).not.toBeNull();
  });
});

describe("formatConfirmationPrompt()", () => {
  it("includes the operation name and the target identifier", () => {
    const p = formatConfirmationPrompt("DROP TABLE", "public.scratch");
    expect(p).toContain("DROP TABLE");
    expect(p).toContain("public.scratch");
  });

  it("instructs the user to retype the target name", () => {
    const p = formatConfirmationPrompt("DROP TABLE", "public.scratch");
    expect(p.toLowerCase()).toContain("type");
  });
});
