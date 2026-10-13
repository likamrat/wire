# Live local search

## Matches and Related results

Navigation search shows separate **Matches** and **Related results**. Related
suggestions can open existing saved content, but cannot populate charts, period
comparisons or report scope. The v2 client and backend share the closed contract
below. They use admitted producer `82494360`, normally composed with fresh UI
input `92028e95`; the restored sidebar, centered Search and one visible Back
restoration helper are preserved. An old panel receives explicit protocol-change
guidance, not an implicit receipt upgrade.

### Closed protocol and authority

`lib/search-wire-contract.mjs` exports one serializable factory and a Node
instance configured from the admitted producer's policy IDs and corpus types.
`lib/search-wire-contract.d.mts` describes the wire union. The factory contains
no Node imports or external closure when serialized with explicit policy values.

- `/api/search/events` now requires exactly `{schemaVersion: 2}`.
- `/api/search/query` requires `{schemaVersion: 2, purpose, query, requestId,
  types?}`, where purpose is exactly `navigation` or `analysis`. Missing or
  malformed purpose is not inferred. Empty/omitted types means all ten; receipt
  `queryTypes` is always the explicit unique, alphabetically sorted effective
  set. Unknown and duplicate request types are rejected.
- Every ordered stream frame carries `schemaVersion: 2`. The results event has
  `purpose`, `requestId`, `matches: {receipt, hits, total}` and, only for hybrid
  navigation, `related: {receipt, hits, total, coverage}`. Totals must equal the
  complete arrays; IDs must be unique and the two sets disjoint. Related coverage
  records evaluated items, corpus `ready | partial`, the literal retrieval mode
  `policy-selected-candidates` and `populationComplete: false`.
- Both receipts bind schema, panel, epoch, request, corpus generation, index,
  model, mode, board revision, authoritative job `queryPurpose` and effective
  `queryTypes`. Matches adds exactly `purpose: strict-match-population` and
  `matchPolicyId`; Related adds exactly `purpose: related-navigation` and
  `relatedPolicyId`, and is valid only for hybrid navigation. Extra fields,
  wrong policy/type order and changed discriminants fail closed.

Analysis calls the producer's **strict-only `search()`**, including the
[optional role-bound lexical increment](search-linguistics.md) when the host
explicitly configures its resource directory. The core-local receipt shape
is unchanged; the runtime builds the v2
wrapper from the admitted exports and its own job, never caller receipt fields.
Disabled hosts retain the original policy values. Enabled hosts stamp the
distinct `SEARCH_LEXICAL_POLICIES` pair; serialized consumers recognize that
explicit pair without accepting mixed policies or bypassing stored-receipt
equality and current-source checks.
Navigation calls `discover()` once, rechecks its producer policy/type metadata
and wraps the two sets only inside its synchronous authorized disclosure. There
is no additional model query, ranker, corpus reader, fetch or persistent index.

Each panel retains distinct `matches` and `related` maps and receipts. There is
no union `panel.hits`. Open selects the map by the validated closed receipt and
requires exact equality with that owned map's admitted stamp, including purpose,
policy and types. The existing before/after current-state gate, frozen-facts
identity and verified-file reader checks remain unchanged. A Matches receipt
cannot open a Related-only ID.

`membership()` additionally requires an original stored **analysis-purpose**
strict receipt, current complete corpus and all four analytical types. It reads
only the strict map. Editing a Related purpose, swapping its policy field,
changing query purpose/types or replaying another request/panel cannot promote
the Related item. `validatePeriodSemanticSelection` uses the same v2 strict
guard; both the live period action and initial paired report preview already
flow through that validator and the runtime authority. Historical frozen file
schemas do not contain live receipts and are unchanged. A legitimately prepared
report still needs no active receipt at later disclosure review/save.

Every query replacement, clear, cancel, fence, source failure, disconnect,
expiry and close clears **both** sets. The existing latest-only queue, two-owner
ceiling, owned Open slot and helper-exit accounting are preserved. The stream
publishes every policy candidate, or closes the slow consumer under the existing
backpressure bound; it never truncates a list and labels the remainder complete.
Lexical-only navigation publishes Matches with explicit degraded model status
and no Related set. Corpus partial coverage is distinct from Related's always
nonexhaustive policy selection.

V1 handshakes/queries and old eight-field Open receipts return explicit 409
protocol-change guidance; malformed v2 requests/receipts return 422. Old period
receipt shapes fail the strict analysis validator. No old receipt is upgraded.
No query/content enters logs, URLs, browser storage, providers or new files.

