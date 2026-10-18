# Live local text search

Search uses deterministic, case-insensitive literal substrings over the existing
authorized corpus. It uses **no AI**: no embedding model, inference tokenizer,
model/linguistic helper, reranker, provider, SDK session or AI-credit budget.
Missing model assets are irrelevant; text matching is the primary path, not a
failed-model fallback. Historical review wording in an authorized saved document
remains searchable; it does not restore a current review or feedback operation.

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

### Result presentation

Each result is one native button led by its original title, with an existing
semantic Lucide glyph aligned to that first text line. All ten categories have distinct
screen-only `--search-*` colors, shared by their glyph and readable category heading:
interaction, conversation context, reply, recorded action, tool, service, report,
comparison, view and setting. Primary text stays neutral; an action's separate
recorded outcome retains its canonical success/failure meaning and color.
The full authorized result population is grouped by type before the displayed
20-item page is selected. Category order follows each type's first ranked match;
results within each category keep their original server ranking. A category can
continue on the next page, but another type cannot interrupt it. Every hit uses the same structure:
one canonical-title row, then matching evidence or necessary supporting context.
There are no per-row category labels on the right and no title-based layout rules.
Original matching evidence follows only when it adds a different matched field.
Input, result text, metadata
and filter labels use the same regular Asta Sans reading scale; hierarchy comes
from order, grouping and contrast, not accidental font sizes or weights.
Type is entry metadata, not inferred prompt authorship. Unmatched source captions
are omitted unless different source labels distinguish hits with the same exact
type and canonical title across the full result population. A matched source is
always preserved; no result is merged or removed by this presentation.
Settings uses the existing Settings gear. Service hits obtain their identity
from the verified service target, not their title, and reuse the same
`serviceCue`/`dimensionalIcons` glyph as the recorded-data widgets. There is no
second service-to-icon map or copied service label. Recorded outcomes use the
existing `*-compact` roles rather than shrinking a regular control icon.

An unmatched retained interaction/context caption is omitted only when its
complete original value equals the complete original title after whitespace
and terminal-sentence-punctuation handling. Case, interior punctuation and
distinct qualifications are not discarded. This is display-only comparison,
not fuzzy corpus deduplication or relationship inference. Matched source text
is never omitted or rematched: if title and matched source are exactly equal,
the source supplies the single original primary line. Each hit, within-type order, count,
identity, Open target and server-supplied range stays unchanged. Related actions
remain separate results; a source-only action match still shows its original
source evidence. Absent optional fields create no blank slots.

Action unit, outcome label, applicability and icon come from the existing
recorded-results helper. A Work IQ tool call can say Worked; an owned HTTP record
instead says HTTP 2xx or HTTP 4xx/5xx, and code references retain Execution not
observed. These are not interchangeable statuses or new analytical counts.
File formats are not part of the main result heading. Supplied formats appear
as supporting disambiguators only when otherwise identical report titles have
different formats in the current full result population. The accessible action
still names the supplied format. Absent formats, including comparison formats
not supplied by Search, are not guessed.
Unmatched fixed "Approved frozen report/comparison" captions are omitted because
the type and saved-item destination already convey that context. A matched
caption is still shown verbatim. Canonical titles always retain priority:
"Saved report" or "Saved comparison" may be a genuine title, and the hit does
not carry authoritative fallback provenance. Generic-looking and specific
titles therefore use exactly the same title row. The title stays neutral,
the type glyph keeps its category color, and matching body evidence stays below.
No title, field, hit, target or match range is rewritten.

