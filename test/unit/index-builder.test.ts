/**
 * Unit tests for the pure CREATE INDEX builder (paired with T110's host glue).
 *
 * The builder is consumed by both the visual index editor (T110) and
 * any future migration-wizard helper that wants a structured "add an
 * index" step. Pure: no `pg`, no `vscode`.
 */

import { describe, expect, it } from "vitest";
import {
  buildCreateIndex,
  suggestIndexName,
  validateIndexSpec,
} from "../../src/sql/index-builder.js";

describe("buildCreateIndex() — basic shapes", () => {
  it("emits a single-column CREATE INDEX with quoted identifiers", () => {
    const r = buildCreateIndex({
      schema: "public",
      table: "users",
      name: "ix_users_email",
      columns: ["email"],
      unique: false,
    });
    expect(r.text).toBe(
      'CREATE INDEX "ix_users_email" ON "public"."users" ("email")',
    );
    expect(r.values).toEqual([]);
  });

  it("emits a multi-column index in user-specified order (NOT alphabetised)", () => {
    const r = buildCreateIndex({
      schema: "public",
      table: "orders",
      name: "ix_orders_user_created",
      // intentionally reverse-alphabetised — the index column order is
      // load-bearing for query planning, so the builder MUST preserve it.
      columns: ["user_id", "created_at"],
      unique: false,
    });
    expect(r.text).toBe(
      'CREATE INDEX "ix_orders_user_created" ON "public"."orders" ("user_id", "created_at")',
    );
  });

  it("emits CREATE UNIQUE INDEX when unique=true", () => {
    const r = buildCreateIndex({
      schema: "public",
      table: "users",
      name: "ux_users_email",
      columns: ["email"],
      unique: true,
    });
    expect(r.text).toBe(
      'CREATE UNIQUE INDEX "ux_users_email" ON "public"."users" ("email")',
    );
  });

  it("emits CREATE INDEX CONCURRENTLY when concurrent=true", () => {
    const r = buildCreateIndex({
      schema: "public",
      table: "users",
      name: "ix_users_email",
      columns: ["email"],
      unique: false,
      concurrent: true,
    });
    expect(r.text).toBe(
      'CREATE INDEX CONCURRENTLY "ix_users_email" ON "public"."users" ("email")',
    );
  });

  it("emits the WHERE clause for a partial index (verbatim — caller validated it)", () => {
    const r = buildCreateIndex({
      schema: "public",
      table: "users",
      name: "ix_users_active_email",
      columns: ["email"],
      unique: false,
      where: "active = true",
    });
    expect(r.text).toBe(
      'CREATE INDEX "ix_users_active_email" ON "public"."users" ("email") WHERE active = true',
    );
  });

  it("composes UNIQUE + CONCURRENTLY + partial in the correct keyword order", () => {
    const r = buildCreateIndex({
      schema: "analytics",
      table: "events",
      name: "ux_events_active_id",
      columns: ["event_id"],
      unique: true,
      concurrent: true,
      where: "deleted_at IS NULL",
    });
    expect(r.text).toBe(
      'CREATE UNIQUE INDEX CONCURRENTLY "ux_events_active_id" ON "analytics"."events" ("event_id") WHERE deleted_at IS NULL',
    );
  });
});

describe("buildCreateIndex() — identifier quoting edge cases", () => {
  it("quotes identifiers with embedded double quotes", () => {
    const r = buildCreateIndex({
      schema: 'My Schema',
      table: 'Order"Items',
      name: 'ix"_weird',
      columns: ['Total"Price'],
      unique: false,
    });
    expect(r.text).toBe(
      'CREATE INDEX "ix""_weird" ON "My Schema"."Order""Items" ("Total""Price")',
    );
  });
});

describe("suggestIndexName()", () => {
  it("suggests ix_<table>_<col> for a single-column index", () => {
    expect(
      suggestIndexName({ table: "users", columns: ["email"], unique: false }),
    ).toBe("ix_users_email");
  });

  it("suggests ux_<table>_<col> for a single-column UNIQUE index", () => {
    expect(
      suggestIndexName({ table: "users", columns: ["email"], unique: true }),
    ).toBe("ux_users_email");
  });

  it("joins multiple columns with underscores in user-specified order", () => {
    expect(
      suggestIndexName({
        table: "orders",
        columns: ["user_id", "created_at"],
        unique: false,
      }),
    ).toBe("ix_orders_user_id_created_at");
  });

  it("truncates to 63 chars (PostgreSQL's NAMEDATALEN limit)", () => {
    const longName = suggestIndexName({
      table: "very_long_table_name_with_lots_of_chars",
      columns: ["another_very_long_column_name", "and_yet_another_one"],
      unique: false,
    });
    expect(longName.length).toBeLessThanOrEqual(63);
  });

  it("normalises whitespace and special chars in identifiers to underscores", () => {
    expect(
      suggestIndexName({
        table: "Order Items",
        columns: ["Total Price"],
        unique: false,
      }),
    ).toBe("ix_order_items_total_price");
  });
});

describe("validateIndexSpec()", () => {
  it("accepts a minimal valid spec", () => {
    expect(
      validateIndexSpec({
        schema: "public",
        table: "users",
        name: "ix_users_email",
        columns: ["email"],
        unique: false,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects an empty column list", () => {
    const r = validateIndexSpec({
      schema: "public",
      table: "users",
      name: "ix_x",
      columns: [],
      unique: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NO_COLUMNS");
      expect(r.reason.toLowerCase()).toContain("column");
    }
  });

  it("rejects a duplicate column in the list", () => {
    const r = validateIndexSpec({
      schema: "public",
      table: "users",
      name: "ix_x",
      columns: ["email", "email"],
      unique: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DUPLICATE_COLUMN");
  });

  it("rejects an empty / whitespace-only name", () => {
    expect(
      validateIndexSpec({
        schema: "public",
        table: "users",
        name: "",
        columns: ["email"],
        unique: false,
      }).ok,
    ).toBe(false);
    expect(
      validateIndexSpec({
        schema: "public",
        table: "users",
        name: "   ",
        columns: ["email"],
        unique: false,
      }).ok,
    ).toBe(false);
  });

  it("rejects a name longer than PostgreSQL's 63-char limit", () => {
    const r = validateIndexSpec({
      schema: "public",
      table: "users",
      name: "x".repeat(64),
      columns: ["email"],
      unique: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NAME_TOO_LONG");
  });

  it("rejects a WHERE clause containing a semicolon (SQL-injection-shaped guard)", () => {
    const r = validateIndexSpec({
      schema: "public",
      table: "users",
      name: "ix_x",
      columns: ["email"],
      unique: false,
      where: "active = true; DROP TABLE users",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_WHERE");
  });
});