### Client separation and ordinary language

The factory is injected into the existing serialized state, Open, equality,
membership and period consumers. Both lists own their receipts, pages and
scroll/focus positions. The accepted journey owner's **one** in-memory
`restore(key)` handles visible reader Back and browser Back for either set.
Late results cannot reclaim focus after the user navigates or interacts elsewhere.
Only the strict analysis-purpose list reaches `onAnalysis`. Related has no
selection/report action and carries this explanation once:

> Similar topics, possibly different work. These do not change your charts or report selection.

The current strict F09 recall gap remains **open**. The optional adjunct's prior
two-query qualification is withdrawn; keep it disabled. Its two original gains
and `vehicle servicing` remain unsatisfied; the five existing ordinary-work
misses also remain open.
The 0.35 floor / 0.02 best
band is a separately qualified navigation policy, not a lowered strict threshold,
a complete population or verified same-work judgment. Related counts describe
only suggestions selected by that policy, not all matching work. No additional
inference/model/provider is introduced.

Search is one stationary rounded capsule in the header. Its position, dimensions,
placeholder and native input identity do not change on focus or typing. Results
appear automatically beneath it, aligned to the field, without moving the page.
An empty field opens nothing. There is no expanded Search mode, Close-search
control, Submit step, microphone, generated answer or conversation history.
Escape, clearing the query or leaving Search dismisses the list. The existing
Open/Back receipts restore query, category, result focus and dropdown scroll.
Navigation search leaves the underlying analysis and report scope unchanged.
While Search owns focus, the page's sticky-header scroll inset is not applied
to native caret scrolling; ordinary page navigation retains that inset.
The associated label stays accessible without consuming visible space.
A single unframed **Filters** disclosure
reveals existing scope/type controls only when deliberately opened. Its collapsed
summary names non-default active choices; it never opens itself during typing.
Ordinary rows show an already-retained request/title and quiet category/source.
The whole row opens its exact destination; there is no repeated Open line,
badge frame or per-row elevation. Both result sets share one softly raised list.
Hover and press fill only the actionable row using the shared interaction colors;
idle rows stay unframed and keyboard focus retains its visible outline.
Reports and meaningful action errors can
keep a short original excerpt for recognition. Accessible action names preserve
the human destination. Internal hashes, encoded routes and
machine-only action lines are not displayed as human summaries; no intent or
outcome is invented. Full authorized details remain at the opened destination.
Routine ready counts are announced without a visible paragraph; paging still
shows the complete per-set page/count. Transient, no-match, partial and degraded
states stay visible when needed, distinct from Related uncertainty.
The word-search fallback is shown only after a current lexical-only result was
admitted. Local model provisioning guidance lives in the existing Troubleshooting
help, reached by one link; search never executes the displayed command.

The preserved applied-analysis banner is visible only within Analyze, not above
Reports/Settings titles. The query/filter remains active; Current-view report
scope still reports its actual availability inside the report journey.

The focused minimal-presentation gate is
`node --test --test-concurrency=1 tests\search-minimal.browser.test.mjs tests\search-control.browser.test.mjs`.
It checks the actual `what` navigation query, one input with an accessible label,
fixed capsule/results alignment and unchanged page geometry, deliberate Filters, native editing/clear,
typed keyboard Open/Back, visible focus, both themes and 375 px/200% text. Text
enlargement is not native browser zoom. The control gate also covers all 45
results over three pages, native deep typing at 1440/768/375 px, and actual focus
departure restoring the reading inset (Escape alone keeps Search focused).
It verifies exact Settings destinations and analytical membership independently
of local time grouping, global Dates and report selection using no-model fixtures.
Set `WIRE_SEARCH_NATIVE_HEADFUL=1` to run its native-scrollbar matrix headed;
on Windows that case uses the installed Edge channel. Group/paging/Back sentinels reuse
the Related browser cases; the semantic and authority algorithms are unchanged.

### Backend and browser proof

```powershell
node --test --test-concurrency=1 tests\related-wire.test.mjs tests\related-browser.test.mjs web\live-search-state.test.mjs
```

