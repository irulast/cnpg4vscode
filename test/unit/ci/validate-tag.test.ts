import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolve the script under test relative to repo root. Vitest's cwd is
// the repo root by default (vitest.config inherits from package.json).
const SCRIPT = "scripts/ci/validate-tag.mjs";

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

// Helper: invoke validate-tag.mjs against a temp dir that holds a
// fixture package.json. Returns the captured stdout/stderr/exit code.
function run(tag: string, packageJson: string | null): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "validate-tag-"));
  try {
    if (packageJson !== null) {
      writeFileSync(join(dir, "package.json"), packageJson);
    }
    const result = spawnSync("node", [join(process.cwd(), SCRIPT), tag], {
      cwd: dir,
      encoding: "utf8",
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? -1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PKG = (version: string): string =>
  JSON.stringify({ name: "cnpg4vscode", version }, null, 2);

describe("validate-tag.mjs", () => {
  it("accepts a stable tag and emits channel=stable", () => {
    const r = run("v0.2.0", PKG("0.2.0"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("channel=stable;version=0.2.0");
  });

  it("accepts a pre-release tag and emits channel=pre-release", () => {
    const r = run("v0.2.0-beta.1", PKG("0.2.0-beta.1"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("channel=pre-release;version=0.2.0-beta.1");
  });

  it("accepts a multi-component pre-release suffix (rc.2)", () => {
    const r = run("v1.0.0-rc.2", PKG("1.0.0-rc.2"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("channel=pre-release;version=1.0.0-rc.2");
  });

  it("rejects a tag without the v prefix (exit 1)", () => {
    const r = run("0.2.0", PKG("0.2.0"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FATAL|tag.*pattern/i);
  });

  it("rejects a SemVer-incomplete tag (missing patch) with exit 1", () => {
    const r = run("v0.2", PKG("0.2.0"));
    expect(r.status).toBe(1);
  });

  it("rejects a tag with extraneous segments (v0.2.0.1) with exit 1", () => {
    const r = run("v0.2.0.1", PKG("0.2.0.1"));
    expect(r.status).toBe(1);
  });

  it("rejects when tag version does not match package.json version (exit 2)", () => {
    const r = run("v0.2.0", PKG("0.1.9"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/version.*mismatch|0\.2\.0.*0\.1\.9/i);
  });

  it("rejects when tag is pre-release but package.json is stable (mismatch on suffix)", () => {
    const r = run("v0.2.0-beta.1", PKG("0.2.0"));
    expect(r.status).toBe(2);
  });

  it("exits 3 when package.json is missing", () => {
    const r = run("v0.2.0", null);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/package\.json/i);
  });

  it("exits 3 when package.json is unparseable JSON", () => {
    const r = run("v0.2.0", "{ not valid json");
    expect(r.status).toBe(3);
  });

  it("exits 3 when package.json is missing the version field", () => {
    const r = run("v0.2.0", JSON.stringify({ name: "cnpg4vscode" }));
    expect(r.status).toBe(3);
  });

  it("rejects an empty tag argument (exit 1)", () => {
    const r = run("", PKG("0.2.0"));
    expect(r.status).toBe(1);
  });
});