Compact rows use whitespace rather than repeated rules or nested cards.
Body evidence shares the heading's reading edge without a blockquote bar.
The scoped blue/teal match color marks
only the server-supplied original range, with restrained weight and semantic `mark`,
not an underline;
it does not indicate a service, outcome, confidence or generated relevance.
Other text uses existing neutral roles, with canonical outcome cue colors.
The result count and any incomplete-coverage notice share one summary above the list.
The grouped display is a new ordering of the same hit references, not a mutation
of the server array. Receipts, exact IDs/revisions/ranges, total counts and
analytical membership are unchanged. Paging, keyboard movement and Open/Back
use that grouped display consistently; displayed-page counts are not group totals.
Partial-corpus coverage is a concise readable line, not a filled card. Known
report-file failures name the supplied cause (missing file or changed bytes that
could not be verified); unclassified failures keep an honest general explanation.
The message is computed only from issues affecting the current requested types,
not from the presence or absence of matching rows. Pending, error,
reconnect, incomplete and complete no-match messages retain their existing
state meanings.

Titles, sources and excerpts wrap independently, including bidirectional text
and unbroken tokens. No CSS line clamp hides a match. The existing excerpt
window preserves the full marked text. A single ellipsis at each omitted boundary
is attached to its neighboring text with a nonbreaking space, never a separate
dot-only row or a second block of punctuation. It is not
labelled as complete saved content. Search keeps its fixed capsule and popup
placement, full-result membership, 20-item paging, single whole-row action,
keyboard focus and native Open/Back history. Hover gives the actual title a
restrained accent tint; press returns it to ink and keyboard focus keeps its
visible outline. Neither titles nor match ranges acquire underlines.
The whole hit area stays usable without a filled hover slab or geometry shift. Forced colors retain system
highlight and focus paint. These styles do not alter saved report output or
global service, outcome, authorship or theme tokens.

Scope and type are immediately available as two compact filter bubbles inside
Search, directly below the query. There is no separate Filters disclosure,
summary or extra click. Accessible labels remain associated with both controls
without becoming another row of visible captions. Both selects use the same
shared adapter and bubble styling as the main activity filters via
`data-select-presentation="filter"`; the shared adapter supplies
`.select-trigger-filter` and `.select-popup-filter`. Search owns only placement
and local layout, not a copy of shared select styling. These remain
single-select listboxes with check marks, not multi-select toggles or new
Apply/Cancel operations. Result rows never opt into filter-menu styling.

One WIRE-owned **Clear search** action belongs to the query capsule, not Filters.
It clears the query and current result/receipt work, resets paging and returns
field focus; it preserves Search scope and result type. Escape and outside
dismissal still hide the popup without clearing the query. Paging still changes
only the displayed slice. Filters therefore contains only the scope and type
choices, not another query-clear entry or an invented filter-reset operation.

After the existing exact saved-file/manifest read succeeds, the corpus consumes
only its optional `canonicalTitle` carrier. That carrier is supplied from the
verified manifest by the saved-artifact reader, never inferred from an indexed
title or UI fallback. Absence preserves extracted/legacy title behavior. A
present malformed carrier fails closed; a valid masked title is used unchanged,
including when masking expands it beyond the 200-character input limit. This
does not bypass producer-side manifest/index/snapshot title binding or change
historical bytes.
The saved-entry constructor carries that verified presence through title
projection: only a declared canonical report/comparison title skips the extra
derived-metadata screening. Identifier-shaped text in that approved title
therefore remains literally searchable with its original ranges. Legacy or
extracted titles, body content, and other metadata keep their existing privacy
filtering; matching text alone never establishes canonical provenance.

The clear action is visible for any nonempty query, including whitespace, and
uses the shared 44px icon target with an official 20px glyph. A reserved trailing
region keeps it away from long editable text, with no capsule geometry change.
The shared field suppresses native pointer-cancel decoration to avoid a
duplicate Clear action; `type=search`, editing, selection, composition and keyboard
behavior remain native. Decorative type glyphs stay inside their text lines
without separate hit areas. Search does not override the shared icon-only
sizing rule for Clear or paging.
SVG dimensions come from the existing `data-icon-size` rules: compact metadata
glyphs are 16px, shared service glyphs retain their established 24px role, and
utility glyphs use 20px inside the shared 44px controls. A first-line-height
decorative slot keeps the same 20px lane and 8px text gap without allowing SVG
dimensions to inflate row height. Category colors and recorded-outcome colors
remain distinct. No Search-local SVG shrink overrides or icon-only buttons are
added to result rows.

