# Live local search

The header's **Search WIRE** field searches while typing. **Everywhere** locates
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
`openSearch` action focuses the single Search WIRE field without changing dates
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
