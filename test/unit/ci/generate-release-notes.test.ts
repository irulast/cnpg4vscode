import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/ci/generate-release-notes.mjs");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

// The script accepts commits via --git-log-stdin so tests don't need
// to fake a git repo. Each input line is `<full-sha>|<subject>`.
function run(args: {
  from: string;
  to: string;
  commits: string[];
  repo?: string;
}): RunResult {
  const input = args.commits.join("\n") + (args.commits.length > 0 ? "\n" : "");
  const r = spawnSync(
    "node",
    [
      SCRIPT,
      "--from", args.from,
      "--to", args.to,
      "--git-log-stdin",
      ...(args.repo ? ["--repo", args.repo] : []),
    ],
    { input, encoding: "utf8" },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

describe("generate-release-notes.mjs", () => {
  it("groups commits by Conventional Commits prefix", () => {
    const r = run({
      from: "v0.1.0",
      to: "v0.2.0",
      commits: [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|feat: add Grid Editor",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|fix: dirty edits revert on Apply",
        "cccccccccccccccccccccccccccccccccccccccc|docs: update README",
        "dddddddddddddddddddddddddddddddddddddddd|chore: bump deps",
      ],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("### feat");
    expect(r.stdout).toContain("add Grid Editor");
    expect(r.stdout).toContain("### fix");
    expect(r.stdout).toContain("dirty edits revert on Apply");
    expect(r.stdout).toContain("### docs");
    expect(r.stdout).toContain("### chore");
  });

  it("buckets non-conforming commits into Other", () => {
    const r = run({
      from: "v0.1.0",
      to: "v0.2.0",
      commits: [
        "1111111111111111111111111111111111111111|feat: real feature",
        "2222222222222222222222222222222222222222|misc typo fix",
        "3333333333333333333333333333333333333333|wip: refactor",
      ],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("### Other");
    expect(r.stdout).toMatch(/misc typo fix/);
    expect(r.stdout).toMatch(/wip: refactor/);
  });

  it("renders short SHA (7 chars) for each commit", () => {
    const r = run({
      from: "v0.1.0",
      to: "v0.2.0",
      commits: ["abcdef0123456789abcdef0123456789abcdef01|feat: thing"],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("abcdef0");
    expect(r.stdout).not.toContain("abcdef01234"); // never the full SHA
  });

  it("emits a Full Changelog link using the compare URL shape", () => {
    const r = run({
      from: "v0.1.0",
      to: "v0.2.0",
      commits: ["1234567890123456789012345678901234567890|feat: thing"],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /Full Changelog.*https:\/\/github\.com\/irulast\/cnpg4vscode\/compare\/v0\.1\.0\.\.\.v0\.2\.0/,
    );
  });

  it("respects --repo override for the compare URL", () => {
    const r = run({
      from: "v0.1.0",
      to: "v0.2.0",
      commits: ["1234567890123456789012345678901234567890|feat: thing"],
      repo: "someuser/somerepo",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("https://github.com/someuser/somerepo/compare/v0.1.0...v0.2.0");
  });

  it("renders a valid empty-changelog body when the commit range is empty", () => {
    const r = run({ from: "v0.1.0", to: "v0.2.0", commits: [] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("_No commits between v0.1.0 and v0.2.0._");
  });

  it("includes the heading naming the release", () => {
    const r = run({
      from: "v0.1.0",
      to: "v0.2.0",
      commits: ["1234567890123456789012345678901234567890|feat: x"],
    });
    expect(r.stdout).toContain("## What's Changed in v0.2.0");
  });

  it("recognises all 10 documented Conventional Commit prefixes", () => {
    const r = run({
      from: "v0.1.0",
      to: "v0.2.0",
      commits: [
        "a000000000000000000000000000000000000000|feat: x",
        "b000000000000000000000000000000000000000|fix: x",
        "c000000000000000000000000000000000000000|docs: x",
        "d000000000000000000000000000000000000000|chore: x",
        "e000000000000000000000000000000000000000|refactor: x",
        "f000000000000000000000000000000000000000|test: x",
        "g000000000000000000000000000000000000000|ci: x",
        "h000000000000000000000000000000000000000|build: x",
        "i000000000000000000000000000000000000000|perf: x",
        "j000000000000000000000000000000000000000|revert: x",
      ],
    });
    expect(r.status).toBe(0);
    for (const prefix of ["feat", "fix", "docs", "chore", "refactor", "test", "ci", "build", "perf", "revert"]) {
      expect(r.stdout).toContain(`### ${prefix}`);
    }
    expect(r.stdout).not.toContain("### Other");
  });

  it("exits 2 on invalid argv (missing --from)", () => {
    const r = spawnSync("node", [SCRIPT, "--to", "v0.2.0"], { encoding: "utf8" });
    expect(r.status ?? -1).toBe(2);
  });
});
