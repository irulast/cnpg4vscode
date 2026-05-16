/**
 * Unit tests for the Grid Editor State serializer (T137, paired with T147).
 *
 * The serializer persists Grid Editor LAYOUT primitives (column order,
 * widths, sort, filters, scroll position) keyed by (context, namespace,
 * cluster, database, schema, table). Per FR-039 + Constitution §Security,
 * it MUST NEVER persist cell data — the serializer enforces this via a
 * defense-in-depth field allowlist on the write path (the same shape as
 * the redaction-store guard in history-store.ts).
 *
 * Tests cover: round-trip, version-tag for forward-compat migration,
 * allowlist rejection of unknown fields, defaults application,
 * key-shape collision-free across overlapping context/namespace combos,
 * empty-state defaults from a column descriptor.
 */

import { describe, expect, it } from "vitest";
import {
  applyDefaults,
  deserialize,
  gridStateKey,
  serialize,
  CURRENT_VERSION,
  type GridEditorState,
  type GridStateKey,
} from "../../src/state/grid-editor-state.js";

const SAMPLE_KEY: GridStateKey = {
  contextName: "kind-dev",
  namespace: "default",
  clusterName: "app-db",
  database: "postgres",
  schema: "public",
  table: "users",
};

const SAMPLE_STATE: GridEditorState = {
  columnOrder: ["id", "email", "name"],
  hiddenColumns: ["password_hash"],
  columnWidths: { id: 60, email: 240, name: 180 },
  sort: [{ column: "created_at", dir: "desc" }],
  filters: [{ column: "active", op: "eq", value: "true" }],
  frozenColumnCount: 1,
  scrollTop: 1200,
  lastOpenedAt: 1747500000000,
};

describe("gridStateKey()", () => {
  it("produces a stable, deterministic string from the 6-tuple", () => {
    expect(gridStateKey(SAMPLE_KEY)).toBe(
      "kind-dev/default/app-db/postgres/public/users",
    );
  });

  it("collides only on identical 6-tuples — overlapping context/namespace names are unambiguous", () => {
    const a = gridStateKey({
      contextName: "prod",
      namespace: "default",
      clusterName: "app/db",
      database: "postgres",
      schema: "public",
      table: "users",
    });
    const b = gridStateKey({
      contextName: "prod/default",
      namespace: "app",
      clusterName: "db",
      database: "postgres",
      schema: "public",
      table: "users",
    });
    // Slashes inside identifiers (legal in PG quoted idents) must not
    // alias to a different 6-tuple. The encoder MUST escape them.
    expect(a).not.toBe(b);
  });

  it("escapes `/` inside any tuple component so quoted identifiers don't break the key", () => {
    const k = gridStateKey({
      ...SAMPLE_KEY,
      table: "weird/table",
    });
    expect(k).not.toContain("/weird/table");
    expect(k.endsWith("/users")).toBe(false);
  });
});

describe("serialize() / deserialize() round-trip", () => {
  it("round-trips a full state object exactly", () => {
    const out = deserialize(serialize(SAMPLE_STATE));
    expect(out).toEqual(SAMPLE_STATE);
  });

  it("round-trips an empty-defaults state", () => {
    const empty: GridEditorState = {
      columnOrder: [],
      hiddenColumns: [],
      columnWidths: {},
      sort: [],
      filters: [],
      frozenColumnCount: 0,
      scrollTop: 0,
      lastOpenedAt: 0,
    };
    expect(deserialize(serialize(empty))).toEqual(empty);
  });

  it("includes the schema version tag so future migrations can identify legacy payloads", () => {
    const json = serialize(SAMPLE_STATE);
    const parsed = JSON.parse(json) as { v: number };
    expect(parsed.v).toBe(CURRENT_VERSION);
  });
});

