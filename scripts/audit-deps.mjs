#!/usr/bin/env node
/**
 * Dependency audit gate (constitution §IV risk-3).
 * - Runs `pnpm audit` and fails on high/critical advisories.
 * - Runs license-checker against an allowlist; fails on disallowed licenses.
 */

import { execFileSync } from "node:child_process";

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
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", ...opts });
}

function auditAdvisories() {
  try {
    const out = run("pnpm", ["audit", "--json"]);
    const advisories = JSON.parse(out);
    const blocking = (advisories.advisories ?? []).filter(
      (a) => a.severity === "high" || a.severity === "critical",
    );
    if (blocking.length > 0) {
      console.error(`[audit] ${blocking.length} high/critical advisor(ies):`);
      for (const a of blocking) console.error(`  - ${a.module_name}: ${a.title}`);
      process.exit(1);
    }
  } catch (err) {
    // pnpm audit exits non-zero when advisories exist; treat parseable JSON as success
    // and unparseable failures as a hard error.
    const msg = err.stdout?.toString() ?? "";
    try {
      const advisories = JSON.parse(msg);
      const blocking = (advisories.advisories ?? []).filter(
        (a) => a.severity === "high" || a.severity === "critical",
      );
      if (blocking.length > 0) {
        console.error(`[audit] ${blocking.length} high/critical advisor(ies):`);
        for (const a of blocking) console.error(`  - ${a.module_name}: ${a.title}`);
        process.exit(1);
      }
    } catch {
      console.error("[audit] failed to parse pnpm audit output:", err.message);
      process.exit(1);
    }
  }
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

console.log("[audit] checking pnpm audit advisories...");
auditAdvisories();
console.log("[audit] checking dependency licenses...");
licenseCheck();
console.log("[audit] ok");
