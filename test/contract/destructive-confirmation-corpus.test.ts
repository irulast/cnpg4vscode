/**
 * Contract — destructive-confirmation corpus (T127, SC-009).
 *
 * Backs the spec's success criterion: "Every DROP / TRUNCATE / REINDEX /
 * destructive-ALTER command requires typed-name confirmation; the modal
 * blocks until the user types the fully-qualified target name exactly."
 *
 * Two-pronged assertion:
 *
 * 1. **Behavior** — run a representative corpus of (operation, target)
 *    pairs through the same `validateTypedName()` gate that the
 *    confirm-modal's OK button keys off of, and assert:
 *      - empty / whitespace / partial / wrong-case all reject;
 *      - only the byte-exact target accepts.
 *    This is the gate behind `confirmDestructive({requireTypedName: true})`
 *    — see src/ui/confirm.ts. If `validateTypedName` returns null only on
 *    an exact match, the modal cannot resolve `true` without an exact
 *    match.
 *
 * 2. **Wiring** — scan `src/commands/schema-actions.ts` for every
 *    destructive code path (anything that appends a DROP / TRUNCATE /
 *    REINDEX cell to the active notebook). For each, prove that the same
 *    code path also invokes `confirmDestructive` somewhere above the
 *    `appendCellToActiveNotebook` call. This catches a regression where
 *    a future PR adds a new destructive verb but forgets the gate.
 *
 * The wiring scan is intentionally textual — running the real commands
 * needs the VS Code host. The text scan is good enough to catch the
 * "you forgot the gate" failure mode that SC-009 cares about.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateTypedName } from "../../src/ui/confirm-validate.js";

// ---------------------------------------------------------------------------
// Part 1 — behavior corpus
// ---------------------------------------------------------------------------

interface DestructiveOp {
  /** Free-text operation name shown in the modal title. */
  operation: string;
  /** Fully-qualified target identifier the user must retype to confirm. */
  target: string;
  /** Free-text rationale for the corpus reader; not asserted. */
  why: string;
}

const CORPUS: ReadonlyArray<DestructiveOp> = [
  // --- DROP family ---
  { operation: "DROP TABLE", target: "public.users", why: "common drop" },
  { operation: "DROP TABLE", target: "public.orders", why: "common drop" },
  { operation: "DROP TABLE", target: "analytics.events_2026_05", why: "schema-qualified table" },
  {
    operation: "DROP TABLE",
    target: 'public."Order Items"',
    why: "quoted identifier with whitespace",
  },
  {
    operation: "DROP TABLE",
    target: 'public."SELECT"',
    why: "quoted identifier that is a SQL keyword",
  },
  { operation: "DROP VIEW", target: "reporting.daily_summary", why: "view drop" },
  {
    operation: "DROP MATERIALIZED VIEW",
    target: "reporting.mv_daily",
    why: "materialized-view drop",
  },
  { operation: "DROP INDEX", target: "public.ix_users_email", why: "index drop" },
  { operation: "DROP INDEX", target: "public.ix_orders_user_created", why: "composite-index drop" },
  { operation: "DROP SCHEMA", target: "scratch", why: "whole-schema drop (cascading)" },
  { operation: "DROP SEQUENCE", target: "public.user_id_seq", why: "sequence drop" },
  { operation: "DROP TYPE", target: "public.address_t", why: "type drop" },
  { operation: "DROP FUNCTION", target: "public.compute_total(int)", why: "function with args" },
  { operation: "DROP TRIGGER", target: "public.users_audit", why: "trigger drop" },

  // --- TRUNCATE family ---
  { operation: "TRUNCATE", target: "public.users", why: "single-table truncate" },
  { operation: "TRUNCATE", target: "analytics.events", why: "schema-qualified truncate" },
  { operation: "TRUNCATE", target: 'public."Order Items"', why: "quoted identifier truncate" },

  // --- REINDEX family ---
  { operation: "REINDEX TABLE", target: "public.users", why: "REINDEX TABLE" },
  { operation: "REINDEX INDEX", target: "public.ix_users_email", why: "REINDEX INDEX" },
  {
    operation: "REINDEX INDEX",
    target: "analytics.ix_events_user_ts",
    why: "REINDEX of composite index",
  },

  // --- Destructive ALTER ---
  // The scaffold-ALTER flow itself does NOT auto-execute (the user edits
  // before running), but if/when destructive ALTERs are wired through
  // confirmDestructive directly (e.g. ALTER TABLE DROP COLUMN), the same
  // validateTypedName gate applies. The corpus exercises that gate.
  { operation: "ALTER TABLE DROP COLUMN", target: "public.users", why: "destructive ALTER" },
  {
    operation: "ALTER TABLE DROP CONSTRAINT",
    target: "public.orders",
    why: "destructive ALTER",
  },
  { operation: "ALTER TABLE SET UNLOGGED", target: "public.users", why: "destructive ALTER" },
  { operation: "ALTER SCHEMA RENAME TO", target: "scratch", why: "rename schema" },
  { operation: "ALTER ROLE NOLOGIN", target: "app_user", why: "auth-breaking ALTER" },

  // --- Edge: identifiers with characters that can throw off naive prompts ---
  { operation: "DROP TABLE", target: "public.t-with-dash", why: "dashed identifier (unquoted is illegal in PG but the gate must still compare bytes verbatim)" },
  { operation: "DROP TABLE", target: 'public."tab\twith\ttab"', why: "tabs in quoted identifier" },
  { operation: "DROP TABLE", target: "public.unicode_table_ñ", why: "non-ASCII identifier" },
  { operation: "DROP TABLE", target: "public.t_with_'_apos", why: "apostrophe in identifier" },
];

