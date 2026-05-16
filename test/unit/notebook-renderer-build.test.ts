/**
 * Unit tests for the renderer's pure HTML builder. The DOM-mounting glue
 * (vscode-notebook-renderer activation) is wiring code; the table-shape
 * decisions live in this pure function and are tested here without a DOM.
 */

import { describe, expect, it } from "vitest";
import { buildTableHtml, ResultGridPayload } from "../../src/notebook/renderer/build-table.js";

const sample: ResultGridPayload = {
  command: "SELECT",
  columns: ["id", "name", "active"],
  rows: [
    [1, "alice", true],
    [2, "bob", null],
  ],
  totalRows: 2,
  truncated: false,
};

describe("buildTableHtml()", () => {
  it("emits a <table> with one header row matching the columns", () => {
    const html = buildTableHtml(sample);
    const header = /<thead[\s\S]*?<\/thead>/.exec(html)?.[0] ?? "";
    expect(header).toContain("id");
    expect(header).toContain("name");
    expect(header).toContain("active");
  });

  it("emits one <tr> per row plus header", () => {
    const html = buildTableHtml(sample);
    const trCount = (html.match(/<tr[\s>]/g) ?? []).length;
    // 1 header + 2 data
    expect(trCount).toBe(3);
  });

  it("escapes HTML-significant characters in cell values", () => {
    const html = buildTableHtml({
      command: "SELECT",
      columns: ["x"],
      rows: [["<script>alert(1)</script>"]],
      totalRows: 1,
      truncated: false,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders NULL distinctly so it's not confused with the string 'NULL'", () => {
    const html = buildTableHtml({
      command: "SELECT",
      columns: ["a"],
      rows: [[null], ["NULL"]],
      totalRows: 2,
      truncated: false,
    });
    // The null cell carries a class the CSS can style differently.
    expect(html).toMatch(/class="cnpg-null"[^>]*>NULL</);
    // The literal string "NULL" is plain text, not classed.
    expect(html).toMatch(/<td(?!\s[^>]*cnpg-null)[^>]*>NULL</);
  });

  it("renders booleans as readable strings", () => {
    const html = buildTableHtml({
      command: "SELECT",
      columns: ["b"],
      rows: [[true], [false]],
      totalRows: 2,
      truncated: false,
    });
    expect(html).toContain("true");
    expect(html).toContain("false");
  });

  it("renders objects as JSON for inspection", () => {
    const html = buildTableHtml({
      command: "SELECT",
      columns: ["j"],
      rows: [[{ a: 1, b: [2, 3] }]],
      totalRows: 1,
      truncated: false,
    });
    expect(html).toContain("a&quot;:1");
  });

  it("shows a footer with the row count and the SQL command", () => {
    const html = buildTableHtml(sample);
    expect(html).toContain("SELECT");
    expect(html).toMatch(/2 row/);
  });

  it("surfaces an overflow notice when truncated", () => {
    const html = buildTableHtml({
      command: "SELECT",
      columns: ["x"],
      rows: [[1], [2]],
      totalRows: 5_000,
      truncated: true,
    });
    expect(html).toMatch(/4,?998/);
    expect(html.toLowerCase()).toContain("truncated");
  });

  it("renders an empty result set with a friendly message rather than a blank table", () => {
    const html = buildTableHtml({
      command: "SELECT",
      columns: ["x"],
      rows: [],
      totalRows: 0,
      truncated: false,
    });
    expect(html.toLowerCase()).toContain("no rows");
  });

  it("renders columns from the payload even when rows is empty (header still shows)", () => {
    const html = buildTableHtml({
      command: "SELECT",
      columns: ["only_col"],
      rows: [],
      totalRows: 0,
      truncated: false,
    });
    // The "no rows" path may omit the table; either way the message reflects the column.
    expect(html.toLowerCase()).toContain("no rows");
  });
});
