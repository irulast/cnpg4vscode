<!--
SYNC IMPACT REPORT
==================
Version change: [UNRATIFIED TEMPLATE] → 1.0.0
Bump rationale: Initial ratification. All placeholders replaced with concrete
content; no prior ratified version existed in the repository.

Modified principles: (none — initial ratification)
Added sections:
  - Core Principles I–V (UX Consistency, Test-First, Kubernetes-Native
    Integration, Observability & Diagnostics, Simplicity & YAGNI)
  - Security & Operational Constraints
  - Development Workflow & Quality Gates
  - Governance
Removed sections: (none)

Templates requiring updates:
  - ✅ .specify/templates/plan-template.md — "Constitution Check" gate
    references this constitution generically; no edits required. Reviewers
    must populate gates from Principles I–V during /speckit-plan.
  - ✅ .specify/templates/spec-template.md — aligned; no constitution-
    specific edits required.
  - ✅ .specify/templates/tasks-template.md — aligned; tests remain optional
    per template, but Principle III makes them MANDATORY for any task that
    ships behavior (the plan/tasks generators must enforce this).
  - ⚠ .specify/templates/commands/*.md — directory not present in this
    repository at ratification time; no action required. Re-check on next
    amendment.
  - ⚠ README.md / docs/quickstart.md — not yet authored. Add a reference
    back to this constitution when initial docs land.

Deferred items / TODOs: (none)
-->

# cnpg4vscode Constitution

## Core Principles

### I. VS Code UX Consistency

The extension MUST follow native VS Code interaction patterns: tree views for
hierarchical resources, the Command Palette for actions, the standard
notification API for transient messages, and the Output / Problems panels for
log streams and diagnostics. Custom webviews are permitted only when no native
surface fits, and MUST inherit the active color theme and respect the user's
font and accessibility settings. New commands MUST be registered in
`package.json` with discoverable titles and category prefixes so users can
find them via the Command Palette.

**Rationale**: Users adopt the extension faster when it behaves like the rest
of their editor. Custom UI is expensive to maintain and frequently breaks
theme contrast, accessibility, and keyboard-navigation expectations.

### II. Kubernetes-Native Integration

All cluster interaction MUST go through the user's active `kubeconfig`
context (read via the official Kubernetes client library, never by shelling
out to `kubectl` for parseable output). The extension MUST honor RBAC: if an
operation is forbidden, surface the server's reason verbatim rather than
retrying or escalating. CNPG-specific operations MUST use the published
`postgresql.cnpg.io` CRD schemas; the extension MUST NOT mutate fields
outside the operator's documented contract. Context switches, namespace
scoping, and credential refresh MUST be observable to the user before any
write operation runs.

**Rationale**: Working through `kubeconfig` and the operator's CRDs keeps the
extension portable across managed/self-hosted clusters and prevents drift
between what the user sees in the extension and what `kubectl` would show.
Shelling out for parseable output is fragile across `kubectl` versions.

### III. Test-First Development (NON-NEGOTIABLE)

Any task that ships user-visible behavior MUST be developed test-first:
failing test written and reviewed → implementation → green. Tests MUST cover
(a) pure logic in unit tests, (b) Kubernetes interactions in contract tests
against fixtures derived from real CRD schemas, and (c) at least one
end-to-end test exercising the command path from VS Code activation through
the cluster call (mocked at the HTTP layer, not at the client library
boundary). A pull request whose net effect is new behavior without a failing-
then-passing test is rejected at review.

**Rationale**: A VS Code extension is glue between an editor and a remote
control plane; both edges change independently. Tests are the only
mechanism that catches the kind of cross-edge breakage (CRD field renames,
VS Code API deprecations) that users hit first.

### IV. Observability & Diagnostics

Every command MUST log start, success, and failure to a dedicated Output
channel named after the extension. Log lines MUST include a stable command
identifier, the targeted context/namespace, and on failure the upstream
error class and message. The extension MUST NOT collect telemetry, crash
reports, or analytics by default; if telemetry is added later it MUST be
opt-in, documented, and respect VS Code's global `telemetry.telemetryLevel`
setting. A "Report a problem" command MUST surface the most recent log lines
in a form the user can copy without redacting credentials manually (the
extension redacts tokens and bearer headers before display).

**Rationale**: Cluster operations fail for dozens of reasons the user cannot
see (RBAC, network policy, CRD version skew). A consistent, copy-pastable
log channel is the difference between a user filing an actionable issue and
abandoning the extension.

### V. Simplicity & YAGNI

Features ship at the smallest scope that delivers user value. No abstractions
or extension points are introduced until a second concrete consumer exists.
Configuration surface area is kept minimal: prefer convention over settings,
and when a setting is unavoidable it MUST have a sensible default that works
for a fresh CNPG install on a local cluster (kind / minikube / k3d). Adding
a new dependency requires a written justification in the PR description
covering bundle-size impact and a rejected-alternatives note.

**Rationale**: VS Code extensions are downloaded and updated on the user's
critical path. Every dependency, setting, and abstraction is a long-term
maintenance liability the extension author pays for silently.

## Security & Operational Constraints

- Credentials (kubeconfig contents, bearer tokens, client certs) MUST NEVER
  be written to extension state, workspace storage, or log output. Use VS
  Code's `SecretStorage` API only when persistence is unavoidable and
  document the scope.
- Destructive operations (delete cluster, drop database, force-failover)
  MUST require an explicit confirmation step that names the target resource
  and namespace. Confirmation MUST NOT be suppressible by a "don't ask
  again" setting.
- Network calls MUST honor the user's HTTP(S) proxy settings as configured
  in VS Code (`http.proxy`, `http.proxyStrictSSL`).
- The extension MUST NOT execute remote code, eval user-supplied YAML as
  JavaScript, or auto-update its own binaries. Updates flow through the VS
  Code Marketplace.
- Third-party content (icons, CRD schemas vendored from upstream) MUST
  preserve original license headers and be tracked in a top-level
  `THIRD_PARTY_LICENSES` file before the first public release.

## Development Workflow & Quality Gates

- **Branching**: Feature work happens on `feature/<short-name>` branches.
  `main` is always releasable; `master` is preserved only for historical
  template compatibility and accepts no new direct commits.
- **Spec-driven flow**: All non-trivial features go through `/speckit-specify
  → /speckit-plan → /speckit-tasks → /speckit-implement`. Direct
  implementation without a spec is permitted only for bug fixes ≤ 50 lines
  and documentation changes.
- **Review**: Every PR requires at least one approving review and a green
  CI run. CI MUST run lint, type-check, unit tests, contract tests, and the
  packaging step (`vsce package`) to catch manifest drift.
- **Versioning**: The extension uses SemVer (MAJOR.MINOR.PATCH). MAJOR is
  reserved for changes that require user reconfiguration (settings
  removed/renamed, supported VS Code engine bumped). MINOR adds commands or
  views. PATCH is bug fixes and dependency bumps. Pre-1.0 releases MAY
  break compatibility in MINOR bumps but MUST note the break in
  `CHANGELOG.md`.
- **Release**: Releases are tagged `v<MAJOR>.<MINOR>.<PATCH>` and published
  to the VS Code Marketplace from CI, never from a developer machine.

## Governance

This constitution supersedes ad-hoc conventions and informal team
agreements. When a PR conflicts with a principle, the PR is changed, not
the principle — unless the author opens a separate amendment PR.

**Amendment procedure**: Amendments are proposed via a PR that (a) edits
this file, (b) bumps the version line at the bottom per the rules below, (c)
updates the Sync Impact Report at the top of this file, and (d) updates any
templates listed in the Sync Impact Report as ✅ in the same PR. Amendment
PRs require two approving reviews.

**Versioning policy for this constitution**:
- MAJOR: A principle is removed or its meaning is reversed in a way that
  would invalidate previously-accepted work.
- MINOR: A new principle or section is added, or existing guidance is
  materially expanded (new MUST/SHOULD clauses).
- PATCH: Wording, typo, or formatting fixes that do not change which
  behaviors are required or forbidden.

**Compliance review**: At the start of each `/speckit-plan` run, the plan
author MUST translate Principles I–V into concrete gate checks in the plan's
"Constitution Check" section and resolve or justify each before Phase 0
research. Justifications for principle exceptions live in the plan's
"Complexity Tracking" table and persist with the feature for audit.

**Runtime guidance**: Day-to-day development guidance (commands, file
layout, technology versions) lives in `CLAUDE.md` and the active feature
plan, not in this constitution. This document changes rarely; runtime
guidance changes per feature.

**Version**: 1.0.0 | **Ratified**: 2026-05-15 | **Last Amended**: 2026-05-15
