---
name: wire-local-search
description: Maintains WIRE's literal on-device Search over retained evidence. Use for corpus admission, Unicode highlights, exact Open/Back, Current Analyze scope or withdrawal of Search results.
license: MIT
---

# WIRE local Search

Use [local text Search](../../../docs/live-search.md) and the
[authorized corpus](../../../docs/search-corpus.md) for the maintained contract.
Search inside a settings list or draft picker narrows its own options. It
does not query the evidence corpus or change the analytical population.

## Match authorized original text

Search runs on-device over admitted text, independently of Copilot/provider
sessions, AI credits, embeddings, semantic inference or an intent veto.
Preserve the versioned normalization and literal substring policy implemented
by the shared matcher; do not add another matcher in the browser.

Representative expectations: `POWER` and `owerp` find `PowerPoint`;
`repair the car` can match `did not repair the car`. Titles, content and admitted source labels are
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
For a withdrawal bug, enter the query through the reported route, withdraw
access and release a delayed result. Check the field, held text and Back target:
none may restore the old query or match. A picker dismissal tests a different path.

Completion means the changed matching, range or navigation behavior is proved
on the exact candidate without widening authority or reviving superseded semantic
work. Use [report integrity](../wire-report-integrity/SKILL.md) when Search
selects a report population, and [UX finish](../wire-ux-finish/SKILL.md)
for result presentation.
