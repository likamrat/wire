# Report contract

For the user workflow, see [Create and compare reports](reporting.md). This
reference defines evidence membership, disclosure and frozen output for the
supported GitHub Copilot experience.

## Report facts

Reports contain recorded outcomes, source/service facts, canonical membership
and observed timing. They do not judge answer correctness, personal permission
or overall task success.

The current format uses report-envelope schema 3, `metricProjectionVersion: 4`
and presentation version 3. `lib/report-facts.mjs`, `assessment-contract.mjs`
and the saved-file readers validate these contracts. Read a saved report using
its declared definitions; never rewrite its files or hashes to change meaning.

Timing displays milliseconds first, with a seconds equivalent from 1,000 ms.
Zero and unavailable are different.

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

Fresh creation opens five built-in choices with a Last 7 days period, inclusive
of today in the selected IANA zone. It does not inherit Analyze restrictions.
Explicit Selected and Current entries retain their own membership. Scope and
author choices remain panel memory, not persisted across reload. **Authors in
report** filters whole originating interactions; My plus Agent excludes
unverified. Calls executed by agents stay with their originating interaction.
Leaving out prompts and replies removes those copies, not membership.

Synthetic, diagnostic, unknown-source and unidentifiable records retain
explicit exclusions; missing project context alone is not exclusion. Counts
distinguish chats, interactions and each evidence layer. Same-count identity
swaps are not equivalent selections. A known empty cohort is different from
unavailable identity or incomplete coverage.

Current Search membership requires the existing analysis-purpose receipt and
complete admitted population. Interaction hits admit their matching records;
action hits admit exact layer records. Query text is not frozen into report
prose or receipt metadata. Selected and All remain separate.

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
not every batch target. Category grouping and service involvement have
different definitions and must not be substituted for one another.

| Measure | Interpretation |
| --- | --- |
| Tool completion | Not application or task success |
| `resultFacts` v1 (`wire-recorded-result-facts-v1`) | Separate explicit application errors, singleton/returned statuses, codes, supplied/retained counts, pagination presence and content availability |
| Partial Work IQ prefix | Original positions and unknown supplied total; not an exhaustive parent cause |
| Item/page totals | Arbitrary response bodies do not establish them |
| Timing | Keep unit, boundary and timed/eligible population; never blend prompt/tool/HTTP intervals or sum concurrent calls |
| Comparison timing | Compatible raw samples, not means of percentages or medians of medians; nearest-rank median/P95 and one-sample limits stay explicit |

Missing timing remains unavailable, not zero.

### Report presets and notes

`reportPopulation` v1 freezes metadata-only reference membership and the included
interaction IDs separately. The reference cohort applies the same source,
authors, dates and services before the outcome restriction. Failure frequency
uses distinct interactions, not calls or the failure subset as its denominator.
Only included cases supply prompt, reply or diagnostic copies.

An error case has a qualified failed call or explicit application/API error.
Mixed interactions qualify. Completed-only requires at least one eligible call,
every call completed and no recorded errors. Unknown evidence is neither failure
nor success. Unverified authors remain available through All.

`reportPatterns` v1 binds normalized operations and distinct error channels to
their calls and interactions. It does not infer root causes or prompt similarity.
`reportNotes` v1 contains report-author context scoped to included pseudonymous
interaction IDs. Notes share privacy treatment and the existing copy budget,
but never enter metrics. Matching namespace hashes are required in the manifest
and snapshot; malformed or expanded fields are rejected.

## Preparation, disclosure and Save

The report controller owns the sequence:

1. Select the activity. Browsing, selecting and cancelling before confirmation
   write no export.
2. Prepare a preview. Freeze membership, options, source facts, time context
   and prepared bytes.
3. Optionally inspect, mask, edit or omit copies and add report-author notes.
4. Confirm local Save, then verify saved readback. Keeping chat details requires
   the warning's explicit choice for that save.

Qualified GitHub previews pin the original content-addressed evidence file.
Later collection can add follow-ups without changing prepared copies.

The Reports landing combines choices and saved access. Back is not discard,
preparation or Save. Selecting the same type with unchanged dates can reopen
the authorized in-memory preview, including its edits, without recapturing
membership. Legacy create URLs and Selected/Current/contextual entry retain
their scope. An unconfirmed write cannot be hidden behind the landing or
replayed through a tile. Saved-list menus use the current authorized index;
withdrawal retires their held text and actions with the existing readers.

| Change after preparation | Effect |
| --- | --- |
| Ordinary Back/browsing with unchanged facts and authority | Preview can survive |
| Scope, author, date or service change | Fresh membership and preparation |
| Title, note, privacy, copy or format change | Regenerate bytes against the original frozen reference and included populations |
| Material source/configuration, consent, deletion, key or owner change | Fresh preparation under current authority; old preparation cannot bypass it |

