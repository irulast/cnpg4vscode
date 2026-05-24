import { build, context } from "esbuild";
import { argv } from "node:process";

const production = argv.includes("--production");
const watch = argv.includes("--watch");

const baseOptions = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  legalComments: "none",
};

const extensionOptions = {
  ...baseOptions,
  platform: "node",
  target: "node20",
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  format: "cjs",
  // `vscode` is provided by the extension host — always external.
  // `better-sqlite3` is a native module referenced only in a design
  // comment (never imported); keep it external so esbuild doesn't try
  // to resolve its .node binary if it's ever added.
  // `@kubernetes/client-node` and `pg` ARE bundled (NOT external): the
  // VSIX is packaged with `vsce package --no-dependencies`, so anything
  // left external would be absent at runtime and crash `activate()`
  // with a module-not-found error (symptom: "command not found" +
  // "no data provider registered" on a Marketplace install, while dev
  // works because dev has node_modules on disk).
  external: ["vscode", "better-sqlite3"],
};

// Notebook renderer runs inside the renderer iframe (browser context, ESM).
const rendererOptions = {
  ...baseOptions,
  platform: "browser",
  target: "es2020",
  entryPoints: ["src/notebook/renderer/index.ts"],
  outfile: "dist/notebook-renderer.js",
  format: "esm",
};

// Grid Editor webview bundle (US6 Phase 8.5 — T136). React + glide-data-grid,
// loaded inside a vscode.WebviewPanel only when the user opens a Grid Editor
// tab. Bundled as an IIFE so the <script nonce="…"> tag can load it directly
// without an additional loader. React-DOM dev warnings tree-shake out in
// production builds via the `process.env.NODE_ENV` define below.
//
// NOTE: CSS is NOT processed by this bundle — it ships as a separate
// `dist/webviews/grid/bundle.css` (see gridWebviewCssOptions below) and is
// loaded by the webview HTML via a `<link rel="stylesheet">` tag. The
// earlier text-loader approach broke because glide-data-grid's `index.css`
// uses `@import` rules to pull in 14 sub-CSS files; injecting the top-level
// file as a `<style>` tag left the imports unresolved (the webview origin
// 403'd on them). esbuild's css loader follows @imports and inlines them.
const gridWebviewOptions = {
  ...baseOptions,
  platform: "browser",
  target: "es2020",
  entryPoints: ["src/webviews/grid/index.tsx"],
  outfile: "dist/webviews/grid/bundle.js",
  format: "iife",
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": production ? '"production"' : '"development"',
  },
  // Treat any .css imports in the TSX as side-effect-free — they're handled
  // by the css bundle target below.
  loader: { ".css": "empty" },
};

// Grid Editor webview CSS bundle — esbuild follows `@import` chains and
// inlines every glide-data-grid sub-stylesheet into one file. Loaded by
// the HTML template via `<link rel="stylesheet">`.
const gridWebviewCssOptions = {
  ...baseOptions,
  entryPoints: ["src/webviews/grid/bundle.css"],
  outfile: "dist/webviews/grid/bundle.css",
  loader: { ".css": "css" },
};

async function run() {
  if (watch) {
    const extCtx = await context(extensionOptions);
    const rendererCtx = await context(rendererOptions);
    const gridCtx = await context(gridWebviewOptions);
    const gridCssCtx = await context(gridWebviewCssOptions);
    await Promise.all([
      extCtx.watch(),
      rendererCtx.watch(),
      gridCtx.watch(),
      gridCssCtx.watch(),
    ]);
    console.log("[esbuild] watching...");
  } else {
    await Promise.all([
      build(extensionOptions),
      build(rendererOptions),
      build(gridWebviewOptions),
      build(gridWebviewCssOptions),
    ]);
    console.log("[esbuild] build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
