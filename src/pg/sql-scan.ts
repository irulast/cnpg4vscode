/**
 * Shared SQL-lexer helpers used by the read-only gate
 * (`src/pg/readonly-gate.ts`) and the result-descriptor source-table
 * detector (`src/pg/result-descriptor.ts`).
 *
 * The functions here are PURELY lexical — they know about line comments
 * (--), block comments (/* … *\/), single-quoted strings, double-
 * quoted identifiers, and PostgreSQL dollar-quoted bodies ($$ … $$
 * and $tag$ … $tag$). They do NOT know SQL grammar; callers layer
 * keyword scanning on top.
 *
 * Extracted so the two consumers share the same definition of
 * "top-level" — a future bug fix in dollar-quote handling lands once,
 * not twice.
 */

export interface ScanOptions {
  /**
   * When true, quoted identifiers (`"…"`) are emitted to the output
   * verbatim, including the surrounding double-quotes. Use this for
   * scans that need to distinguish `"Order"` (an identifier) from
   * `Order` (a keyword).
   *
   * When false (the default), the body is emitted without the quote
   * marks — matches the readonly-gate's behavior, which is intentionally
   * conservative (a quoted identifier that happens to spell a write
   * keyword still triggers the embedded-write rule).
   */
  keepQuotedIdentifiers?: boolean;
}

/**
 * Strip comments and string bodies for keyword scanning. See ScanOptions
 * for the quoted-identifier knob.
 */
export function stripCommentsAndQuotesForScan(sql: string, opts: ScanOptions = {}): string {
  const keepQuotedIdent = opts.keepQuotedIdentifiers === true;
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    // -- line comment
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // /* block comment */ (PG block comments nest)
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
    // '…' single-quoted string — body dropped.
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    // "…" quoted identifier — body kept (with or without surrounding quotes).
    if (ch === '"') {
      if (keepQuotedIdent) out += '"';
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          out += '"';
          i += 2;
        } else if (sql[i] === '"') {
          if (keepQuotedIdent) out += '"';
          i++;
          break;
        } else {
          out += sql[i];
          i++;
        }
      }
      continue;
    }
    // $tag$ … $tag$ — dollar-quoted body, dropped.
    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
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

/** Detect a `$tag$` opening dollar-quote at `i`. */
function matchDollarTag(input: string, i: number): { closer: string; bodyStart: number } | null {
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

/**
 * True when the input contains a `;` that is not inside a comment /
 * string / dollar-quoted body. A trailing semicolon followed by only
 * whitespace returns false — that's a single statement with a
 * conventional terminator.
 */
export function containsTopLevelSemicolon(sql: string): boolean {
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
      const t = matchDollarTag(sql, i);
      if (t) {
        const closerIndex = sql.indexOf(t.closer, t.bodyStart);
        i = closerIndex < 0 ? n : closerIndex + t.closer.length;
        continue;
      }
    }
    if (ch === ";") {
      // Trailing semicolon is OK when nothing MEANINGFUL follows it —
      // trailing whitespace and comments don't count as a second
      // statement. Strip them and decide based on what's left.
      const tail = stripCommentsAndQuotesForScan(sql.slice(i + 1)).trim();
      if (tail.length === 0) return false;
      return true;
    }
    i++;
  }
  return false;
}
