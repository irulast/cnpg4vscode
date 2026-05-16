/**
 * Kubeconfig discovery (FR-001, FR-014, data-model.md § Kubeconfig Context).
 *
 * Uses @kubernetes/client-node's KubeConfig loader so exec / auth-provider
 * plugins (EKS aws eks get-token, GKE gke-gcloud-auth-plugin) work without
 * us reimplementing them.
 *
 * KUBECONFIG resolution mirrors kubectl: explicit KUBECONFIG env var first
 * (colon-separated list, merged in order), then ~/.kube/config.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KubeConfig } from "@kubernetes/client-node";

export type AuthMode = "token" | "cert" | "exec" | "authProvider" | "basic" | "unknown";

export interface KubeconfigContextInfo {
  name: string;
  cluster: string;
  user: string;
  server: string;
  namespace: string | null;
  authMode: AuthMode;
}

export interface LoadResult {
  contexts: KubeconfigContextInfo[];
  currentContext: string | null;
  /** Files that were merged to produce the result; subscribe to these for change detection. */
  resolvedPaths: string[];
  /** The underlying KubeConfig the rest of the K8s layer should reuse. */
  kubeConfig: KubeConfig;
}

export interface LoadOptions {
  /** Explicit path (test-only). Bypasses env + ~/.kube/config discovery. */
  kubeconfig?: string;
  /** Override env for testing. */
  env?: NodeJS.ProcessEnv;
  /** Override home for testing. */
  home?: string;
}

function resolveKubeconfigPaths(opts: LoadOptions): string[] {
  if (opts.kubeconfig) return [opts.kubeconfig];
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const fromEnv = env["KUBECONFIG"];
  if (fromEnv) {
    const sep = process.platform === "win32" ? ";" : ":";
    return fromEnv.split(sep).map((p) => p.trim()).filter((p) => p.length > 0);
  }
  return [path.join(home, ".kube", "config")];
}

/**
 * Accepts either the raw YAML shape (kebab-case keys) or the parsed
 * `@kubernetes/client-node` User shape (camelCase). Both forms turn up
 * depending on the caller.
 */
export function classifyAuthMode(user: Record<string, unknown>): AuthMode {
  if (user["exec"]) return "exec";
  if (user["auth-provider"] || user["authProvider"]) return "authProvider";
  if (typeof user["token"] === "string" || typeof user["tokenFile"] === "string") return "token";
  if (
    user["client-certificate-data"] ||
    user["client-certificate"] ||
    user["certData"] ||
    user["certFile"]
  ) {
    return "cert";
  }
  if (typeof user["username"] === "string" && typeof user["password"] === "string") return "basic";
  return "unknown";
}

export function loadContexts(opts: LoadOptions = {}): LoadResult {
  const paths = resolveKubeconfigPaths(opts);
  const kc = new KubeConfig();
  let loadedAnything = false;
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    if (!loadedAnything) {
      kc.loadFromFile(p);
      loadedAnything = true;
    } else {
      // Merge additional files by parsing and adding their contexts/clusters/users.
      const more = new KubeConfig();
      more.loadFromFile(p);
      for (const ctx of more.getContexts()) kc.addContext(ctx);
      for (const cluster of more.getClusters()) kc.addCluster(cluster);
      for (const user of more.getUsers()) kc.addUser(user);
    }
  }

  const contexts: KubeconfigContextInfo[] = kc.getContexts().map((ctx) => {
    const clusterObj = kc.getCluster(ctx.cluster);
    const userObj = kc.getUser(ctx.user);
    return {
      name: ctx.name,
      cluster: ctx.cluster,
      user: ctx.user,
      server: clusterObj?.server ?? "",
      namespace: ctx.namespace ?? null,
      authMode: classifyAuthMode((userObj ?? {}) as Record<string, unknown>),
    };
  });

  return {
    contexts,
    currentContext: kc.getCurrentContext() ?? null,
    resolvedPaths: paths,
    kubeConfig: kc,
  };
}

/**
 * Watch kubeconfig file(s) for external mutation (FR-014). Returns a dispose
 * function. Coalesces rapid filesystem events to one callback per ~100ms.
 *
 * Uses `fs.watchFile` (polling-based) for cross-platform reliability —
 * `fs.watch` misses events on some Linux filesystems and over network mounts.
 */
export function watchKubeconfig(paths: string[], onChange: () => void): () => void {
  const watched: string[] = [];
  let pendingTimer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(onChange, 100);
  };
  for (const p of paths) {
    try {
      fs.watchFile(p, { interval: 500, persistent: false }, (curr, prev) => {
        // mtime changed implies a meaningful update; size-only changes are also
        // forwarded so truncate-and-rewrite cycles are observed.
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) fire();
      });
      watched.push(p);
    } catch {
      // File may not exist yet; that's fine — silently skip.
    }
  }
  return () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    for (const p of watched) fs.unwatchFile(p);
  };
}
