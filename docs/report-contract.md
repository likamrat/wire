# Report contract

For the user workflow, see [Create and read reports](reporting.md). This
reference defines evidence membership, disclosure and frozen output for the
supported GitHub Copilot experience.

For selection changes, start with [evidence and membership](#evidence-and-membership).
For report edits or writing files, use [preparation and Save](#preparation-disclosure-and-save).
Saved readers and comparisons have their own [file](#frozen-files-and-saved-reading)
and [comparison](#comparisons) requirements.

**Contents**

- [Report facts](#report-facts)
- [Evidence and membership](#evidence-and-membership)
- [Service, outcome and time meaning](#service-outcome-and-time-meaning):
  [result extensions](#result-extensions), [interpretation rules](#interpretation-rules),
  [report presets and notes](#report-presets-and-notes)
- [Preparation, disclosure and Save](#preparation-disclosure-and-save):
  [frozen preparation](#frozen-preparation), [report text choices](#report-text-choices),
  [Save authorization](#save-authorization), [prepared bytes and recovery](#prepared-bytes-and-recovery)
- [Bounded linked context](#bounded-linked-context)
- [Frozen files and saved reading](#frozen-files-and-saved-reading): [usage facts](#usage-facts),
  [formats](#formats), [branding](#report-branding), [verified Open](#verified-open), [Brief](#brief)
- [Comparisons](#comparisons): [existing saved comparisons](#existing-saved-comparisons),
  [retained-period comparison](#report-a-retained-period-comparison)
- [Saved-artifact deletion](#saved-artifact-deletion)
- [Validation pointers](#validation-pointers)

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

Named drafts are editable local selections, not prepared reports or saved
artifacts. The Copilot picker binds them to the retained store and, for an
approved source, its database identity, configured locations and selected
GitHub account. Without a configured source, a draft belongs to the current
local WIRE sign-in. Restarting retires access leases, not draft ownership.
Unverified configured accounts and older generation-only partitions are not
adopted by guessing. The picker stores membership references, not chat text.
Prepare checks the exact draft identity, revision and Selected IDs
against the same state used to build the preview. Later draft edits do not
modify that preview, any saved files, or the interaction itself.

Count canonical identities once before pagination. Work IQ calls, returned API
entries, Graph request sites, sites with visible status, owned HTTP captures
and code references are distinct populations. Visible statuses are a subset
of sites. A multi-target fetch is one call; response-array position does not
identify the corresponding requested target. Code references do not establish
execution.

If two call IDs claim the same start event in one chat, operational activity can
count that start once, but the report cannot attribute result details or
operation patterns to either call. It keeps other identifiable calls and
reports the gap rather than choosing a winner.

| Report scope | Membership rule |
| --- | --- |
| Selected | Resolve explicit IDs and known aliases; keep picks hidden by filters/pages. |
| Current | Resolve the complete accepted analytical membership, then include complete eligible parent interactions. Chart-matching calls and full report counts are different. |
| All | All retained reportable activity, including eligible preserved records; independent of Analyze filters/Search/paging and never a source scan. |

Fresh creation offers five built-in choices. The reporting period defaults
to Last 7 days unless the browser has a different [Reports default](user-guide.md#wire-defaults).
These rolling periods include today in the selected IANA zone. A fresh report
does not inherit Analyze restrictions.
Explicit Selected and Current entries retain their own membership. Scope and
author choices remain panel memory, not persisted across reload. **Authors in
report** filters whole originating interactions; Human plus Agent excludes
unverified. Calls executed by agents stay with their originating interaction.
Leaving out prompts and replies removes those copies, not membership.

New reports can preserve a closed, versioned author-qualification `issue` on an
unknown actor/basis pair. It can distinguish an unmatched message boundary,
unrecognized host framing, workspace details without verified origin, or an
unsupported sender value. It does not identify an author or a tool failure. The reason is carried
from retained metadata through normalized facts and included prompt copies.
Older records without it remain readable and gain no inferred issue. Readers
predating this extension cannot validate new normalized facts containing it;
keep a compatible reader. Saved files, manifests and hashes are never rewritten.

New prepared presentation declares `originExplanationVersion: 1` alongside
presentation schema 3. Saved JSON views use that declared wording policy;
unmarked schema-3 snapshots retain the historical origin explanations, including
their former conflict wording. Markdown-backed views read the saved Markdown.
Opening either format must preserve the frozen reading, not only file hashes.
Report explanation versions are independent of live screen wording.

New ordinary reports declare `presentation.authorLabelVersion: 1` for the
“Human prompt” vocabulary. Reports without that marker keep their original
author captions when rendered from JSON. The marker changes neither actor
classification nor membership; previously saved titles, text and files stay frozen.
`presentation.iconVersion: 2` selects the frozen React Icons author marks and
their license notice for new HTML. A report with the earlier Human captions
and no `iconVersion` keeps its original glyphs; older reports still have none.
Screen icon upgrades must not change any of these saved presentations.

New focused product reports declare `presentation.productVersion: 1` alongside
presentation schema 3 and the existing origin/brand versions. This changes
reading order, repeated definitions and narrow-table layout, not facts, units
or membership. Outcomes and timing lead; exact call/result details remain
available. HTML evidence tables scroll locally rather than fragmenting tool
identifiers. The marker is supported only for ordinary `kind: "report"` snapshots
with reportPopulation v1. Unmarked saved files and JSON-only rendered readings
retain their original presentation; unknown marker versions are refused.

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

New report facts containing the Exchange ID conversion path use technical
pattern v4 and require a compatible reader. Its normalized operation identifies
no individual mailbox item or named app. Older v3 patterns keep the shapes and
counts they saved; comparisons do not equate the two pattern definitions.

| Measure | Interpretation |
| --- | --- |
| Tool completion | Not application or task success |
| `resultFacts` v1 (`wire-recorded-result-facts-v1`) | Separate explicit application errors, singleton/returned statuses, codes, supplied/retained counts, pagination presence and content availability |
| Partial Work IQ prefix | Original positions and unknown supplied total; not an exhaustive parent cause |
| Item/page totals | Arbitrary response bodies do not establish them |
| Timing | Keep unit, boundary and timed/eligible population; never blend prompt/tool/HTTP intervals or sum concurrent calls |
| Comparison timing | Compatible raw samples, not means of percentages or medians of medians; nearest-rank median/P95 and one-sample limits stay explicit |

The canonical tool `partial` bucket preserves an explicit retained
`reportedOutcome: "partial"`.

- It isn't derived from returned statuses, `contentStatus: "partial"`, missing
  completion timing or response truncation.
- HTTP 206 stays a 2xx status in its own evidence layer.
- The current Copilot completion normalizer emits succeeded/failed/unknown from
  the completion event's boolean success field. No partial tool state is
  synthesized during capture.
- Screen explanations can identify the saved partial flag and absent completion
  provenance without inferring which work completed. Frozen report meanings and
  interpretations don't acquire that screen-only explanation.

Missing timing stays unavailable, not zero.

### Result extensions

Each extension below is optional on new observations. Existing frozen
observations without it stay unchanged, and each needs a compatible reader.

#### `timingFailure` v1

New result observations can include `timingFailure` v1: the saved, qualified
`request-timeout` signal with `basis: "retained-failure-signal"`.

- Reports keep it separate from the outer error code and unavailable original
  error text.
- The recorded timeout message or its qualified retained signal must establish
  this condition. -32001 or elapsed time alone doesn't.
- A timeout doesn't establish whether the requested work finished.
- Compare can identify newly included evidence without calling it a new
  execution.
- Readers predating this extension can't read new reports containing it.

#### `interpretation` v2

New GitHub result observations can also freeze `interpretation` v2. Its closed
condition, call/result/returned-entry scope and exact explanatory text are
validated together.

- **WIRE interpretation** is technical context, not a quoted source reason or a
  report-author note. It changes no outcome, count or timing sample.
- Compare separates changed interpretations from changed source facts.
- Old observations without it receive no new interpretation when opened.
- Version 1 interpretations keep their frozen wording.
- Version 2 limits absence statements to the error signal or status alone, so a
  specific detail in another retained channel isn't contradicted.
- Older readers reject version 2. Keep a compatible reader after saving new
  reports.

#### `statusConflict` v1

A returned entry can freeze `statusConflict` v1 with separate `reported` and
`diagnostic` statuses.

- Both are qualified numeric statuses. The reported value matches the existing
  entry status, and the values must differ.
- Its interpretation keeps that ambiguity at the same entry instead of choosing
  a status as the definitive outcome.
- For new preparation, either conflicting side in the 400-599 range counts as
  recorded error evidence: the interaction belongs in Errors & failures and isn't
  completed-only. This doesn't change the outer tool completion or choose an API
  outcome.
- A conflict between non-error statuses alone isn't error evidence.

### Interpretation rules

Interpretations use qualified retained signals, diagnostic fields and statuses,
never prompts, replies or elapsed-time thresholds.

- Detailed source wording stays intact without a repetitive status glossary.
- Partial or missing evidence can't establish a timeout, cancellation or the
  outcomes of omitted entries.
- Fixed technical context can travel without optional diagnostic prose. It
  contains no source-text excerpts, private identifiers or reconstructed causes.
- Each interpreted call keeps its recorded operation and qualified tool interval
  beside the explanation.
- When diagnostic copies are selected, their masked or edited wording appears
  there too, without another copy in the result-text section. Omitted copies stay
  omitted.
- The explanation states what the evidence doesn't establish, without next
  checks, troubleshooting recommendations or remediation advice.
- It never reruns the operation or borrows a nearby call's evidence.

Sources for the explanations:

- The timeout explanation follows the
  [MCP lifecycle timeout rule](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#timeouts)
  and the [TypeScript SDK's request timeout handling](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.25.2/src/shared/protocol.ts).
  The SDK defines `RequestTimeout = -32001`, but
  [JSON-RPC reserves that range for implementation-defined errors](https://www.jsonrpc.org/specification#error_object):
  the number alone isn't a universal timeout diagnosis. WIRE requires the
  recorded timeout message or its qualified retained signal. It doesn't infer
  the configured deadline, the slow component or whether the work finished.
- HTTP explanations follow [RFC 9110 status semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-15)
  and [RFC 6585 for rate limiting](https://www.rfc-editor.org/rfc/rfc6585.html#section-4),
  with recorded upstream connection details kept separate from a bare 503.

### Report presets and notes

#### `reportPopulation` v1

`reportPopulation` v1 freezes metadata-only reference membership and the
included interaction IDs separately.

- The reference cohort applies the same source, authors, dates and services
  before the outcome restriction.
- Failure frequency uses distinct interactions, not calls or the failure subset
  as its denominator.
- Only included cases supply prompt, reply or diagnostic copies.

Preset membership:

- An error case has a qualified failed call or explicit application/API error.
  Mixed interactions qualify.
- Completed-only requires at least one eligible call, every call completed and no
  recorded errors.
- Unknown evidence is neither failure nor success.
- Unverified authors stay available through All.

#### `reportPatterns` v3

`reportPatterns` v3 binds normalized operations and distinct error channels to
their calls and interactions. It doesn't infer root causes or prompt similarity.

Reading controls in a new HTML pattern table:

- The arrow beside **Interactions** links to one example, not a filtered list.
  Its destination is the group's first stored interaction reference, and the link
  names the total and the destination's report number. The in-app report reader
  opens that interaction's disclosure.
- In v3 error rows, **Calls** links to the individual report call, or expands a
  list of call links when there are several. Plain call totals aren't actions.
- These reading controls don't change membership or rewrite earlier saved HTML.

Error evidence:

- For conflicting returned statuses with error evidence, patterns keep both the
  reported and diagnostic sides and label the conflict.
- New observations can include `errorDetailVersion: 1`: the typed error field
  supplied text or a code, independently of whether the report may disclose its
  value.
- A status disagreement between two non-error statuses isn't itself an error.
- Version 3 patterns count these qualified signals without copying the message or
  a withheld code into the pattern.
- A qualified recurring cause, such as sign-in required or an upstream connection
  timeout, is grouped with its operation and attributed to its call, result or
  returned entry. An unexplained marker doesn't acquire a cause from similar
  calls.

Version 1 patterns and all saved population flags keep their original frozen
meaning; they aren't recomputed on read. Older observations and v1/v2 pattern
groups keep their saved meaning; new reports with this extension need a
compatible reader.

#### `reportNotes` v1

`reportNotes` v1 contains report-author context scoped to included pseudonymous
interaction IDs.

- Notes share privacy treatment and the existing copy budget, but never enter
  metrics.
- Matching namespace hashes are required in the manifest and snapshot. Malformed
  or expanded fields are rejected.

## Preparation, disclosure and Save

### Frozen preparation

The report controller owns the sequence:

1. Select the activity. Browsing, selecting and cancelling before confirmation
   write no export.
2. Prepare a preview. Freeze membership, options, source facts, time context
   and prepared bytes.
3. Optionally inspect, mask, edit or omit copies and add report-author notes.
4. Confirm local Save, then verify saved readback. Keeping chat details requires
   the warning's explicit choice for that save.

Before preparation, a [named draft](reporting.md#keep-interactions-in-a-draft)
stores references to selected interactions for its owner and source.

- Adding an interaction doesn't copy its text.
- Preparing freezes the eligible membership at that point. Later draft edits
  can't add cases to an open preview or rewrite a saved file.
- Deleting a draft removes its selection only.

Qualified GitHub previews pin the original content-addressed evidence file.
Later collection can add follow-ups without changing prepared copies.

#### Landing, Back and resume

The Reports landing combines choices and saved access. Back isn't discard,
preparation or Save.

- Resuming the same focus with unchanged dates can reopen the authorized
  in-memory preview, including its edits, without recapturing membership.
- Legacy create URLs and Selected/Current/contextual entry keep their scope.
- An unconfirmed write can't be hidden behind the landing or replayed through a
  new preparation.
- Saved-list menus use the current authorized index. Withdrawal retires their
  held text and actions with the existing readers.

#### Retiring prepared copies

Accepted activity deletion, changed scope and preview replacement use the same
prepared-copy retirement boundary.

- It scrubs app-owned mutable Text/Attr nodes, editor fields and file and frame
  payloads before their owners detach them, and disables old callbacks.
- Hidden Local original copies are included.
- This isn't erasure of immutable strings copied outside WIRE, and activity
  deletion doesn't delete or rewrite independently saved report files.

| Change after preparation | Effect |
| --- | --- |
| Ordinary Back/browsing with unchanged facts and authority | Preview can survive |
| Scope, author selection, date or service change | Fresh membership and preparation |
| Title, note, privacy, copy or format change | Regenerate bytes against the original frozen reference and included populations |
| Material source/configuration, consent, deletion, key or owner change | Fresh preparation under current authority; old preparation cannot bypass it |

Original evidence-file identity also keys the report read model, so reading a
saved report can't replace current Analyze facts.

- Saving appends to current state. It never restores the preview's evidence
  snapshot over newer collection.
- For a qualified pinned preparation, a later correction to collected prompt
  authorship stays outside that frozen source snapshot. Explicit Save keeps the
  prepared author-filtered membership and facts; a new preparation uses the
  correction.
- Source or account permission, consent, deletion and owner changes still
  invalidate Save.
- Unpinned preparations must revalidate their live selected facts.

New ordinary saved entries keep their snapshot's date selection as
`reportPeriod`, independently of report presets.

- When present it must match the frozen manifest and participates in the
  artifact fingerprint.
- The native publication check also binds the new index entry to the reviewed
  period before registering it.
- Older entries without it stay readable. Missing index metadata isn't evidence
  that the file has no period.
- Preparation timestamps never substitute for the saved date selection.

### Report text choices

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

### Save authorization

New reports use `savePolicy: "local-save-v1"`. A preparation supplies a one-save
challenge binding its bundle, snapshot, prompt mode, formats and exact file
inventory. The receipt records `explicit-local-save`, with both reviewer flags
false. Its keep-chat-details flag is true exactly when original wording was
chosen. Historical attested bundles keep their existing interpretation.

Mask detected details and save regenerates masked bytes before binding the save intent.
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

A new report preparation cannot replace a dispatched or unconfirmed Save. Withdrawal
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
| Shared message edits | Source-qualified ordinary aliases reconcile to one shared edit key without merging interactions; equivalent choices survive context on/off/on, conflicting choices fail |
| Analytical scope | Context adds no membership, metric denominator or period cohort |
| Revoked reply-copy override | Cannot remain reusable text |

## Frozen files and saved reading

### Usage facts

New reports can include `usageFacts` version 1. The optional breakdown counts
each originating interaction once, separately in each period for a period
report. Model token shares include all metered interactions.
Per-interaction rows use the report's projected
interaction references and never carry source call IDs or extra prompt text.
Question-led reports freeze their cohort rows and coverage with the same
manifest hash. An author or tool filter and a high-usage threshold narrow an
interaction report before disclosure; changing the cohort requires a new
preparation. A fixed two-period report retains its accepted evidence, with
the question applied separately inside each period. Tool groups can overlap,
but repeated uses of a tool never multiply an interaction's tokens. Model
groups use the model on each receipt. A missing return size is never counted
as zero. New reports freeze token counts and coverage (`readingVersion: 3`).

Token-overview reports with per-interaction rows use `usageFacts` version 2
and `readingVersion: 4`. Ordinary breakdowns remain version 1.
They freeze author totals over the same eligible members and derive the leading
contributor share only from frozen positive ranked rows and the recorded total.
Unmeasured and measured-zero cohorts have no concentration percentage. This
overview leads in each saved format; earlier readings keep their interpretation.

In activity reports, a usage question about an author, tool or model also leads.
Otherwise the optional token breakdown follows the activity evidence, before the closing WIRE signature.
When counts are included but none were recorded, the breakdown says so; turning
counts off omits the section.

JSON-only overviews require a reader that supports version 2. Older readers
refuse that structured view rather than silently omitting its finding and author
totals. For portable reading, explicitly include HTML or PDF and open that saved
format; WIRE never adds a format the user did not confirm.

Earlier reports retain their originally saved fields and wording.
Earlier snapshots without `usageFacts` gain no usage section when reopened.
Use a current reader for newly saved JSON-only reports. Older readers that
require the retired field on timing metrics may refuse the newer snapshot.
Opening an earlier file in the current reader does not rewrite it.

### Finding-first reading

Focused reports prepared with `presentation.findingVersion: 1` or `2` use a
finding-first reading. Version 2 changes the explanation of the counts, not what
is counted. Version 1 keeps its original wording when reopened from JSON.

- HTML/PDF/Markdown and the verified Brief refer to the same frozen
  `reportPopulation.reference` / `included`, `reportPatterns` member sets and
  `resultFacts` observations.
- The five leading pattern bars use distinct interaction counts against the
  included population; patterns overlap.
- The example follows `reportPatterns.calls[].ref → scenarioRef` and, for
  diagnostic text, the exact `memberRefs`, `observationRef` and `entryIndex` of
  the saved copy. A null entry index doesn't describe a returned item's reason.
- Neither an improvement hypothesis nor a future evaluation target is a fact in
  the report.
- Earlier presentations and original downloads are unchanged.

### Formats

| Format | Saved representation |
| --- | --- |
| HTML | Escaped and self-contained; no scripts or remote assets |
| PDF | Local HTML rendering with embedded fonts |
| Markdown | Portable text |
| JSON and manifest | Complete typed facts and bindings |

Human summaries may omit redundant prose, not selected evidence or
qualifications. Screen tokens, icons and typography can't restyle frozen files.

### Report branding

New reports declare `presentation.brandVersion: 2` for the clean-contour Magenta
Human Path artwork.

| Declared version | Artwork |
| --- | --- |
| `2` | Clean-contour Magenta Human Path |
| `1` | Its originally shipped artwork, in the frozen `wire-report-brand-v1` SVGs |
| None | The historical `wire-wordmark` brand |
| Unknown | Unsupported; not permission to use the current logo |

- Keep historical logo assets and report styles unchanged so JSON/Markdown-only
  Open preserves the complete historical rendering, not merely the saved bytes.
- An identity change needs a new presentation brand version and preservation of
  its predecessors.
- The screen and README brand isn't a global report override.
- Markdown files stay portable text. Their in-app file-preview brand follows the
  verified manifest's declared version, with the historical brand used when that
  field is absent.

### Recorded tool results

Recorded tool results include every selected call, including calls with no saved
diagnostic; there's no first-twelve-call display cap.

- Each result names its tool and the requested operation from the same frozen
  technical facts, when available.
- Returned-entry positions stay separate from requested batch targets.
- Error details distinguish source absence, retention loss, privacy exclusion and
  unsupported formats.
- Completed means the source recorded tool completion, not that WIRE established
  task success.

When an invocation error and a separate result error are both retained, selected
copies keep both with distinct labels and copy identities under the same call.
Readers must understand those labels; an older reader may refuse a newer report
rather than drop one of its errors. Existing saved copies and hashes stay
unchanged.

### Verified Open

Verified Open follows the saved artifact:

1. Check ownership, managed paths, manifest, inventory, file hash/length and
   current retained access.
2. Read the registered original bytes. A broken declared preferred file does
   not silently fall back to another format.
3. Render HTML in an opaque network-free sandbox, or text/PDF locally without
   fetching cited resources. Format selectors and downloads use the same
   registered inventory, not regenerated DOM.

Failed verification can't silently downgrade to an unchecked reading path.
Unsupported schemas and missing facts stay explicit; current activity can't fill
gaps in a saved report.

Report view is separate from original-file inspection and Download.

- When HTML is absent, supported saved JSON can supply a read-only HTML view after
  snapshot, manifest, ownership and disclosure checks.
- Markdown/PDF-only saves use their local readable representations.
- A declared missing or altered preferred file still refuses. This isn't a
  fallback or repair path.
- Legacy-original viewing keeps its explicit warning and unverified status.

Screen-only section and interaction disclosures preserve all content and original
anchor identities. Color repeats recorded outcome words, never a new success
judgment. Collapse, navigation and format switching don't change membership,
facts, file bytes or print/export completeness.

### Brief

For supported ordinary focused reports, Brief uses the verified manifest's
pattern membership, call-to-interaction bindings and permitted result copies with
the corresponding saved document anchors.

- It never joins a call to a prompt by display order or transfers a returned
  status to the parent outcome.
- For a returned-status finding, quoted entry text must bind to that call,
  observation, entry position and nonconflicting status.
- A separately labelled call-level example isn't an entry explanation; other
  entries' text stays in the exact call view.
- The full historical reading and original files stay separate choices.

Saved metadata search doesn't read prompt or report bodies. Global Search
extracts only permitted text from independently verified saved files through the
[corpus contract](search-corpus.md). Its receipt authority isn't interchangeable
with library authority on reload or invalidation.

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
must already be frozen and masked; extra masking is allowed, but fetching missing
source text isn't.

### Existing saved comparisons

Existing saved comparisons are read-only. Some schema-3 files declare
`presentation.comparisonVersion: 1`.

- Their two `sourceIdentity` entries bind the exact Earlier/Later report
  references and hashes to manifest-declared titles, selected windows, time
  contexts and included-interaction counts.
- Missing historical metadata is explicitly null, not recovered from current
  activity or an indexed display name.
- Titles pass the report masking rules.
- The identity is frozen in the comparison hash, snapshot and manifest, and isn't
  derived from current activity.

The versioned reading leads with this named pair and recorded measures.

- Selected report windows aren't verified per-call coverage.
- Operation failure wording names its evidence layer, and Markdown carries the
  same saved operation paths as HTML/PDF.
- Earlier/Later values stay adjacent when the layout reflows.
- Unmarked comparisons keep their historical wording, styles and original files;
  they acquire no inferred identity.
- Unsupported or mismatched new markers are refused. Version-marked JSON-only
  comparisons need the matching reader; downgrading isn't permission to
  regenerate them from current history.

### Report a retained-period comparison

Fresh Compare entry uses all eligible activity in the saved collection,
independently of Analyze.

- Its 7/14/30-day presets end yesterday in the selected IANA zone and compare the
  immediately preceding equal number of civil days.
- Custom ranges can differ in length or overlap.
- Use Analyze view is an explicit transfer of its authorized non-date scope.
  Unavailable private membership can't fall back to all activity.

Chart views and inspection are presentations of one accepted pair. Outcome shares
keep the before-outcome reference population. Error-focused reading keeps failed
execution distinct from explicit application/API errors; report presets still use
their documented whole-interaction membership rules.

1. Freeze accepted A/B ranges, shared non-date filters, source/revision and
   exact matching rows. For an explicit Analyze entry, replace its dates while
   retaining Search, source/group and other selectors.
2. Keep each period's measured cohort and compatible raw timing samples.
   One empty side is valid; two empty sides cannot create a report.
3. Bind facts in schema-3 `periodComparison` and its matching manifest hash.
   This subtype omits the ordinary single date-range envelope.
4. Revalidate accepted fields through shared comparison math. Caller hit lists
   cannot supply receipt authority.

Complete parent interactions support copies and full-interaction timing without
expanding matching-call denominators.

- `records` supplies those permitted copies, not a union metric denominator or
  third cohort.
- Undated rows stay outside dated cohorts.
- B-minus-A shares use percentage points, not relative percent.

A saved period report is one artifact with two cohorts.

- New preparation never manufactures two source reports.
- Changed selected facts or authority invalidate preparation; unrelated accepted
  activity need not.
- Comparison-origin preparation and saved reading return to the accepted
  comparison while its authority stays current. Reports-origin returns keep their
  separate library state.
- Opening Reports from the sidebar starts a Reports-origin task. Creating a
  report from the accepted comparison keeps its explicit comparison origin.

Current readers accept both the older Analyze author-policy wording and the new
Compare periods wording. Older readers that recognize only the Analyze wording
reject new paired reports. After saving a new paired report, downgrading to such a
reader isn't a compatible recovery path; keep the matching reader and original
saved files.

## Saved-artifact deletion

| Deletion | Included / preserved |
| --- | --- |
| One report | Remove managed bundle, recognized copies and index entry; preserve source activity and external downloads |
| Input to a saved comparison | Saved comparison survives with an unavailable input link |
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