The stationary capsule has one blue/violet/rose gradient edge and a soft halo
even while idle. Hover and focus glide the gradient over a bounded transition,
without moving or resizing the field or running a perpetual animation. Keyboard
focus replaces that edge with a high-contrast inset outline, not a second exterior
ring. Both themes retain readable input and placeholder text. Reduced motion
disables the transition; forced colors use system border/focus colors without
gradient or glow. This treatment does not change non-search controls or saved output.

### Shared search field

`web/search-field.mjs` owns the search-field Module: `searchFieldMarkup` renders
the escaped input identity, placeholder, optional help/popup associations,
canonical magnifier and Clear target; `searchFieldStyles` supplies the capsule
paint and geometry. Callers retain their associated labels and contextual help,
results and width constraints. The saved-report field remains capped at 18rem;
the global field remains stationary.

The nonce-authorized shell injects the self-contained `createSearchFields(ux)`
factory once. Its `mount(input, { clearLabel, onInput, onClear?, focusAfterClear? })`
Interface returns `sync(value?)`, `clear()` and `dispose()`. Native input calls
the caller once, without changing composition, selection, debounce or submission.
Clear updates the field and calls `onClear` (or `onInput`) once, then restores
focus. It does not synthesize a second input event. `sync` reconciles caller-owned
values without dispatch, and avoids replacing an unchanged value/caret.
Remounting the same input releases its previous field listeners; transient
owners call `dispose` before retirement. Persistent shell fields are mounted once.
No queries, corpus, storage, transport or result state live in this Module.

| Current entry | Caller-owned behavior |
| --- | --- |
| `wireSearch` | Global/Analyze query, existing debounce, popup Escape, verified results and Open/Back |
| `settingsSearch` | Fixed setting metadata and native setting destinations; Escape clears |
| `issueSearch` | Affected-history metadata, existing paging; clearing an authoritative empty list focuses its heading |
| `savedReportSearch` | Saved-report metadata, not saved contents; Clear preserves library paging |
| `reportRequestSearch` | Local interaction list; Clear never changes the report selection |
| `recollectSearch` | Local eligible-chat names and independent selection; native Escape clears nonempty search before dialog cancellation |

Period comparison's current **Search this comparison** entry opens `wireSearch`
in Analyze scope. `comparisonSearch` is a hidden fallback, and `activitySearch`
is the hidden legacy private-filter adapter. Neither is revived as a second
visible search field. Ordinary title/path/date inputs and select-option lists
are not search bars.

The fixed timing destination describes "tool latencies" at the authoritative
navigation-corpus source. Its title, route and focus target stay unchanged.
Normal content hashing/index rebuilds provide new receipts and original ranges;
historical text is not renamed and there are no search aliases.

### Leaving and returning

The runtime still releases an idle Search owner after 120 seconds. That cleanup
is not a user cancellation: the mounted page keeps only its query, scope/type,
page and reading intent in memory. Hidden/pagehide and genuine window-blur transitions clear displayed
hits, receipts and open-document authority. On return a surviving stream gets
one fresh query; a released owner gets a fresh authenticated stream and query.
Focus-only return is covered even when an unminimized window stayed visible;
focus moving into a child frame is not treated as leaving the window.
Only an observed `idle`, `session-released` or `runtime-stopped` fence for the
same stream, owner and epoch qualifies a clean remote EOF for automatic recovery.
Idle release retains intent whether it happens before or after departure.
One qualified release during return can replace the old stream once, not enter
a retry loop. Unfenced EOF, protocol/parsing/network errors and engine read
failures terminate automatic resume in both visible and inactive states.
The transport finalizes fatal UTF-8 decoding, rejects unfinished event buffers,
and never relabels caller cancellation as remote EOF.
Repeated lifecycle notifications do not repeat the read.
Query replacement, explicit clear/cancel/close, genuine read failure, and source
or deletion invalidation retain their existing fences. A cancelled or failed
query is not silently restarted by later visibility changes.

