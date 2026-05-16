/**
 * Unit tests for the pure ALTER TABLE ADD CONSTRAINT builder (paired
 * with T111's host glue).
 *
 * Supports four constraint kinds — PRIMARY KEY, UNIQUE, FOREIGN KEY,
 * CHECK — matching the spec scope. The builder is pure (no `pg`,
 * no `vscode`); the host gathers user input via QuickPick/InputBox.
 */

import { describe, expect, it } from "vitest";
import {
  buildAddConstraint,
  suggestConstraintName,
  validateConstraintSpec,
} from "../../src/sql/constraint-builder.js";

describe("buildAddConstraint() — PRIMARY KEY", () => {
  it("emits a single-column PK", () => {
    const r = buildAddConstraint({
      kind: "primaryKey",
      schema: "public",
      table: "users",
      name: "pk_users",
      columns: ["id"],
    });
    expect(r.text).toBe(
      'ALTER TABLE "public"."users" ADD CONSTRAINT "pk_users" PRIMARY KEY ("id")',
    );
    expect(r.values).toEqual([]);
  });

  it("emits a composite PK preserving column order", () => {
    const r = buildAddConstraint({
      kind: "primaryKey",
      schema: "analytics",
      table: "events_daily",
      name: "pk_events_daily",
      columns: ["tenant_id", "event_id"],
    });
    expect(r.text).toBe(
      'ALTER TABLE "analytics"."events_daily" ADD CONSTRAINT "pk_events_daily" PRIMARY KEY ("tenant_id", "event_id")',
    );
  });
});

describe("buildAddConstraint() — UNIQUE", () => {
  it("emits a single-column UNIQUE constraint", () => {
    const r = buildAddConstraint({
      kind: "unique",
      schema: "public",
      table: "users",
      name: "uq_users_email",
      columns: ["email"],
    });
    expect(r.text).toBe(
      'ALTER TABLE "public"."users" ADD CONSTRAINT "uq_users_email" UNIQUE ("email")',
    );
  });

  it("emits a multi-column UNIQUE constraint", () => {
    const r = buildAddConstraint({
      kind: "unique",
      schema: "public",
      table: "memberships",
      name: "uq_memberships",
      columns: ["user_id", "group_id"],
    });
    expect(r.text).toBe(
      'ALTER TABLE "public"."memberships" ADD CONSTRAINT "uq_memberships" UNIQUE ("user_id", "group_id")',
    );
  });
});

