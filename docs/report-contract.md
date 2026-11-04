# Report contract

For the user workflow, see [Create and compare reports](reporting.md). This
reference owns evidence membership, disclosure, frozen output and historical
interpretation for the supported GitHub Copilot experience.

## Current and historical facts

| Version | Meaning |
| --- | --- |
| Current report envelope 3 | Recorded outcomes, source/service facts, canonical membership and observed timing |
| Metric projection 2 | Omitted Cost |
| Metric projection 3 | Also excluded generated review facts |
| Current metric projection 4 | Also excludes personal-rating lanes |
| Presentation 3 | Milliseconds first, with a seconds equivalent from 1,000 ms; zero is distinct from unavailable |

New reports contain no AI/personal judgments, review-status recitals, grading
bands or placeholder quality measures. Removing a measure does not establish
that past spending was zero or settled.

Supported historical versions retain their definitions and saved bytes.
`lib/report-facts.mjs`, `assessment-contract.mjs` and frozen readers validate
them; files, manifests and hashes are not rewritten to make them current.

| Retired operation | Response / surviving boundary |
| --- | --- |
| AI evaluation execution/setup | Authenticated stale requests return `AI_REVIEW_RETIRED` (410) |
| Personal-feedback writes | Authenticated stale requests return `PERSONAL_FEEDBACK_RETIRED` (410) |
| Historical receipt read | Exact owner/token-bound reads preserve pending/unknown states without replay |
| Legacy ready-ID export | `captured`, `reviewing`, `ready_to_export` remain workflow classifications, separate from ratings |

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

| Measure | Interpretation |
| --- | --- |
| Tool completion | Not application or task success |
| `resultFacts` v1 (`wire-recorded-result-facts-v1`) | Separate explicit application errors, singleton/returned statuses, codes, supplied/retained counts, pagination presence and content availability |
| Partial Work IQ prefix | Original positions and unknown supplied total; not an exhaustive parent cause |
| Item/page totals | Arbitrary response bodies do not establish them |
| Timing | Keep unit, boundary and timed/eligible population; never blend prompt/tool/HTTP intervals or sum concurrent calls |
| Comparison timing | Compatible raw samples, not means of percentages or medians of medians; nearest-rank median/P95 and one-sample limits stay explicit |
| Historical review pass share | Passed / (passed + failed); unassessed, insufficient and error coverage is outside that denominator |

Missing timing remains unavailable, not zero.

## Preparation, disclosure and Save

The existing controller owns the sequence:

1. Select the activity. Browsing, selecting and cancelling before confirmation
   write no export and change no source classifications.
2. Prepare a preview. Freeze membership, options, source facts, time context
   and prepared bytes.
3. Review the disclosure and approve it.
4. Confirm Save separately, then verify saved readback.

Qualified GitHub previews pin the original content-addressed evidence file.
Later collection can add follow-ups without changing reviewed copies.

| Change after preparation | Effect |
| --- | --- |
| Ordinary Back/browsing with unchanged facts and authority | Preview can survive |
| Material scope, author, text or format change | Fresh preparation and disclosure |
| Material source/configuration, consent, deletion, key or owner change | Fresh preparation/disclosure under current authority; old preparation cannot bypass it |

`collectedSourceFrozen` is a private transport qualification, not a saved-file
schema field or reusable approval. Original evidence-file identity also keys
the report read model, so validating an older report cannot replace current
Analyze facts. Publication appends to current state; it never restores an old
evidence snapshot over newer collection.

| Text choice | Required treatment |
| --- | --- |
| None | Omit prompt prose without changing membership |
| Masked | Retain source wording with local pattern masking, not generated summaries |
| Original | Retain wording, still removing credentials |
| Additional terms and manual edits | Affect copies, not source records; credential removal still applies |
| Title | One line, at most 200 characters, always masked metadata |
| Include recorded result text (masked) | Starts off, independently of prompt/reply choices; admits screened diagnostics and qualified descriptions, never raw response bodies |

Names and confidential meaning require human review; masking is not complete
DLP or privacy certification. Result copies keep original entry/fact
associations and edited/omitted/disclosure status.

Snapshot, manifest and index must agree on a declared title. Old absent titles
keep a factual fallback. `canonicalTitle` comes only from the verified
declared manifest binding.

### Prepared bytes and recovery

Selected and contextual copies share the existing 3,000-copy/4 MiB budget.
Oversize or unreadable output refuses as a whole; no silent truncation,
format omission or weakened file limit. PDF is generated locally before review,
not swapped for HTML after a failure.

The version-3 manifest freezes source/prompt coverage, transformations,
snapshot identity, exact file SHA-256 values and attestation. It contains no
matched private snippets or masking terms. Report JSON is an object, not JSONL.

Staging reserves a new bundle, writes every selected format, atomically
publishes its files, then separately appends history. Earlier bundles and
classifications stay unchanged.

| Save state | Recovery meaning |
| --- | --- |
| Proved pre-dispatch refusal | Establishes no write |
| Dispatched or uncertain | Retain original bundle identity and read saved history/status; do not export again |
| Later draft invalidation | Does not settle the dispatched Save |
| Partial files or absent receipt | Not rollback proof |

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

