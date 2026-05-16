/**
 * Unit tests for the Grid Editor's per-type cell-editor registry (T140,
 * paired with T149).
 *
 * The registry is pure — given a column descriptor (from the protocol
 * contract), it returns the JS-side editor kind the renderer should
 * mount: text / number / boolean / date / json / enum / readonly.
 * PG type → JS type mapping covers the common scalar types plus the
 * load-bearing jsonb and timestamptz cases.
 */

import { describe, expect, it } from "vitest";
import {
  pickEditor,
  pgTypeToJsType,
  type CellEditorChoice,
} from "../../src/grid/cell-editors.js";
import type { ColumnDescriptor } from "../../src/webviews/grid/protocol.js";

function col(over: Partial<ColumnDescriptor>): ColumnDescriptor {
  return {
    name: "c",
    pgType: "text",
    jsType: "string",
    nullable: false,
    hasDefault: false,
    isPk: false,
    ...over,
  };
}

describe("pgTypeToJsType()", () => {
  it("maps text-family types to 'string'", () => {
    for (const t of ["text", "varchar", "character varying", "character", "char", "name", "citext", "bpchar"]) {
      expect(pgTypeToJsType(t)).toBe("string");
    }
  });

  it("maps integer-family types to 'number'", () => {
    for (const t of ["int", "int2", "int4", "int8", "smallint", "integer", "bigint", "smallserial", "serial", "bigserial"]) {
      expect(pgTypeToJsType(t)).toBe("number");
    }
  });

  it("maps floating + numeric types to 'number'", () => {
    for (const t of ["real", "float4", "double precision", "float8", "numeric", "decimal", "money"]) {
      expect(pgTypeToJsType(t)).toBe("number");
    }
  });

  it("maps boolean to 'boolean'", () => {
    expect(pgTypeToJsType("bool")).toBe("boolean");
    expect(pgTypeToJsType("boolean")).toBe("boolean");
  });

  it("maps date/time/timestamp/timestamptz family to 'date'", () => {
    for (const t of ["date", "time", "timetz", "timestamp", "timestamptz", "timestamp with time zone", "timestamp without time zone"]) {
      expect(pgTypeToJsType(t)).toBe("date");
    }
  });

  it("maps jsonb / json to 'json'", () => {
    expect(pgTypeToJsType("jsonb")).toBe("json");
    expect(pgTypeToJsType("json")).toBe("json");
  });

  it("maps UUID to 'string' (no native picker needed)", () => {
    expect(pgTypeToJsType("uuid")).toBe("string");
  });

  it("falls back to 'unknown' for unrecognised types", () => {
    expect(pgTypeToJsType("inet")).toBe("unknown");
    expect(pgTypeToJsType("polygon")).toBe("unknown");
    expect(pgTypeToJsType("custom_user_type")).toBe("unknown");
  });

  it("is case-insensitive (pg type names round-trip lower from format_type)", () => {
    expect(pgTypeToJsType("INTEGER")).toBe("number");
    expect(pgTypeToJsType("Timestamptz")).toBe("date");
  });
});

