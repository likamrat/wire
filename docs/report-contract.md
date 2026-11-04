# Report contract

For the user workflow, see [Create and compare reports](reporting.md). This
reference owns evidence membership, disclosure, frozen output and historical
interpretation. Microsoft-native report assembly is preserved as
[incubation](incubation/native-retained-views.md), not released source support.

## Current and historical facts

New ordinary reports use report-envelope schema 3 and independent
`metricProjectionVersion: 4`. They contain recorded outcomes, source/service
facts, canonical membership and observed timing. They do not contain new AI
or personal judgments, review-status recitals, grading bands or placeholder
quality measures. Presentation version 3 uses milliseconds first, with a
seconds equivalent from 1,000 ms; zero and unavailable remain different.

Historical supported projection/presentation versions retain their original
definitions. V2 omitted Cost; v3 additionally excluded generated review facts;
v4 excludes personal-rating lanes. None means past spending was zero or
settled. `lib/report-facts.mjs`, `assessment-contract.mjs` and the frozen
readers own validation. Old saved files, manifests and hashes are never
rewritten to make them current.

AI evaluation execution/setup and personal-feedback writes are retired.
Authenticated stale requests return `AI_REVIEW_RETIRED` or
`PERSONAL_FEEDBACK_RETIRED` (410). Exact owner/token-bound historical receipt
reads preserve pending and unknown states without replay. Legacy workflow
classification (`captured`, `reviewing`, `ready_to_export`) is separate from
ratings and remains relevant to the old ready-ID export API.

Historical reviews distinguish answer correctness, answer support, tool use
versus the request, and personal permission feedback. Tool completion, citation
presence and action matching never prove those other meanings. Saved
check/version/origin selects interpretation; absent/conflicting identity shows
a meaning gap rather than borrowing a modern definition. Unknown billing and
old consent/receipt identities remain preserved, not revoked or reconciled by
retirement.

## Evidence and membership

Count canonical identities once before pagination. Work IQ calls, returned API
entries, Graph request sites, sites with visible status, owned HTTP captures
and code references are distinct populations. Visible statuses are a subset
of sites. A multi-target fetch is one call; response-array position does not
identify the corresponding requested target. Code references do not establish
execution.

| Report scope | Membership rule |
| --- | --- |
| Selected | Resolve explicit IDs and known aliases; keep picks hidden by filters/pages. |
| Current | Resolve the complete accepted analytical membership, then include complete eligible parent interactions. Chart-matching calls and full report counts are different. |
| All | All retained reportable activity, including eligible preserved records; independent of Analyze filters/Search/paging and never a source scan. |

New panels start empty Selected. Scope and author choices remain panel memory,
not inferred from opening Reports or persisted across reload. `Authors in
report` filters whole originating interactions; My plus Agent excludes
unverified. Calls executed by agents stay with their originating interaction.
No prompts removes prose, not membership.

Synthetic, diagnostic, unknown-source and unidentifiable records retain
explicit exclusions; missing project context alone is not exclusion. Counts
distinguish chats, interactions and each evidence layer. Same-count identity
swaps are not equivalent selections. A known empty cohort is different from
unavailable identity or incomplete coverage.

Current Search membership requires the existing analysis-purpose receipt and
complete admitted population. Interaction hits admit their matching records;
action hits admit exact layer records. Legacy `semanticSelection` is a
compatibility property name, not permission for inference. Query text is not
frozen into report prose or receipt metadata. Selected and All remain separate.

## Service, outcome and time meaning

`wire-service-involvement` v1 supplies overlapping named associations over a
declared canonical denominator. A Files-and-Mail call counts once in the
population and once under each service; shares may exceed 100% in total.
Missing service detail and discovery/not-applicable are separate. Known and
missing-detail sets can overlap; preparation is disjoint.

Activity-category v3 remains an exclusive grouping. Discovery/schema inspection
is preparation, not execution of the described operation. The supported shared
file path belongs to Files without disclosing its opaque token. Returned
entries use their own qualified path or the explicit single-target fallback,
not every batch target. Historical category/pattern definitions remain distinct
from current involvement facts.

Tool completion does not prove application or task success. `resultFacts` v1
(`wire-recorded-result-facts-v1`) separately freezes explicit application errors,
singleton/returned statuses, codes, supplied/retained entry counts,
pagination presence and content availability. Partial Work IQ prefixes retain
their original positions and an unknown supplied total, never an exhaustive
parent cause. Arbitrary bodies do not establish item/page totals.

