import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { redact } from "../../src/pg/redact.js";

// Vitest runs from the repo root.
const fixturesDir = path.resolve(process.cwd(), "test/fixtures/redaction");

function loadPairs() {
  const inputs = readdirSync(fixturesDir).filter((f) => f.endsWith(".in.sql"));
  return inputs.map((f) => {
    const name = f.replace(/\.in\.sql$/, "");
    return {
      name,
      input: readFileSync(path.join(fixturesDir, f), "utf8"),
      expected: readFileSync(path.join(fixturesDir, `${name}.out.sql`), "utf8"),
    };
  });
}

describe("redact()", () => {
  const pairs = loadPairs();

  it("loads at least 7 fixture pairs (one per starter pattern)", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(7);
  });

  for (const { name, input, expected } of pairs) {
    it(`redacts fixture "${name}"`, () => {
      expect(redact(input)).toBe(expected);
    });
  }

  it("is idempotent: redact(redact(x)) === redact(x)", () => {
    for (const { input } of pairs) {
      const once = redact(input);
      const twice = redact(once);
      expect(twice).toBe(once);
    }
  });

  it("only changes input when a pattern matches", () => {
    const benign = "SELECT 1 FROM users WHERE id = $1;";
    expect(redact(benign)).toBe(benign);
  });

  it("treats output already containing the redaction token as a no-op for that span", () => {
    const already = "CREATE ROLE x WITH PASSWORD '***REDACTED***';";
    expect(redact(already)).toBe(already);
  });

  it("redacts under mixed case", () => {
    expect(redact("create role x with password 'secret'")).toContain("***REDACTED***");
    expect(redact("CREATE ROLE x WITH PASSWORD 'SECRET'")).toContain("***REDACTED***");
  });
});
