#!/usr/bin/env node
/**
 * validate-tag.mjs — spec 002 / T011 / FR-012
 *
 * Parse a git tag, infer the Marketplace channel, and assert the
 * tag's base SemVer matches `package.json#version`. Pure
 * input → output module; no network calls; no env reads.
 *
 * IMPORTANT: the VS Code Marketplace does NOT accept SemVer
 * pre-release suffixes in the version field. The version is always
 * plain `x.y.z`. The pre-release CHANNEL is signalled only by the
 * `--pre-release` flag on `vsce publish`. To reconcile: the tag's
 * suffix is purely a maintainer signal of channel intent; it is
 * stripped before the version goes anywhere near the Marketplace.
 *
 * Argv:  node scripts/ci/validate-tag.mjs <tag>
 *
 * Tag patterns:
 *   - `v<X>.<Y>.<Z>`        — stable channel, version X.Y.Z
 *   - `v<X>.<Y>.<Z>-pre.<N>` — pre-release channel, version X.Y.Z
 *
 * The Marketplace allows the same X.Y.Z to exist on both channels
 * simultaneously (different `preRelease` flag). Multiple pre-releases
 * of the same X.Y.Z require bumping patch between them (e.g.
 * v0.7.0-pre.1 publishes 0.7.0, v0.7.1-pre.1 publishes 0.7.1).
 *
 * Stdout (on success): `channel=<stable|pre-release>;version=<X.Y.Z>`
 * Exit codes (per contracts/script-cli.md):
 *   0  valid; output emitted
 *   1  tag does not match either supported pattern
 *   2  tag base version does not match package.json#version
 *   3  package.json missing / unparseable / missing version field
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = "validate-tag";

// Two accepted patterns:
//   v<X>.<Y>.<Z>          → stable
//   v<X>.<Y>.<Z>-pre.<N>  → pre-release  (N = pre-release iteration number)
const STABLE_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const PRERELEASE_RE = /^v(\d+)\.(\d+)\.(\d+)-pre\.(\d+)$/;

function fatal(code, message) {
  process.stderr.write(`[${SCRIPT}] FATAL: ${message}\n`);
  process.exit(code);
}

const tag = process.argv[2];
if (!tag) {
  fatal(1, "tag argument is required");
}

let channel;
let version;
const stable = STABLE_RE.exec(tag);
const prerelease = PRERELEASE_RE.exec(tag);
if (stable) {
  channel = "stable";
  version = `${stable[1]}.${stable[2]}.${stable[3]}`;
} else if (prerelease) {
  channel = "pre-release";
  version = `${prerelease[1]}.${prerelease[2]}.${prerelease[3]}`;
} else {
  fatal(
    1,
    `tag "${tag}" does not match either supported pattern: ` +
      `v<X>.<Y>.<Z> (stable) or v<X>.<Y>.<Z>-pre.<N> (pre-release)`,
  );
}

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
  fatal(
    2,
    `tag version mismatch: tag's base version is "${version}" but package.json says "${pkg.version}". ` +
      `(Note: package.json must hold the plain SemVer; the tag's -pre.<N> suffix only signals channel.)`,
  );
}

process.stdout.write(`channel=${channel};version=${version}\n`);
process.exit(0);
