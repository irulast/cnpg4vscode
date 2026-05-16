#!/usr/bin/env node
/**
 * Webview CSP audit (T130).
 *
 * Constitution-aligned check: any webview HTML we ship MUST set a
 * strict Content-Security-Policy per
 * contracts/webview-protocol.md § Security posture. Today no webviews
 * are bundled (the notebook renderer uses VS Code's own iframe with
 * VS Code-managed CSP; the result-grid + ER diagram are native
 * surfaces). The script remains in place as a future-proof gate —
 * when cell-editing or the ELK+D3 upgrade lands, we want the audit
 * to fail loudly if the new webview omits CSP.
 *
 * Run in CI after `pnpm build`. Scans `dist/` for any `.html` file,
 * fails the build if any of them lacks a `<meta http-equiv="Content-Security-Policy"`
 * directive or uses `default-src 'unsafe-inline'` (CSP escape).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "dist";

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

const htmlFiles = walk(root);

if (htmlFiles.length === 0) {
  console.log(`[csp-audit] no HTML files under ${root}/ — nothing to audit.`);
  process.exit(0);
}

let failures = 0;
for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");

  if (!/Content-Security-Policy/i.test(html)) {
    console.error(`[csp-audit] ✗ ${file} — missing CSP meta tag`);
    failures++;
    continue;
  }

  // Disallowed patterns that defeat the purpose of CSP.
  const badPatterns = [
    /default-src[^;]*\*/,
    /default-src[^;]*'unsafe-inline'/,
    /script-src[^;]*\*(?!-)/,
    /script-src[^;]*'unsafe-eval'/,
    /<script\s+src=["']https?:\/\//, // external CDN script tag
  ];
  for (const pat of badPatterns) {
    if (pat.test(html)) {
      console.error(`[csp-audit] ✗ ${file} — disallowed pattern matched: ${pat}`);
      failures++;
      break;
    }
  }

  if (failures === 0) console.log(`[csp-audit] ✓ ${file}`);
}

if (failures > 0) {
  console.error(`[csp-audit] ${failures} failure(s)`);
  process.exit(1);
}
console.log(`[csp-audit] ${htmlFiles.length} webview HTML file(s) audited`);
