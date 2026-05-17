import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/ci/scan-advisories.mjs");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

// Fixture shape mirrors `pnpm audit --json`'s top-level structure that
// we actually consume: per-advisory entries keyed by advisory id, with
// id, module_name, severity, url, title.
interface FakeAdvisory {
  id: number;
  module_name: string;
  severity: "info" | "low" | "moderate" | "high" | "critical";
  url: string;
  title: string;
}

function run(args: {
  advisories: FakeAdvisory[];
  allowlist: Array<{ advisoryId: number; justification: string; reviewedBy?: string; reviewedAt?: string }>;
}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "scan-adv-"));
  try {
    const auditPayload = {
      advisories: Object.fromEntries(args.advisories.map((a) => [String(a.id), a])),
      metadata: {
        vulnerabilities: {
          info: args.advisories.filter((a) => a.severity === "info").length,
          low: args.advisories.filter((a) => a.severity === "low").length,
          moderate: args.advisories.filter((a) => a.severity === "moderate").length,
          high: args.advisories.filter((a) => a.severity === "high").length,
          critical: args.advisories.filter((a) => a.severity === "critical").length,
          total: args.advisories.length,
        },
      },
    };
    writeFileSync(join(dir, "audit.json"), JSON.stringify(auditPayload));
    writeFileSync(
      join(dir, "allowlist.json"),
      JSON.stringify({ version: 1, allowed: args.allowlist }, null, 2),
    );
    const r = spawnSync(
      "node",
      [
        SCRIPT,
        "--audit-json", join(dir, "audit.json"),
        "--allowlist", join(dir, "allowlist.json"),
      ],
      { encoding: "utf8" },
    );
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HIGH_ADV = (id: number, name = "vulnerable-pkg"): FakeAdvisory => ({
  id, module_name: name, severity: "high",
  url: `https://github.com/advisories/GHSA-${id}`,
  title: `Sample high-severity vulnerability ${id}`,
});

describe("scan-advisories.mjs", () => {
  it("exits 0 when there are no advisories", () => {
    const r = run({ advisories: [], allowlist: [] });
    expect(r.status).toBe(0);
  });

  it("exits 1 when a HIGH advisory is not allowlisted", () => {
    const r = run({ advisories: [HIGH_ADV(1001)], allowlist: [] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("1001");
    expect(r.stderr).toMatch(/high/i);
  });

  it("exits 1 when a CRITICAL advisory is not allowlisted", () => {
    const r = run({
      advisories: [{ ...HIGH_ADV(1002), severity: "critical" }],
      allowlist: [],
    });
    expect(r.status).toBe(1);
  });

  it("exits 0 when the HIGH advisory IS allowlisted with a justification", () => {
    const r = run({
      advisories: [HIGH_ADV(1003)],
      allowlist: [{ advisoryId: 1003, justification: "false positive, upstream fix in v2" }],
    });
    expect(r.status).toBe(0);
  });

  it("exits 2 when allowlist entry has an empty justification (silent allowlist refused)", () => {
    const r = run({
      advisories: [HIGH_ADV(1004)],
      allowlist: [{ advisoryId: 1004, justification: "" }],
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/justification/i);
  });

  it("exits 2 when allowlist entry has only-whitespace justification", () => {
    const r = run({
      advisories: [HIGH_ADV(1005)],
      allowlist: [{ advisoryId: 1005, justification: "   \t  " }],
    });
    expect(r.status).toBe(2);
  });

  it("exits 3 when allowlist contains an entry no longer present in the audit (stale)", () => {
    const r = run({
      advisories: [],
      allowlist: [
        { advisoryId: 9999, justification: "no longer applies — keep until cleanup" },
      ],
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/stale|no longer/i);
  });

  it("ignores MODERATE and LOW advisories regardless of allowlist", () => {
    const r = run({
      advisories: [
        { ...HIGH_ADV(2001), severity: "moderate" },
        { ...HIGH_ADV(2002), severity: "low" },
        { ...HIGH_ADV(2003), severity: "info" },
      ],
      allowlist: [],
    });
    expect(r.status).toBe(0);
  });

  it("reports multiple offending HIGH advisories in one pass", () => {
    const r = run({
      advisories: [HIGH_ADV(3001, "pkg-a"), HIGH_ADV(3002, "pkg-b")],
      allowlist: [],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("3001");
    expect(r.stderr).toContain("3002");
    expect(r.stderr).toContain("pkg-a");
    expect(r.stderr).toContain("pkg-b");
  });

  it("partial allowlist: allowlisted one passes, the other still fails", () => {
    const r = run({
      advisories: [HIGH_ADV(4001), HIGH_ADV(4002)],
      allowlist: [{ advisoryId: 4001, justification: "false positive" }],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("4002");
    expect(r.stderr).not.toMatch(/4001 .*not allowlisted/);
  });

  it("exits 2 on invalid argv (missing --audit-json)", () => {
    const r = spawnSync("node", [SCRIPT, "--allowlist", "x.json"], { encoding: "utf8" });
    expect(r.status ?? -1).toBe(2);
  });
});
