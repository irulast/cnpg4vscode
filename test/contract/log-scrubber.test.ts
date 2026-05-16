/**
 * Contract — log-scrubber (T124, SC-006).
 *
 * Backs the spec's success criterion: "Across the full test run, the
 * LogOutputChannel surfaces ZERO credential literals (PASSWORD values,
 * bearer tokens, libpq DSN URLs, PEM private keys, kubeconfig contents,
 * function bodies that embed connection strings)."
 *
 * Strategy — drive every log helper with payloads that *do* contain
 * credential-shaped substrings, then snapshot the recent-log ring buffer
 * AND the captured channel-sink lines, and assert none of the original
 * credentials survive. The buffer stores exactly what reached the VS Code
 * LogOutputChannel (`write()` records `line` AFTER `redact()` runs and
 * BEFORE handing it to the channel), so this is the same bytes the user
 * would copy from the "CNPG: Report a Problem" command — and the same
 * bytes that show up in `output:cnpg4vscode` captures during
 * `@vscode/test-electron` runs.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Captured-line sink — populated by every level method on the stub channel.
type CapturedLine = { level: string; line: string };
const channelLines: CapturedLine[] = [];

vi.mock("vscode", () => {
  const make = (level: string) => (l: string) => {
    channelLines.push({ level, line: l });
  };
  return {
    window: {
      createOutputChannel: (_name: string, _opts?: unknown) => ({
        trace: make("trace"),
        debug: make("debug"),
        info: make("info"),
        warn: make("warn"),
        error: make("error"),
        dispose: () => {},
      }),
    },
  };
});

// Imported AFTER the mock is registered so the module's `import * as vscode`
// resolves to our stub.
import { initLog, disposeLog, log, snapshotRecentLog } from "../../src/logging/channel.js";

// Canary substrings that, if any survive into a captured log line, mean
// the scrubber failed. The corresponding `Rule.name` from src/pg/redact.ts
// is included so a failure points straight at the regression.
interface Canary {
  rule: string;
  literal: string;
  // The payload we'll log — chosen to land in the matching rule's regex.
  payload: string;
}

const CANARIES: ReadonlyArray<Canary> = [
  {
    rule: "password-keyword",
    literal: "p@ssw0rd-CANARY-001",
    payload: "CREATE ROLE alice WITH PASSWORD 'p@ssw0rd-CANARY-001'",
  },
  {
    rule: "password-keyword (ENCRYPTED)",
    literal: "p@ssw0rd-CANARY-002",
    payload: "ALTER USER bob WITH ENCRYPTED PASSWORD 'p@ssw0rd-CANARY-002'",
  },
  {
    rule: "identified-by",
    literal: "secret-CANARY-003",
    payload: "CREATE USER carol IDENTIFIED BY 'secret-CANARY-003'",
  },
  {
    rule: "connection-string",
    literal: "host=db password=CANARY-004 user=x",
    payload:
      "CREATE SUBSCRIPTION s CONNECTION 'host=db password=CANARY-004 user=x' PUBLICATION p",
  },
  {
    rule: "dsn-option",
    literal: "host=remote password=CANARY-005",
    payload:
      "CREATE SERVER s FOREIGN DATA WRAPPER w OPTIONS (dsn 'host=remote password=CANARY-005')",
  },
  {
    rule: "kv-secret-token-apikey (SECRET=)",
    literal: "sk-live-CANARY-006",
    payload: "options={SECRET='sk-live-CANARY-006'}",
  },
  {
    rule: "kv-secret-token-apikey (TOKEN=)",
    literal: "ghp_CANARY-007",
    payload: "headers={TOKEN='ghp_CANARY-007'}",
  },
  {
    rule: "kv-secret-token-apikey (API_KEY=)",
    literal: "AKIA-CANARY-008",
    payload: "params={API_KEY='AKIA-CANARY-008'}",
  },
  {
    rule: "bearer-token",
    literal: "eyJhbGciOiJIUzI1NiCANARY009.signature",
    payload: "Authorization: Bearer eyJhbGciOiJIUzI1NiCANARY009.signature",
  },
  {
    rule: "libpq-dsn-url",
    literal: "postgresql://u:secret-CANARY-010@host:5432/db",
    payload: "connecting to postgresql://u:secret-CANARY-010@host:5432/db",
  },
  {
    rule: "pem-private-key",
    literal:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEACANARY011\n-----END RSA PRIVATE KEY-----",
    payload:
      "client cert blob: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEACANARY011\n-----END RSA PRIVATE KEY-----",
  },
  {
    rule: "plpgsql-function-body (embedded credential)",
    // The function body wrapper redaction wipes the whole body, so the
    // password literal inside MUST disappear too.
    literal: "embedded-CANARY-012",
    payload:
      "CREATE FUNCTION secret_fn() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM dblink('host=h password=embedded-CANARY-012', 'select 1'); END; $$",
  },
];

describe("SC-006 — log scrubber (full-run credential survey)", () => {
  beforeAll(() => {
    initLog();
    // Drive every log helper with every canary payload at every level
    // exactly once so the per-canary assertions below all have a populated
    // buffer to inspect.
    for (const c of CANARIES) {
      log.trace("trace.test", { reason: c.payload });
      log.debug("debug.test", { reason: c.payload });
      log.info("info.test", { reason: c.payload });
      log.warn("warn.test", { reason: c.payload });
      log.error("error.test", { reason: c.payload });
    }
  });

  afterAll(() => {
    disposeLog();
    channelLines.length = 0;
  });

  it("the test actually drove the logger (sanity)", () => {
    expect(snapshotRecentLog().length).toBeGreaterThan(0);
    expect(channelLines.length).toBeGreaterThan(0);
  });

  for (const c of CANARIES) {
    it(`scrubs ${c.rule} before reaching the recent-log buffer`, () => {
      const recent = snapshotRecentLog();
      for (const entry of recent) {
        if (entry.line.includes(c.literal)) {
          throw new Error(
            `SC-006 violation — literal "${c.literal}" (rule: ${c.rule}) survived into the log buffer: ${entry.line}`,
          );
        }
      }
    });

    it(`scrubs ${c.rule} before reaching the VS Code channel sink`, () => {
      for (const entry of channelLines) {
        if (entry.line.includes(c.literal)) {
          throw new Error(
            `SC-006 violation — literal "${c.literal}" (rule: ${c.rule}) reached the channel sink: ${entry.line}`,
          );
        }
      }
    });
  }

  it("the scrubber actually fired (at least one line contains the REDACTED marker)", () => {
    // Loose sanity check that the scrubber is actually firing — if every
    // line came through verbatim because the rules silently no-op'd, the
    // per-canary checks above would still pass on a payload that didn't
    // match any rule. This ensures we exercised the rules.
    const recent = snapshotRecentLog();
    const anyRedacted = recent.some((e) => e.line.includes("***REDACTED***"));
    expect(anyRedacted).toBe(true);
  });

  it("recent-log buffer is bounded — never exceeds the documented cap", () => {
    // The doc-stated cap is 200 lines; drive well past it then verify.
    for (let i = 0; i < 250; i++) log.info("flood", { i });
    expect(snapshotRecentLog().length).toBeLessThanOrEqual(200);
  });
});