describe("buildAddConstraint() — FOREIGN KEY", () => {
  it("emits a basic single-column FK with default actions", () => {
    const r = buildAddConstraint({
      kind: "foreignKey",
      schema: "public",
      table: "posts",
      name: "fk_posts_user",
      columns: ["user_id"],
      references: {
        schema: "public",
        table: "users",
        columns: ["id"],
      },
    });
    expect(r.text).toBe(
      'ALTER TABLE "public"."posts" ADD CONSTRAINT "fk_posts_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id")',
    );
  });

  it("emits a composite FK preserving both sides' column order", () => {
    const r = buildAddConstraint({
      kind: "foreignKey",
      schema: "public",
      table: "child",
      name: "fk_child_parent",
      columns: ["pa", "pb"],
      references: { schema: "public", table: "parent", columns: ["pa", "pb"] },
    });
    expect(r.text).toBe(
      'ALTER TABLE "public"."child" ADD CONSTRAINT "fk_child_parent" FOREIGN KEY ("pa", "pb") REFERENCES "public"."parent" ("pa", "pb")',
    );
  });

  it("emits ON UPDATE / ON DELETE actions when supplied", () => {
    const r = buildAddConstraint({
      kind: "foreignKey",
      schema: "public",
      table: "posts",
      name: "fk_posts_user",
      columns: ["user_id"],
      references: {
        schema: "public",
        table: "users",
        columns: ["id"],
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
    });
    expect(r.text).toBe(
      'ALTER TABLE "public"."posts" ADD CONSTRAINT "fk_posts_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON UPDATE CASCADE ON DELETE SET NULL',
    );
  });

  it("omits action clauses when their value is 'NO ACTION' (the PG default)", () => {
    const r = buildAddConstraint({
      kind: "foreignKey",
      schema: "public",
      table: "posts",
      name: "fk_posts_user",
      columns: ["user_id"],
      references: {
        schema: "public",
        table: "users",
        columns: ["id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
      },
    });
    expect(r.text).toBe(
      'ALTER TABLE "public"."posts" ADD CONSTRAINT "fk_posts_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id")',
    );
  });
});

describe("buildAddConstraint() — CHECK", () => {
  it("emits a CHECK with the predicate verbatim", () => {
    const r = buildAddConstraint({
      kind: "check",
      schema: "public",
      table: "products",
      name: "ck_products_positive_price",
      expression: "price > 0",
    });
    expect(r.text).toBe(
      'ALTER TABLE "public"."products" ADD CONSTRAINT "ck_products_positive_price" CHECK (price > 0)',
    );
  });
});

describe("suggestConstraintName()", () => {
  it("prefixes pk_ for PRIMARY KEY", () => {
    expect(
      suggestConstraintName({ kind: "primaryKey", table: "users", columns: ["id"] }),
    ).toBe("pk_users");
  });

  it("prefixes uq_ for UNIQUE", () => {
    expect(
      suggestConstraintName({
        kind: "unique",
        table: "users",
        columns: ["email"],
      }),
    ).toBe("uq_users_email");
  });

  it("prefixes fk_ for FOREIGN KEY and incorporates the referenced table", () => {
    expect(
      suggestConstraintName({
        kind: "foreignKey",
        table: "posts",
        columns: ["user_id"],
        referencedTable: "users",
      }),
    ).toBe("fk_posts_users");
  });

  it("prefixes ck_ for CHECK and incorporates the columns when supplied", () => {
    expect(
      suggestConstraintName({
        kind: "check",
        table: "products",
        columns: ["price"],
      }),
    ).toBe("ck_products_price");
  });

  it("truncates to 63 chars (PostgreSQL NAMEDATALEN)", () => {
    const n = suggestConstraintName({
      kind: "primaryKey",
      table: "x".repeat(40),
      columns: ["y".repeat(40)],
    });
    expect(n.length).toBeLessThanOrEqual(63);
  });
});

describe("validateConstraintSpec()", () => {
  it("rejects an empty name", () => {
    const r = validateConstraintSpec({
      kind: "unique",
      schema: "s",
      table: "t",
      name: "",
      columns: ["x"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EMPTY_NAME");
  });

  it("rejects a name longer than 63 chars", () => {
    const r = validateConstraintSpec({
      kind: "unique",
      schema: "s",
      table: "t",
      name: "x".repeat(64),
      columns: ["x"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NAME_TOO_LONG");
  });

  it("rejects PK/UNIQUE/FK with no columns", () => {
    for (const kind of ["primaryKey", "unique"] as const) {
      const r = validateConstraintSpec({
        kind,
        schema: "s",
        table: "t",
        name: "n",
        columns: [],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("NO_COLUMNS");
    }
    const fk = validateConstraintSpec({
      kind: "foreignKey",
      schema: "s",
      table: "t",
      name: "n",
      columns: [],
      references: { schema: "s", table: "p", columns: ["id"] },
    });
    expect(fk.ok).toBe(false);
  });

  it("rejects PK/UNIQUE with duplicate columns", () => {
    const r = validateConstraintSpec({
      kind: "unique",
      schema: "s",
      table: "t",
      name: "n",
      columns: ["a", "a"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DUPLICATE_COLUMN");
  });

  it("rejects FK where local-column and referenced-column counts differ", () => {
    const r = validateConstraintSpec({
      kind: "foreignKey",
      schema: "s",
      table: "t",
      name: "n",
      columns: ["a", "b"],
      references: { schema: "s", table: "p", columns: ["id"] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FK_ARITY_MISMATCH");
  });

  it("rejects CHECK with empty expression", () => {
    const r = validateConstraintSpec({
      kind: "check",
      schema: "s",
      table: "t",
      name: "n",
      expression: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EMPTY_EXPRESSION");
  });

  it("rejects CHECK with a bare semicolon (SQL-injection guard)", () => {
    const r = validateConstraintSpec({
      kind: "check",
      schema: "s",
      table: "t",
      name: "n",
      expression: "x > 0; DROP TABLE t",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_EXPRESSION");
  });

  it("accepts a valid spec for every kind", () => {
    expect(
      validateConstraintSpec({
        kind: "primaryKey",
        schema: "s",
        table: "t",
        name: "n",
        columns: ["id"],
      }).ok,
    ).toBe(true);
    expect(
      validateConstraintSpec({
        kind: "unique",
        schema: "s",
        table: "t",
        name: "n",
        columns: ["a", "b"],
      }).ok,
    ).toBe(true);
    expect(
      validateConstraintSpec({
        kind: "foreignKey",
        schema: "s",
        table: "t",
        name: "n",
        columns: ["pid"],
        references: { schema: "s", table: "p", columns: ["id"] },
      }).ok,
    ).toBe(true);
    expect(
      validateConstraintSpec({
        kind: "check",
        schema: "s",
        table: "t",
        name: "n",
        expression: "x > 0",
      }).ok,
    ).toBe(true);
  });
});
