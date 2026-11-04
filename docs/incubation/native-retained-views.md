# Bounded retained Microsoft views

These incubation interfaces read already-retained, account-authorized data
through the genuine callback-owned [retention](native-retention.md) reader.
They do not activate the source, migrate storage or grant report Save.
The normal release remains Copilot-only.

## Requests, pages and authority

Protected `/api/retained/microsoft/query`, `/detail` and `/search` requests use
schema 1, latest or exact board revision, an explicit nonempty native-source
subset and `{limit,after}` page input. Limits are 1-100; cursors are opaque
returned values, never client-generated offsets.

Query also takes validated analytics. Detail takes a source-issued conversation
ID. Search takes nonblank text up to 4,000 UTF-16 code units and the closed type
subset. Unknown fields, duplicate sources, foreign/stale cursors and invalid
revisions reject.

The actual response guard supplies original owner/generation. Cursors bind that
owner, root/revisions, exact selector and limit; a bounded 128-entry registry
and ten-minute expiry do not permit silent first-page fallback.
Reader/private state objects cannot escape admission.

Response metadata includes exact revision/source revision, selection reference,
whole-root definitions, safe readback and a bounded page. IDs/references are
private-key HMACs, not capabilities. Public readback omits raw account/storage
identity and separates committed and current tuples. Optional committedAt is
the storage receipt time, not an activity date.

An 8 MiB total response ceiling reserves half for items. Byte-short pages are
valid; only nextCursor determines continuation. A single oversize item refuses
rather than truncating source text.

## Complete query population

Query returns complete aggregates independently of its conversation page:
conversations, variants, messages, parts, task states, calls, returned results,
selected rows and outcomes. Context observation counts are not extra calls.
Canonical call folding spans the complete root, preserving name/outcome
conflicts and separate result units.

The page's screened title is a recognition excerpt of retained prompt, reply
or context, not an inferred conversation title. Presentation can carry selected
tool names and qualified selected-row date bounds. Missing names/dates remain
explicit; capture/completion does not substitute for start.

`viewId` binds the original complete Current selector. `allViewId` separately
binds unfiltered requested native sources at the same root. A displayed page
never establishes either population or write authority.

Grouping, tool/source groups, before-outcome facets and time-series totals
fold the full selection. Counter memory is bounded with explicit oversize
refusal. Time bins use qualified source observation clocks and common
calendar/DST rules; undated rows stay outside bins. The 400-bin presentation
limit does not become a report membership or filter-inventory limit.

Ordinary Chat message creation can admit conversation context without dated
call rows when other predicates allow it. Tool/result/service/path restrictions
cannot be bypassed by evaluating a fabricated context placeholder.
Native services, original response models and whole-response latency remain
unavailable when no source contract qualifies them.

## Detail and exact Open

Detail sections are observations, messages, context and calls. Every page
replaces its predecessor, rather than accumulating history. Section counts
cover the complete accepted section, not page length; cursors cannot cross
sections.

Messages retain source order and representation/variant identity, not a
fabricated unique-turn count. Context stays independently reachable even when
authored text exists. Calls join complete-root outcomes to one canonical
identity, keeping each original input/evidence variant beside its call.
Returned results cannot borrow a sibling's input or become the parent's
failure verdict.

Exact Search Open adds original `at` ordinal and sourceRevision with an exact
board revision and null initial cursor. It checks that ordinal's actual
conversation membership before seeking, without traversing earlier pages.
Following pages keep the accepted root and cursor, not the original seek.
Stale/missing membership refuses rather than selecting the same ordinal in
a different root.

The server can pin accepted immutable detail roots across ordinary collection
updates, bounded to 128 offered/active frames. Every read still rechecks
account, owner, configuration, privacy, pseudonym key, deletion epoch and
current retained access. Old DTOs without deletion qualification cannot
establish cross-revision continuity.

The shared reader preserves exact authorized text/Copy, original ordinals and
bounded section history. Folding/paging/departure scrubs held Text/Attr values
and retires callbacks. Reopen keeps only bounded receipts, then performs a
fresh authorized exact-page read. Explicit target ordinal takes precedence
over remembered source-section/page state.

Cards shared by Analyze/report consumers have per-root cleanup; replacing
one consumer retires only its owned cards/listeners. Whole access withdrawal
retires all. Older-reader report-selection changes are disabled rather than
rebound to a new source revision.

## Inventories, grouping and analytical text

`inventory` takes the original Current receipt, exact revision, dimension and
bounded page. It removes only that dimension's own filter while preserving
Dates and all other original selectors/group scope. Tools, outcomes, sources
and conversations have qualified complete inventories.
Services/endpoints/workloads/prompt-authors remain explicitly unqualified where
the source supplies no such contract, with null aggregates rather than zeros.