describe("pickEditor() — happy path mapping", () => {
  it("returns a text editor for string columns", () => {
    const e = pickEditor(col({ jsType: "string" }));
    expect(e.kind).toBe("text");
    if (e.kind === "text") expect(e.allowEmpty).toBe(true);
  });

  it("returns a number editor for numeric columns", () => {
    const e = pickEditor(col({ pgType: "numeric", jsType: "number" }));
    expect(e.kind).toBe("number");
    if (e.kind === "number") expect(e.precision).toBe("decimal");
  });

  it("returns a boolean editor (checkbox) for bool columns", () => {
    const e = pickEditor(col({ pgType: "bool", jsType: "boolean" }));
    expect(e.kind).toBe("boolean");
  });

  it("returns a date editor for date/time/timestamp columns", () => {
    const e = pickEditor(col({ pgType: "timestamptz", jsType: "date" }));
    expect(e.kind).toBe("date");
    if (e.kind === "date") expect(e.includeTime).toBe(true);
  });

  it("returns a json popout editor for jsonb / json columns", () => {
    const e = pickEditor(col({ pgType: "jsonb", jsType: "json" }));
    expect(e.kind).toBe("json");
    if (e.kind === "json") expect(e.popout).toBe(true);
  });

  it("returns an enum dropdown editor for enum columns with allowed values", () => {
    const e = pickEditor(
      col({
        pgType: "order_status",
        jsType: "enum",
        enumValues: ["pending", "shipped", "refunded"],
      }),
    );
    expect(e.kind).toBe("enum");
    if (e.kind === "enum") expect(e.choices).toEqual(["pending", "shipped", "refunded"]);
  });

  it("falls back to a readonly editor for 'unknown' types", () => {
    const e = pickEditor(col({ jsType: "unknown" }));
    expect(e.kind).toBe("readonly");
  });
});

describe("pickEditor() — date precision (time vs date)", () => {
  it("date-only PG type sets includeTime=false", () => {
    const e = pickEditor(col({ pgType: "date", jsType: "date" }));
    if (e.kind === "date") expect(e.includeTime).toBe(false);
  });

  it("timestamp without time zone includes time but not zone", () => {
    const e = pickEditor(col({ pgType: "timestamp", jsType: "date" }));
    if (e.kind === "date") {
      expect(e.includeTime).toBe(true);
      expect(e.includeZone).toBe(false);
    }
  });

  it("timestamptz includes time AND zone", () => {
    const e = pickEditor(col({ pgType: "timestamptz", jsType: "date" }));
    if (e.kind === "date") {
      expect(e.includeTime).toBe(true);
      expect(e.includeZone).toBe(true);
    }
  });
});

describe("pickEditor() — number precision (int vs decimal)", () => {
  it("int family yields integer precision", () => {
    const e = pickEditor(col({ pgType: "int4", jsType: "number" }));
    if (e.kind === "number") expect(e.precision).toBe("integer");
  });

  it("numeric / float family yields decimal precision", () => {
    expect(
      (pickEditor(col({ pgType: "numeric", jsType: "number" })) as CellEditorChoice & { kind: "number" }).precision,
    ).toBe("decimal");
    expect(
      (pickEditor(col({ pgType: "float8", jsType: "number" })) as CellEditorChoice & { kind: "number" }).precision,
    ).toBe("decimal");
  });
});

describe("pickEditor() — PK + non-editable surfaces", () => {
  it("PK columns are returned as readonly (cell editing must NOT mutate the row identity)", () => {
    const e = pickEditor(col({ isPk: true, jsType: "number" }));
    expect(e.kind).toBe("readonly");
  });

  it("enum columns without enumValues fall back to text (defensive — descriptor bug)", () => {
    const e = pickEditor(col({ jsType: "enum" }));
    expect(e.kind).toBe("text");
  });
});

describe("pickEditor() — null/default sentinel keystrokes (FR-038)", () => {
  it("nullable columns get allowSetNull=true on every editor type", () => {
    for (const jsType of ["string", "number", "boolean", "date", "json"] as const) {
      const e = pickEditor(col({ jsType, nullable: true }));
      expect(e.allowSetNull).toBe(true);
    }
  });

  it("non-nullable columns get allowSetNull=false", () => {
    const e = pickEditor(col({ jsType: "string", nullable: false }));
    expect(e.allowSetNull).toBe(false);
  });

  it("columns with defaults get allowResetDefault=true", () => {
    const e = pickEditor(col({ jsType: "number", hasDefault: true }));
    expect(e.allowResetDefault).toBe(true);
  });

  it("columns without defaults get allowResetDefault=false", () => {
    const e = pickEditor(col({ jsType: "number", hasDefault: false }));
    expect(e.allowResetDefault).toBe(false);
  });
});