Invented stores and the actual pinned MiniLM exercise: closed v1/v2 rejection,
producer/wire stamp conversion, strict-versus-Related map/owner/type/policy
forgery, zero strict car results with navigable Related but empty valid analytical
cohorts, live period and report-preview rejection, unchanged complete strict
admission, every typed destination, all 63 selected candidates across four
20-item slices without retrieval truncation, latest-query/cancel/two-panel
fences, reply revocation with independently approved artifacts, tamper refusal,
source unavailability, lexical-only/partial separation, Related Open-close and
backpressure closure. Browser proof separately exercises simultaneous 21 exact
phrase matches and 63 Related suggestions with independent two/four-page lists,
mouse/keyboard Open, visible/browser Back, delayed restoration without focus
theft, strict-only scope switching, source/session invalidation, partial/degraded/
protocol states and both themes at 375 px/200% text. Existing real-model paired
Review/Save/frozen Open proof remains a consumer-regression sentinel. These are
invented-data implementation checks, not a universal relevance claim or a new
model qualification.

## Search journey

The header's **Search** field searches while typing. **Everywhere** locates
authorized interactions, conversation context, retained replies, recorded actions,
tools, services, saved report/comparison contents, views and settings. It does not
change analytical filters or report selection. **Current Analyze scope** explicitly
applies the same engine's verified interaction/action membership to Analyze.
The retained metadata-only utilities inside Settings, report selection, the saved
library and collection diagnostics remain separate list utilities.

There is no Submit or generated answer. Results identify type, source, excerpt,
coverage and exact destination. Arrow Down from the field enters the results;
arrows, Home/End, Tab and Enter work normally. Escape closes the list. Direct Open
rechecks authorization; Back restores the query, category, result page, scroll and
focus, then revalidates the results instead of restoring cached excerpts. New
global text lives only in panel memory. Only an opaque restoration marker enters
`history.state`; existing legacy analytical/list history state is unchanged.
Cross-layer Back keeps its restoration intent until the accepted analytical scope
and its result receipt agree; a scope reload does not reset the saved result page.

## Runtime and privacy boundary

