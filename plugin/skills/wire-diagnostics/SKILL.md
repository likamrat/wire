---
name: wire-diagnostics
description: Package the user's recorded Work IQ tool failures into a local diagnostic report and redacted bundle with WIRE. Use for "what is failing in my Work IQ calls", "collect diagnostics for the team", "package these tool failures" or "make a diagnostic bundle". Writes local files only, after the user agrees; never sends, uploads or files bugs. For investigating or filing, use wire-failure-audit.
---

# WIRE diagnostics

The deliverable is a short, honest `report.md`: what failed, how often, which counts mean something, and what evidence is missing. The bundle (a zip beside it) carries the sanitized evidence behind each claim.

WIRE is the data source. It already holds the user's Work IQ tool calls from approved Copilot app history, deduplicated, with recorded outcomes and failure reasons. There's nothing to export by hand.

## 1. Agree the scope

Confirm the window (UTC start and end), the tools and, if relevant, specific chats. Say plainly that a bundle is a local file and nothing is sent anywhere.

Call `wire_status` first. If collection is paused, not approved or failing, say so: the bundle can only cover what WIRE has collected.

## 2. Look before packaging

Call `wire_diagnostic_calls` with the window. Read `totals`, `coverage` and `coverage.limitations` before anything else.

- The unit is **tool calls**. One call that returned a 200 and a 404 is one failed call; its per-entry statuses are separate evidence.
- `outcome` is what the host recorded: `ok`, `fail` or `unknown`. Unknown isn't success.
- WIRE doesn't keep successful result bodies or server request IDs. Failures hidden inside successful calls can only be found from retained per-entry statuses. Say this in the report; don't imply zero.
- `coverage.complete` is true only when every call in the window is included. Only then can you quote a failure rate.

## 3. Prepare the bundle

Call `wire_diagnostic_bundle` with the same window and `save: false`. It returns the draft `report.md`, headline counts, the clusters with each one's tool, API path, error codes, HTTP statuses and recorded reasons, plain limitations and a verdicts template, without writing anything.

The user can do the same in the WIRE canvas: **Analyze > Tool call results > Package these failures** previews and saves the current view's failures. Both paths use the same WIRE server, so a bundle saved either way appears under **Reports > Saved library > Diagnostic bundles**.

Choose `captureScope`:

| Scope | Use when | Failure rate |
| --- | --- | --- |
| `complete` | `coverage.complete` is true for this window (the default then) | Withheld anyway: WIRE keeps no successful reply bodies. WIRE reconciles its own totals |
| `sample` | Anything else, including a truncated window | Withheld |
| `failures-only` | The user asked only about failures | Withheld |

The default `internal` profile keeps identifiers useful for server-side correlation. `external` minimizes them, but it isn't approval to share with customers; release still needs a human review.

## 4. Triage (optional)

Clusters arrive as `unclassified`. That's a legitimate answer. To label them, fill the verdicts template using the stable cluster IDs (not rank positions) and the taxonomy in [wire-failure-audit/reference/triage-taxonomy.md](../wire-failure-audit/reference/triage-taxonomy.md), then prepare again with `verdicts`.

Don't infer cause from a symptom, ownership from a timeout, or test intent from an odd-looking input. Operator-written narrative is only included with `reviewedNarrative: true`, after you've read it for content that shouldn't be shared.

## 5. Save locally, after the user agrees

Show the first screen of the draft report: what was observed, the issues worth acting on, which counts are meaningful, and what's missing. Then ask before saving. Call `wire_diagnostic_bundle` again with `save: true`; WIRE writes the zip and `report.md` to its private data folder, lists the bundle in Reports and returns its `bundleId` and paths. Saving never overwrites an existing bundle. `wire_diagnostic_bundles` lists what's saved.

The save refuses if the final redaction check finds residue. Redaction is rule-based, not a judgment about meaning, so a passing check isn't proof that nothing private remains.

Never send, upload, attach, post or comment. If the user wants bugs filed, hand over to **wire-failure-audit**.
