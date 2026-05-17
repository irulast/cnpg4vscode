import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/ci/wait-for-ci-gate.mjs");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Stub `gh` on PATH. The fake reads a queue of JSON payloads from a
 * fixture file and prints one per invocation, advancing the queue index
 * via a sidecar counter file. This simulates the polling loop:
 *
 *   call 1 → "queued"
 *   call 2 → "in_progress"
 *   call 3 → "completed/success"
 *
 * The script under test invokes `gh run list … --json conclusion,status,databaseId --limit N`
 * — we only need to return the right shape for that one command.
 */
function run(args: {
  sha: string;
  ghQueue: Array<Array<{ databaseId: number; status: string; conclusion: string | null }>>;
  ghExitCode?: number;
  extraArgs?: string[];
  envOverrides?: Record<string, string>;
}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "wait-ci-"));
  try {
    writeFileSync(join(dir, "gh-queue.json"), JSON.stringify(args.ghQueue));
    writeFileSync(join(dir, "gh-counter"), "0");
    const exitCode = args.ghExitCode ?? 0;
    const fakeGh = `#!/usr/bin/env bash
set -eu
COUNTER_FILE="${dir}/gh-counter"
QUEUE_FILE="${dir}/gh-queue.json"
idx=$(cat "$COUNTER_FILE")
node -e "
const fs=require('fs');
const q=JSON.parse(fs.readFileSync('$QUEUE_FILE','utf8'));
const i=parseInt(fs.readFileSync('$COUNTER_FILE','utf8'),10);
const payload = i < q.length ? q[i] : q[q.length-1];
fs.writeFileSync('$COUNTER_FILE', String(i+1));
process.stdout.write(JSON.stringify(payload));
"
exit ${exitCode}
`;
    const fakeBin = join(dir, "gh");
    writeFileSync(fakeBin, fakeGh);
    chmodSync(fakeBin, 0o755);
    const r = spawnSync(
      "node",
      [
        SCRIPT,
        args.sha,
        "--poll-seconds",
        "0", // immediate poll for tests
        ...(args.extraArgs ?? []),
      ],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_TOKEN: "fake-token-for-tests",
          ...(args.envOverrides ?? {}),
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("wait-for-ci-gate.mjs", () => {
  it("exits 0 immediately when the latest run is completed/success", () => {
    const r = run({
      sha: "abc123",
      ghQueue: [
        [{ databaseId: 99, status: "completed", conclusion: "success" }],
      ],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/conclusion=success/);
    expect(r.stdout).toMatch(/run_id=99/);
  });

  it("exits 1 when the latest run is completed/failure", () => {
    const r = run({
      sha: "abc123",
      ghQueue: [[{ databaseId: 99, status: "completed", conclusion: "failure" }]],
    });
    expect(r.status).toBe(1);
  });

  it("exits 1 for conclusion=cancelled", () => {
    const r = run({
      sha: "abc",
      ghQueue: [[{ databaseId: 1, status: "completed", conclusion: "cancelled" }]],
    });
    expect(r.status).toBe(1);
  });

  it("exits 1 for conclusion=neutral / action_required (not a green pass)", () => {
    for (const conc of ["neutral", "action_required"]) {
      const r = run({
        sha: "abc",
        ghQueue: [[{ databaseId: 1, status: "completed", conclusion: conc }]],
      });
      expect(r.status).toBe(1);
    }
  });

  it("polls through queued → in_progress → success", () => {
    const r = run({
      sha: "abc",
      ghQueue: [
        [{ databaseId: 1, status: "queued", conclusion: null }],
        [{ databaseId: 1, status: "in_progress", conclusion: null }],
        [{ databaseId: 1, status: "completed", conclusion: "success" }],
      ],
    });
    expect(r.status).toBe(0);
  });

  it("picks the latest databaseId when multiple eligible runs exist", () => {
    const r = run({
      sha: "abc",
      ghQueue: [
        [
          { databaseId: 100, status: "completed", conclusion: "failure" },
          { databaseId: 200, status: "completed", conclusion: "success" },
          { databaseId: 50, status: "completed", conclusion: "failure" },
        ],
      ],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/run_id=200/);
  });

  it("exits 2 (timeout) when the run never reaches completed within the budget", () => {
    const r = run({
      sha: "abc",
      ghQueue: [[{ databaseId: 1, status: "queued", conclusion: null }]],
      extraArgs: ["--timeout-seconds", "1"], // 1-second timeout, polls are 0s
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/timeout|did not complete/i);
  });

  it("exits 2 when no eligible run exists for the SHA (empty array) past timeout", () => {
    const r = run({
      sha: "abc",
      ghQueue: [[]],
      extraArgs: ["--timeout-seconds", "1"],
    });
    expect(r.status).toBe(2);
  });

  it("exits 3 when gh invocation fails", () => {
    const r = run({
      sha: "abc",
      ghQueue: [[{ databaseId: 1, status: "completed", conclusion: "success" }]],
      ghExitCode: 1,
    });
    expect(r.status).toBe(3);
  });

  it("exits 4 for missing SHA argv", () => {
    const r = spawnSync("node", [SCRIPT], { encoding: "utf8" });
    expect(r.status ?? -1).toBe(4);
  });
});
