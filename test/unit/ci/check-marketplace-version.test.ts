import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/ci/check-marketplace-version.mjs");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Invoke check-marketplace-version.mjs with a fake `vsce` binary on
 * PATH. The fake vsce reads the fixture's `vsce-stub.json` and prints
 * it to stdout, or exits non-zero based on the fixture's `mode` field.
 *
 * The script under test spawns `vsce show <pub>.<ext> --json` (or its
 * `npx --no @vscode/vsce` equivalent), and the contract says it MUST
 * locate vsce on PATH. We control PATH so the fake wins.
 */
function run(
  publisher: string,
  extension: string,
  version: string,
  channel: string,
  vsceStub: { mode: "ok"; versions: Array<{ version: string; preRelease: boolean }> } | { mode: "fail" } | { mode: "garbage" },
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "check-mkt-"));
  try {
    // Translate the test's `preRelease: boolean` fixture shape into the
    // actual `vsce show --json` shape, which carries the flag inside
    // `properties[]` (key=Microsoft.VisualStudio.Code.PreRelease, value="true"/"false").
    const writeFixture = (): void => {
      if (vsceStub.mode === "ok") {
        const marketplace = {
          versions: vsceStub.versions.map((v) => ({
            version: v.version,
            properties: [
              {
                key: "Microsoft.VisualStudio.Code.PreRelease",
                value: v.preRelease ? "true" : "false",
              },
            ],
          })),
        };
        writeFileSync(join(dir, "vsce-stub.json"), JSON.stringify(marketplace));
      } else {
        writeFileSync(join(dir, "vsce-stub.json"), JSON.stringify(vsceStub));
      }
    };
    writeFixture();
    const fakeVsce = `#!/usr/bin/env bash
set -eu
case "${vsceStub.mode}" in
  ok)   cat "${dir}/vsce-stub.json" ;;
  fail) echo "simulated vsce failure" >&2; exit 1 ;;
  garbage) echo "{not-json" ;;
esac
`;
    const fakeBin = join(dir, "vsce");
    writeFileSync(fakeBin, fakeVsce);
    chmodSync(fakeBin, 0o755);
    const r = spawnSync(
      "node",
      [SCRIPT, publisher, extension, version, channel],
      {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf8",
      },
    );
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("check-marketplace-version.mjs", () => {
  it("exits 0 when version is absent from the listing", () => {
    const r = run("cnpg4vscode", "cnpg4vscode", "0.2.0", "stable", {
      mode: "ok",
      versions: [{ version: "0.1.0", preRelease: false }],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("collision=false");
  });

  it("exits 0 when extension never published (vsce prints literal 'undefined')", () => {
    // First-ever publish: `vsce show <publisher>.<ext> --json` prints
    // the literal string "undefined\n" and exits 0. The script must
    // treat that as "no collision possible" so the first publish can
    // actually proceed.
    const dir = mkdtempSync(join(tmpdir(), "check-mkt-first-"));
    try {
      const fakeVsce = "#!/usr/bin/env bash\necho undefined\nexit 0\n";
      const fakeBin = join(dir, "vsce");
      writeFileSync(fakeBin, fakeVsce);
      chmodSync(fakeBin, 0o755);
      const r = spawnSync(
        "node",
        [SCRIPT, "cnpg4vscode", "cnpg4vscode", "0.2.0", "stable"],
        {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          encoding: "utf8",
        },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("collision=false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when (version, stable) already published", () => {
    const r = run("cnpg4vscode", "cnpg4vscode", "0.2.0", "stable", {
      mode: "ok",
      versions: [{ version: "0.2.0", preRelease: false }],
    });
    expect(r.status).toBe(1);
  });

  it("exits 1 when (version, pre-release) already published", () => {
    const r = run("cnpg4vscode", "cnpg4vscode", "0.2.0-beta.1", "pre-release", {
      mode: "ok",
      versions: [{ version: "0.2.0-beta.1", preRelease: true }],
    });
    expect(r.status).toBe(1);
  });

  it("exits 0 when same version exists on a DIFFERENT channel (not a collision)", () => {
    // Stable v0.2.0 exists; we're asking about pre-release v0.2.0.
    // Per FR-013 the (version, channel) tuple is what counts.
    const r = run("cnpg4vscode", "cnpg4vscode", "0.2.0", "pre-release", {
      mode: "ok",
      versions: [{ version: "0.2.0", preRelease: false }],
    });
    expect(r.status).toBe(0);
  });

  it("exits 2 when vsce show fails", () => {
    const r = run("cnpg4vscode", "cnpg4vscode", "0.2.0", "stable", { mode: "fail" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/vsce|simulated/i);
  });

  it("exits 2 when vsce show returns malformed JSON", () => {
    const r = run("cnpg4vscode", "cnpg4vscode", "0.2.0", "stable", { mode: "garbage" });
    expect(r.status).toBe(2);
  });

  it("exits 3 for unknown channel argv", () => {
    const r = run("cnpg4vscode", "cnpg4vscode", "0.2.0", "preview", {
      mode: "ok",
      versions: [],
    });
    expect(r.status).toBe(3);
  });

  it("exits 3 for missing argv (too few arguments)", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-mkt-argv-"));
    try {
      const r = spawnSync("node", [SCRIPT, "cnpg4vscode", "cnpg4vscode"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(r.status).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
