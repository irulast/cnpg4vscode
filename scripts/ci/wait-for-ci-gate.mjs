#!/usr/bin/env node
/**
 * wait-for-ci-gate.mjs — spec 002 / T013 / FR-011
 *
 * Poll the GitHub Checks API (via `gh run list`) for the CI gate's
 * conclusion on a specific commit SHA. Blocks until the run reaches a
 * terminal state or the timeout expires.
 *
 * Argv:
 *   node scripts/ci/wait-for-ci-gate.mjs <sha>
 *     [--workflow <name>]         default: ci.yml
 *     [--timeout-seconds <int>]   default: 1800 (30 min)
 *     [--poll-seconds <int>]      default: 15
 *
 * Env:
 *   GH_TOKEN — required (workflow's GITHUB_TOKEN); passed to `gh`.
 *
 * Stdout (on success): `conclusion=success;run_id=<id>;run_url=<url>`
 * Exit codes (per contracts/script-cli.md):
 *   0  completed/success — publish may proceed
 *   1  completed/non-success (failure, cancelled, timed_out, neutral,
 *      action_required, skipped)
 *   2  timeout — no completed run within --timeout-seconds
 *   3  `gh` invocation failed (binary missing / API persistent error)
 *   4  invalid argv
 */

import { spawnSync } from "node:child_process";

const SCRIPT = "wait-for-ci-gate";

const fatal = (code, message) => {
  process.stderr.write(`[${SCRIPT}] FATAL: ${message}\n`);
  process.exit(code);
};

const log = (message) => {
  process.stderr.write(`[${SCRIPT}] ${message}\n`);
};

function parseArgs(argv) {
  const sha = argv[0];
  if (!sha || sha.startsWith("--")) {
    fatal(4, "usage: wait-for-ci-gate.mjs <sha> [--workflow <name>] [--timeout-seconds <int>] [--poll-seconds <int>]");
  }
  const opts = {
    sha,
    workflow: "ci.yml",
    timeoutSeconds: 1800,
    pollSeconds: 15,
  };
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--workflow":
        opts.workflow = v;
        break;
      case "--timeout-seconds": {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) fatal(4, `--timeout-seconds must be a non-negative number; got "${v}"`);
        opts.timeoutSeconds = n;
        break;
      }
      case "--poll-seconds": {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) fatal(4, `--poll-seconds must be a non-negative number; got "${v}"`);
        opts.pollSeconds = n;
        break;
      }
      default:
        fatal(4, `unknown flag: ${k}`);
    }
  }
  return opts;
}

function ghRunList(sha, workflow) {
  // `gh` autodetects the repo from git, which can fail in container
  // CI when git refuses on the "dubious ownership" check. Pass --repo
  // explicitly when GITHUB_REPOSITORY is set (it always is on GitHub
  // Actions) so we don't depend on git resolution at all.
  const args = [
    "run", "list",
    "--commit", sha,
    "--workflow", workflow,
    "--event", "push",
    "--json", "conclusion,status,databaseId,url",
    "--limit", "10",
  ];
  if (process.env.GITHUB_REPOSITORY) {
    args.push("--repo", process.env.GITHUB_REPOSITORY);
  }
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `gh exited ${result.status}: ${result.stderr.trim()}`;
    return { ok: false, reason };
  }
  try {
    const parsed = JSON.parse(result.stdout || "[]");
    return { ok: true, runs: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    return { ok: false, reason: `gh returned non-JSON: ${err.message}` };
  }
}

const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "neutral",
  "action_required",
  "skipped",
]);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  log(`polling ci gate on ${opts.sha} (workflow=${opts.workflow}, timeout=${opts.timeoutSeconds}s, poll=${opts.pollSeconds}s)`);

  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let elapsed = 0;
  let attempts = 0;

  while (true) {
    attempts++;
    const res = ghRunList(opts.sha, opts.workflow);
    if (!res.ok) {
      fatal(3, res.reason);
    }
    // Pick the latest run for this SHA (highest databaseId).
    const latest = res.runs.length === 0
      ? null
      : [...res.runs].sort((a, b) => (b.databaseId ?? 0) - (a.databaseId ?? 0))[0];

    if (latest && latest.status === "completed") {
      const conclusion = latest.conclusion;
      if (conclusion === "success") {
        process.stdout.write(
          `conclusion=success;run_id=${latest.databaseId};run_url=${latest.url ?? ""}\n`,
        );
        log(`CI gate is green (run #${latest.databaseId})`);
        process.exit(0);
      }
      if (FAILURE_CONCLUSIONS.has(conclusion)) {
        log(`CI gate concluded "${conclusion}" (run #${latest.databaseId} — ${latest.url ?? ""})`);
        process.exit(1);
      }
      // Unknown conclusion — treat as non-green per the contract.
      log(`CI gate concluded with unrecognised value "${conclusion}"; treating as not-green`);
      process.exit(1);
    }

    // Not yet completed (queued / in_progress / no eligible run).
    elapsed = Math.floor((Date.now() - (deadline - opts.timeoutSeconds * 1000)) / 1000);
    if (Date.now() >= deadline) {
      fatal(
        2,
        `timeout: CI gate did not complete within ${opts.timeoutSeconds}s for ${opts.sha} (${attempts} poll attempts)`,
      );
    }
    const status = latest?.status ?? "no-run-found-yet";
    log(`[poll #${attempts}] status=${status} elapsed=${elapsed}s — sleeping ${opts.pollSeconds}s`);
    if (opts.pollSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, opts.pollSeconds * 1000));
    }
  }
}

main().catch((err) => fatal(4, err?.message ?? String(err)));
