import { describe, expect, it } from "vitest";
import { normalizeNotebookName, validateNotebookName } from "../../src/notebook/per-cluster.js";

describe("validateNotebookName()", () => {
  it("returns null for a valid name", () => {
    expect(validateNotebookName("analysis")).toBeNull();
    expect(validateNotebookName("query-tuning")).toBeNull();
    expect(validateNotebookName("Vacuum_2026-05-15")).toBeNull();
  });

  it("rejects empty / whitespace-only input", () => {
    expect(validateNotebookName("")).not.toBeNull();
    expect(validateNotebookName("   ")).not.toBeNull();
    expect(validateNotebookName("\t")).not.toBeNull();
  });

  it("rejects names containing path separators", () => {
    expect(validateNotebookName("foo/bar")).not.toBeNull();
    expect(validateNotebookName("foo\\bar")).not.toBeNull();
    expect(validateNotebookName("a/b/c")).not.toBeNull();
  });

  it("rejects names that begin with a dot (hidden files)", () => {
    expect(validateNotebookName(".hidden")).not.toBeNull();
    expect(validateNotebookName(".cnpg-sql")).not.toBeNull();
  });

  it("rejects names containing Windows-reserved characters", () => {
    for (const ch of [":", "*", "?", '"', "<", ">", "|"]) {
      expect(validateNotebookName(`foo${ch}bar`)).not.toBeNull();
    }
  });

  it("rejects trailing whitespace or trailing dot (Windows rule)", () => {
    expect(validateNotebookName("foo ")).not.toBeNull();
    expect(validateNotebookName("foo.")).not.toBeNull();
  });
});

describe("normalizeNotebookName()", () => {
  it("appends .cnpg-sql when missing", () => {
    expect(normalizeNotebookName("foo")).toBe("foo.cnpg-sql");
  });

  it("preserves an existing .cnpg-sql extension", () => {
    expect(normalizeNotebookName("foo.cnpg-sql")).toBe("foo.cnpg-sql");
  });

  it("appends regardless of other dotted suffixes", () => {
    // .sql is a different extension; user gets .sql.cnpg-sql which is intentional.
    expect(normalizeNotebookName("foo.sql")).toBe("foo.sql.cnpg-sql");
  });

  it("does not double-append on repeated calls", () => {
    expect(normalizeNotebookName(normalizeNotebookName("foo"))).toBe("foo.cnpg-sql");
  });
});
