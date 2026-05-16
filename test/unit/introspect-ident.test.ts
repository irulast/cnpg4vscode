import { describe, expect, it } from "vitest";
import { qualifyIdent, quoteIdent, toStringArray } from "../../src/pg/introspect.js";

describe("quoteIdent()", () => {
  it("always quotes the identifier", () => {
    expect(quoteIdent("users")).toBe('"users"');
  });

  it("preserves mixed case and spaces", () => {
    expect(quoteIdent("My Table")).toBe('"My Table"');
  });

  it("doubles embedded double quotes", () => {
    expect(quoteIdent('Quote"In"Name')).toBe('"Quote""In""Name"');
  });
});

describe("qualifyIdent()", () => {
  it("produces schema.name with both parts quoted", () => {
    expect(qualifyIdent("public", "users")).toBe('"public"."users"');
  });

  it("handles unusual names safely", () => {
    expect(qualifyIdent("My Schema", "Quote\"Name")).toBe('"My Schema"."Quote""Name"');
  });
});

describe("toStringArray()", () => {
  it("returns [] for null / undefined", () => {
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
  });

  it("preserves a real JS array (happy path — pg parsed text[])", () => {
    expect(toStringArray(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(toStringArray([1, 2, 3])).toEqual(["1", "2", "3"]);
  });

  it("parses a Postgres array literal string (defensive fallback for name[])", () => {
    // This is what node-postgres returns when it has no parser for the
    // array's element type — historically caused the
    // `(r.from_columns ?? []).map is not a function` ER-diagram crash.
    expect(toStringArray("{user_id,tenant_id}")).toEqual(["user_id", "tenant_id"]);
    expect(toStringArray("{a,b,c}")).toEqual(["a", "b", "c"]);
  });

  it("handles the empty Postgres array literal '{}'", () => {
    expect(toStringArray("{}")).toEqual([]);
  });

  it("strips surrounding double quotes inside the array literal", () => {
    expect(toStringArray('{"My Col","Other"}')).toEqual(["My Col", "Other"]);
  });

  it("falls back to a single-element string array for any other scalar", () => {
    expect(toStringArray(42)).toEqual(["42"]);
  });
});