| Context binding | Rule |
| --- | --- |
| Closed context schema v1 | Freeze anchors, original relationships, ordered entry keys, text/null, representation, availability, omissions, masking changes, gaps and separate context coverage |
| Source timestamps | Support ordering; withheld from the text projection |
| Event/observation references | Pseudonymous; no raw source IDs or paths |
| Snapshot and manifest | Agree on context copies, `recordedContextHash` and ordinary snapshot/file hashes |
| Shared message edits | One edit key without merging interactions; conflicts fail |
| Analytical scope | Context adds no membership, metric denominator or period cohort |
| Revoked reply-copy override | Cannot remain reusable text |

## Frozen files and saved reading

| Format | Saved representation |
| --- | --- |
| HTML | Escaped and self-contained; no scripts or remote assets |
| PDF | Local HTML rendering with embedded fonts |
| Markdown | Portable text |
| JSON and manifest | Complete typed facts and bindings |

Human summaries may omit redundant prose, not selected evidence or
qualifications. Screen tokens, icons and typography cannot restyle frozen files.

Verified Open follows the saved artifact:

1. Check ownership, managed paths, manifest, inventory, file hash/length and
   current retained access.
2. Read the registered original bytes. A broken declared preferred file does
   not silently fall back to another format.
3. Render HTML in an opaque network-free sandbox, or text/PDF locally without
   fetching cited resources. Format selectors and downloads use the same
   registered inventory, not regenerated DOM.

The separate legacy-original action is explicitly unverified. It requires the
supported old manifest/index shape and an explicit choice; it is not automatic
downgrade from failed verified Open, historical approval proof or eligibility
for comparison. Missing legacy facts are not reconstructed from today's history.

Saved metadata search does not read prompt/report bodies. Global Search
extracts only permitted text from independently verified saved files through
the [corpus contract](search-corpus.md). Its receipt authority is not
interchangeable with library authority on reload or invalidation.

## Comparisons

| Comparison fact | Required interpretation |
| --- | --- |
| Identity and overlap | Exact frozen identities, definitions and source-qualified populations; equal arbitrary IDs do not prove compatibility |
| Cohort | Distinguish snapshot, non-overlapping and later-additions populations |
| Missing/incompatible/one-sided measure | No invented delta or counterpart; absent, unavailable and zero differ |
| Technical pattern | Normalized operation structure, not prompt similarity |
| Rate change | Traffic mix may change an overall rate without changing a matched pattern |
| Missing pattern | Not proof of a fix; no generated causality/significance claim |
| Historical review | Keep that lane's saved origin/model/rubric and meaning |

New comparisons preserve supported outcomes and timing, not retired quality
lanes. Separately selected result copies must already be frozen and masked;
additional masking is allowed, but fetching missing source text is not.

Reading a pair is independent of preparation, disclosure, separate Save and
original-identity recovery.

### Report a retained-period comparison

1. Freeze accepted A/B ranges, shared non-date filters, source/revision and
   exact matching rows. Replace the ordinary Analyze dates while retaining
   Search, source/group and other selectors.
2. Keep each period's measured cohort and compatible raw timing samples.
   One empty side is valid; two empty sides cannot create a report.
3. Bind facts in schema-3 `periodComparison` and its matching manifest hash.
   This subtype omits the ordinary single date-range envelope.
4. Revalidate accepted fields through shared comparison math. Caller hit lists
   cannot supply receipt authority.

Complete parent interactions support copies and full-interaction timing without
expanding matching-call denominators. `records` supplies those permitted copies,
not a union metric denominator or third cohort. Undated rows stay outside dated
cohorts; B-minus-A shares use percentage points, not relative percent.

A saved period report is one artifact with two cohorts, not an ordinary
single-source input to saved-report comparison. New preparation never
manufactures two source reports. Changed selected facts/authority invalidate
review; unrelated accepted activity need not.

## Saved-artifact deletion

| Deletion | Included / preserved |
| --- | --- |
| One report | Remove managed bundle, recognized copies and index entry; preserve source activity and external downloads |
| Input to a saved comparison | Saved comparison survives with an unavailable historical source link; dependent unsaved comparisons/approval are invalidated |
| All saved reports | Counted, membership/hash-bound two-minute preview across all pages/search |
| Excluded from bulk deletion | Later reports, saved comparisons, activity, drafts and external downloads |

Bulk deletion is not a directory purge or a loop of independent deletes.

Logical removal, tombstones and the pending journal precede file cleanup.
An interruption may leave files; recovery finishes only the sealed exact plan
and never repeats confirmation or grants new scope. Hash-only reservations
prevent stale writes from resurrecting deleted artifacts.

Historical artifacts retain their source/account dependency checks; unavailable
dependencies must not be bypassed to open or delete them. A saved-read lease or
activity-deletion grant is not saved-artifact mutation permission. A per-target
eligibility hint is not confirmation or bulk authority.

## Validation pointers

Use the existing report-journey, report-format/privacy, frozen-reader,
comparison and deletion tests for the changed boundary. Inspect actual generated
formats when output changes; an on-screen preview or screenshot is not
cross-format correctness. Preserve legacy bytes and interpretations in
regressions. Source definitions and shared validators, not copies of schema
tables in multiple documents, remain the executable authority.
