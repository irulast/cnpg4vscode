/**
 * Credential-literal redaction (Constitution §Security; spec FR-033, FR-034).
 *
 * This is the single chokepoint every log line, every history insert, and
 * every restored tab buffer passes through before reaching disk.
 *
 * Idempotent: `redact(redact(x)) === redact(x)`.
 */

const REDACTED = "***REDACTED***";

interface Rule {
  /** Human-readable name for debugging. */
  name: string;
  /** Regex with the literal capture group (or a special replace function). */
  pattern: RegExp;
  /** Replacement string referencing capture groups; or a function. */
  replacement: string | ((substr: string, ...args: unknown[]) => string);
}

// IMPORTANT: order matters. Function bodies must run first so credential
// patterns embedded in plpgsql bodies don't double-redact.
const RULES: ReadonlyArray<Rule> = [
  {
    name: "plpgsql-function-body",
    // $$ ... $$ — the body is replaced wholesale because functions frequently
    // embed dblink/dsn calls with credentials.
    pattern: /(\bLANGUAGE\s+\w+\s+AS\s+)\$\$[\s\S]*?\$\$/gi,
    replacement: `$1$$$$${REDACTED}$$$$`,
  },
  {
    name: "password-keyword",
    // PASSWORD 'literal' — covers CREATE ROLE, ALTER USER, WITH PASSWORD, ENCRYPTED PASSWORD.
    pattern: /(PASSWORD\s+)'[^']*'/gi,
    replacement: `$1'${REDACTED}'`,
  },
  {
    name: "identified-by",
    pattern: /(IDENTIFIED\s+BY\s+)'[^']*'/gi,
    replacement: `$1'${REDACTED}'`,
  },
  {
    name: "connection-string",
    // CREATE SUBSCRIPTION ... CONNECTION 'host=... password=...'
    pattern: /(\bCONNECTION\s+)'[^']*'/gi,
    replacement: `$1'${REDACTED}'`,
  },
  {
    name: "dsn-option",
    // OPTIONS (dsn '...'), OPTIONS (conninfo '...')
    pattern: /(\b(?:dsn|conninfo|connection_string)\s+)'[^']*'/gi,
    replacement: `$1'${REDACTED}'`,
  },
  {
    name: "kv-secret-token-apikey",
    // SECRET='...', TOKEN='...', API_KEY='...', AUTHORIZATION='...'
    pattern: /\b(SECRET|TOKEN|API[_-]?KEY|AUTHORIZATION)(\s*[:=]\s*)'[^']*'/gi,
    replacement: `$1$2'${REDACTED}'`,
  },
  {
    name: "bearer-token",
    // "Bearer <chars>" — chars exclude '*', so already-redacted text stays put.
    pattern: /(\bBearer\s+)[A-Za-z0-9._-]+/g,
    replacement: `$1${REDACTED}`,
  },
  {
    name: "libpq-dsn-url",
    // postgres://user:password@host — keep scheme + user, redact password.
    pattern: /(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+(@)/g,
    replacement: `$1${REDACTED}$2`,
  },
  {
    name: "pem-private-key",
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
];

export function redact(input: string): string {
  let out = input;
  for (const rule of RULES) {
    out = out.replace(
      rule.pattern,
      typeof rule.replacement === "function"
        ? (rule.replacement as never)
        : rule.replacement,
    );
  }
  return out;
}

/**
 * Returns true iff any pattern matches the input. Used in tests; not on a
 * hot path. Resets `lastIndex` for each rule since some are stateful (`/g`).
 */
export function isSensitive(input: string): boolean {
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (re.test(input)) return true;
  }
  return false;
}

/** Exposed only for the property test corpus tooling. */
export const REDACTION_TOKEN = REDACTED;
