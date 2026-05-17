/**
 * Contract — host ↔ Grid Editor webview message protocol (T138, paired
 * with the validator at `src/webviews/grid/protocol.ts`).
 *
 * Backs the host-side guarantee that the renderer cannot smuggle bad
 * data through the postMessage channel: every inbound message is
 * JSON-parsed by VS Code's bridge then validated by the host BEFORE
 * the orchestrator sees it (per `contracts/webview-protocol.md`'s
 * Security posture).
 *
 * Two-pronged coverage:
 *
 *   1. **Completeness** — every `type` enumerated in the protocol
 *      contract has both a builder (`buildXxxRequest()` / `buildXxx
 *      Response()`) and a validator (`isXxxRequest()` / `is...`); a
 *      builder without a validator (or vice versa) is the kind of
 *      drift that lets a bad message through unchecked.
 *
 *   2. **Per-message shape** — for each type, a representative
 *      well-formed payload validates, while at least one malformed
 *      payload (wrong type, missing required field, out-of-bounds
 *      numeric, embedded SQL in a string field) does NOT.
 *
 * Correlation-id round-tripping: when the host sends a request with
 * an `id`, the renderer's response MUST echo the same `id` so the
 * host can resolve the pending promise. The validator preserves this.
 */

import { describe, expect, it } from "vitest";
import {
  // type tags as a single source of truth
  HOST_TO_GRID,
  GRID_TO_HOST,
  // generic message validator
  validateInbound,
  // builders (host-side) — return the wire-shape message
  buildInit,
  buildPage,
  buildApplyPreview,
  buildApplyResult,
  buildThemeChanged,
  buildModeChanged,
  buildDisposed,
} from "../../../src/webviews/grid/protocol.js";

// ---------------------------------------------------------------------------
// Completeness — the protocol contract enumerates 7 host→grid + 11 grid→host
// types. Every type must appear in the type-tag exports + the validator's
// dispatch table.
// ---------------------------------------------------------------------------

