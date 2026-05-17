#!/usr/bin/env node
/**
 * check-marketplace-version.mjs — spec 002 / T012 / FR-013
 *
 * Query the VS Code Marketplace for the extension's published versions
 * (via `vsce show <publisher>.<extension> --json`) and decide whether
 * the requested (version, channel) tuple is already published.
 *
 * Argv:  node scripts/ci/check-marketplace-version.mjs <publisher> <extension> <version> <channel>
 *   channel ∈ {stable, pre-release}
 *
 * Stdout (on success):  collision=<true|false>
 * Exit codes (per contracts/script-cli.md):
 *   0  no collision; safe to publish
 *   1  collision; (version, channel) already on Marketplace
 *   2  `vsce show` failed or returned non-JSON
 *   3  invalid argv (wrong arity / unknown channel)
 */

import { spawnSync } from "node:child_process";

const SCRIPT = "check-marketplace-version";
const VALID_CHANNELS = new Set(["stable", "pre-release"]);

function fatal(code, message) {
  process.stderr.write(`[${SCRIPT}] FATAL: ${message}\n`);
  process.exit(code);
}

function warn(message) {
  process.stderr.write(`[${SCRIPT}] WARN: ${message}\n`);
}

const [publisher, extension, version, channel] = process.argv.slice(2);
if (!publisher || !extension || !version || !channel) {
  fatal(3, "usage: validate-tag.mjs <publisher> <extension> <version> <channel>");
}
if (!VALID_CHANNELS.has(channel)) {
  fatal(3, `unknown channel "${channel}" (must be one of: ${[...VALID_CHANNELS].join(", ")})`);
}

const result = spawnSync(
  "vsce",
  ["show", `${publisher}.${extension}`, "--json"],
  { encoding: "utf8" },
);

if (result.error || result.status !== 0) {
  const reason = result.error?.message ?? `vsce exited ${result.status}: ${result.stderr.trim()}`;
  fatal(2, `vsce show failed: ${reason}`);
}

let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch (err) {
  fatal(2, `vsce show returned non-JSON output: ${err.message}`);
}

const versions = Array.isArray(parsed?.versions) ? parsed.versions : [];
const wantPreRelease = channel === "pre-release";

const collision = versions.some((v) => {
  if (typeof v?.version !== "string") return false;
  if (v.version !== version) return false;
  // Channel match: Marketplace marks pre-release versions with
  // `preRelease: true`. Absence (undefined / null / false) means stable.
  const isPre = v.preRelease === true;
  return isPre === wantPreRelease;
});

if (collision) {
  process.stdout.write("collision=true\n");
  warn(`version ${version} already published on the ${channel} channel; aborting`);
  process.exit(1);
}
process.stdout.write("collision=false\n");
process.exit(0);