`drilldown` accepts an original group ID, not a label. It refolds that exact
group against the complete original selector and returns a Current receipt
retaining the group. All remains the unfiltered originally requested sources.
Unknown/foreign/expired or changed-root IDs fail.

Native navigation Search uses the shared literal normalization/ranges and
scans the full authorized selected source while retaining a bounded best page.
Hits identify exact conversation and original ordinal. Messages, admitted
source facts and qualified action text retain their units; missing text
coverage is not a complete empty search.

Navigation Search is not Analyze Dates/facet membership and does not mint
ordinary in-memory Search receipts. The separate `analyze` route takes the
original **unrefined** Current/group view plus query/types and exact revision.
Each replacement uses that base, not its previous result as a new authority.

Only complete eligible text coverage yields a source-owned analytical selection.
Context/reply/interaction hits select their parent conversation; action hits
select exact canonical rows within the original layer and predicates.
The private membership commitment binds root, original selector/group,
query/policy/types and full row/conversation digest/totals. Query text and raw
member inventories are not returned.

Widgets keep exact matching rows. Ordinary Current reports intentionally
include each matching parent's complete retained evidence, so matching-row
and report-call counts can differ. This is not a native period cohort.

## Operation readback

`readback` takes only the original operation ID. The backend resolves genuine
owner, original receipt and current account/root privately. A matched result
requires exact committed operation/revision/write-generation/configuration/
privacy tuples; it does not compare a raw storage hash with a public HMAC.

Missing/uncommitted/different/mismatched receipts remain unconfirmed; corruption
and unavailable authority are errors, never empty success. Matched readback
proves that retained operation, not provider-currentness or complete source
history, and grants no repeat Collect.

## Report and comparison admission

The backend `nativeReportViewFor` supplies the existing controller a genuine
resolver for the original complete view. Current refolds its original selector;
Selected additionally validates each exact native ID; All requires allViewId.
Membership and interpretation expectations come from the original root, not
a recaptured page or normalized copy.

All/Current and refined periods keep explicit zero-member source frames when
membership is genuinely empty. Missing/unavailable/foreign source is not null,
empty or a GitHub-only fallback. Only explicit Selected with no native IDs
remains independent GitHub selection.

HTTP partitions GitHub IDs through their independent board authority and
native IDs through the source frame. A native receipt cannot widen GitHub
membership. The controller's reviewed source frame, disclosure and separate
Save remain required. Closed `nativeReportPublication` readiness qualifies
installed code only; it is not a browser-created grant.

Period comparison starts from the complete original source frame, or the
original Current/Search/group receipt for a refined comparison.
`datePolicy:"replace-original-dates"` replaces Dates with A/B while preserving
all other original predicates. The producer returns exact per-window and
undated canonical row membership plus a separate supporting-parent frame.
Conversation-only Search has no exact matching-message relation and therefore
remains context, not a guessed message-date cohort.

Source-qualified tool/result/message/task populations are not pooled with
GitHub outcome denominators. Missing/incompatible identity or interpretation
withholds deltas and overlap. New native period reports use period-report v2;
refined Search/group periods additionally use native-period namespace v2 and
an explicit replace-original-dates/predicate commitment. Conversation-only
matches remain supporting context, not matching message-date rows.

An empty-only native source frame uses nativeEvidence v2 while v1 remains
nonempty. Its original root, definitions, account and owner remain dependencies
through Save even when only GitHub rows supply measured facts. Explicit
GitHub-only Selected does not gain that dependency from its surrounding view.
An entirely empty report is still not authorized by an empty source frame.
Older strict readers must refuse unsupported versions, not drop these bindings.
Existing frozen files are not regenerated.

Saved comparisons bind actual original source-index/account dependencies
through their own frame and `nativeComparisonHash`, alongside the original
private `nativeSourceBinding`, not current activity or an ordinary
`nativeEvidenceHash`. Authorized saved reads and distinct target-qualified deletion
must remain composed with publication. Readonly access and per-target
eligibility cannot authorize bulk deletion or source writes.

## Presentation and limits

The source-aware client uses the same Analyze widgets/list/pager/reader,
not a second Microsoft dashboard. It keeps GitHub/native unavailable counts
separate and never calls a partial combined view complete.
Options load only for the current opened facet; late responses cannot reopen
closed menus or replace newer scope.

Query pages, navigation results, report picks and frozen source frames retain
their distinct authority. Existing fixtures exercise those paths with invented
data; complete real acquisition, large-history traversal and native product
acceptance are not established by that proof.
