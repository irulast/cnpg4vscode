import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "dist/test/e2e/**/*.test.js",
  version: "stable",
  workspaceFolder: "./test/fixtures/workspace",
  mocha: {
    ui: "tdd",
    timeout: 60000,
  },
});
