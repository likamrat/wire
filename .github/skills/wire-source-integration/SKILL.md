---
name: wire-source-integration
description: Integrate WIRE sources through approved acquisition, retention and existing product interfaces. Use for local collectors, source adapters, account lifecycle, Windows/WSL source access, pagination, fidelity or acquisition-window changes. Distinguish sample reads and fixture proof from normal end-to-end operation.
license: MIT
---

# WIRE source integration

Use the existing collection, storage, reading and account seams. WIRE is a local
Node server with a browser interface, not a new chat client or an Electron rewrite.
Read [collection](../../../docs/collection.md) and
[platform setup](../../../docs/development.md#windows-wsl-and-linux) on the
actual candidate.

The supported source is approved local GitHub Copilot app metadata and history.
Microsoft 365 Chat, Cowork and remote-only provider history are not supported
sources. An explicitly requested future adapter needs its own qualified contract;
historical feasibility notes do not establish implementation or permission.

## Establish the source contract first

Resolve these facts from supported source evidence before depending on them:

| Fact | Required distinction |
| --- | --- |
| Access | An observed path or endpoint, supported access, sign-in and application authorization are different facts. |
| Identity | Source-qualified principal/namespace and account binding, not equal-looking IDs, stored configuration or a successful page load. |
| Discovery | Ordinary history discovery versus supplied conversation/task IDs. |
| Completeness | Paging, continuation, end conditions, late activity and reconnect, not a row count or null cursor alone. |
| Time | Per-activity timestamp, unit and basis versus conversation recency, capture or commit time. |
| Fidelity | Original message/part/call/result identity, ordering, nested failures and provenance, not just decoded event totals. |
| Retention | Acquisition bounds, retained-history policy and current view dates are separate. |

Reconcile current user decisions before choosing an access method. Older prompts
are not permission to revive rejected registration, borrowed tokens, endpoint
replay, VPN requirements or an obsolete acquisition architecture. Report an
actual source limitation precisely; one local diagnostic refusal does not prove
every supported access method impossible.

## Keep input and instance state separate

Copilot metadata is opened read-only; independent WIRE instances may approve
the same input. Each instance owns its writable store, approval, reply-saving
consent, collection window, cursors, settings and reports. A different port
neither isolates data nor authorizes sharing a writable store.

For Windows-owned metadata read from WSL, reuse the existing bounded source-native
Windows Node helper described in
[source mapping](../../../docs/collection.md#source-mapping-and-bounded-reads).
It runs the read-only projection and exits. It is not another WIRE server,
a daemon or a copy of the live database. Preserve source identity, freshness and
pre-write validation; do not bypass locks or remove store-owner bindings.

## Deliver one integrated slice

Follow normal source review/approval -> discovery/collection -> existing writer ->
retained readback -> affected Analyze/cards/reader/Search/reports. Exercise
later incremental collection and restart/reconnect when the change affects
those behaviors.

Use the existing complete-population query and canonical selectors, not just the
visible page. Preserve existing GitHub behavior and independently qualified
evidence units. Keep source filters, account controls and Settings inside the
shared WIRE experience rather than a separate source-specific interface.

Preserve distinct lifecycle behavior under the product contract:
Pause stops automatic acquisition while retained content stays readable;
the approved manual Refresh exception remains bounded.
Sign out of WIRE stops collection and hides private retained content without
deleting it or signing out other apps. Apply revocation across tabs, pending
responses and streams. Fresh source proof must establish any legacy-account
compatibility; equal raw IDs do not authorize rekeying, replacement or merging
namespaces.

## Prove the actual requirement

Use disposable fixtures to prove decoder, lifecycle and integration mechanics.
Where genuine acquisition is required, qualify the normal source path under
actual permission and read back its committed results. Fixture success,
authentication or one selected conversation cannot establish complete history.
Report each required surface as proved, partial or blocked with its precise gap.
Do not substitute more diagnostics for the missing working product behavior.

Use [evidence semantics](../wire-evidence-semantics/SKILL.md) when changing
measured units or attribution, and [report integrity](../wire-report-integrity/SKILL.md)
when the source reaches reporting. Follow only affected paths; this skill grants
no provider, private-data, account or runtime operations.