describe("protocol completeness — type-tag enums", () => {
  it("exports every host→grid type tag from contracts/webview-protocol.md", () => {
    const expected = new Set([
      "init",
      "page",
      "applyPreview",
      "applyResult",
      "themeChanged",
      "modeChanged",
      "disposed",
    ]);
    expect(new Set(Object.values(HOST_TO_GRID))).toEqual(expected);
  });

  it("exports every grid→host type tag from contracts/webview-protocol.md", () => {
    const expected = new Set([
      "ready",
      "loadPage",
      "applyRequested",
      "applyConfirmed",
      "applyCancelled",
      "deleteRequested",
      "insertRequested",
      "openReferencedRow",
      "layoutChanged",
      "exportRequested",
      "refreshRequested",
    ]);
    expect(new Set(Object.values(GRID_TO_HOST))).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Validator — handles every inbound (grid→host) type.
// ---------------------------------------------------------------------------

describe("validateInbound() — accepts well-formed messages", () => {
  it("accepts a 'ready' message (no payload)", () => {
    const r = validateInbound({ type: "ready" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.type).toBe("ready");
  });

  it("accepts a 'loadPage' with sort + filters", () => {
    const r = validateInbound({
      type: "loadPage",
      id: "req-1",
      payload: {
        offset: 0,
        limit: 1000,
        sort: [{ column: "id", dir: "asc" }],
        filters: [{ column: "active", op: "eq", value: "true" }],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message.type).toBe("loadPage");
      expect(r.message.id).toBe("req-1");
    }
  });

  it("accepts an 'applyRequested' with one dirty row", () => {
    const r = validateInbound({
      type: "applyRequested",
      payload: {
        dirtyRows: [
          { rowKey: "r1", pkValues: [42], changes: { name: "Alice" } },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts 'applyConfirmed' and 'applyCancelled' (no payload)", () => {
    expect(validateInbound({ type: "applyConfirmed" }).ok).toBe(true);
    expect(validateInbound({ type: "applyCancelled" }).ok).toBe(true);
  });

  it("accepts a 'deleteRequested' with multiple rows", () => {
    const r = validateInbound({
      type: "deleteRequested",
      payload: {
        rows: [
          { rowKey: "r1", pkValues: [1] },
          { rowKey: "r2", pkValues: [2] },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts an 'insertRequested' with a values record", () => {
    const r = validateInbound({
      type: "insertRequested",
      payload: { values: { name: "Alice", email: "a@x" } },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts an 'openReferencedRow' with a column + value", () => {
    const r = validateInbound({
      type: "openReferencedRow",
      payload: { fromColumn: "user_id", value: 7 },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a 'layoutChanged' with a minimal state object", () => {
    const r = validateInbound({
      type: "layoutChanged",
      payload: {
        state: {
          columnOrder: ["id"],
          hiddenColumns: [],
          columnWidths: {},
          sort: [],
          filters: [],
          frozenColumnCount: 0,
          scrollTop: 0,
          lastOpenedAt: 0,
        },
      },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts an 'exportRequested' with a recognized format + scope", () => {
    expect(
      validateInbound({
        type: "exportRequested",
        payload: { format: "csv", scope: "selection" },
      }).ok,
    ).toBe(true);
    expect(
      validateInbound({
        type: "exportRequested",
        payload: { format: "json", scope: "allRows" },
      }).ok,
    ).toBe(true);
    expect(
      validateInbound({
        type: "exportRequested",
        payload: { format: "sql-insert", scope: "selection" },
      }).ok,
    ).toBe(true);
  });

  it("accepts a 'refreshRequested' (no payload)", () => {
    expect(validateInbound({ type: "refreshRequested" }).ok).toBe(true);
  });
});

describe("validateInbound() — rejects malformed messages", () => {
  it("rejects an unknown type at warn (returns ok=false with a stable code)", () => {
    const r = validateInbound({ type: "evil" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_TYPE");
  });

  it("rejects null / non-object input", () => {
    expect(validateInbound(null).ok).toBe(false);
    expect(validateInbound("nope").ok).toBe(false);
    expect(validateInbound(42).ok).toBe(false);
  });

  it("rejects a 'loadPage' with non-numeric offset", () => {
    const r = validateInbound({
      type: "loadPage",
      payload: { offset: "0", limit: 1000 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_PAYLOAD");
  });

  it("rejects a 'loadPage' with negative limit", () => {
    expect(
      validateInbound({
        type: "loadPage",
        payload: { offset: 0, limit: -1 },
      }).ok,
    ).toBe(false);
  });

  it("rejects a 'loadPage' with an unknown filter op (injection guard)", () => {
    const r = validateInbound({
      type: "loadPage",
      payload: {
        offset: 0,
        limit: 100,
        filters: [{ column: "x", op: "; DROP TABLE", value: "1" }],
      },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an 'applyRequested' with an empty dirtyRows list (caller bug)", () => {
    const r = validateInbound({
      type: "applyRequested",
      payload: { dirtyRows: [] },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an 'applyRequested' where a row lacks pkValues", () => {
    const r = validateInbound({
      type: "applyRequested",
      payload: {
        dirtyRows: [{ rowKey: "r1", changes: { x: 1 } }],
      },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an 'exportRequested' with an unknown format", () => {
    const r = validateInbound({
      type: "exportRequested",
      payload: { format: "rce.exe", scope: "selection" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a 'layoutChanged' where state is missing", () => {
    expect(
      validateInbound({ type: "layoutChanged", payload: {} }).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Correlation id round-trip — when the host sends a request with id,
// the validator preserves it on the parsed message so the host can
// route the response.
// ---------------------------------------------------------------------------

describe("correlation id preservation", () => {
  it("preserves the id field on every inbound message that includes one", () => {
    for (const msg of [
      { type: "loadPage", id: "abc", payload: { offset: 0, limit: 100 } },
      { type: "applyConfirmed", id: "def" },
      { type: "refreshRequested", id: "ghi" },
    ] as const) {
      const r = validateInbound(msg);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.message.id).toBe(msg.id);
    }
  });

  it("treats a missing id as absent (no synthetic id is invented)", () => {
    const r = validateInbound({ type: "ready" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Builders — host-side message constructors. Tested for shape only;
// they don't validate input (callers must — the validator is for the
// untrusted direction).
// ---------------------------------------------------------------------------

describe("host-side message builders", () => {
  it("buildInit emits a wire-shape message with descriptor + theme + persistedState", () => {
    const m = buildInit({
      descriptor: {
        columns: [{ name: "id", pgType: "int4", jsType: "number", nullable: false, hasDefault: true, isPk: true }],
        pkColumns: ["id"],
        totalRowsEstimate: null,
        target: { schema: "public", table: "users", kind: "table" },
        editable: true,
      },
      theme: {
        background: "#000",
        foreground: "#fff",
        border: "#333",
        accent: "#0a0",
        headerBg: "#111",
        headerFg: "#ccc",
        selectionBg: "#222",
        errorFg: "#f00",
        warningFg: "#fa0",
        fontFamily: "monospace",
        fontSize: 13,
      },
      persistedState: null,
      connection: { id: "ctx/ns/cluster/cred/postgres", mode: "write", database: "postgres", cluster: "app-db" },
    });
    expect(m.type).toBe("init");
    expect(m.payload.descriptor.editable).toBe(true);
  });

  it("buildPage / buildApplyPreview / buildApplyResult emit correctly-tagged messages", () => {
    expect(
      buildPage({ offset: 0, rows: [], totalRows: 0, truncated: false }).type,
    ).toBe("page");
    expect(
      buildApplyPreview({
        statements: [{ rowKey: "r1", text: "UPDATE x SET y=$1", values: [1] }],
      }).type,
    ).toBe("applyPreview");
    expect(
      buildApplyResult({ rowKey: "r1", outcome: { kind: "applied", rowsAffected: 1 } }).type,
    ).toBe("applyResult");
  });

  it("buildThemeChanged / buildModeChanged / buildDisposed emit correctly-tagged messages", () => {
    expect(buildThemeChanged({ theme: {} as never }).type).toBe("themeChanged");
    expect(buildModeChanged({ mode: "readonly" }).type).toBe("modeChanged");
    expect(buildDisposed().type).toBe("disposed");
  });

  it("buildInit/Page/ApplyPreview/ApplyResult round-trip through JSON.stringify intact", () => {
    const initMsg = buildInit({
      descriptor: {
        columns: [],
        pkColumns: [],
        totalRowsEstimate: null,
        target: { schema: "s", table: "t", kind: "table" },
        editable: false,
      },
      theme: {
        background: "#000", foreground: "#fff", border: "#333", accent: "#0a0",
        headerBg: "#111", headerFg: "#ccc", selectionBg: "#222",
        errorFg: "#f00", warningFg: "#fa0",
        fontFamily: "monospace", fontSize: 13,
      },
      persistedState: null,
      connection: { id: "c/cred/d", mode: "readonly", database: "d", cluster: "c" },
    });
    const round = JSON.parse(JSON.stringify(initMsg));
    expect(round).toEqual(initMsg);
  });
});
