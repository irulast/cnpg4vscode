#!/usr/bin/env node
/**
 * generate-release-notes.mjs — spec 002 / T022 / FR-021
 *
 * Render the markdown body of a GitHub Release from the commit log
 * between two refs (typically the previous tag and the current one).
 * Groups commits by Conventional Commits prefix; non-conforming
 * commits bucket into "Other". Empty range renders a valid empty body.
 *
 * Argv:
 *   --from <ref>            required (e.g. v0.1.0)
 *   --to <ref>              required (e.g. v0.2.0)
 *   [--repo <owner/repo>]   default: irulast/cnpg4vscode
 *   [--git-log-stdin]       if present, reads commits from stdin instead of
 *                           invoking `git log` — used by unit tests so they
 *                           don't need a git repo
 *
 * Stdin format when --git-log-stdin is set:
 *   <full-sha>|<subject>\n
 *
 * Stdout: rendered markdown
 *
 * Exit codes (per contracts/script-cli.md):
 *   0  rendered ok
 *   1  `git log` failed
 *   2  invalid argv
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCRIPT = "generate-release-notes";

const fatal = (code, message) => {
  process.stderr.write(`[${SCRIPT}] FATAL: ${message}\n`);
  process.exit(code);
};

function parseArgs(argv) {
  const opts = {
    from: null,
    to: null,
    repo: "irulast/cnpg4vscode",
    fromStdin: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case "--from": opts.from = argv[++i]; break;
      case "--to": opts.to = argv[++i]; break;
      case "--repo": opts.repo = argv[++i]; break;
      case "--git-log-stdin": opts.fromStdin = true; break;
      default: fatal(2, `unknown flag: ${k}`);
    }
  }
  if (!opts.from || !opts.to) {
    fatal(2, "usage: generate-release-notes.mjs --from <ref> --to <ref> [--repo <owner/repo>] [--git-log-stdin]");
  }
  return opts;
}

function readCommits(opts) {
  if (opts.fromStdin) {
    const raw = readFileSync(0, "utf8");
    return raw.split("\n").filter(Boolean);
  }
  const r = spawnSync(
    "git",
    ["log", `${opts.from}..${opts.to}`, "--pretty=format:%H|%s"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    fatal(1, `git log failed (exit ${r.status}): ${r.stderr.trim()}`);
  }
  return (r.stdout ?? "").split("\n").filter(Boolean);
}

const KNOWN_PREFIXES = Object.freeze([
  "feat", "fix", "docs", "chore", "refactor",
  "test", "ci", "build", "perf", "revert",
]);

const PREFIX_RE = new RegExp(`^(${KNOWN_PREFIXES.join("|")})(\\([^)]+\\))?!?:\\s*(.+)$`);

function classify(commits) {
  const groups = new Map();
  for (const prefix of KNOWN_PREFIXES) groups.set(prefix, []);
  groups.set("Other", []);
  for (const line of commits) {
    const idx = line.indexOf("|");
    if (idx === -1) continue;
    const sha = line.slice(0, idx);
    const subject = line.slice(idx + 1);
    const m = PREFIX_RE.exec(subject);
    if (m) {
      groups.get(m[1]).push({ sha, subject });
    } else {
      groups.get("Other").push({ sha, subject });
    }
  }
  return groups;
}

function render(opts, commits) {
  const out = [];
  out.push(`## What's Changed in ${opts.to}`);
  out.push("");
  if (commits.length === 0) {
    out.push(`_No commits between ${opts.from} and ${opts.to}._`);
    out.push("");
    out.push(`**Full Changelog**: https://github.com/${opts.repo}/compare/${opts.from}...${opts.to}`);
    return out.join("\n") + "\n";
  }
  const groups = classify(commits);
  for (const prefix of KNOWN_PREFIXES) {
    const entries = groups.get(prefix);
    if (!entries || entries.length === 0) continue;
    out.push(`### ${prefix}`);
    for (const e of entries) {
      out.push(`- ${e.sha.slice(0, 7)} ${e.subject}`);
    }
    out.push("");
  }
  const other = groups.get("Other");
  if (other.length > 0) {
    out.push(`### Other`);
    for (const e of other) {
      out.push(`- ${e.sha.slice(0, 7)} ${e.subject}`);
    }
    out.push("");
  }
  out.push(`**Full Changelog**: https://github.com/${opts.repo}/compare/${opts.from}...${opts.to}`);
  return out.join("\n") + "\n";
}

const opts = parseArgs(process.argv.slice(2));
const commits = readCommits(opts);
process.stdout.write(render(opts, commits));
process.exit(0);
