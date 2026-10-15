# Live local text search

Search uses deterministic, case-insensitive literal substrings over the existing
authorized corpus. It uses **no AI**: no embedding model, inference tokenizer,
model/linguistic helper, reranker, provider, SDK session or AI-credit budget.
Missing model assets are irrelevant; text matching is the primary path, not a
failed-model fallback. Optional WIRE assessments remain separate.

`POWER` finds `PowerPoint` in an admitted title, content or source label. `owerp`
also finds it. `repair the car` finds `did not repair the car`; Search does not
judge intent. A phrase must occur within one field, with its words in order.
There is no synonym expansion, stemming, fuzzy spelling, query language,
autocomplete, generated answer or Related result set.

## Matching and original-text ranges

`lib/search-text.mjs` defines the versioned text policy. The executable rule is:

1. Apply JavaScript `trim()` to the query ends only.
2. Normalize the query and each field independently with
   `text.normalize("NFKC").toLowerCase().replace(/\u03c2/gu, "\u03c3")`.
3. Test the normalized query with literal `indexOf` in each normalized field.

Internal whitespace, punctuation and accents are not stripped or tokenized.
The final-sigma fold makes Greek `Σ`, `σ` and `ς` work in both ending and
nonending contexts. This is the specified deterministic normalization, not a
claim of locale-specific linguistic matching for every language.

Fields are the already-admitted `title`, `content`, and `source.label`.
Operational IDs, paths, hashes, target descriptors and private source values
never become search text. A match cannot span a title/content/source boundary.
Interaction, follow-up and reply titles are at most 120 graphemes of their
already-admitted original text, starting at the first non-whitespace grapheme.
They are original slices, without generated summaries, decorative ellipses or
role prefixes. Unavailable/empty content keeps its truthful generic fallback.
Full content stays searchable; title changes participate in the existing entry
revision and index identity. Type/category and source remain separate.
Results prioritize a whole-title match, then title substring, then content/source,
with canonical ID ordering for ties. Every admitted matching item is returned;
neither retrieval nor analytical membership is limited to the displayed page.

Each hit has `match: "text"` and a closed:

```js
textMatch: {
    field: "title" | "content" | "source",
    start,        // original field UTF-16 offset, inclusive
    end,          // original field UTF-16 offset, exclusive
    excerptStart  // original field offset of the returned excerpt
}
```

`source` means `source.label`. These are offsets in the admitted plain-text field,
not HTML bytes, tokenizer positions or the normalized string. Marked ranges and
excerpt edges preserve original graphemes/surrogate pairs. A compatibility
ligature can therefore be marked as one original glyph even when the normalized
query matches only part of its expansion.

Length-changing normalization maps decomposed grapheme spans back to their
original source spans before recomposition. The excerpt is an original slice
around that match; it expands if needed to retain normalization context.
The normalized marked region within the excerpt contains the normalized query.
No unrelated leading report paragraph is substituted for a body-only match.
The browser validates relative bounds and marks
`[start - excerptStart, end - excerptStart)` with inert text nodes. It does not
run a second matcher. Title/source matches can be marked directly in those
original fields without duplicating the same excerpt.

## Corpus, saved files and authority

`createSearchRetrieval` indexes the current [authorized corpus](search-corpus.md)
in memory. Both `search()` and `discover()` use the same complete text population.
The latter supplies only `{ matches: { hits, receipt } }`, not Related candidates.
Index identity binds the text policy, corpus generation and canonical revisions.

Existing HTML, JSON, Markdown and local PDF text extraction stays in use.
For HTML reports, the inert `<head><title>` is now a separate searchable title,
read from the same verified saved file; scripts, styles, attributes and other
hidden content remain excluded. Body content remains separately searchable.
Title and excerpt are privacy-screened original admitted text, never generated.
This does not rewrite a saved file, regenerate a report, relax its manifest/hash
checks or change frozen report/comparison schemas.

Only `corpus.deliver` discloses freshly revalidated IDs/revisions and closed
targets. Verified Open still rechecks ownership, current source and exact saved
bytes. Missing extraction, unreadable files and changed sources retain explicit
partial/unavailable/stale outcomes. An empty query, a fully searched no-match and
an incomplete search are distinct. A zero-hit partial corpus is not reported as
a complete no-match.

Query replacement, clear, cancellation, permission/source/deletion changes,
disconnect and expiry clear owned results. Closing waits for active corpus
operations, including the non-AI PDF parser, to settle. There is no persistent
query, derived-content or embedding cache; queries are not placed in URLs/logs.
Search never expands source approval, capture, retention or history windows.

## Live v3 interface

`search-wire-contract.mjs` is the shared serializable factory. Handshake and query
use `schemaVersion: 3`; query purpose remains `navigation | analysis`, and type
allowlists remain closed, unique and canonical.

Every result has one `matches` set with complete `hits` and matching `total`.
Receipts bind schema, panel, epoch, request, generation, index, revision, purpose,
effective types and the text policy. `mode` is `text`; there is no `modelId`,
model status, linguistic status, chunk count or Related receipt/set. Unknown
range fields, invalid bounds, old match enums and old policy/schema receipts
reject rather than being upgraded.

Analysis still requires the current stored analysis-purpose receipt and complete
coverage of its analytical types. The same matching interactions/actions feed
widgets, both comparison periods and report preparation before paging. Private
internal/frozen property names such as `semanticSelection` remain compatible;
they do not cause semantic inference. Frozen saved reports/comparisons keep their
independent readers and schemas, not a dependence on a current live receipt.

The stationary header capsule shows actual matches as the user types. It does
not expand into another mode, fill in queries or add a Submit button. Results show
their category/source and matching original title/snippet; verified Open/Back,
keyboard access, category filters and paging retain their existing behavior.

## Focused proof and retired research

```powershell
node --test --test-concurrency=1 tests\search-text.test.mjs tests\live-search-text.test.mjs tests\live-search-text-lifecycle.test.mjs tests\search-corpus.test.mjs tests\search-corpus-readonly.test.mjs
```

These use real isolated invented stores, saved HTML/JSON/Markdown/PDF files,
actual corpus extraction/delivery, normal local HTTP streams and verified Open.
They trap inference/helper/model-asset/provider paths, cover Unicode ranges,
all supported types, 63-ID pages, latest-query replacement, privacy/source and
deletion fences, both periods and in-memory frozen scope. PDF parsing is non-AI.
Browser proof belongs to the coordinated v3 UI integration, not these core tests.

The old meaning-oriented MUST/ALLOWED fixture and model/linguistic/Related/denial
experiments are **historical**, not passing gates for text Search. Their semantics
were superseded by the explicit product scope reset. Preserve their source,
tests and evidence at `8dab98f4e847186c2606efb3fe2ada87c609db98`; do not relabel
them as green, activate their assets or reintroduce the denial veto. The former
[semantic retrieval](semantic-retrieval.md) and [linguistic adjunct](search-linguistics.md)
documents are historical references only.
See [test retirement and active coverage](search-history.md) for the explicit
old-case-to-current-proof map.
