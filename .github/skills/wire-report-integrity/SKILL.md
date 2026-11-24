---
name: wire-report-integrity
description: Checks WIRE named drafts, report preparation and frozen output. Use for Add to report, selection, disclosure/Save, period-report exports, legacy readers and report-theme isolation.
license: MIT
---

# WIRE report integrity

Follow the [reporting workflow](../../../docs/reporting.md). For membership
changes, check the [scope rules](../../../docs/report-contract.md#evidence-and-membership);
for Save, check [what the user confirmed](../../../docs/report-contract.md#save-authorization).

## Preserve selection and authority

Trace report choice/selection -> preparation -> optional copy edits -> explicit
local Save -> verified saved Open. Keeping chat details requires its warning
choice for that exact save; new receipts must not claim a human text review.
Preserve historical attested bundles, author/privacy choices, hidden selections
and return navigation. Current, Selected and All scopes use their canonical
populations, not pagination or whatever rows the browser has loaded.

A named draft is a saved selection, a preview is a frozen working copy and a
saved report is a set of files. Verify which one the action affects. Deleting
a draft must leave activity, other drafts and saved files alone. For a
persistence change, put the same interaction in two drafts, remove it from
one and reopen both after a process restart. Check identities, not counts.
New Compare reports start from two retained periods; historical saved comparisons remain
readable without restoring the command to compare two saved files.

Bind prepared membership to its authoritative source, selectors and account.
Empty cohorts still need their source dependency and revocation checks.
Period replacement changes Dates explicitly while preserving applicable Search,
group and other selectors. A parent conversation can support the frame without
becoming measured membership. Keep undated observations explicit.

## Freeze prepared facts and copies

Background collection may continue while an already prepared report stays frozen,
subject to actual authority/revocation rules. Avoid recapturing a moving live
population or globally pausing unrelated work to preserve a preview.
Revalidate the required source and disclosure authority at the existing commit
boundary. Definite pre-write refusal and uncertain Save need different recovery;
an uncertain operation uses its original receipt rather than a replay.

## Inspect the saved artifact

Read the actual generated formats affected by the change, not only the screen
preview. Reconcile membership, definitions, titles, scope and facts across
HTML/PDF/JSON/Markdown where supported. Check document usefulness and relevant
print/page boundaries without inventing fields or fetching cited content.

Preserve prior saved files, manifests, hashes and historical interpretation.
When a change affects the frozen format or its interpretation, exercise
[verified Open](../../../docs/report-contract.md#frozen-files-and-saved-reading)
on disposable data. Write the new facts in JSON alone, open them with the
proposed fallback, then return to the candidate reader. Check the rendered
meaning as well as the bytes; a neighboring HTML file can hide an incompatible
JSON reader. Verify an old file still reads as saved and an altered file is refused.
Never regenerate old reports from current history to make them
look current. Screen tokens, typography and icons remain isolated from frozen
report paint; `screenTokens` is not a report-output replacement.

Keep verified Open distinct from any explicit unverified-original reading path.
Missing or altered files retain truthful outcomes, not a successful-looking
fallback. Saving a local artifact does not authorize publication or disclosure.

Completion means the affected normal report journey and actual output retain
their agreed membership, facts and authority, while existing saved bytes stay
unchanged. Use [evidence semantics](../wire-evidence-semantics/SKILL.md)
for changed measures and [UX finish](../wire-ux-finish/SKILL.md)
for affected reading/selection interfaces.