Original evidence-file identity also keys the report read model, so reading
a saved report cannot replace current Analyze facts. Saving appends to current
state; it never restores the preview's evidence snapshot over newer collection.

| Text choice | Required treatment |
| --- | --- |
| None | Omit prompt prose without changing membership |
| Masked | Retain source wording with local pattern masking, not generated summaries |
| Original | Retain wording, still removing credentials |
| Additional terms and manual edits | Affect copies, not source records; credential removal still applies |
| Title | One line, at most 200 characters, always masked metadata |
| Error details in a preset report | Retained masked diagnostics only; enabled by default for Errors & failures, independent of prompt/reply mode; no raw bodies or unrelated descriptions |

Masking can miss names and confidential meaning; it is not complete DLP or
privacy certification. Optional review remains available. Result copies keep original entry/fact
associations and edited/omitted/disclosure status.

Snapshot, manifest and index must agree on a declared title. `canonicalTitle`
comes only from the verified declared manifest binding.

New reports use `savePolicy: "local-save-v1"`. A preparation supplies a one-save
challenge binding its bundle, snapshot, prompt mode, formats and exact file
inventory. The receipt records `explicit-local-save`, with both reviewer flags
false. Its keep-chat-details flag is true exactly when original wording was
chosen. Historical attested bundles keep their existing interpretation.

Hide details and save regenerates masked bytes before binding the save intent.
Cancellation writes nothing. Later content or authority changes retire that
intent. A dispatched or uncertain save keeps its original exact-content
recovery identity rather than preparing or writing another bundle.

Content-only `rebuildFrom` is limited to the same owner's unexpired ordinary
preset preview. It preserves the pinned reference and included populations,
scope and undated coverage. It cannot change dates, time zone or focus, and
cannot admit interactions collected after preparation.

### Prepared bytes and recovery

Selected and contextual copies share the existing 3,000-copy/4 MiB budget.
Oversize or unreadable output refuses as a whole; no silent truncation,
format omission or weakened file limit. PDF is generated locally during preparation,
not swapped for HTML after a failure.

The version-3 manifest freezes source/prompt coverage, transformations,
snapshot identity, exact file SHA-256 values and save authorization. It contains no
matched private snippets or masking terms. Report JSON is an object, not JSONL.

Staging reserves a new bundle, writes every selected format, atomically
publishes its files, then separately appends the saved-report index.
Existing bundles stay unchanged.

| Save state | Recovery meaning |
| --- | --- |
| Proved pre-dispatch refusal | Establishes no write |
| Dispatched or uncertain | Retain original bundle identity and read saved history/status; do not export again |
| Later draft invalidation | Does not settle the dispatched Save |
| Partial files or absent receipt | Not rollback proof |

Ordinary reports and saved comparisons share one preview owner. New Prepare
retires the other transient preparation and save authorization but preserves
its ordinary choices. Neither task can replace a dispatched/unconfirmed Save. Withdrawal
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

Failed verification cannot silently downgrade to an unchecked reading path.
Unsupported schemas and missing facts remain explicit; current activity cannot
fill gaps in a saved report.

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

Comparisons use recorded outcomes and timing. Separately selected result copies
must already be frozen and masked; additional masking is allowed, but fetching
missing source text is not.

Reading a pair does not save it. Preparation and explicit local Save retain
their source checks and original-identity recovery.

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
preparation; unrelated accepted activity need not.

## Saved-artifact deletion

| Deletion | Included / preserved |
| --- | --- |
| One report | Remove managed bundle, recognized copies and index entry; preserve source activity and external downloads |
| Input to a saved comparison | Saved comparison survives with an unavailable input link; dependent unsaved preparations/save authorizations are invalidated |
| All saved reports | Counted, membership/hash-bound two-minute preview across all pages/search |
| Excluded from bulk deletion | Later reports, saved comparisons, activity, drafts and external downloads |

Bulk deletion is not a directory purge or a loop of independent deletes.

Logical removal, tombstones and the pending journal precede file cleanup.
An interruption may leave files; recovery finishes only the sealed exact plan
and never repeats confirmation or grants new scope. Hash-only reservations
prevent stale writes from resurrecting deleted artifacts.

Saved artifacts retain their source/account dependency checks; unavailable
dependencies must not be bypassed to open or delete them. A saved-read lease or
activity-deletion grant is not saved-artifact mutation permission. A per-target
eligibility hint is not confirmation or bulk authority.

## Validation pointers

Use the existing report-journey, report-format/privacy, frozen-reader,
comparison and deletion tests for the changed boundary. Inspect actual generated
formats when output changes; an on-screen preview or screenshot is not
cross-format correctness. Check that existing saved bytes and definitions stay
unchanged. Source definitions and shared validators remain the executable authority.
