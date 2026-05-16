import { describe, expect, it } from "vitest";
import {
  deserializeNotebookBytes,
  serializeNotebookData,
} from "../../src/notebook/serializer.js";

const CODE = 2 as const;
const MARKUP = 1 as const;

describe("CNPG notebook serializer", () => {
  it("round-trips a simple 3-cell notebook", () => {
    const input = {
      metadata: { boundControllerId: "ctx/ns/db/secret/db" },
      cells: [
        { kind: CODE, value: "SELECT 1", languageId: "sql" },
        { kind: MARKUP, value: "## Notes", languageId: "markdown" },
        { kind: CODE, value: "SELECT count(*) FROM users", languageId: "sql" },
      ],
    };
    const bytes = serializeNotebookData(input);
    const round = deserializeNotebookBytes(bytes);
    expect(round.metadata).toEqual(input.metadata);
    expect(round.cells.length).toBe(3);
    expect(round.cells[0]!.value).toBe("SELECT 1");
    expect(round.cells[1]!.kind).toBe(MARKUP);
    expect(round.cells[2]!.value).toBe("SELECT count(*) FROM users");
  });

  it("redacts credential literals from cell values on serialize", () => {
    const input = {
      cells: [
        {
          kind: CODE,
          value: "CREATE ROLE bob WITH PASSWORD 'plaintext'",
          languageId: "sql",
        },
      ],
    };
    const bytes = serializeNotebookData(input);
    const onDisk = new TextDecoder().decode(bytes);
    expect(onDisk).not.toContain("plaintext");
    expect(onDisk).toContain("***REDACTED***");
  });

  it("does NOT serialize cell outputs to disk (security)", () => {
    const input = {
      cells: [
        {
          kind: CODE,
          value: "SELECT 1",
          languageId: "sql",
          outputs: [
            {
              items: [{ mime: "text/plain", data: "SUPER_SECRET_RESULT_VALUE" }],
            },
          ],
        },
      ],
    };
    const bytes = serializeNotebookData(input);
    const onDisk = new TextDecoder().decode(bytes);
    expect(onDisk).not.toContain("SUPER_SECRET_RESULT_VALUE");
    // The cell itself survives.
    expect(onDisk).toContain("SELECT 1");
  });

  it("accepts a deserialise of an empty / new file with no cells", () => {
    const bytes = new TextEncoder().encode("");
    const round = deserializeNotebookBytes(bytes);
    expect(round.cells).toEqual([]);
  });

  it("preserves cell metadata on round-trip", () => {
    const input = {
      cells: [
        {
          kind: CODE,
          value: "SELECT 1",
          languageId: "sql",
          metadata: { mode: "readonly" },
        },
      ],
    };
    const round = deserializeNotebookBytes(serializeNotebookData(input));
    expect(round.cells[0]!.metadata).toEqual({ mode: "readonly" });
  });

  it("rejects deserialise of malformed JSON gracefully (no throw)", () => {
    const bytes = new TextEncoder().encode("not json");
    const round = deserializeNotebookBytes(bytes);
    expect(round.cells).toEqual([]);
  });
});
