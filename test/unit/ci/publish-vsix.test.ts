import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/ci/publish-vsix.mjs");

const ALL_TARGETS = [
  "linux-x64", "linux-arm64",
  "darwin-x64", "darwin-arm64",
  "win32-x64", "win32-arm64",
];

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
  callLog: string[]; // each `vsce publish` invocation, captured argv
}

/**
 * Stub `vsce` on PATH. Behaviour controlled by a per-target outcome
 * map written into the temp dir; each invocation appends its argv to
 * a call log file the test can read back.
 *
 *   outcome map:
 *     { "linux-x64": "ok" | "transient" | "fail" }
 *   "transient" succeeds on the 2nd attempt (the stub tracks a per-
 *   target retry counter); "fail" never succeeds.
 */
function run(args: {
  tag: string;
  channel: "stable" | "pre-release";
  targets?: string[];
  outcomes: Record<string, "ok" | "transient" | "fail">;
  maxRetries?: number;
  // Note: explicit `| undefined` is required for the "PAT absent"
  // case (the test that exercises exit code 3) under
  // `exactOptionalPropertyTypes: true`. Passing `vscePat: undefined`
  // here triggers the deletion branch in the function body.
  vscePat?: string | undefined;
  artifactsExist?: boolean;
}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "publish-vsix-"));
  try {
    // Write outcome map + per-target counter file.
    writeFileSync(join(dir, "outcomes.json"), JSON.stringify(args.outcomes));
    writeFileSync(join(dir, "counters.json"), "{}");
    writeFileSync(join(dir, "callLog.txt"), "");
    // Stub vsce — succeeds, transiently fails, or terminally fails per
    // the outcome map. Reads target from --target argv.
    const fakeVsce = `#!/usr/bin/env bash
set -eu
DIR="${dir}"
# Capture full argv to call log.
printf "%q " "$@" >> "$DIR/callLog.txt"
printf "\\n" >> "$DIR/callLog.txt"
# Parse the --target arg.
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    *) shift ;;
  esac
done
node -e "
const fs=require('fs');
const out=JSON.parse(fs.readFileSync('$DIR/outcomes.json','utf8'));
const counters=JSON.parse(fs.readFileSync('$DIR/counters.json','utf8'));
const target='$TARGET';
const outcome=out[target] || 'ok';
counters[target]=(counters[target]||0)+1;
fs.writeFileSync('$DIR/counters.json', JSON.stringify(counters));
if (outcome==='ok') process.exit(0);
if (outcome==='fail') { process.stderr.write('terminal failure for '+target+'\\n'); process.exit(1); }
if (outcome==='transient') {
  if (counters[target] >= 2) process.exit(0);
  process.stderr.write('ECONNRESET: transient failure for '+target+' (attempt '+counters[target]+')\\n');
  process.exit(1);
}
" || exit $?
`;
    const fakeBin = join(dir, "vsce");
    writeFileSync(fakeBin, fakeVsce);
    chmodSync(fakeBin, 0o755);

    // Pre-built VSIX artifacts (the build stage happens upstream in
    // the workflow; publish-vsix.mjs consumes ready-made VSIXs from
    // its --artifacts-dir).
    const artifactsDir = join(dir, "vsix-bundle");
    if (args.artifactsExist !== false) {
      mkdirSync(artifactsDir);
      const versionPart = args.tag.replace(/^v/, "");
      for (const target of args.targets ?? ALL_TARGETS) {
        writeFileSync(
          join(artifactsDir, `cnpg4vscode-${target}-${versionPart}.vsix`),
          "fake-vsix-body",
        );
      }
    }

    const targetsArg = args.targets ? ["--targets", args.targets.join(",")] : [];
    const retriesArg = ["--max-retries", String(args.maxRetries ?? 3)];

    const env: Record<string, string> = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
    };
    if (args.vscePat !== undefined) env.VSCE_PAT = args.vscePat;
    else delete env.VSCE_PAT;

    const r = spawnSync(
      "node",
      [
        SCRIPT,
        "--tag", args.tag,
        "--channel", args.channel,
        "--artifacts-dir", artifactsDir,
        ...targetsArg,
        ...retriesArg,
      ],
      { env, encoding: "utf8", timeout: 60_000 },
    );
    const callLog = existsSync(join(dir, "callLog.txt"))
      ? readFileSync(join(dir, "callLog.txt"), "utf8").split("\n").filter(Boolean)
      : [];
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status ?? -1,
      callLog,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SENTINEL_PAT = "abcd1234EFGH5678ijklMNOP9012qrstUVWX3456yzabCDEF7890";

