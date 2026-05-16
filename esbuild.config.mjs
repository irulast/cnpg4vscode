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
  external: ["vscode", "better-sqlite3", "@kubernetes/client-node"],
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
const gridWebviewOptions = {
  ...baseOptions,
  platform: "browser",
  target: "es2020",
  entryPoints: ["src/webviews/grid/index.tsx"],
  outfile: "dist/webviews/grid/bundle.js",
  format: "iife",
  jsx: "automatic",
  loader: { ".css": "text" },
  define: {
    "process.env.NODE_ENV": production ? '"production"' : '"development"',
  },
};

async function run() {
  if (watch) {
    const extCtx = await context(extensionOptions);
    const rendererCtx = await context(rendererOptions);
    const gridCtx = await context(gridWebviewOptions);
    await Promise.all([extCtx.watch(), rendererCtx.watch(), gridCtx.watch()]);
    console.log("[esbuild] watching...");
  } else {
    await Promise.all([
      build(extensionOptions),
      build(rendererOptions),
      build(gridWebviewOptions),
    ]);
    console.log("[esbuild] build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