`lib/live-search.mjs` owns one accepted `createSearchRetrieval` facade per connected
search panel. The actual `collectorFor(session).assessmentSource(state)` supplies
current source identity; missing collector means unavailable, never persisted
consent fallback. Nothing in search enables collection, rereads original history,
saves replies, runs Work IQ/Graph, dispatches assessments or acquires model assets.
The [pinned model's explicit provisioning](semantic-retrieval.md) is unchanged.

All search endpoints are same-origin capability-authenticated JSON POSTs:

| Endpoint | Purpose |
| --- | --- |
| `/api/search/events` | Ordered JSON-lines stream: connection, content-free heartbeat/fence/status, gated results, explicit opened item |
| `/api/search/query` | Monotonic request ID, text and optional closed type allowlist; acknowledges scheduling, not results |
| `/api/search/status` | Content-free facade/model/index status and measured durations |
| `/api/search/open` | Exact hit ID, complete receipt and open ID; no caller target/path/URL |
| `/api/search/cancel` | Clears queued work and invalidates/aborts actual owned computation |
| `/api/search/close` | Clears synchronously and waits for owned work/helper exit |

Text/content/capabilities never enter URLs. There is no query log, provider call,
telemetry, browser-storage entry or persistent search index. Missing/corrupt assets
produce explicitly labelled **exact/prefix only**, not false semantic success.
Partial coverage and safe issue codes remain visible; stale, changing,
disconnected and unavailable are not no-match.

One active query plus **one replaceable latest query** is allowed per panel.
Explicit item opening also has one owned read slot; concurrent opens are refused
as busy, and closure waits for that read gate without admitting late content.
Normal typing waits behind an active verified delivery rather than superseding
its PDF parser and repeatedly rebuilding the corpus. Queued intermediate text is
discarded. A 120 ms input stabilizer is not a performance guarantee. Explicit
cancel, stream disconnect, capability expiry and runtime shutdown close actual
owned work. There are at most **two model-owning panels**, including owners still
closing. A third receives an explicit busy response; it does not start another
helper or enter an unbounded wait queue.

Search panels expire after two minutes without query/open/status activity.
Existing capability TTL also remains enforced proactively. Heartbeats run every
second; the browser clears on disconnect, hidden/page-leave, failed state/status
read or five seconds without a stream event. Reconnection gets a new panel and
requires fresh admission. Queries are limited to 64 KiB; a stalled stream is
closed above 8 MiB buffered output (48 MiB for an explicit saved-file read).
These are local resource policies, not completeness truncation or an SLA.

## Fences, not a claim of atomic network erasure

Existing collector `onCommitted`, deletion `onSeal`, recollection `onCommitted`
and evaluation `onChanged` hooks invalidate every connected search owner.
Server mutations also fence before dispatch and **before acknowledgment** and
block new disclosure/admission while a mutation is active. Read/preparation-only
report preview operations do not revoke the receipt they are legitimately
admitting; final artifact registration does fence.

Invalidation synchronously drops the server's pending/hit/target references and
index, aborts model/parser work, and writes a new epoch to the same ordered channel
as results and explicit opens. Browser results require the current panel, epoch
and request; openings additionally require corpus/index/model/mode/revision.
An observed fence erases rows, targets, owned saved-document contents and a
search-opened request reader. Late events from an earlier epoch cannot resurrect
them. A failed heartbeat or unreadable stream fails closed.

An already-sent frame may arrive **before** its subsequent mutation fence.
Neither HTTP nor JavaScript can retroactively erase previously delivered bytes,
guarantee secure memory zeroization, or make network delivery atomic with a local
store commit. The ordered stream and final open/admission gates address that
boundary without claiming otherwise. A content-free state/source observer also
fences changes detected outside normal owned mutation routes; artifact bytes are
revalidated on actual search/open, not continuously polled from disk.

## Verified openings and analytical admission

Saved reports use `readSavedReportFile` inside the read-only board gate: registered
ownership, disclosure, manifest, format inventory, hash, byte length and current
generation must still agree. No unregistered adjacent file or caller path can be
opened. HTML reuses the existing sandbox/CSP-isolated saved-copy frame. JSON and
Markdown are inert source text. Explicit PDF Open downloads the verified saved
bytes without running a PDF viewer or external resources inside WIRE. Typing never
downloads a file. Comparisons first use `readSavedComparison` to retain the
receipt's frozen-facts identity check, then `readSavedComparisonFile` for the
actual saved bytes. The file hash is distinct from the facts hash. Selection is
HTML -> JSON -> Markdown -> PDF, using only declared inventory; a declared broken
file fails rather than falling through to another representation. Registered
manifest/index identity, file hash/length and current generation are checked in
the same read gate. No comparison document is reconstructed with today's renderer.
The shared `/api/artifact-file` route remains a read-only operation, not a search
mutation fence or permission to retry writes. No copy is regenerated.
Revoking optional replies does not revoke an
independently authorized saved artifact; deleting that artifact does invalidate it.

`web/search-membership.mjs` maps only accepted typed request/action descriptors,
not text, arbitrary context links or navigation hits. Its arrays cover **all**
matches, not the twenty-row navigation page. Full interaction hits and exact
layer/action hits stay distinct. Before-outcome facets are refined independently;
`parentScenarioIds` is solely broader API-parent coverage. Current-view reports
still select whole eligible interactions, not just matched calls. Selected/All
and hidden selections are not silently replaced.

The internal synchronous authority method
`services.search.membership(owner, receipt, state, layer)` runs inside the caller's
accepted state gate. It returns `{scenarioIds, actionIds, parentScenarioIds}` from
the **last server-disclosed/admitted** hit map, not proof of browser display.
It rejects wrong owner, changed source/revision/generation, active mutation,
partial coverage or a category-limited receipt. Actual valid zero matches return
three empty arrays. The frontend independently requires its observed current
receipt/scope. HTTP consumers submit the receipt only, never trusted match IDs.
The whole-retained-corpus mapping is independent of ordinary Analyze dates, so a
paired-period consumer can apply both chosen date ranges without a new ranker.

A complete, current receipt is required to display an analytical population.
Partial results remain usable for labelled navigation, but neither partial empty
nor partial nonempty matches render charts, rows, timed populations or outcome
facet counts. Visibility owners preserve that state during controls-only
navigation too. Current-view reports remain unavailable; Selected/All still show
their independent known populations without pretending that current matches are
known.

Legacy `route.search` remains an additional **intersection**, including
before-outcome facets and broader API-parent coverage. Its visible chip,
removal and history Back are retained. `createAnalysisSlice.legacyScenarioIds`
reuses that same phrase predicate over the full retained roster; there is no
second matcher or keyword contribution to semantic ranking. The agreed paired
qualifier is optional `semanticSelection.withinScenarioIds`: omitted means no
additional restriction, and `[]` explicitly means none. The paired consumer
validates known IDs and intersects them with receipt-authorized membership.
The phrase stays in the browser/history; neither phrase nor live receipt belongs
in the frozen report.

## Focused proof

Use the lockfile packages and explicitly provisioned pinned CPU-WASM assets:

```powershell
node --test --test-concurrency=1 web\live-search-state.test.mjs tests\analysis-slice.test.mjs tests\live-search-transport.test.mjs tests\live-search.test.mjs tests\live-search.browser.test.mjs
```

The normal-entry browser fixture uses only invented ephemeral stores and an
isolated paused synthetic collector. It covers actual zero-word-overlap
paraphrase, method/path/status/prefix controls, all ten types, all four saved
formats and comparison, direct Open/Back, preserved selection, exact scoped
membership beyond result paging, two-panel revocation/deletion/source replacement,
capability recovery, poll failure, both themes and 375 px at 200% text.
Partial searchable coverage separately proves only Current-view report preparation
is blocked: hidden Selected requests and All remain available and unchanged.
The focused review-correction gate is:

```powershell
node --test --test-concurrency=1 --test-name-pattern="correction:|partial searchable|verified empty|serialized factories|receipt READ closes" tests\analysis-slice.test.mjs tests\live-search.browser.test.mjs tests\saved-artifact-read-lifecycle.browser.test.mjs
```

It covers actual partial-empty/nonempty unavailable UI (including controls-only
navigation), legacy intersection/removal/Back with no phrase in HTTP bodies,
full-roster qualifier and facet/parent parity, page-two cross-layer action
Open/Back with a delayed accepted snapshot, and adjacent selection/lifecycle
sentinels. Red/green logs are kept as private session proof artifacts, not
application data or a query log.

The joint real-model gate is:

```powershell
node --test --test-concurrency=1 --test-name-pattern="joint:" tests\live-search.browser.test.mjs
```

It exercises full-corpus paraphrase plus the private legacy qualifier across
two periods, ignoring ordinary Analyze date limits; one actual receipt admission
for the pair and one for the preview; separate Review and Save; clearing the live
query after legitimate preview without revoking it; and verified frozen report
search/Open/Back with unchanged saved bytes. An exact-action case retains broader
API parents, opens a later-period call and restores dates/disclosure/focus on Back,
then proves a stale fence blocks both paired output and report creation. Partial
search never dispatches a complete paired request. The optional comparison
`openSearch` action focuses the single Search field without changing dates
or membership; its absence retains the standalone legacy field.

The joint test exposed a save-receipt reset when ordinary Analyze dates survived
alongside a paired report: `syncTime` reapplied ordinary dates during the
post-save snapshot read. It now uses the same captured paired time/date basis as
report selection. Deferred paired reading restoration waits for the actual
current consumer render, rather than trying to focus a record before its
asynchronous paired read completes.

The final frozen-reader composition gate is:

```powershell
node --test --test-concurrency=1 --test-name-pattern="frozen-reader:|joint: real meaning|joint: partial|artifact-file rejects missing|caller cancellation" tests\live-search.browser.test.mjs tests\live-search.test.mjs tests\saved-comparison-reader.test.mjs tests\live-search-transport.test.mjs
```

It opens an invented historical comparison HTML copy containing a registered,
hash-bound note absent from structured rendering, then opens exact JSON-only
comparison source. Tampered and declared-missing HTML refuse even with a valid
JSON alternative. A foreign panel receipt and closure during the queued file
read admit no bytes. A valid artifact-file read leaves the search index intact;
missing private state is not initialized. One real semantic-period
Review/Save/frozen-reopen sentinel and partial/transport gates qualify the merge
without repeating the prior model/format matrices.
The runtime fixture covers latest-only PDF scheduling with an unchanged index,
explicit cancellation/closure, busy/idle/TTL owners, source-unavailable admission,
unowned/stale receipts, tampered files and missing/corrupt models.

Full-gated measurements are emitted as content-free test diagnostics. A measured
52-item/64-chunk PDF fixture rebuilt in about 3.1-3.5 seconds; warm verified PDF
queries took about 0.59-0.72 seconds, about 0.59-0.71 seconds of which was
delivery/revalidation rather than inference. The normal browser's mixed-format
56-item/110-chunk build took 6.7 seconds; seven characters typed at 140 ms intervals
plus the final verified PDF result took 2.4 seconds with the index unchanged.
Model RSS was about 195-197 MiB, with observed high-water RSS about 338-348 MiB. These are synthetic Windows measurements,
not real-use relevance calibration or a hardware-independent latency promise.
