/**
 * Shapes upstream Kubernetes errors into a discriminated union the UI layer
 * can pattern-match. Preserves the upstream message verbatim per spec FR-007
 * and constitution §II ("surface the server's reason verbatim").
 *
 * NEVER includes auth headers in the shaped message — the redact() chokepoint
 * runs at the log boundary but the shaper itself only extracts safe fields.
 */

export type K8sErrorKind =
  | "forbidden"
  | "unauthenticated"
  | "not-found"
  | "unreachable"
  | "proxy-strips-upgrade"
  | "other";

export interface ShapedK8sError {
  kind: K8sErrorKind;
  /** Upstream message verbatim (with credential headers stripped). */
  message: string;
  /** Original error preserved for debugging in trace-level logs. */
  raw: unknown;
}

interface ResponseLikeError {
  statusCode?: number;
  body?: { message?: string; reason?: string; kind?: string };
  code?: string;
  message?: string;
  isProxyStripsUpgrade?: boolean;
}

function asResponseLike(err: unknown): ResponseLikeError {
  if (err === null || typeof err !== "object") return {};
  return err as ResponseLikeError;
}

function readUpstreamMessage(err: ResponseLikeError): string {
  const fromBody = err.body?.message;
  if (typeof fromBody === "string" && fromBody.length > 0) return fromBody;
  if (typeof err.message === "string" && err.message.length > 0) return err.message;
  return "Unknown error";
}

export function shapeK8sError(err: unknown): ShapedK8sError {
  const e = asResponseLike(err);

  if (e.isProxyStripsUpgrade === true) {
    return {
      kind: "proxy-strips-upgrade",
      message:
        "The HTTPS proxy stripped the Upgrade header required for port-forwarding. " +
        "Disable proxy interception for the Kubernetes API server.",
      raw: err,
    };
  }

  const networkCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ECONNRESET"]);
  if (typeof e.code === "string" && networkCodes.has(e.code)) {
    return {
      kind: "unreachable",
      message: `Cannot reach cluster (${e.code}): ${readUpstreamMessage(e)}`,
      raw: err,
    };
  }

  switch (e.statusCode) {
    case 401:
      return {
        kind: "unauthenticated",
        message: "Authentication failed — refresh credentials.",
        raw: err,
      };
    case 403:
      return { kind: "forbidden", message: readUpstreamMessage(e), raw: err };
    case 404:
      return { kind: "not-found", message: readUpstreamMessage(e), raw: err };
    default:
      return { kind: "other", message: readUpstreamMessage(e), raw: err };
  }
}
