#!/usr/bin/env node
/**
 * publish-vsix.mjs — spec 002 / T014 / FR-014 + FR-017 + FR-017a
 *
 * Per-platform Marketplace publisher with:
 *   - build-then-publish staging (artifacts must exist before publish)
 *   - per-target retry on transient errors with exponential backoff
 *   - end-of-run PAT-leak scan (defends SC-005)
 *   - partial-publish failure → recovery `workflow_dispatch` line
 *     surfaced to stdout AND $GITHUB_STEP_SUMMARY (FR-017a #4)
 *
 * Argv:
 *   --tag <tag>                  required
 *   --channel <stable|pre-release>  required
 *   --artifacts-dir <path>       required; must contain
 *                                cnpg4vscode-<target>-<version>.vsix for each target
 *   --targets <comma-list>       optional; default = all six
 *   --max-retries <n>            optional; default = 3
 *
 * Env:
 *   VSCE_PAT — required. Read once at startup; passed to spawned `vsce`
 *              via env (NEVER argv). All OTHER spawns get an env with
 *              VSCE_PAT cleared.
 *
 * Exit codes (per contracts/script-cli.md):
 *   0  all targets published
 *   1  partial success (1-5 targets succeeded; recovery dispatch printed)
 *   2  total failure (0 targets succeeded)
 *   3  pre-flight error (missing PAT / missing artifact / bad argv)
 *   4  internal error (script bug, OR end-of-run PAT-leak scan tripped)
 */

import { spawnSync } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = "publish-vsix";

const ALL_TARGETS = Object.freeze([
  "linux-x64", "linux-arm64",
  "darwin-x64", "darwin-arm64",
  "win32-x64", "win32-arm64",
]);

const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /5\d\d /, // HTTP 5xx
  /service\s+unavailable/i,
  /try\s+again/i,
  /socket\s+hang up/i,
];

// Captured output buffer for the end-of-run PAT-leak scan.
const captured = [];

const writeOut = (s) => {
  process.stdout.write(s);
  captured.push(s);
};
const writeErr = (s) => {
  process.stderr.write(s);
  captured.push(s);
};

const log = (sev, message) => {
  writeErr(`[${SCRIPT}] ${sev}: ${message}\n`);
};

const fatal = (code, message) => {
  log("FATAL", message);
  scanForPatLeak();
  process.exit(code);
};

function parseArgs(argv) {
  const opts = { tag: null, channel: null, artifactsDir: null, targets: null, maxRetries: 3 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--tag": opts.tag = v; break;
      case "--channel": opts.channel = v; break;
      case "--artifacts-dir": opts.artifactsDir = v; break;
      case "--targets": opts.targets = v.split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--max-retries": opts.maxRetries = Number(v); break;
      default: fatal(3, `unknown flag: ${k}`);
    }
  }
  if (!opts.tag) fatal(3, "--tag is required");
  if (!opts.channel || !["stable", "pre-release"].includes(opts.channel)) {
    fatal(3, `--channel must be one of: stable | pre-release (got "${opts.channel}")`);
  }
  if (!opts.artifactsDir) fatal(3, "--artifacts-dir is required");
  if (!existsSync(opts.artifactsDir)) {
    fatal(3, `--artifacts-dir does not exist: ${opts.artifactsDir}`);
  }
  if (!opts.targets) opts.targets = [...ALL_TARGETS];
  if (!Number.isFinite(opts.maxRetries) || opts.maxRetries < 0) {
    fatal(3, `--max-retries must be a non-negative integer (got "${opts.maxRetries}")`);
  }
  return opts;
}

function vsixPath(artifactsDir, target, version) {
  return join(artifactsDir, `cnpg4vscode-${target}-${version}.vsix`);
}

