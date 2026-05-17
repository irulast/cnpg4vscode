#!/usr/bin/env node
/**
 * validate-tag.mjs — spec 002 / T011 / FR-012
 *
 * Parse a git tag, infer the Marketplace channel from its SemVer
 * suffix, and assert it matches `package.json#version`. Pure
 * input → output module; no network calls; no env reads.
 *
 * Argv:  node scripts/ci/validate-tag.mjs <tag>
 * Stdout (on success): `channel=<stable|pre-release>;version=<semver>`
 * Exit codes (per contracts/script-cli.md):
 *   0  valid; output emitted
 *   1  tag does not match either SemVer pattern
 *   2  tag version does not match package.json#version
 *   3  package.json missing / unparseable / missing version field
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = "validate-tag";

// Stable: v<major>.<minor>.<patch>   (no suffix)
// Pre:    v<major>.<minor>.<patch>-<suffix> where suffix is SemVer pre-release
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function fatal(code, message) {
  process.stderr.write(`[${SCRIPT}] FATAL: ${message}\n`);
  process.exit(code);
}

const tag = process.argv[2];
if (!tag) {
  fatal(1, "tag argument is required");
}

const match = TAG_RE.exec(tag);
if (!match) {
  fatal(1, `tag "${tag}" does not match SemVer pattern v<major>.<minor>.<patch>[-<suffix>]`);
}

const [, , , , suffix] = match;
const version = tag.slice(1); // strip leading "v"
const channel = suffix ? "pre-release" : "stable";

// Read package.json from cwd (matches the existing scripts/*.mjs
// convention; the workflow runs from repo root).
let pkg;
try {
  const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
  pkg = JSON.parse(raw);
} catch (err) {
  fatal(3, `cannot read package.json: ${err.message}`);
}

if (typeof pkg.version !== "string") {
  fatal(3, `package.json does not declare a string "version" field`);
}

if (pkg.version !== version) {
  fatal(2, `tag version mismatch: tag says "${version}" but package.json says "${pkg.version}"`);
}

process.stdout.write(`channel=${channel};version=${version}\n`);
process.exit(0);
