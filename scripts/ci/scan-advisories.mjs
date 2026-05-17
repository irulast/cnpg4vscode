#!/usr/bin/env node
/**
 * scan-advisories.mjs — spec 002 / T027 / FR-030 + FR-031
 *
 * Parse a `pnpm audit --json` output, compare HIGH / CRITICAL advisories
 * against an in-repo allowlist file, fail the gate on any
 * un-allowlisted advisory. The allowlist's justification field is
 * mandatory (defends against silent-allowlist abuse) and stale entries
 * (allowlisted advisory no longer in the dep tree) trip exit 3 so the
 * allowlist stays clean.
 *
 * Argv:
 *   --audit-json <path>   required
 *   --allowlist <path>    required (must exist; empty allowlist OK)
 *
 * Exit codes (per contracts/script-cli.md):
 *   0  no findings (or all HIGH/CRITICAL advisories are allowlisted)
 *   1  at least one un-allowlisted HIGH/CRITICAL advisory
 *   2  invalid argv OR allowlist entry has empty/whitespace justification
 *   3  stale allowlist entry (advisory no longer in audit output)
 */

import { readFileSync, existsSync } from "node:fs";

const SCRIPT = "scan-advisories";
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

const fatal = (code, message) => {
  process.stderr.write(`[${SCRIPT}] FATAL: ${message}\n`);
  process.exit(code);
};

const warn = (message) => {
  process.stderr.write(`[${SCRIPT}] WARN: ${message}\n`);
};

function parseArgs(argv) {
  const opts = { auditJson: null, allowlist: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case "--audit-json": opts.auditJson = argv[++i]; break;
      case "--allowlist": opts.allowlist = argv[++i]; break;
      default: fatal(2, `unknown flag: ${k}`);
    }
  }
  if (!opts.auditJson) fatal(2, "--audit-json is required");
  if (!opts.allowlist) fatal(2, "--allowlist is required");
  return opts;
}

function readJson(path, label) {
  if (!existsSync(path)) fatal(2, `${label} not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fatal(2, `${label} is not valid JSON: ${err.message}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
const audit = readJson(opts.auditJson, "audit JSON");
const allowlist = readJson(opts.allowlist, "allowlist");

// Validate allowlist entries up front (FR-031).
const allowed = Array.isArray(allowlist.allowed) ? allowlist.allowed : [];
for (const entry of allowed) {
  const j = typeof entry?.justification === "string" ? entry.justification.trim() : "";
  if (j.length === 0) {
    fatal(2, `allowlist entry for advisory ${entry?.advisoryId ?? "?"} has empty justification (required)`);
  }
}

const allowedIds = new Set(allowed.map((e) => e.advisoryId));

// Collect blocking advisories from the audit output. `pnpm audit --json`
// emits advisories under `.advisories` keyed by id (string).
const advisoriesObj = audit?.advisories ?? {};
const advisories = Object.values(advisoriesObj).filter(
  (a) => a && BLOCKING_SEVERITIES.has(String(a.severity).toLowerCase()),
);
const presentIds = new Set(advisories.map((a) => Number(a.id)));

// Stale-allowlist check (FR-031 #2): entries pointing at advisories
// not in the audit output anymore must be pruned in the same PR that
// removed the dep. Refusing them prevents the allowlist from
// accumulating dead entries that silently weaken the gate later.
const staleIds = [...allowedIds].filter((id) => !presentIds.has(id));
if (staleIds.length > 0) {
  for (const id of staleIds) {
    warn(`allowlist entry for advisory ${id} is STALE — no longer in dependency audit output; prune it`);
  }
  fatal(3, `${staleIds.length} stale allowlist entry/entries; refusing to proceed`);
}

// Per-advisory check.
const offending = advisories.filter((a) => !allowedIds.has(Number(a.id)));
if (offending.length > 0) {
  for (const a of offending) {
    warn(
      `${a.severity} advisory ${a.id} in ${a.module_name}: ${a.title} (${a.url}) — not allowlisted`,
    );
  }
  fatal(1, `${offending.length} un-allowlisted ${[...BLOCKING_SEVERITIES].join("/")} advisory/advisories`);
}

// Allowlisted advisories still report a note so reviewers can see what
// was accepted.
for (const a of advisories) {
  if (allowedIds.has(Number(a.id))) {
    const entry = allowed.find((e) => e.advisoryId === Number(a.id));
    warn(`allowlisted: ${a.severity} ${a.id} in ${a.module_name} — justification: "${entry.justification.trim()}"`);
  }
}

process.stdout.write(`OK — ${advisories.length} blocking advisory/advisories, all allowlisted or absent\n`);
process.exit(0);
