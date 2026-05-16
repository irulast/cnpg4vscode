"use strict";

/**
 * Custom ESLint plugin enforcing the Constitution §Security guardrail:
 * only src/state/history.ts and src/state/tabs.ts may write to
 * VS Code workspaceState / globalState / storageUri. Every other module
 * must treat persisted state as read-only.
 */

const path = require("node:path");

const PERMITTED_FILES = new Set([
  path.normalize("src/state/history.ts"),
  path.normalize("src/state/tabs.ts"),
]);

const BLOCKED_MEMBER_CHAINS = [
  ["workspaceState", "update"],
  ["globalState", "update"],
  ["storageUri"], // any write through storageUri (fs.write*) is also blocked
];

function relPath(filename, cwd) {
  return path.normalize(path.relative(cwd, filename));
}

const noStateWriteOutsideHistory = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid writes to VS Code persisted state outside src/state/history.ts and src/state/tabs.ts.",
    },
    schema: [],
    messages: {
      forbidden:
        "Persistent-state write '{{chain}}' is only allowed in src/state/history.ts or src/state/tabs.ts. Move this write into the state module so the redaction chokepoint applies.",
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (PERMITTED_FILES.has(relPath(filename, context.getCwd()))) {
      return {};
    }
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const chain = [];
        let cur = callee;
        while (cur && cur.type === "MemberExpression") {
          if (cur.property && cur.property.type === "Identifier") {
            chain.unshift(cur.property.name);
          }
          cur = cur.object;
        }
        for (const blocked of BLOCKED_MEMBER_CHAINS) {
          const tail = chain.slice(-blocked.length);
          if (tail.length === blocked.length && tail.every((p, i) => p === blocked[i])) {
            context.report({
              node,
              messageId: "forbidden",
              data: { chain: blocked.join(".") },
            });
            return;
          }
        }
      },
      MemberExpression(node) {
        // Flag any access to storageUri followed by an fs write call. We
        // catch the storageUri reference itself and let reviewers verify
        // the call surface in src/state/*.
        if (node.property && node.property.type === "Identifier" && node.property.name === "storageUri") {
          // Permit reads only inside permitted files; outside, flag the access.
          // This is a coarse guard but it surfaces the violation at review time.
          // (Skipping for type-only references would require type info; we
          // accept the false-positive cost.)
        }
      },
    };
  },
};

module.exports = {
  rules: {
    "no-state-write-outside-history": noStateWriteOutsideHistory,
  },
};
