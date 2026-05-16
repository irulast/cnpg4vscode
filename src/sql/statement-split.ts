/**
 * Split a SQL buffer into statements at top-level semicolons.
 *
 * Honors PostgreSQL lexical rules:
 *   - single-quoted strings ('...'), with no SQL-standard escape: `''` doubles
 *   - double-quoted identifiers ("..."), same doubling rule for `""`
 *   - dollar-quoted bodies ($$...$$ and $tag$...$tag$) — no escape inside
 *   - line comments (-- to end-of-line)
 *   - block comments delimited by slash-star and star-slash, arbitrarily
 *     nestable per PostgreSQL.
 */

interface Token {
  start: number;
  end: number;
  text: string;
}

export function splitStatements(input: string): string[] {
  const tokens = lexStatements(input);
  const out: string[] = [];
  for (const t of tokens) {
    const stripped = stripLeadingNoise(t.text).trim();
    if (stripped.length > 0) out.push(stripped);
  }
  return out;
}

export function statementAtOffset(
  input: string,
  offset: number,
): { text: string; start: number; end: number } | null {
  const tokens = lexStatements(input);
  for (const t of tokens) {
    if (offset >= t.start && offset < t.end) {
      const range = trimmedRange(input, t.start, t.end);
      if (!range) return null;
      const text = stripLeadingNoise(input.slice(range.start, range.end)).trim();
      if (text.length === 0) return null;
      return { text, start: range.start, end: range.end };
    }
  }
  return null;
}

/** Remove leading whitespace + line/block comments. Used so a comment block
 * doesn't end up at the head of an extracted statement. */
function stripLeadingNoise(input: string): string {
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "-" && input[i + 1] === "-") {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (input[i] === "/" && input[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (input[i] === "*" && input[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    break;
  }
  return input.slice(i);
}

/** Return the inner non-whitespace span [start, end) of input[start..end). */
function trimmedRange(
  input: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(input[s] ?? "")) s++;
  while (e > s && /\s/.test(input[e - 1] ?? "")) e--;
  if (s >= e) return null;
  return { start: s, end: e };
}

function lexStatements(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let segmentStart = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i]!;
    // Line comment
    if (ch === "-" && input[i + 1] === "-") {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    // Block comment (nestable)
    if (ch === "/" && input[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (input[i] === "/" && input[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (input[i] === "*" && input[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    // Single-quoted string
    if (ch === "'") {
      i++;
      while (i < n) {
        if (input[i] === "'" && input[i + 1] === "'") {
          i += 2;
        } else if (input[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    // Double-quoted identifier
    if (ch === '"') {
      i++;
      while (i < n) {
        if (input[i] === '"' && input[i + 1] === '"') {
          i += 2;
        } else if (input[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    // Dollar-quoted body — $tag$...$tag$
    if (ch === "$") {
      const tagMatch = matchDollarTag(input, i);
      if (tagMatch) {
        const closer = tagMatch.closer;
        i = tagMatch.bodyStart;
        const closerIndex = input.indexOf(closer, i);
        if (closerIndex < 0) {
          // Unterminated — skip to end so we don't loop.
          i = n;
        } else {
          i = closerIndex + closer.length;
        }
        continue;
      }
    }
    // Semicolon at top level — emit a segment
    if (ch === ";") {
      out.push({ start: segmentStart, end: i, text: input.slice(segmentStart, i) });
      i++;
      segmentStart = i;
      continue;
    }
    i++;
  }
  // Trailing segment without semicolon
  if (segmentStart < n) {
    out.push({ start: segmentStart, end: n, text: input.slice(segmentStart, n) });
  }
  return out;
}

function matchDollarTag(
  input: string,
  i: number,
): { closer: string; bodyStart: number } | null {
  // $$ ... $$ or $tag$ ... $tag$.
  // Tag chars: A-Z a-z 0-9 _ (no digits as first char per PostgreSQL).
  let j = i + 1;
  if (input[j] === "$") {
    return { closer: "$$", bodyStart: j + 1 };
  }
  const tagStart = j;
  if (j >= input.length) return null;
  const firstCh = input[j];
  if (!firstCh || !/[A-Za-z_]/.test(firstCh)) return null;
  j++;
  while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j++;
  if (input[j] !== "$") return null;
  const tag = input.slice(tagStart, j);
  return { closer: `$${tag}$`, bodyStart: j + 1 };
}