Timing keeps units, boundaries and timed/eligible populations. Tool latency,
request-to-recorded-final-response and HTTP response/error intervals are not
blended or summed across concurrent calls. Comparisons use compatible raw
samples, not means of percentages or medians of medians. Nearest-rank
median/P95 and one-sample limitations remain explicit. Missing is not zero.
Historical review pass shares use passed divided by passed plus failed,
with unassessed/insufficient/error coverage outside that denominator.

## Preparation, disclosure and Save

The existing controller owns selection -> preparation -> disclosure approval
-> separate confirmation -> saved readback. Selecting, browsing or cancelling
before confirmation does not write an export or change source classifications.

An admitted preview freezes membership, options, source facts, time context
and prepared bytes. Qualified GitHub previews pin the original content-addressed
evidence file; later collection can add follow-ups without changing reviewed
copies. Current source/configuration, consent, deletion, key and owner authority
still apply. An unchanged preview can survive ordinary Back/browsing, while
material scope, author, text, format or authority changes require fresh
preparation and disclosure.

`collectedSourceFrozen` is a private transport qualification, not a saved-file
schema field or reusable approval. Original evidence-file identity also keys
the report read model, so validating an older report cannot replace current
Analyze facts. Publication appends to current state; it never restores an old
evidence snapshot over newer collection.

Prompt modes are None, Masked and Original. Masked retains source wording with
local pattern masking, not a generated summary. Mandatory credential removal
applies even in Original and after edits. Exact additional terms affect copies,
not source records. Names and confidential meaning still require human review;
the scanner is not complete DLP or privacy certification.

Titles are one-line input up to 200 characters, always masked metadata.
Snapshot, manifest and index must agree on a declared title; absent old titles
keep a factual fallback rather than gaining a new canonical title.
`canonicalTitle` comes only from the verified declared manifest binding.

`Include recorded result text (masked)` starts off and is independent of
prompt mode and reply saving. It admits already-screened diagnostics and
qualified descriptions, not raw response bodies. Each copy keeps its original
entry/fact association, edited/omitted status and disclosure treatment.

Selected and contextual copies share the existing 3,000-copy/4 MiB budget.
Oversize or unreadable output refuses as a whole; no silent truncation,
format omission or weakened file limit. PDF is generated locally before review,
not swapped for HTML after a failure.

The version-3 coverage/redaction manifest freezes source/prompt coverage,
transformations, snapshot identity, exact file SHA-256 values and attestation.
It contains no matched private snippets or masking terms. The report JSON is
an object, not JSONL. Staging reserves a new bundle, writes every selected
format, atomically publishes its files and separately appends history. Earlier
bundles and classifications remain unchanged.

A dispatched or uncertain Save has an outcome independent of later draft
invalidation. Retain the original bundle identity and use saved-history/status
readback; do not export again. Only a proved pre-dispatch refusal establishes
no write. For qualified native publication, a one-use not-published disposition
is likewise distinct from an arbitrary HTTP conflict. Partial files or an
absent receipt are not rollback proof.

Ordinary reports and saved comparisons share one preview owner. New Prepare
retires the other transient preparation/approval but preserves its ordinary
choices. Neither task can replace a dispatched/unconfirmed Save. Withdrawal
scrubs private content while retaining only minimal original recovery identity;
fresh readiness does not restore an old preview or replay its operations.

## Bounded linked context

The default-off `recordedContext` option adds at most one uniquely linked
preceding and following interaction using the existing request-context
selector. It is not a recursive chat reconstruction, retry inference or new
measured population. No prompts disables context and reads no reply payloads.

Author choices apply before original/reply text is read. An excluded neighbor
cannot leak through a retained follow-up. Ungrouped follow-ups need the
unverified-author choice as well as their known sender qualification.
Replies use current retained-response consent, source, membership and integrity
checks; missing/no-longer-authorized text stays unavailable, while malformed
or corrupted payloads block preparation.

The optional closed context schema v1 freezes anchors, original relationships,
ordered entry keys, projected text/null, representation, availability, omission,
masking changes, gaps and separate context coverage. Source timestamps support
ordering but are withheld from this text projection. Pseudonymous event and
observation references do not disclose raw source IDs or paths.

Snapshot and manifest context copies must agree, with `recordedContextHash`
and ordinary snapshot/file hashes. Shared messages use one edit key without
merging interactions; conflicts fail rather than select convenient wording.
Context never expands analytical membership, metric denominators or period
cohorts. Revoked reply-copy overrides cannot survive as reusable text.