describe("SC-009 — destructive-confirmation corpus (≥25 representative ops)", () => {
  it("the corpus is large enough to satisfy SC-009's representativeness bar", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(25);
  });

  for (const op of CORPUS) {
    describe(`${op.operation} on ${op.target}`, () => {
      it("rejects an empty input (modal stays blocked)", () => {
        expect(validateTypedName("", op.target)).not.toBeNull();
      });
      it("rejects whitespace-only input", () => {
        expect(validateTypedName("   ", op.target)).not.toBeNull();
        expect(validateTypedName("\t\n", op.target)).not.toBeNull();
      });
      it("rejects a partial match (prefix)", () => {
        if (op.target.length <= 1) return; // skip degenerate
        const partial = op.target.slice(0, Math.max(1, op.target.length - 1));
        expect(validateTypedName(partial, op.target)).not.toBeNull();
      });
      it("rejects a partial match (suffix only)", () => {
        if (op.target.length <= 1) return; // skip degenerate
        const tail = op.target.slice(1);
        expect(validateTypedName(tail, op.target)).not.toBeNull();
      });
      it("rejects a wrong-case variant (identifier comparison is byte-exact)", () => {
        const altered = op.target === op.target.toUpperCase()
          ? op.target.toLowerCase()
          : op.target.toUpperCase();
        if (altered === op.target) return; // skip if no case-distinct variant exists
        expect(validateTypedName(altered, op.target)).not.toBeNull();
      });
      it("rejects a similar-but-different target (typo)", () => {
        // Replace the first char with `X` (or, if already X, `Y`).
        const first = op.target[0]!;
        const swap = first === "X" ? "Y" : "X";
        const typo = swap + op.target.slice(1);
        if (typo === op.target) return;
        expect(validateTypedName(typo, op.target)).not.toBeNull();
      });
      it("accepts the byte-exact target (the only path that resolves the modal)", () => {
        expect(validateTypedName(op.target, op.target)).toBeNull();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Part 2 — wiring scan
// ---------------------------------------------------------------------------

describe("SC-009 — wiring (every destructive code path routes through confirmDestructive)", () => {
  const schemaActionsPath = path.resolve(
    process.cwd(),
    "src/commands/schema-actions.ts",
  );

  it("the source file exists", () => {
    expect(fs.existsSync(schemaActionsPath)).toBe(true);
  });

  it("imports confirmDestructive (the central gate)", () => {
    const src = fs.readFileSync(schemaActionsPath, "utf8");
    expect(src).toMatch(/from\s+"\.\.\/ui\/confirm\.js"/);
    expect(src).toMatch(/\bconfirmDestructive\b/);
  });

  it("every dropNode / truncateRelation / reindexNode body calls confirmDestructive before appending a destructive cell", () => {
    const src = fs.readFileSync(schemaActionsPath, "utf8");
    const destructiveFns = ["dropNode", "truncateRelation", "reindexNode"] as const;
    for (const fn of destructiveFns) {
      const match = src.match(
        new RegExp(
          `export\\s+async\\s+function\\s+${fn}\\b[^{]*\\{([\\s\\S]*?)^\\}`,
          "m",
        ),
      );
      if (!match) {
        throw new Error(`Could not locate function body for ${fn} in ${schemaActionsPath}`);
      }
      const body = match[1]!;
      const callsConfirm = body.includes("confirmDestructive");
      const callsAppend = body.includes("appendCellToActiveNotebook");
      if (callsAppend && !callsConfirm) {
        throw new Error(
          `SC-009 wiring regression: ${fn}() appends a destructive cell without calling confirmDestructive`,
        );
      }
      // The confirm call must appear before the append (source-text order).
      const confirmIdx = body.indexOf("confirmDestructive");
      const appendIdx = body.indexOf("appendCellToActiveNotebook");
      if (callsConfirm && callsAppend && confirmIdx > appendIdx) {
        throw new Error(
          `SC-009 wiring regression: ${fn}() appends a destructive cell BEFORE calling confirmDestructive`,
        );
      }
      // The function must also guard on the confirm result and bail when false.
      if (callsConfirm && !/if\s*\(\s*!\s*ok\s*\)\s*return/.test(body)) {
        throw new Error(
          `SC-009 wiring regression: ${fn}() does not bail on a negative confirm result (missing 'if (!ok) return')`,
        );
      }
    }
  });

  it("every destructive call site sources requireTypedName from cnpg4vscode.confirmation.requireTypedName (no hard-coded false)", () => {
    const src = fs.readFileSync(schemaActionsPath, "utf8");
    // Sanity: there should be at least 3 destructive call sites (drop,
    // truncate, reindex).
    const calls = [...src.matchAll(/confirmDestructive\s*\(/g)].length;
    expect(calls).toBeGreaterThanOrEqual(3);

    // For each `requireTypedName:` value in the file, assert it is NOT a
    // hard-coded `false` — that would silently bypass the gate. A
    // single-source-of-truth `requireTyped` variable derived from the
    // config setting is the accepted shape.
    const valueRe = /requireTypedName:\s*([^,}\n]+)/g;
    let valueMatches = 0;
    for (const m of src.matchAll(valueRe)) {
      valueMatches++;
      const value = m[1]!.trim();
      if (value === "false") {
        throw new Error(
          "SC-009 wiring regression: requireTypedName hard-coded to false (silent bypass)",
        );
      }
    }
    expect(valueMatches).toBeGreaterThanOrEqual(calls);

    // And the derivation itself must trace back to the setting.
    const requireTypedDefRe =
      /const\s+requireTyped\s*=[\s\S]*?confirmation\.requireTypedName/;
    expect(requireTypedDefRe.test(src)).toBe(true);
  });
});