Capability release/expiry and runtime shutdown have distinct stream fence reasons
from explicit Search close. The old capability and receipt remain invalid; normal
same-origin session renewal obtains a new owner before any result is admitted.
No mutation or report save is retried. A failed recovery retains the actual error
and explicit retry instead of replacing it with a false initial "connect" prompt.
There is no persisted query/history cache. BFCache can restore the in-memory
intent only when the browser actually retains the document; a discarded/reloaded
document does not recover private query text from storage.

The former `Updating this view...` return banner was owned by the independent
snapshot read, not Search's idle timer. Automatic return/online restoration now
uses the existing background-read path when an accepted snapshot exists. Loading,
staleness, selection gates, generation checks, timeout/error handling and final
busy cleanup still belong to that read. First load still uses foreground loading.
Report-preview invalidation and save recovery are unchanged.

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

Focused presentation and connected browser proof:

```powershell
node --test --test-concurrency=1 web\live-search-presentation.test.mjs tests\search-coherence.browser.test.mjs tests\search-result-design.browser.test.mjs tests\search-row-paint.browser.test.mjs tests\search-text-ui.browser.test.mjs tests\search-control.browser.test.mjs tests\search-minimal.browser.test.mjs
node --test --test-concurrency=1 tests\search-visibility.browser.test.mjs tests\search-category.browser.test.mjs tests\saved-artifact-read-lifecycle.browser.test.mjs tests\report-history-recovery.browser.test.mjs
node --test tests\search-grouping.browser.test.mjs
```

The design case measures full normal-root result hierarchy, text/icon alignment,
contrast, repeated titles with distinct targets, title/body/source marks,
multilingual and long unbroken text, both themes, intermediate and 375px widths,
200% text and forced colors. The paint case checks idle/hover/pressed/keyboard
contrast and exact Open/Back. Existing text/control cases retain real saved
report and interaction opening, touch, paging, query replacement, clear,
partial/error states, receipt fences and pending-departure cancellation. Retired
personal-feedback guard cases do not recreate the removed feature; current
report/source/consent authority remains tested. The coherence case also checks
current review destinations are absent while approved frozen review wording
still matches and opens unchanged. Optional
`WIRE_SEARCH_DESIGN_PROOFS`, `WIRE_SEARCH_ROW_PROOFS` and
`WIRE_TEXT_SEARCH_PROOFS` directories receive local synthetic screenshots and
measurements only; these are not live/private-data captures.

`WIRE_SEARCH_CATEGORY_PROOFS` captures all ten actual category glyphs/labels and
measures their rendered contrast (at least 4.5:1) and pairwise OKLab separation
(at least 6), plus mixed results, the capsule's idle/hover/focus/open states,
375px/enlarged text, partial/no-match/error/recovered states. Visibility proof
uses a controlled 120001ms server interval, visibility and focus-only return,
held and failed reads, capability
expiry/release, runtime replacement, current page/focus restoration and a real
CDP-frozen renderer. Dispatched page-transition events are emulation. A separate
native back/forward traversal reports whether BFCache actually admitted the
document; a fresh document is not misreported as BFCache recovery.
Fault checks deliberately remove a fixture file or fail a request. They remain
executable assertions, separate from healthy-state design screenshots; earlier
fault captures are archived as internal evidence, not presented as observations
of the user's live data.

The old meaning-oriented MUST/ALLOWED fixture and model/linguistic/Related/denial
experiments are **historical**, not passing gates for text Search. Their semantics
were superseded by the explicit product scope reset. Preserve their source,
tests and evidence at `8dab98f4e847186c2606efb3fe2ada87c609db98`; do not relabel
them as green, activate their assets or reintroduce the denial veto. The former
[semantic retrieval](semantic-retrieval.md) and [linguistic adjunct](search-linguistics.md)
documents are historical references only.
See [test retirement and active coverage](search-history.md) for the explicit
old-case-to-current-proof map.
