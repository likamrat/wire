---
name: wire-local-search
description: Implement and verify WIRE's literal on-device Search contract. Use for corpus admission, matching, Unicode highlights, result identity/Open, analytical Search membership, lifecycle or revocation changes. Preserve exact authorized text without AI, semantic inference, provider sessions or off-device query processing.
license: MIT
---

# WIRE local Search

Use [local text Search](../../../docs/live-search.md) and the
[authorized corpus](../../../docs/search-corpus.md) for the maintained contract.
Earlier semantic/Related experiments are superseded, not alternative backends.

## Match authorized original text

Search runs on-device over admitted text, independently of Copilot/provider
sessions, AI credits, embeddings, semantic inference or an intent veto.
Preserve the versioned normalization and literal substring policy implemented
by the shared matcher; do not add another matcher in the browser.

Representative expectations: `POWER` and `owerp` find `PowerPoint`;
`repair the car` can match `did not repair the car`. Missing model assets have
no bearing on this search. Titles, content and admitted source labels are
separate fields; operational IDs, private paths and secrets do not become text.

Keep match/highlight ranges in the original admitted text, including
length-changing Unicode normalization and grapheme boundaries. Highlight with
inert text nodes. A body-only match needs its actual excerpt, not an unrelated
opening paragraph or generated summary.

## Preserve result identity and lifecycle

Index and return the complete admitted population, not just a displayed page.
Keep known no-match, incomplete search, loading, stale and unavailable distinct.
Open revalidates the exact original target, revision, owner and saved-file bytes;
never widen a match to another record or an entire conversation by convenience.

Query replacement, permission/source changes, deletion, sign-out and disconnect
invalidate owned private results as required by the current contract. Reject
late responses instead of restoring cleared or revoked content. Preserve exact
Open/Back, selection, focus and reading-position behavior.

Reuse the stationary shared Search capsule and automatic typed results. Do not
turn a Search fix into an expanding field, separate Search mode or duplicate
search interface. Query text remains out of logs, URLs and persistent caches.

## Focused proof

Select relevant cases from title/body/source matching, Unicode ranges,
all-page membership, exact Open/Back and delayed-result revocation. A result
count or screenshot alone cannot establish the target/authorization contract.

Completion means the changed matching, range or navigation behavior is proved
on the exact candidate without widening authority or reviving superseded semantic
work. Use [report integrity](../wire-report-integrity/SKILL.md) when Search
selects a report population, and [UX finish](../wire-ux-finish/SKILL.md)
for result presentation.
