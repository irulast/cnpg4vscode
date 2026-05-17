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
  // Note: the VS Code Marketplace rejects SemVer pre-release suffixes
  // in the version field. The tag's `-pre.<N>` suffix only signals
  // channel intent; the version that lands in package.json + on the
  // Marketplace is always plain `x.y.z`.

  it("accepts a stable tag and emits channel=stable + plain version", () => {
    const r = run("v0.2.0", PKG("0.2.0"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("channel=stable;version=0.2.0");
  });

  it("accepts a pre-release tag (-pre.<N>) and emits channel=pre-release + BASE version", () => {
    const r = run("v0.2.0-pre.1", PKG("0.2.0"));
    expect(r.status).toBe(0);
    // Note: the published version is "0.2.0" not "0.2.0-pre.1" —
    // the suffix is stripped because the Marketplace doesn't accept it.
    expect(r.stdout.trim()).toBe("channel=pre-release;version=0.2.0");
  });

  it("accepts -pre.N with N being any positive integer", () => {
    for (const n of [1, 2, 42, 100]) {
      const r = run(`v1.0.0-pre.${n}`, PKG("1.0.0"));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("channel=pre-release;version=1.0.0");
    }
  });

  it("rejects -beta, -rc, and other SemVer suffixes (only -pre.<N> supported)", () => {
    for (const tag of ["v0.2.0-beta.1", "v0.2.0-rc.1", "v0.2.0-alpha", "v0.2.0-snapshot"]) {
      const r = run(tag, PKG("0.2.0"));
      expect(r.status).toBe(1);
    }
  });

  it("rejects -pre without an iteration number", () => {
    const r = run("v0.2.0-pre", PKG("0.2.0"));
    expect(r.status).toBe(1);
  });

  it("rejects a tag without the v prefix (exit 1)", () => {
    const r = run("0.2.0", PKG("0.2.0"));
    expect(r.status).toBe(1);
  });

  it("rejects a SemVer-incomplete tag (missing patch) with exit 1", () => {
    const r = run("v0.2", PKG("0.2.0"));
    expect(r.status).toBe(1);
  });

  it("rejects a tag with extraneous segments (v0.2.0.1) with exit 1", () => {
    const r = run("v0.2.0.1", PKG("0.2.0"));
    expect(r.status).toBe(1);
  });

  it("rejects when tag base version does not match package.json#version (exit 2)", () => {
    const r = run("v0.2.0", PKG("0.1.9"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/version.*mismatch|0\.2\.0.*0\.1\.9/i);
  });

  it("pre-release tag's BASE version must match package.json (not the full -pre.N string)", () => {
    // v0.2.0-pre.1 with package.json#version "0.2.0" should PASS
    expect(run("v0.2.0-pre.1", PKG("0.2.0")).status).toBe(0);
    // v0.2.0-pre.1 with package.json#version "0.2.0-pre.1" should FAIL
    // (the version field must be plain SemVer per the Marketplace rule)
    expect(run("v0.2.0-pre.1", PKG("0.2.0-pre.1")).status).toBe(2);
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