describe("publish-vsix.mjs", () => {
  it("happy path: all 6 targets succeed → exit 0", () => {
    const r = run({
      tag: "v0.2.0",
      channel: "stable",
      outcomes: Object.fromEntries(ALL_TARGETS.map((t) => [t, "ok"])),
      vscePat: SENTINEL_PAT,
    });
    expect(r.status).toBe(0);
    expect(r.callLog.length).toBe(6);
    for (const line of r.callLog) {
      expect(line).toMatch(/--target/);
      expect(line).toMatch(/--packagePath/);
    }
  });

  it("transient failure recovers via retry → exit 0", () => {
    const r = run({
      tag: "v0.2.0",
      channel: "stable",
      outcomes: { ...Object.fromEntries(ALL_TARGETS.map((t) => [t, "ok"])), "darwin-arm64": "transient" },
      vscePat: SENTINEL_PAT,
    });
    expect(r.status).toBe(0);
    // 6 successful + 1 transient retry = 7 invocations
    expect(r.callLog.length).toBe(7);
  });

  it("terminal failure after retries on one target → exit 1 + recovery dispatch line", () => {
    const r = run({
      tag: "v0.2.0",
      channel: "stable",
      outcomes: {
        ...Object.fromEntries(ALL_TARGETS.map((t) => [t, "ok"])),
        "darwin-arm64": "fail",
      },
      vscePat: SENTINEL_PAT,
      maxRetries: 1,
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Recovery:.*gh workflow run publish-recover.yml.*-f tag=v0.2.0/);
    expect(r.stdout + r.stderr).toMatch(/targets=.*darwin-arm64/);
  });

  it("all 6 fail terminally → exit 2 (full failure)", () => {
    const r = run({
      tag: "v0.2.0",
      channel: "stable",
      outcomes: Object.fromEntries(ALL_TARGETS.map((t) => [t, "fail"])),
      vscePat: SENTINEL_PAT,
      maxRetries: 0,
    });
    expect(r.status).toBe(2);
  });

  it("missing VSCE_PAT → exit 3 (preflight failure)", () => {
    const r = run({
      tag: "v0.2.0",
      channel: "stable",
      outcomes: Object.fromEntries(ALL_TARGETS.map((t) => [t, "ok"])),
      vscePat: undefined,
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/VSCE_PAT/);
  });

  it("missing artifacts dir → exit 3", () => {
    const r = run({
      tag: "v0.2.0",
      channel: "stable",
      outcomes: Object.fromEntries(ALL_TARGETS.map((t) => [t, "ok"])),
      vscePat: SENTINEL_PAT,
      artifactsExist: false,
    });
    expect(r.status).toBe(3);
  });

  it("pre-release flag wiring: --pre-release present iff channel=pre-release", () => {
    const stable = run({
      tag: "v0.2.0",
      channel: "stable",
      outcomes: Object.fromEntries(ALL_TARGETS.map((t) => [t, "ok"])),
      vscePat: SENTINEL_PAT,
    });
    for (const line of stable.callLog) expect(line).not.toMatch(/--pre-release/);

    const pre = run({
      tag: "v0.2.0-beta.1",
      channel: "pre-release",
      outcomes: Object.fromEntries(ALL_TARGETS.map((t) => [t, "ok"])),
      vscePat: SENTINEL_PAT,
    });
    for (const line of pre.callLog) expect(line).toMatch(/--pre-release/);
  });

  it("--targets filters to a subset (recovery use-case)", () => {
    const subset = ["darwin-arm64", "win32-x64"];
    const r = run({
      tag: "v0.2.0",
      channel: "stable",
      targets: subset,
      outcomes: Object.fromEntries(subset.map((t) => [t, "ok"])),
      vscePat: SENTINEL_PAT,
    });
    expect(r.status).toBe(0);
    expect(r.callLog.length).toBe(2);
    expect(r.callLog.some((l) => l.includes("--target darwin-arm64"))).toBe(true);
    expect(r.callLog.some((l) => l.includes("--target win32-x64"))).toBe(true);
  });

  it("PAT-leak invariant: VSCE_PAT does not appear in stdout or stderr or call log", () => {
    const r = run({
      tag: "v0.2.0",
      channel: "stable",
      outcomes: Object.fromEntries(ALL_TARGETS.map((t) => [t, "ok"])),
      vscePat: SENTINEL_PAT,
    });
    expect(r.stdout).not.toContain(SENTINEL_PAT);
    expect(r.stderr).not.toContain(SENTINEL_PAT);
    // The vsce stub captures argv to callLog — if the script ever
    // passed --pat <PAT>, the PAT would land here. It must NOT.
    for (const line of r.callLog) {
      expect(line).not.toContain(SENTINEL_PAT);
      // Also check for any substring of length ≥ 8 chars of the PAT.
      expect(line).not.toContain(SENTINEL_PAT.slice(0, 8));
    }
  });
});
