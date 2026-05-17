#!/usr/bin/env node
/**
 * Per-platform VSIX packaging (T131).
 *
 * Produces one .vsix per supported (platform, arch) combination via
 * `vsce package --target <platform-arch>`. VS Code's Marketplace
 * resolves the right .vsix for the user's machine at install time.
 *
 * Per-platform packaging is needed because of native modules — when
 * `better-sqlite3` lands (deferred US4 history task T072), the
 * platform-specific .node binary has to match the user's
 * (platform, arch, Electron ABI). For now there are no native deps,
 * so a single platform-agnostic .vsix would technically work — but
 * structuring the publish step around `--target` keeps the muscle
 * memory in place for when native deps return.
 *
 * Usage:
 *   pnpm package                # all targets
 *   pnpm package -- --target linux-x64
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { argv } from "node:process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const VERSION = pkg.version;

const TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
];

const outDir = "dist/vsix";
mkdirSync(outDir, { recursive: true });

// Optional --target <platform> filter.
const idx = argv.indexOf("--target");
const onlyTarget = idx > 0 && argv[idx + 1] ? argv[idx + 1] : null;
const targets = onlyTarget ? [onlyTarget] : TARGETS;

if (!existsSync("dist/extension.js")) {
  console.error("[package] dist/extension.js not found. Run `pnpm build` first.");
  process.exit(1);
}

function run(cmd, args) {
  console.log(`[package] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

let failures = 0;
for (const target of targets) {
  try {
    // vsce package --target <target> -o <outfile>
    // The file name is built from package.json's name + version + target so it
    // can co-exist in the same out folder. The version segment is load-bearing
    // for spec 002's publish pipeline: `publish-vsix.mjs` looks up artifacts
    // by `cnpg4vscode-<target>-<version>.vsix`.
    const filename = `cnpg4vscode-${target}-${VERSION}.vsix`;
    const outPath = `${outDir}/${filename}`;
    // vsce/yazl chokes when the output path already exists as a 0-byte
    // file (leftover from a partial previous run). Remove first.
    if (existsSync(outPath)) rmSync(outPath);
    run("pnpm", [
      "exec",
      "vsce",
      "package",
      "--target",
      target,
      "-o",
      `${outDir}/${filename}`,
      "--no-dependencies",
    ]);
    console.log(`[package] ✓ ${target} → ${outDir}/${filename}`);
  } catch (err) {
    failures++;
    console.error(`[package] ✗ ${target}: ${err.message}`);
  }
}

if (failures > 0) {
  console.error(`[package] ${failures} target(s) failed`);
  process.exit(1);
}
console.log(`[package] ${targets.length} target(s) packaged into ${outDir}/`);
