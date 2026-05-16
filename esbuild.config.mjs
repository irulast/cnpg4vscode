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

async function run() {
  if (watch) {
    const extCtx = await context(extensionOptions);
    const rendererCtx = await context(rendererOptions);
    await Promise.all([extCtx.watch(), rendererCtx.watch()]);
    console.log("[esbuild] watching...");
  } else {
    await Promise.all([build(extensionOptions), build(rendererOptions)]);
    console.log("[esbuild] build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
