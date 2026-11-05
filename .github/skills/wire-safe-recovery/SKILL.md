---
name: wire-safe-recovery
description: Diagnose and recover WIRE state without replaying uncertain effects or losing retained evidence. Use for Refresh failures, interrupted saves, historical repair, recollection, deletion, checkpoint persistence or recovery receipts. Separate ordinary code fixes from actually authorized private-data operations.
license: MIT
---

# WIRE safe recovery

Read the affected [collection and recovery](../../../docs/collection.md) and
[runtime access](../../../docs/runtime-access.md) contracts.
Diagnose first; the skill does not authorize access or mutation.

## Identify the operation

Separate reading retained state, checking approved sources, recollecting history,
changing source configuration, saving replies and deleting activity.
View dates/filters are not acquisition approval. Refresh does not implicitly
enroll a source, widen history, resume Pause or enable optional reply retention.
Preserve the existing bounded manual Refresh exception under Pause; it does
not resume automatic collection.

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

Use [source integration](../wire-source-integration/SKILL.md) when collection's
source contract is affected and [report integrity](../wire-report-integrity/SKILL.md)
for report-save/frozen-artifact boundaries. Keep the recovery outcome with its
existing owner and avoid another diagnostic framework.
