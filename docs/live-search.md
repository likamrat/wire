# Local text Search

Search is deterministic, on-device literal matching over the
[authorized corpus](search-corpus.md). It uses no AI, embeddings, inference
tokenizer, provider/SDK session, credit budget, semantic Related set or intent
veto. Missing model assets have no effect on current Search.

For the user task, see [Find saved text](user-guide.md#find-saved-text).

## Matching and original-text ranges

`lib/search-text.mjs` owns the versioned policy:

1. Apply JavaScript `trim()` only to query ends.
2. Independently normalize query and fields with
   `normalize("NFKC").toLowerCase().replace(/\u03c2/gu, "\u03c3")`.
3. Use literal `indexOf` within each admitted title, content or source label.

Internal whitespace, accents and punctuation are not stripped. A match cannot
cross field boundaries. `POWER` and `owerp` find `PowerPoint`;
`repair the car` also finds `did not repair the car`. This is not a claim of
locale-specific linguistic matching, synonym expansion, stemming or spelling
correction.

Rank whole-title matches before title substrings, then content/source matches,
with canonical ID ties. Return the complete admitted matching population
before display paging. Interaction/context/reply titles are bounded original
slices of up to 120 graphemes, not summaries; full admitted content remains
searchable. IDs, hashes, paths and target descriptors are not query text.

Every hit has `match: "text"` and a closed range:

```js
textMatch: {
    field: "title" | "content" | "source",
    start,
    end,
    excerptStart
}
```

Offsets are original-field UTF-16, end-exclusive. `source` means `source.label`.
Length-changing normalization maps back to whole original graphemes and
surrogate pairs. An excerpt surrounds the actual match and retains the
normalization context; it cannot substitute an unrelated leading paragraph.
The browser validates bounds and uses inert text nodes/marks, never another
matcher or injected HTML.

## Retrieval and live protocol

`createSearchRetrieval` builds an in-memory index through corpus `index` and
discloses only through freshly revalidated `deliver`. `search` and `discover`
use the same text population; discover returns only `matches`, not Related.
Index identity binds text policy, corpus generation and canonical revisions.

The shared serializable wire contract uses schema 3 for handshake/query.
Purpose is `navigation | analysis`; type sets remain closed, unique and
canonical. A receipt binds panel, epoch, request, generation, index, revision,
purpose, effective types and text policy. There are no current model,
linguistic, chunk or Related status fields. Old schemas/enums/policies and
malformed ranges reject rather than upgrade.

Analysis requires a current stored analysis-purpose receipt and complete
coverage of its analytical types. Exact interactions/actions then narrow
charts, rows, both comparison periods and current-view report preparation
before paging. Navigation hits cannot become analytical membership by editing
a purpose string. Partial navigation results remain useful but do not prove
a complete analytical population.

Private names such as `semanticSelection` remain compatible without inference.
Saved reports use their own frozen schemas, not a current live receipt.

## Corpus authority and Open

Index publication, hit delivery and Open recheck current owner, source,
permission, exact identity/revision and saved-file integrity. Missing,
corrupt, unreadable and changed content remain partial/unavailable/stale,
not a complete no-match or an alternate target.

Query replacement, Clear, cancellation, source/permission/deletion changes,
disconnect and expiry retire owned results and their actions. Closing waits
for active corpus work, including the owned non-AI PDF parser. Queries, derived
content and index state are not persisted or put in URLs/logs. Search never
widens collection, retention or history permission.

Verified report Open retains its Search owner/receipt; it cannot borrow the
Reports library's independent authority after reload or invalidation.
Exact request/call/result targets retain their original revision guards and
Back/return ownership.

## Screen behavior

The stationary capsule shows actual matches as the user types, with scope and
type choices directly below. There is no Submit or expanded Search mode.
Clear resets query/result work and paging while preserving scope/type.
Escape/outside dismissal hides the popup without clearing text.

Group the complete hit population by type before selecting a 20-item page.
Categories follow their first ranked match and keep server order within each
category. This changes presentation order only, not receipts or membership.
Original titles, relevant excerpts and distinguishing source labels identify
hits. Omit equivalent unmatched captions, never a matched field or distinct
record. Formats are supporting disambiguation, not invented metadata.

Use the shared `web/search-field.mjs` for field paint and Clear behavior.
Callers own their query, scope, results, debounce and lifetime. Settings,
saved-report metadata, issue and report-picker searches keep their separate
normalization/scope; they are not aliases for global evidence Search.

Title, excerpt and source wrap independently; no clamp hides the actual match.
Use original ranges and a single boundary ellipsis where text is omitted.
Category/service/outcome cues retain their distinct meanings and shared icon
roles. See [design](design.md#search), not a duplicate palette specification.

## Withdrawal and return

`mountLiveSearch` requires the shared transport's `publicationToken`,
`isCurrent` and validated `accessState`. Tokens are synchronous/non-null and
checks must return literal true. Capture the owner before callouts and recheck
after them; withdrawal followed by readiness cannot rebind old work.

Local `withdrawAccess` aborts streams/timers and scrubs query, results,
receipts, return maps, analysis and document preparations without navigation,
focus restoration or requests. Clear actual held Text/Attr values before
detachment. Shared owners independently clear analytical membership, private
history and readers. Resume enables only new intent.

The runtime releases idle Search owners after 120 seconds. While shared access
remains current, hidden/pagehide/window-blur transitions clear displayed
authority but may keep in-memory reading intent. Return issues one fresh
read/query; a released owner gets a fresh stream. Only a same-owner/epoch
`idle`, `session-released` or `runtime-stopped` fence qualifies automatic EOF
recovery. Protocol/network/parsing failures, unfenced EOF and explicit
cancellation do not restart on visibility changes.

Validated unbound-to-unbound renewal preserves its limited legacy intent through
a new owner/read. Enforced renewal withdraws old intent and requires fresh
authority. Neither path retries a mutation. A `collected` fence can coalesce a
fresh visible navigation query after a committed collector advance; it is not
recovery from deletion, permission loss or integrity failure.

Late query, error, document and return-focus continuations retain both original
Search sequence and shared publication ownership. Navigation/document callbacks
must check before their own side effects, not only after returning.
Back restores Search focus only after reader closure and underlying reading
restoration settle, unless newer user input supersedes it.

## Retired Search research

Semantic, embedding, linguistic, Related and explicit-denial experiments are
retired, not alternative backends or acceptance gates. Their former opposite
expectation for `did not repair the car` is intentionally not current behavior.
Inference dependencies and provisioning npm scripts are already absent from
the current manifest.

The full [semantic](semantic-retrieval.md) and
[linguistic](search-linguistics.md) notes remain temporarily because their cited
development revisions are not accessible through the published repository.
Do not treat their commands as runnable here, publish old ancestry to repair
the links, provision assets or delete private historical resources.

Current lifecycle/privacy coverage remains active in `search-text.test.mjs`,
`live-search-text.test.mjs`, `live-search-text-lifecycle.test.mjs`,
`search-corpus*.test.mjs` and the current Search browser suites. Retiring
model/recall expectations does not retire ownership, complete-population,
Unicode, exact Open, saved-file integrity or cancellation requirements.
Existing assertions are not a blanket passing-suite claim.

## Optional Microsoft consumer

The incubation retained-reader uses this literal matcher and its own genuine
account/source lease, not GitHub reply consent. Native source observations
remain context, not fabricated authored messages or calls. Bounded native
navigation pages do not mint ordinary full-population analysis receipts.
Use the [retained-view contract](incubation/native-retained-views.md) for its
separate original-view membership and report admission.
