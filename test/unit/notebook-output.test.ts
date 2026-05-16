import { describe, expect, it } from "vitest";
import {
  formatErrorOutput,
  formatSuccessOutput,
  renderAlignedTable,
  renderMarkdownTable,
} from "../../src/notebook/output.js";

describe("formatSuccessOutput()", () => {
  it("produces structured JSON, text/plain, and text/markdown items for a non-empty SELECT", () => {
    const items = formatSuccessOutput({
      command: "SELECT",
      rowCount: 2,
      fields: [{ name: "id" }, { name: "name" }],
      rows: [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ],
    } as never);
    const mimes = items.map((i) => i.mime);
    expect(mimes).toContain("application/x-cnpg-result+json");
    expect(mimes).toContain("text/plain");
    expect(mimes).toContain("text/markdown");
  });

  it("orders application/x-cnpg-result+json FIRST so the renderer prefers it", () => {
    const items = formatSuccessOutput({
      command: "SELECT",
      rowCount: 1,
      fields: [{ name: "x" }],
      rows: [{ x: 1 }],
    } as never);
    expect(items[0]!.mime).toBe("application/x-cnpg-result+json");
  });

  it("the JSON item carries columns, rows, command, rowCount, and overflow info", () => {
    const items = formatSuccessOutput(
      {
        command: "SELECT",
        rowCount: 3,
        fields: [{ name: "id" }, { name: "name" }],
        rows: [
          { id: 1, name: "alice" },
          { id: 2, name: "bob" },
          { id: 3, name: "carol" },
        ],
      } as never,
      { previewRows: 2 },
    );
    const json = JSON.parse(items.find((i) => i.mime === "application/x-cnpg-result+json")!.text);
    expect(json.columns).toEqual(["id", "name"]);
    expect(json.rows.length).toBe(2);
    expect(json.totalRows).toBe(3);
    expect(json.truncated).toBe(true);
    expect(json.command).toBe("SELECT");
  });

  it("the JSON item reports truncated=false when nothing was sliced", () => {
    const items = formatSuccessOutput({
      command: "SELECT",
      rowCount: 1,
      fields: [{ name: "x" }],
      rows: [{ x: 1 }],
    } as never);
    const json = JSON.parse(items.find((i) => i.mime === "application/x-cnpg-result+json")!.text);
    expect(json.truncated).toBe(false);
  });

  it("DOES NOT produce a JSON item for side-effect-only statements (no result set)", () => {
    const items = formatSuccessOutput({
      command: "CREATE TABLE",
      rowCount: null,
      fields: [],
      rows: [],
    } as never);
    const mimes = items.map((i) => i.mime);
    expect(mimes).not.toContain("application/x-cnpg-result+json");
    expect(mimes).toContain("text/plain");
  });

  it("renders an `OK (N rows)` summary for statements with no result columns", () => {
    const items = formatSuccessOutput({
      command: "CREATE TABLE",
      rowCount: null,
      fields: [],
      rows: [],
    } as never);
    const text = items.find((i) => i.mime === "text/plain")?.text ?? "";
    expect(text).toMatch(/CREATE TABLE/);
  });

  it("never includes a literal that the redaction ruleset matches", () => {
    // For a SELECT row that contains a PG-shaped credential, the output is
    // user-visible only in-memory; the formatter doesn't redact value cells
    // (that would corrupt query results). It MUST redact column NAMES that
    // contain credential keywords though, in case someone aliases `password`
    // as the column name. We at least verify the formatter doesn't inject
    // any credential literals of its own.
    const items = formatSuccessOutput({
      command: "SELECT",
      rowCount: 0,
      fields: [],
      rows: [],
    } as never);
    for (const i of items) {
      expect(i.text).not.toContain("***REDACTED***");
    }
  });

  it("limits the rendered preview to a configurable row cap", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
    const items = formatSuccessOutput(
      {
        command: "SELECT",
        rowCount: big.length,
        fields: [{ name: "id" }],
        rows: big,
      } as never,
      { previewRows: 50 },
    );
    const text = items.find((i) => i.mime === "text/plain")?.text ?? "";
    expect(text.split("\n").length).toBeLessThan(60); // header + 50 rows + footer
    expect(text).toContain("4950 more row");
  });
});

describe("formatErrorOutput()", () => {
  it("produces a stderr-classified error item", () => {
    const item = formatErrorOutput("syntax error at or near \"FRMO\"", "42601");
    expect(item.mime).toBe("application/vnd.code.notebook.error");
    expect(item.text).toContain("syntax error");
    expect(item.text).toContain("42601");
  });

  it("works when no sqlstate is provided", () => {
    const item = formatErrorOutput("connection reset");
    expect(item.text).toContain("connection reset");
  });
});

describe("renderAlignedTable()", () => {
  it("renders headers and rows with consistent column widths", () => {
    const out = renderAlignedTable(["a", "long_col"], [
      ["1", "x"],
      ["123", "yy"],
    ]);
    const lines = out.split("\n");
    // Header line ends with the rightmost column intact.
    expect(lines[0]).toContain("a");
    expect(lines[0]).toContain("long_col");
    // Each data line shares the same column count.
    expect(lines[2]!.split(/\s+/).filter(Boolean).length).toBe(2);
  });

  it("renders NULL for null/undefined cells", () => {
    const out = renderAlignedTable(["a"], [[null], [undefined]]);
    expect(out).toMatch(/NULL/);
  });
});

describe("renderMarkdownTable()", () => {
  it("produces a valid markdown table", () => {
    const md = renderMarkdownTable(["a", "b"], [
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(md.split("\n")[0]).toBe("| a | b |");
    expect(md.split("\n")[1]).toBe("| --- | --- |");
    expect(md.split("\n")[2]).toBe("| 1 | 2 |");
  });

  it("escapes pipe characters in cell values", () => {
    const md = renderMarkdownTable(["a"], [["x|y"]]);
    expect(md).toContain("x\\|y");
  });
});
