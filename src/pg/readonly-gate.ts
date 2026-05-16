/**
 * Client-side read-only SQL gate (US4; FR-020, SC-008).
 *
 * The spec calls for a three-layer hybrid (research.md §9):
 *   1. client-side AST allowlist (this file, layer 1)
 *   2. server-side `SET LOCAL transaction_read_only=on` (src/pg/connection.ts)
 *   3. role recommendation (UX in the credential picker)
 *
 * This implementation uses a keyword/structure regex allowlist rather than a
 * full SQL AST parser. The trade-off is documented in plan.md § Complexity
 * Tracking and matches Constitution §V (Simplicity & YAGNI): start with the
 * simplest enforcement that meets SC-008, then upgrade to libpg_query when
 * a real bypass is observed. The server-side layer still catches anything
 * this allowlist lets through.
 *
 * The classifier strips line/block/dollar-quoted bodies before inspection so
 * a benign-looking `SELECT 'INSERT INTO ...'` is recognised as SELECT, not
 * rejected as INSERT.
 */

export type Classification =
  | { kind: "allowed" }
  | { kind: "rejected"; code: string; reason: string };

/** Top-level statement kinds we accept. */
const ALLOWED_FIRST_KEYWORDS = new Set([
  "SELECT",
  "WITH", // CTE — additionally checked for embedded writes
  "EXPLAIN",
  "SHOW",
  "VALUES",
  "TABLE",
]);

/** Tokens that always indicate a side effect. */
const WRITE_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "TRUNCATE",
  "DROP",
  "CREATE",
  "ALTER",
  "GRANT",
  "REVOKE",
  "CALL",
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "LOCK",
  "NOTIFY",
  "LISTEN",
  "UNLISTEN",
  "COPY",
  "DO",
  "REFRESH",
  "PREPARE",
  "DEALLOCATE",
  "DISCARD",
  "CHECKPOINT",
  "ANALYZE",
  "SECURITY",
  "COMMENT",
];

/** Transaction-control keywords — caller must not embed them in run-as-statement flows. */
const TRANSACTION_KEYWORDS = ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "START", "END"];

/** Function calls that mutate even from a SELECT context. */
const MUTATING_FUNCTIONS = [
  "nextval",
  "setval",
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_replication_origin_create",
  "pg_replication_origin_advance",
  "pg_logical_emit_message",
  "lo_create",
  "lo_unlink",
  "lo_import",
  "lo_export",
  "lo_put",
];

export function classify(sql: string): Classification {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { kind: "rejected", code: "EMPTY", reason: "Empty statement." };
  }

  // Reject multi-statement input — the caller must split first so each gate
  // pass operates on a single SQL command (this matches the run-query flow
  // and avoids a class of "second statement smuggled past the first" issues).
  if (containsTopLevelSemicolon(trimmed)) {
    return {
      kind: "rejected",
      code: "MULTI_STATEMENT",
      reason: "Run one statement at a time in read-only mode.",
    };
  }

  // Strip comments and quoted bodies for keyword scanning.
  const stripped = stripCommentsAndQuotes(trimmed).trim();
  const upper = stripped.toUpperCase();

  // Reject FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE / FOR KEY SHARE — even
  // on SELECT, these acquire locks (mutating side effects).
  if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/.test(upper)) {
    return {
      kind: "rejected",
      code: "ROW_LOCK",
      reason: "FOR UPDATE / FOR SHARE acquire row locks and are not permitted in read-only mode.",
    };
  }

  const firstWord = upper.match(/^[A-Z]+/)?.[0];
  if (!firstWord) {
    return { kind: "rejected", code: "NO_KEYWORD", reason: "No SQL keyword recognised." };
  }

  if (TRANSACTION_KEYWORDS.includes(firstWord)) {
    return {
      kind: "rejected",
      code: "TXN_CONTROL",
      reason: `Transaction control (${firstWord}) is managed by the extension, not the editor.`,
    };
  }

  if (!ALLOWED_FIRST_KEYWORDS.has(firstWord)) {
    return {
      kind: "rejected",
      code: `WRITE_${firstWord}`,
      reason: `Statement type ${firstWord} is not permitted in read-only mode. Toggle Write mode first.`,
    };
  }

  // Block EXPLAIN ANALYZE explicitly — ANALYZE executes the underlying plan.
  if (firstWord === "EXPLAIN" && /\bANALYZE\b/.test(upper)) {
    return {
      kind: "rejected",
      code: "EXPLAIN_ANALYZE",
      reason: "EXPLAIN ANALYZE executes the statement; use plain EXPLAIN in read-only mode.",
    };
  }

  // Scan for embedded write keywords (catches CTE-with-write, EXPLAIN of a
  // write, etc.). Look at whole-word matches only.
  for (const w of WRITE_KEYWORDS) {
    const re = new RegExp(`\\b${w}\\b`);
    if (re.test(upper)) {
      return {
        kind: "rejected",
        code: `EMBEDDED_${w}`,
        reason: `Embedded ${w} statement detected. Read-only mode rejects any side-effecting clause.`,
      };
    }
  }

  // Scan for mutating function calls.
  for (const fn of MUTATING_FUNCTIONS) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, "i");
    if (re.test(stripped)) {
      return {
        kind: "rejected",
        code: `MUTATING_FN_${fn.toUpperCase()}`,
        reason: `Function ${fn}() mutates state and is not permitted in read-only mode.`,
      };
    }
  }

  // SET is rejected (transaction-scope SETs would be ok, but mixing them in
  // a single-statement runner is a footgun; the connection layer issues its
  // own SET LOCAL where needed).
  if (firstWord === "SHOW") return { kind: "allowed" };
  return { kind: "allowed" };
}

function stripCommentsAndQuotes(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (ch === '"') {
      // Keep the body for identifier-aware checks elsewhere; drop quotes.
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          out += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          out += sql[i];
          i++;
        }
      }
      continue;
    }
    if (ch === "$") {
      const tag = matchTag(sql, i);
      if (tag) {
        const closer = tag.closer;
        const closerIndex = sql.indexOf(closer, tag.bodyStart);
        if (closerIndex < 0) {
          i = n;
        } else {
          i = closerIndex + closer.length;
        }
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function matchTag(input: string, i: number): { closer: string; bodyStart: number } | null {
  let j = i + 1;
  if (input[j] === "$") return { closer: "$$", bodyStart: j + 1 };
  const tagStart = j;
  const first = input[j];
  if (!first || !/[A-Za-z_]/.test(first)) return null;
  j++;
  while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j++;
  if (input[j] !== "$") return null;
  const tag = input.slice(tagStart, j);
  return { closer: `$${tag}$`, bodyStart: j + 1 };
}

function containsTopLevelSemicolon(sql: string): boolean {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (ch === "$") {
      const t = matchTag(sql, i);
      if (t) {
        const closerIndex = sql.indexOf(t.closer, t.bodyStart);
        i = closerIndex < 0 ? n : closerIndex + t.closer.length;
        continue;
      }
    }
    if (ch === ";") {
      // Trailing semicolon is OK when nothing meaningful follows it.
      const tail = sql.slice(i + 1).trim();
      if (tail.length === 0) return false;
      return true;
    }
    i++;
  }
  return false;
}
