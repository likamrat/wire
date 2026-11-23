---
name: wire-end-to-end-delivery
description: Diagnose a reported WIRE bug, fix a regression, implement a feature, or qualify a combined build. Follow the normal product entry and distinguish a source fix from a working delivery.
license: MIT
---

# WIRE end-to-end delivery

Deliver the user's observable result through the existing application. Use the
smallest complete change, not the smallest isolated component.

## 1. Name the success criterion

Recover the current request and acceptance criteria. State the normal user entry,
expected result, required evidence and real authority boundaries in the existing
task record. Reuse recovered facts; ask only about consequential unknowns.

Inspect the actual checkout and relevant current contracts. Start with
[Development](../../../docs/development.md) and the pertinent sections of
[the user guide](../../../docs/user-guide.md),
[design](../../../docs/design.md),
[reporting](../../../docs/reporting.md) or
[Search](../../../docs/live-search.md). Read current scripts from
`package.json` at the repository root when needed. Historical handoffs can
describe retired or unshipped features; applicable user decisions govern the
requested change without silently broadening access. An absent adapter is a
source/version gap, not proof it is delivered.

**Ready:** completion can be distinguished from a demo, preparation or a partial
result. Source-only work can be complete as source-only without claiming live
acceptance or activating private operations.

## 2. Follow the affected path

Trace the capability from normal UI/API entry through its existing producer,
validation, canonical state and affected consumers. Identify the shared seam
before adding logic; reuse current mechanisms and owners.

Load only the skills whose branches apply:

| Branch | Skill |
| --- | --- |
| Collection, source adapters, native history or account integration | [Source integration](../wire-source-integration/SKILL.md) |
| Counts, filters, outcomes, authorship, service or timing meaning | [Evidence semantics](../wire-evidence-semantics/SKILL.md) |
| Report creation, comparison, exports or saved reading | [Report integrity](../wire-report-integrity/SKILL.md) |
| Search corpus, matching, highlights, result opening or invalidation | [Local Search](../wire-local-search/SKILL.md) |
| Refresh, repair, recollection, deletion or uncertain operations | [Safe recovery](../wire-safe-recovery/SKILL.md) |

For combining accepted work, qualifying or replacing a build, read
[build delivery](references/build-delivery.md).

These are branches, not mandatory workstreams for every change. Follow actual
dependencies; do not create a parallel interface or platform to avoid integrating
an existing path. For UI changes, use [UX finish](../wire-ux-finish/SKILL.md)
on the affected journey.

**Ready:** the change has an owner and input, each affected consumer is accounted
for, and any missing producer contract is explicit.

## 3. Implement and prove the requested behavior

For a bug, use the entry where the failure was reported. Get a check that fails
on that symptom before the fix and passes on the candidate. For missing or
incorrect data, follow one invented record from source to store to screen to
find the first disagreement, including the projection the screen reads. If you
cannot observe a step, say which one. A fixture can reproduce a defect without
establishing why an earlier request failed.

Reuse existing modules, tests and tooling. Start with the smallest command that
covers the changed behavior and its coupled regressions. Expand only for a
specific dependency, observed failure or acceptance requirement. A focused check
must prove the right outcome, not weaken an assertion to fit the implementation.
For documentation or skill links, check exact-case paths, GitHub heading
anchors and embedded images. When replacing screenshots or explaining a
changed control, operate that path with invented data in the [documentation
fixture](../../../docs/development.md#capture-documentation-screenshots). Keep the rest
of the app out of the test unless it supplies a necessary step.

Use invented records and disposable stores for mutation tests. Real collection,
private-data reads, authentication, disclosure and destructive operations retain
their actual permission gates; this skill supplies none. Prove ordinary product
entry when that is the acceptance criterion, rather than seeding backend state.

Call a failure inherited only after reproducing it on the baseline with the same
input and route. Keep diagnosis and routine corrections with the feature owner.

**Ready:** the exact candidate satisfies the relevant behavior, error and
preservation criteria; unrun real-data or UI criteria remain visibly pending.

## 4. Finish the owned outcome

Self-review the result, correct observed defects and hand a reviewable candidate
to the existing integration owner with its exact input, scope, proof and limits.
Include a concrete next action rather than requesting another routine assignment.
Keep source implementation, integration acceptance, publication and live delivery
separate. A qualified archive is not a running application.

When delivery is in scope and authorized, the sole build owner completes the
build-delivery branch. Otherwise stop at the actual owned boundary without
claiming a working live product.

Give the user only the material result: what works, where to use it and any real
limit or blocker. Keep intermediate logs and hashes in the task record.
