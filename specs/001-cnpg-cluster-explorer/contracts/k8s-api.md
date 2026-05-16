# Contract — Kubernetes API surface

This file enumerates every Kubernetes API call the extension issues.
Contract tests under `test/contract/k8s/` replay nock fixtures recorded
from a real `kind` cluster with CNPG installed; new fixtures are added
only when a new entry is added here.

All calls go through `@kubernetes/client-node`. Authentication uses the
user's active kubeconfig (incl. `exec` plugins). The extension MUST NOT
shell out to `kubectl` for any of these.

## Kubeconfig (local, not API)

| Operation | Source | Notes |
|---|---|---|
| Load kubeconfig | `KubeConfig.loadFromDefault()` | Honors `$KUBECONFIG`; on Windows we merge colon-list manually (research §2). |
| Watch kubeconfig file | `fs.watch` on the resolved path(s) | Reacts to context switches (FR-014). |

## Discovery — Operator Presence

| Verb | Path | Purpose |
|---|---|---|
| GET | `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/clusters.postgresql.cnpg.io` | Determine `cnpgPresent` per context. Not-found ⇒ `absent`. Forbidden ⇒ `forbidden`. |

## Cluster discovery — listing CNPG Clusters

| Verb | Path | Purpose |
|---|---|---|
| GET | `/apis/postgresql.cnpg.io/v1/clusters` | Cluster-scoped list across all namespaces (when RBAC permits). Used when a context grants cluster-wide list. |
| GET | `/apis/postgresql.cnpg.io/v1/namespaces/{namespace}/clusters` | Namespace-scoped list (fallback when cluster-wide list is forbidden). |
| GET | `/apis/postgresql.cnpg.io/v1/namespaces/{namespace}/clusters/{name}` | Per-cluster read for the detail surface (US2). |

Issued via `CustomObjectsApi.listClusterCustomObject` /
`listNamespacedCustomObject` / `getNamespacedCustomObject`.

## Pod listing (cluster-detail enrichment, US2)

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/v1/namespaces/{namespace}/pods?labelSelector=cnpg.io/cluster={name}` | Enumerate the pods belonging to a CNPG Cluster so the detail surface can render per-instance role, phase, readiness, restart count, and age. Read-only; no field-selector / no watch. |

Issued via `CoreV1Api.listNamespacedPod`. Failures degrade the detail
surface to "Could not list pods: <message>" without breaking the rest of
the page; in particular, a 403 on this call MUST NOT block the cluster
detail from opening (FR-007 sibling-resilience).

## Secrets (credential lookup)

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/v1/namespaces/{namespace}/secrets` | List secrets in the cluster's namespace. Filter client-side to those owned by (or matching naming convention of) the CNPG Cluster. |
| GET | `/api/v1/namespaces/{namespace}/secrets/{name}` | Read the user-selected secret to decode `username`/`password`/`dbname`. **In-memory use only — never persisted.** |

## TLS CA (for `pg` connection over the tunnel)

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/v1/namespaces/{namespace}/secrets/{cluster}-ca` | Read CA bundle for `ssl.ca` on the pg client. CA bytes are not logged. |

## Port-forward

| Verb | Path | Purpose |
|---|---|---|
| POST (SPDY upgrade) | `/api/v1/namespaces/{namespace}/pods/{pod}/portforward?ports=5432` | Open a port-forward stream to the cluster's primary pod, derived from the `-rw` Service's endpoint. SPDY upgrade. Implemented via `@kubernetes/client-node` `PortForward`. |

The pod name is resolved as follows: GET the `<cluster>-rw` Service →
read its `endpoints` (`/api/v1/namespaces/{ns}/endpoints/{cluster}-rw`)
→ pick the first ready address → use its `targetRef.name` as the pod
name. (Service-level port-forward is not in K8s; the SPDY endpoint is
pod-scoped.)

## Error shaping

| Upstream signal | Surface |
|---|---|
| HTTP 403 with `Forbidden` reason | Surface verbatim on the affected tree node (FR-007). No retry. |
| HTTP 401 | "Authentication failed — refresh credentials" marker; no retry. |
| `ENOTFOUND` / `ETIMEDOUT` | "Cannot reach cluster" marker with the underlying error class; sibling contexts unaffected. |
| Proxy strips `Upgrade` headers during SPDY | "Tunnel unsupported by proxy" diagnostic on the cluster node. |

## Things the extension MUST NOT call

- Any write verb against any CNPG resource (POST/PUT/PATCH/DELETE on
  `clusters.postgresql.cnpg.io`). This feature is Kubernetes-read-only
  (FR-009; spec Assumption "Kubernetes-level state is read-only").
- Any `subjectaccessreviews` probe to "preflight" RBAC — we let the
  real call fail and surface the upstream message (constitution §II).
- Any namespace-listing call across all namespaces if the user lacks
  cluster-wide list permission — fall back to walking known namespaces
  from CR membership.

## Fixture recording

`pnpm record:fixtures` against a fresh `kind` cluster with CNPG
installed via:

```
helm install cnpg cnpg/cloudnative-pg
kubectl apply -f test/fixtures/k8s/cluster-app-db.yaml
```

Recorded with nock's `nock.recorder.rec({ output_objects: true })` and
saved under `test/contract/k8s/fixtures/<scenario>.json`. Auth tokens
and bearer headers are stripped from recorded fixtures before commit.
