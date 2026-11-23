---
name: wire-safe-recovery
description: Reconciles uncertain WIRE operations and missing historical records. Use for a lost Refresh, Save or Delete response, recovery receipts, historical repair or recollection.
license: MIT
---

# WIRE safe recovery

For missing calls, use [explicit recollection](../../../docs/collection.md#explicit-recollection).
For a lost response, start with the original operation's
[recovery rules](../../../docs/runtime-access.md#existing-owner-responsibilities).
Diagnosis grants no access or mutation.

## Identify the operation

Separate reading retained state, checking approved sources, recollecting history,
changing source configuration, saving replies and deleting activity.
View dates/filters are not acquisition approval. Refresh does not implicitly
enroll a source, widen history, resume Pause or enable optional reply retention.
Preserve the existing bounded manual Refresh exception under Pause; it does
not resume automatic collection.

For a lost draft-deletion response, read the named draft list. For saved-file
or collected-activity deletion, check the original operation's receipt in
its own workflow. None of those checks sends another Delete.

Recover the operation's real grant, target, owner, revision and receipt.
Distinguish source failure, transport uncertainty, retained-read failure and
an honestly successful no-change result. Historical failure details do not
establish a current connection problem.

## Preserve state through the existing seam

Use the established single-writer, checkpoint and maintenance interfaces.
An isolated projector or board-only patch may be overwritten by the next cycle;
prove persistence through the real commit, restart and later append when relevant.
Recover only source-qualified facts; unknown or conflicting records stay honest.

For an authorized live repair, bind the exact target population and compare
relevant before/after state. Preserve unselected data, consent, Pause, cursors,
unresolved receipts and saved report bytes. Store private proof outside source.
Use synthetic stores for destructive and crash/recovery testing. Independent
instances retain separate stores and grants even when they read the same source;
changing a port does not create data isolation.

## Recover uncertainty instead of replaying

A lost response is not a confirmed no-effect failure. Read the original
operation receipt/state through its supported recovery path before deciding
whether any new operation is permitted. Preserve unresolved effects;
neither takeover nor a fresh operation ID resets their authority.

Deletion uses a membership-bound preview and a separate explicit confirmation,
with scope and consequences at the decision point. Filter reset and clearing
selection never delete. Changed scope invalidates the preview; later collection
must respect the existing deletion/reimport policy.

## Finish at the real boundary

Prove normal UI recovery and relevant no-change, failure, stale and uncertain
cases with focused existing tests. A safer error label alone does not close
broken collection; a missing retained cause does not justify unapproved rereads.
Give the actual result or one precise blocked action and next actor.

Report prevention and restoration separately. A restart test can prove the
next call survives. Count a historical call as restored only after the approved
operation's receipt and retained readback identify it. List unresolved members
separately; a candidate in a preview is not a restored call.

For partial scans and continuation, use the
[bounded-reader check](../wire-source-integration/SKILL.md#prove-the-actual-requirement).
Use [report integrity](../wire-report-integrity/SKILL.md)
for report-save/frozen-artifact boundaries. Keep the recovery outcome with its
existing owner and avoid another diagnostic framework.
