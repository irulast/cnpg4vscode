#!/usr/bin/env node
/**
 * Dependency licence-allowlist gate (constitution §IV risk-3).
 *
 * Runs license-checker against an allowlist; fails on disallowed
 * licenses. The pnpm-audit advisory check that used to live here was
 * moved to spec 002's `scripts/ci/scan-advisories.mjs`, which has
 * richer allowlist semantics (per-advisory justification + stale-
 * entry detection). Running both would duplicate the work and require
 * synchronising two allowlist files.
 */

import { spawnSync } from "node:child_process";

const ALLOWED_LICENSES = new Set([
  "MIT",
  "MIT*",
  "ISC",
  "Apache-2.0",
  "Apache 2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "Python-2.0",
  "BlueOak-1.0.0",
]);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });
  if (r.error) {
    const err = new Error(r.error.message);
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  if ((r.status ?? 0) !== 0) {
    const err = new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  return r.stdout ?? "";
}

function licenseCheck() {
  let raw;
  try {
    raw = run("pnpm", ["exec", "license-checker", "--production", "--json"]);
  } catch (err) {
    console.error("[audit] license-checker failed:", err.message);
    process.exit(1);
  }
  const all = JSON.parse(raw);
  const violations = [];
  for (const [pkg, info] of Object.entries(all)) {
    const licenses = Array.isArray(info.licenses) ? info.licenses : [info.licenses];
    const ok = licenses.some((l) => ALLOWED_LICENSES.has(String(l).replace(/[()]/g, "").trim()));
    if (!ok) violations.push({ pkg, licenses });
  }
  if (violations.length > 0) {
    console.error(`[audit] ${violations.length} dependency(ies) with non-allowlisted licenses:`);
    for (const v of violations) console.error(`  - ${v.pkg}: ${v.licenses}`);
    process.exit(1);
  }
}

console.log("[audit] checking dependency licenses...");
licenseCheck();
console.log("[audit] ok");