describe("deserialize() — forward + backward compat", () => {
  it("returns null on unparseable JSON (corrupt persisted blob)", () => {
    expect(deserialize("not json {")).toBeNull();
  });

  it("returns null on missing version field (treats as too-old to migrate)", () => {
    expect(deserialize(JSON.stringify({ columnOrder: ["a"] }))).toBeNull();
  });

  it("returns null on version higher than CURRENT_VERSION (forward-incompatible)", () => {
    const payload = { v: CURRENT_VERSION + 1, state: SAMPLE_STATE };
    expect(deserialize(JSON.stringify(payload))).toBeNull();
  });

  it("ignores unknown fields at the top level rather than failing", () => {
    const payload = {
      v: CURRENT_VERSION,
      state: SAMPLE_STATE,
      unrelatedFutureField: "ignore me",
    };
    expect(deserialize(JSON.stringify(payload))).toEqual(SAMPLE_STATE);
  });
});

describe("serialize() — defense-in-depth field allowlist (FR-039 + Constitution §Security)", () => {
  it("strips any field on the state object that is not in the layout-primitive allowlist", () => {
    const sneakedIn = {
      ...SAMPLE_STATE,
      cellData: [["secret", "row", "values"]], // simulated accidental cell-data spill
      bearerToken: "eyJhbGciOiJIUzI1NiC", // simulated credential leak
    } as unknown as GridEditorState;
    const out = deserialize(serialize(sneakedIn));
    expect(out).not.toBeNull();
    if (out) {
      expect(out).toEqual(SAMPLE_STATE);
      // Specifically: the spilled fields MUST NOT survive round-trip.
      const raw = JSON.parse(serialize(sneakedIn)) as Record<string, unknown>;
      const state = raw["state"] as Record<string, unknown>;
      expect("cellData" in state).toBe(false);
      expect("bearerToken" in state).toBe(false);
    }
  });

  it("strips unknown filter ops (defends against an injection attempt via persistence)", () => {
    // An attacker who can write to workspaceState shouldn't be able to
    // inject an arbitrary SQL fragment via the `op` field — the
    // serializer drops filters whose op isn't in the enum.
    const tainted = {
      ...SAMPLE_STATE,
      filters: [
        { column: "x", op: "eq", value: "1" }, // legitimate
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { column: "x", op: "; DROP TABLE users", value: "1" } as any,
      ],
    };
    const out = deserialize(serialize(tainted));
    expect(out?.filters.length).toBe(1);
    expect(out?.filters[0]?.op).toBe("eq");
  });

  it("strips negative widths and absurd values (the renderer's coercion would render badly)", () => {
    const tainted: GridEditorState = {
      ...SAMPLE_STATE,
      columnWidths: { id: -50, email: 240, total: 999_999 },
    };
    const out = deserialize(serialize(tainted));
    expect(out?.columnWidths["id"]).toBeUndefined(); // negative dropped
    expect(out?.columnWidths["email"]).toBe(240); // OK kept
    expect(out?.columnWidths["total"]).toBeUndefined(); // absurd dropped
  });
});

describe("applyDefaults()", () => {
  it("derives a sensible default state from a column descriptor", () => {
    const out = applyDefaults({
      columns: [
        { name: "id" },
        { name: "email" },
        { name: "created_at" },
      ],
    });
    expect(out.columnOrder).toEqual(["id", "email", "created_at"]);
    expect(out.hiddenColumns).toEqual([]);
    expect(out.sort).toEqual([]);
    expect(out.filters).toEqual([]);
    expect(out.frozenColumnCount).toBe(0);
    expect(out.scrollTop).toBe(0);
    // Should be valid for round-trip without any of the defense-in-depth
    // strips firing.
    expect(deserialize(serialize(out))).toEqual(out);
  });

  it("returns an empty-but-valid state when the descriptor has no columns", () => {
    const out = applyDefaults({ columns: [] });
    expect(out.columnOrder).toEqual([]);
    expect(out).toEqual(deserialize(serialize(out)));
  });
});