## Frozen files and saved reading

HTML is escaped and self-contained, without scripts or remote assets. PDF
uses the local HTML rendering path with embedded fonts; Markdown retains
portable text; JSON and the manifest retain complete typed facts. Human
summaries may omit redundant prose, not selected evidence or qualifications.
Current screen tokens, icons and typography cannot restyle frozen documents.

Verified Open checks registered ownership, managed paths, manifest, inventory,
file hash/length and current retained access. A declared broken preferred file
does not fall back silently to another format. File selectors/downloads use
the registered inventory and original bytes, not regenerated DOM.
HTML uses an opaque network-free sandbox. Text/PDF viewing remains local and
cannot fetch cited resources.

The separate legacy-original action is explicitly unverified. It requires the
supported old manifest/index shape and an explicit choice; it is not automatic
downgrade from failed verified Open, historical approval proof or eligibility
for comparison. Missing legacy facts are not reconstructed from today's history.

Saved metadata search does not read prompt/report bodies. Global Search
extracts only permitted text from independently verified saved files through
the [corpus contract](search-corpus.md). Its receipt authority is not
interchangeable with library authority on reload or invalidation.

## Comparisons

Saved-report comparison uses exact frozen identities, definitions and
source-qualified populations. Equal arbitrary identifiers do not establish
namespace compatibility or overlap. Snapshot, non-overlapping and later-additions
cohorts must remain distinguishable; absent, unavailable and zero are different.
An incompatible or one-sided measure has no invented delta or counterpart.

Technical patterns use normalized operation structure, not prompt similarity.
Different traffic mixes can change an overall rate without changing a matched
pattern. A missing pattern does not prove a fix; no causal/significance claim
is generated. Each historical review lane retains its own saved origin/model/
rubric and meaning, rather than borrowing the other side's definition.

New comparisons preserve current supported outcomes and timing, not retired
quality lanes. They may include only already-frozen masked result copies when
separately selected, with additional masking; they never fetch missing source
text. Preparation, disclosure, separate Save and original-identity recovery
remain independent from merely reading a pair.

### Report a retained-period comparison

The accepted live pair freezes A/B ranges, shared non-date filters, current
source/revision and exact matching rows. The comparison's dates replace the
ordinary Analyze range; Search, source/group and other selectors remain.
One empty side is valid; two empty sides cannot create a report.

Each period owns its measured cohort and compatible raw timing samples.
Complete parent interactions can support copies and full-interaction timing
without expanding matching-call denominators. A shared context union is not
a third measured population. Undated rows remain explicitly outside dated
cohorts. B-minus-A share changes use percentage points, not relative percent.

The optional schema-3 `periodComparison` namespace and matching manifest hash
bind those facts. The ordinary single date-range envelope is absent for that
subtype. `records` supplies permitted supporting copies, not a union metric
denominator. Actual shared comparison math revalidates the accepted fields;
caller-supplied hit lists are not receipt authority.

A saved period report is one artifact with two cohorts, not an ordinary
single-source input to saved-report comparison. New preparation never
manufactures two source reports. Changed selected facts/authority invalidate
review; unrelated accepted activity need not.

## Saved-artifact deletion

Deleting one report removes that managed bundle, recognized copies and index
entry, not source activity or external downloads. A saved comparison survives
deletion of its input; its historical source link becomes unavailable.
Dependent unsaved comparisons and their approval are invalidated.

Delete all saved reports binds a counted, membership/hash-bound two-minute
preview across all pages/search. Later reports, saved comparisons, activity,
drafts and external downloads are excluded. It is not a directory purge or
a loop of independent deletes.

Logical removal, tombstones and the pending journal precede file cleanup.
An interruption may leave files; recovery finishes only the sealed exact plan
and never repeats confirmation or grants new scope. Hash-only reservations
prevent stale writes from resurrecting deleted artifacts.

Microsoft-dependent artifacts require their own current-account/dependency
mutation admission. A saved-read lease or activity-deletion grant is not that
permission; a per-target eligibility hint is not confirmation or bulk authority.

## Validation pointers

Use the existing report-journey, report-format/privacy, frozen-reader,
comparison and deletion tests for the changed boundary. Inspect actual generated
formats when output changes; an on-screen preview or screenshot is not
cross-format correctness. Preserve legacy bytes and interpretations in
regressions. Source definitions and shared validators, not copies of schema
tables in multiple documents, remain the executable authority.