function publishOnce(opts, target, vsix, vscePat) {
  // Build argv that NEVER contains the PAT. The PAT travels via env.
  const argv = [
    "publish",
    "--no-dependencies",
    "--target", target,
    "--packagePath", vsix,
  ];
  if (opts.channel === "pre-release") argv.push("--pre-release");
  const result = spawnSync("vsce", argv, {
    encoding: "utf8",
    env: { ...envWithoutPat(), VSCE_PAT: vscePat },
  });
  return {
    ok: (result.status ?? -1) === 0,
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function envWithoutPat() {
  // Every OTHER spawn (anything that's not the publish call we control)
  // gets an env with the PAT scrubbed so it can't leak through child
  // processes' diagnostics.
  const env = { ...process.env };
  delete env.VSCE_PAT;
  return env;
}

function isTransient(stderr) {
  return TRANSIENT_PATTERNS.some((re) => re.test(stderr));
}

async function publishTargetWithRetry(opts, target, vsix, vscePat) {
  // Attempts are: initial + maxRetries; backoff between attempts.
  const totalAttempts = 1 + opts.maxRetries;
  let lastResult = null;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    log("INFO", `publishing ${target} (attempt ${attempt}/${totalAttempts})`);
    const r = publishOnce(opts, target, vsix, vscePat);
    lastResult = r;
    if (r.ok) {
      log("INFO", `published ${target}`);
      return { ok: true };
    }
    if (!isTransient(r.stderr)) {
      log("ERROR", `${target} failed terminally (non-transient): ${r.stderr.trim()}`);
      return { ok: false, terminal: true, stderr: r.stderr };
    }
    if (attempt < totalAttempts) {
      const backoff = Math.min(45, 5 * Math.pow(3, attempt - 1)) * 1000; // 5s, 15s, 45s
      log("WARN", `${target} transient failure (attempt ${attempt}/${totalAttempts}); backing off ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  log("ERROR", `${target} failed terminally after ${totalAttempts} attempts`);
  return { ok: false, terminal: true, stderr: lastResult?.stderr ?? "" };
}

function appendStepSummary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, markdown + "\n");
  } catch (err) {
    log("WARN", `could not append to GITHUB_STEP_SUMMARY: ${err.message}`);
  }
}

function scanForPatLeak() {
  const pat = process.env.VSCE_PAT;
  if (!pat || pat.length < 8) return;
  const tokens = [pat, pat.slice(0, 8), pat.slice(0, 16)];
  for (const token of tokens) {
    if (token.length < 8) continue;
    for (const chunk of captured) {
      if (chunk.includes(token)) {
        process.stderr.write(
          `[${SCRIPT}] FATAL: PAT-leak scan detected credential substring (len=${token.length}) in captured output\n`,
        );
        process.exit(4);
      }
    }
  }
}

async function main() {
  // Read PAT BEFORE parseArgs (parseArgs may fatal, which scans captured
  // output for the PAT; doing it in this order means PAT is available
  // for the scan to detect leaks).
  const vscePat = process.env.VSCE_PAT;
  if (!vscePat || vscePat.length === 0) {
    fatal(3, "VSCE_PAT env var is required");
  }

  const opts = parseArgs(process.argv.slice(2));
  const version = opts.tag.replace(/^v/, "");

  log("INFO", `publishing ${opts.targets.length} target(s) for ${opts.tag} on ${opts.channel} channel`);

  // Pre-flight: every requested target's VSIX must exist before any
  // publish call. This is the build-then-publish staging invariant.
  for (const target of opts.targets) {
    const vsix = vsixPath(opts.artifactsDir, target, version);
    if (!existsSync(vsix)) {
      fatal(3, `missing artifact for ${target}: ${vsix}`);
    }
  }

  const published = [];
  const failed = [];

  for (const target of opts.targets) {
    const vsix = vsixPath(opts.artifactsDir, target, version);
    const result = await publishTargetWithRetry(opts, target, vsix, vscePat);
    if (result.ok) published.push(target);
    else failed.push(target);
  }

  // Summary table.
  const summary = [
    "## Publish summary",
    "",
    "| Target | Result |",
    "| --- | --- |",
    ...opts.targets.map((t) => `| \`${t}\` | ${published.includes(t) ? "✅ published" : "❌ failed"} |`),
  ];
  if (failed.length > 0) {
    const recoveryCmd = `gh workflow run publish-recover.yml -f tag=${opts.tag} -f targets=${failed.join(",")}`;
    summary.push("", "### Recovery", "");
    summary.push(`${failed.length} target(s) failed terminally. To complete the publish:`);
    summary.push("", "```bash", `Recovery: ${recoveryCmd}`, "```");
    writeOut(`\nRecovery: ${recoveryCmd}\n`);
  }
  appendStepSummary(summary.join("\n"));
  for (const line of summary) writeOut(line + "\n");

  // End-of-run leak scan.
  scanForPatLeak();

  if (failed.length === 0) process.exit(0);
  if (published.length === 0) process.exit(2);
  process.exit(1);
}

main().catch((err) => {
  log("FATAL", `internal error: ${err?.stack ?? err}`);
  scanForPatLeak();
  process.exit(4);
});
