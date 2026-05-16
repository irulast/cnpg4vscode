import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { watchKubeconfig } from "../../src/k8s/kubeconfig.js";

const tmps: string[] = [];

afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "cnpg-test-"));
  tmps.push(d);
  return d;
}

describe("watchKubeconfig()", () => {
  it("fires when a watched file is modified", async () => {
    const d = tmpDir();
    const f = path.join(d, "config");
    writeFileSync(f, "v1\n");

    const fired = new Promise<void>((resolve) => {
      const stop = watchKubeconfig([f], () => {
        stop();
        resolve();
      });
    });

    // Schedule a write after the poll interval (500ms) so the change is detected.
    setTimeout(() => writeFileSync(f, "v2 with more bytes\n"), 700);

    await expect(
      Promise.race([
        fired.then(() => "fired"),
        new Promise<string>((r) => setTimeout(() => r("timeout"), 5000)),
      ]),
    ).resolves.toBe("fired");
  });

  it("silently tolerates non-existent paths", () => {
    const stop = watchKubeconfig(["/this/does/not/exist"], () => {});
    expect(() => stop()).not.toThrow();
  });
});
