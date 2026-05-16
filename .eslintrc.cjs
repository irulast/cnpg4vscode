/* eslint-env node */
const path = require("node:path");

module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: ["./tsconfig.json"],
  },
  plugins: ["@typescript-eslint", "cnpg-local"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: [
    "dist",
    "out",
    "node_modules",
    "coverage",
    ".vscode-test",
    "eslint-plugins",
    "vitest.config.ts",
    "esbuild.config.mjs",
    "scripts",
    "*.cjs",
    "*.mjs",
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
    "cnpg-local/no-state-write-outside-history": "error",
  },
  settings: {
    "import/resolver": {
      typescript: { project: "./tsconfig.json" },
    },
  },
  // Load the local plugin from the scripts/ folder. ESLint accepts plugins by
  // package name; we publish the local plugin via a tiny stub package under
  // node_modules/eslint-plugin-cnpg-local that re-exports the rule module.
  // For dev convenience without an extra package, the rule is also reachable
  // through the resolvePaths shim below.
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        "cnpg-local/no-state-write-outside-history": "error",
      },
    },
  ],
};
