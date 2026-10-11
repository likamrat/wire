# Reports and comparisons in WIRE

WIRE describes your approved, recorded interactions. It does not require a synthetic benchmark or an expected-answer dataset, and it does not replay Work IQ or Graph requests.

## Reading the measures

The analytical filter row uses short display names, not new provenance or units:
**Work IQ calls**, **Graph API call sites**, **Graph statuses**, **Returned API
entries**, **HTTP recorder** and **Graph code references**. A call site is not a
measured network execution; visible statuses are a subset of those sites. Returned
entries, owned diagnostic captures and code references remain separate evidence.
Contextual help carries these distinctions; counts and reports keep their exact
unit names. Filter layout and wording do not alter saved reports or membership.

**Activity categories** group Work IQ calls by recorded data-service targets or by
preparatory **Discovery**. API discovery (`search_paths`), schema lookup (`get_schema`)
and agent discovery (`list_agents`) are not executions of the data operations they
describe. Their data service is **Not applicable**; a schema argument is a **Schema path**.
API-result and owned-HTTP layers still classify their own service evidence. A schema
argument is never used as a fallback target for a returned API result.

Category definition v3 retains the v2 Discovery boundary and recognizes the exact
`/shares/{opaque}/driveItem` shared-file path as Files. The opaque sharing token and
query values remain withheld from normalized/report paths. This is a regrouping, not an
improvement in tool behavior. Near-miss or unsupported paths stay unassigned.
For this shape, unversioned relative, supported-version relative and trusted Graph HTTPS
targets share the same origin/version qualification in analytics and report sanitization.
The public API version is preserved; credentials, opaque tokens and query values are not.
New reports freeze that definition and v3 technical patterns; comparisons against older
pattern definitions withhold matched-pattern deltas while keeping independently compatible
measures visible. Raw evidence/automatic-attempt fingerprints do not change, so regrouping
cannot schedule another assessment. Existing saved files remain unchanged.

**Service involvement** is a separate, versioned projection
(`wire-service-involvement`, v1), not a replacement for activity-category v3.
A call targeting Files and Mail matches either service and counts once in a combined
selection. Each service's count includes that call once; its percentage divides by
all canonical rows in the declared slice. Those percentages can sum above 100%.
Missing-service rows remain in an unfiltered slice and are not assigned to a service.
Layer units still differ: returned entries, recorded sites and code references do
not become measured service executions.

The analytics `services` filter matches supported associations. The `workloads`
filter and existing category groups remain exclusive v3 categories; the legacy
Discovery, Multiple workloads and Unknown choices still select their display category.
Strict Files matching is the API and direct-link default. The main Service menu
explicitly enables named missing-service context when a service is chosen.
`includeMissingService: true` adds
calls with missing or unusable service detail, respecting every other filter.
Consumers must name that scope **Files + calls with missing service details** and
make the extra context removable. A partially identified call may have both a known
service and a gap; it still counts once. Discovery is not missing-service context.
The context chip removes only this extension, and the scope then offers an
explicit add-context action. Old `service=...` URLs remain exclusive category
links; `services=...` uses associations, with omitted/false
`includeMissingService` preserving strict membership. These browsing controls do
not change separately selected report authors, hidden selected requests, existing
full-interaction report scope or frozen report files.

Private analytical search now uses the same all-page canonical call membership
on Home, Activity and current-view report setup. **Current view** resolves the
matching request IDs once, then includes their complete eligible interactions,
not only chart-matching calls. Setup shows the matching-call count separately
from full report counts. **Selected** keeps hidden selections; **All collected
activity** is not narrowed by browsing search. Report author/privacy rules,
preview approval and frozen artifacts are unchanged. This is not the later
period-comparison report's frozen matching-call cohort contract.

Returned entries use their explicit normalized endpoint, or the existing
single-target fallback for a non-discovery call. They never inherit all parent
batch targets or use response-array position as target evidence. An entry without
a target in a multi-target call is **Result target not identified**. API coverage
counts a qualifying parent once using supported call or returned-target associations;
discovery qualifies only through returned evidence, never its schema argument.

New involvement consumers receive the definition, exact canonical drilldown IDs,
known-match IDs and context-only IDs together. Reports that adopt involvement must
freeze that definition, the declared selection and exact membership; absent or
different involvement definitions cannot yield involvement comparison deltas.
Current report category counts and v3 technical patterns retain their original
meaning and bytes; they are not historical involvement facts. No current report
measure is replaced by this additive projection.

**Service not shown** (canonical `Unknown`, previously displayed as Service not identified)
remains a genuine evidence limit. Contextual help distinguishes service details missing
from a Copilot-assistance record, recorded paths not recognized by WIRE, unsupported target formats and
genuinely missing targets. Copilot assistance is a known tool purpose, not an assigned
downstream service. A neutral information glyph replaces the question mark where category
cues remain; chart columns do not regain the removed icon row.
In the app, the selected **Service not shown** view exposes its actual tool/reason
counts before any disclosure. Hosted-call technical details explicitly mark a
downstream API path, HTTP method or API version missing from that record. This
does not claim Work IQ never exposes services or that no service was used. A question,
attachment or conversation identifier is not evidence of an executed service
endpoint. These explanations preserve category v3 and its frozen report patterns;
they do not regroup calls, change scores or reinterpret existing saved reports.
**Search and retrieval** is distinct from path discovery. Tool success is independent:
discovery can work, fail or lack a recorded completion. An absent API status is not proof
that discovery returned no useful catalog information, and absent owned HTTP capture does
not establish that no network traffic occurred.

**No target recorded** means no usable target was retained in this record, not
proof that the original source omitted it. Proving a source omission requires a
qualified comparison with original evidence; this projection neither makes that
comparison nor reconstructs missing targets. Unsupported formats, recorded paths
WIRE cannot match to a service, and absent targets remain distinct.
Multiple reasons can describe one call. The existing tool/reason groups count it
once under its first gap; its association and full explanation retain every reason.

The shared-file shape is documented by Microsoft Graph v1.0
[Access shared items, single-file example](https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0#example-single-file).
This explains retained target metadata, not proof of a new request, a particular tenant's
capabilities, or whether a recorded request succeeded.

| Measure | What the value means |
| --- | --- |
| Recorded tool success | Successful recorded tool calls divided by all unique included calls. Failed, partial and unknown outcomes remain separate. This is not answer accuracy. |
| Accuracy | Passed assessments divided by passed plus failed assessments, with assessed coverage alongside. Personal verdicts are labeled separately from automatic checks. |
| Speed | The named recorded timing boundary, such as median tool-call duration or time to HTTP response headers. Different boundaries are not blended. |
| Trust: answers | Evidence-supported answer checks or explicitly labeled personal verdicts. Citation presence alone does not establish support. |
| Trust: actions | Model-assessed alignment with recorded intent, or separate personal authorization verdicts. Intent alignment, tool success and accepted HTTP requests are not proof of human authorization. |

Local observations alone do not judge semantic answer quality. Separately approved
model assessments can provide Accuracy, answer Trust and action Trust from recorded
evidence, with model/rubric origin and exact interaction coverage. No result is
**Not assessed**, not zero or tool-success rate. Insufficient evidence and evaluator
errors remain distinct. Optional personal feedback is not a required grading workflow.

New reports use metric projection v2: Accuracy, Speed and Trust, with no original
Cost metric, placeholder, or definition. Historical four-dimension report facts
remain readable without alteration. Evaluator spending safeguards remain in
Automatic scores; omitting original Cost never means zero spending or improvement.

Pass-share colors use versioned presentation bands: below 50%, 50% to below 75%, 75% to below 90%, and 90% to 100%. Exact counts and coverage are retained. Displayed percentages do not round across a color boundary. These bands are not a combined quality grade, statistical confidence, or a score for a person or team.

## Saving a report

The **Setup -> Review -> Save locally** flow stays deliberate and empty-first.
Setup combines Selected/Current/All scope, author inclusion, prompt text mode and
all four formats. Its counts use the actual full-interaction population across
all pages, not the visible list. It names selected groups outside browsing filters.
Reports navigation still opens the saved library; Create a report opens Setup.

The current step and selection share one task header. Each stage has a local
Back/next action area; missing prerequisites appear there, not under future steps.
**Scope and exclusions** and **Included requests and optional labels** are
supporting details, not extra steps. Reports has no analytical Reset to Home.

Review keeps **Included evidence and preparation details**, **Inspect exact files**,
prompt copies and privacy findings available beside the formatted preview.
Save shows the approved membership, prompt mode and formats before the separate
**Confirm local export** action. Back to Setup can retain an unchanged prepared
snapshot; stored-data refresh remains disabled while it exists.

**Prompt authors in this report** is an explicit membership choice in Setup, separate from
No prompts / Masked / Original. It intersects the chosen Selected requests, Current view or All
collected activity base scope. Your-only excludes agent-originated and unverified interactions,
including their complete calls and scores; select the unverified category explicitly to include it.
Your + Agent is not All: All includes unverified authors. Human-origin groups keep calls executed
by agents. Changing browsing filters never discards hidden selected IDs, while a report author
change invalidates its preview and disclosure approval even if the current matching IDs are unchanged.

New snapshots freeze `selectionScope.promptAuthors`, `baseRequestGroups`, and
`authorExcludedRequestGroups` alongside the exact included membership/counts. HTML, PDF, JSON and
Markdown share those facts and denominators. Source-neutral reports call the app's Your cohort
**User prompts**, without a named-person or authentication claim.

- Every selected format uses the same frozen facts and reviewed content.
- Markdown names each timing boundary and assessment origin, just like HTML/PDF;
  tool-call and final-response medians keep separate call/request coverage.
- New readable model results name the frozen model and rubric ID/version, including
  each comparison side's own origin. Missing legacy metadata is not filled from
  today's evaluator; a partly saved rubric labels its missing ID or version.
- The manifest retains privacy-projected evaluation facts even when JSON is not a chosen presentation format.
- Evaluation facts contain no answer excerpts or raw prompt text. Prompt copies follow the separately chosen None, Masked or Original mode.
- New readable reports label attributable originating text **User prompt** or **Agent prompt**, using the same retained author evidence as the app's **Your prompt** and **Agent prompt**. Known chat origin with an unverified author is **Copilot chat prompt**; genuinely unverified/non-chat origin remains **Prompt**. Captured question/query/filter fields are **Recorded tool argument**, not assumed to be human-authored. The prompt's author does not establish who initiated or authorized subsequent calls.
- New readable reports embed the approved WIRE mark, font and presentation rules. They do not fetch live styling or assets that could change their appearance later.
- Changes to selected evidence, relevant captured evidence, feedback or permission state can invalidate a draft. Unrelated activity does not change a report whose exact selected evidence remains unchanged.

Saved reports are immutable. A new assessment or a new visual design does not rewrite an existing HTML, PDF, JSON or Markdown file.

### New native reports

New HTML, PDF and Markdown lead with **What the record shows**: recorded call
outcomes, supported historical reasons, and separately qualified answer/action
findings. Compact **Recorded numbers**, flat tool bars and recorded timing follow.
Permitted bounded context precedes representative technical examples; full
quality measures, operation tables, reviewed prompt copies and coverage remain
available as supporting detail. HTML disclosures are native keyboard controls.
PDF expands every disclosure and copy. JSON retains the factual snapshot rather
than an inferred narrative.

Native output consumes the shared METROPOLIS typography and light/dark palette:
`Arial,"Helvetica Neue","Segoe UI",sans-serif`, shared heading roles, control/copy
radii and semantic outcome capsules. Both theme wordmarks remain local.
New HTML does not embed the retained historical Asta CSS font; that licensed
asset remains unchanged for explicit historical consumers. Bars use exact
linear fractions from zero, without minimum paint, gradients or perspective.
Rounded tracks do not alter their count-derived widths. Counts/shares and exact tables are readable
without hover. A prepared report ignores narrower browsing filters: its complete
selected interactions own every denominator. Returned API units, Graph sites,
owned HTTP records and tool calls remain distinct.

`evaluationFacts.reviewStatuses` is an optional, closed content-free projection
of the existing selected review statuses. Each unique interaction reference must
belong to frozen membership; execution counts must equal that interaction's
canonical `recordedOutcomes`, **not** completion-qualified check counts. Partial
status coverage is explicitly labelled. In particular, a legacy reported outcome
without a completion event remains a reported outcome and an unassessed
completion check; WIRE does not invent event IDs. Existing qualified sign-in,
timeout and access-denial signals retain their historical meaning. Raw error
text and semantic rationales are not added.

The native adapter calls the app's existing assessment presentation and timing
helpers over validated frozen facts. Timing retains raw milliseconds, named
boundaries, nearest-rank median/P95 and timed/eligible populations. One sample is
labelled as one sample, missing is not zero, and concurrent calls are never
summed into task latency. Model/rubric and personal lanes retain separate
percentages and coverage.
Each finding also carries its saved origin beside the claim, including the exact
model and rubric ID/version for each AI lane, even when different lanes have
identical wording or counts. Technical detail is not the only place that names
these origins.

The optional field is inside the existing evaluation-facts and snapshot hashes
and privacy validation. It does not change comparison definitions, metrics or
pattern identities. Old facts without it remain valid and say that detailed
call-status context was not saved; no current-data lookup fills the gap. Missing
historical activity bins and missing semantic explanations are also stated as
unavailable, not reconstructed. Opening an older artifact still reads its
verified saved bytes without calling a current renderer.

New facts also freeze optional `serviceInvolvement`: the exact
`wire-service-involvement` v1 definition, explicit `tool-call` layer, keyed
canonical member references/denominator, per-service member sets/counts, and
missing-detail/not-applicable reference sets. This uses the existing canonical
association projection, not a new classifier. The validator requires the same
tool members as `recordedOutcomes`, exact counts, and complete coverage by the
union of known, missing and not-applicable sets. Known service sets can overlap
each other and missing-detail membership; preparation is disjoint from both.
Shares use the explicitly covered tool calls and are not a 100% composition.
If conflicting/unmapped records leave the assessment membership narrower than
the operational report inventory, both counts and the coverage limitation are
shown; missing calls are never relabelled as an absent service or silent success.
The complete closed definition is validated without importing product code into
the browser-shared executable contract. Its wording must remain identical to
the existing service definition; the focused test guards that seam.

The involvement field is hashed and privacy-validated inside the same facts.
Absent legacy involvement stays **Service involvement was not saved** even if
older category-v3 counts exist. Current comparison adapters ignore this
additional display field: they neither change existing deltas nor invent
involvement comparisons. Categories remain labelled **Activity categories**.

### Native print typography

Native report width, gutters, bar height and print point sizes are unchanged.
Print uses the selected report's shared palette rather than stale native-only
ink/rule overrides. PDF generation uses locally available fonts and embeds their
font programs; saved readers still forbid external resources and system-font
fallback. Focused proof checks the real embedded program bytes, exact extracted
text and page boundaries through the strict saved-PDF reader.

New PDF header/footer templates use the shared font stack with their existing
8px text and page-number placeholders. Chromium renders these margins as
separate white documents, not children of the report body. The renderer resolves
the document's `--muted` color in print media, then uses that foreground only if
it is opaque and readable on white. Tokenless, invalid, transparent or
insufficient-contrast values use the shared light palette's resolved muted
foreground. This fallback is obtained from the shared stylesheet, not a second
hardcoded palette. Only normalized color values and an HTML-escaped font stack
enter template attributes. Native and new comparison PDFs share this margin
styling; comparison layout and all saved artifact bytes remain unchanged.

### Setup consumer contract

`createReportJourney` is still presentation-only: steps 1/2/3 are Setup/Review/Save
locally. `beginScan` opens actual Review; only the export controller's confirmed
disclosure response calls `reviewed()`. The separate final confirmation owns the
local write. Back to Setup returns to the same preview only when unchanged.
No report persistence, schema, preview/review/export endpoint or permission contract changes.

`createReportScope.resolve` supplies canonical requests, aliases, base membership,
author exclusions and full-interaction counts. `updateSelection` synchronizes this
with `createReportDraft`; private search stays browser-only and is represented to
report APIs by IDs, never query text. Pending/failed reads gate review/save without
discarding copies. Accepted reads compare selected source content and aliases,
base/included membership, author/options, time/date basis, source permissions,
feedback/deletion revisions and assessment mapping. Unrelated source/browsing
changes can keep verified approval; same-count identity swaps cannot. Global
feedback/permission invalidations are conservative. When model results exist, the
snapshot does not expose selected evaluation dependencies, so a revision change
requires a new review without deleting copy edits. Backend validation is authoritative.

### Bounded recorded context

**Include bounded recorded context** is a separate, initially unchecked Setup
choice. The API option is `recordedContext: true`; omission defaults to false.
No prompts forces the effective option off, opens no retained reply files, and
adds no context text or context-review originals. This is a report-copy choice,
not a capture or permission change. A reader visit is never export permission.

`collectReportContext` reuses `createRequestContext.select` and `compare` against
the already-retained collection, independently of browsing filters. Each selected
anchor gets at most one supported preceding and following group, using the
reader's exact same-chat event links and chronology. There is no recursive walk,
task clustering, generated account, or inferred retry/finality. Missing links,
ambiguous chronology, source exclusions, author exclusions and unavailable replies
remain explicit gaps. A neighboring request can describe changed intent; its old
verdict is not transferred to the selected result.

Author choices apply to **originating interaction groups**, before opening reply
payloads or presenting originals/copies. A copied follow-up that matches another
retained group's originating event uses that group's author eligibility, not the
copy's possibly different author label. An excluded neighbor cannot leak through
the selected record's existing follow-up appendix, even with context off.
An ungrouped follow-up also requires the unverified-author choice, in addition to
any supported sender category: a known sender does not establish a missing group.
Unsupported/conflicting authorship follows the existing unverified-author choice;
synthetic, diagnostic and unsupported-source context follows existing report
exclusions. Replies within an eligible user-originated group remain eligible:
assistant delivery is not an agent-originated prompt.

Replies come only from the existing authorized assessment read model and
`readRetainedResponse`, shared with the reader. Capture membership, current consent,
source configuration, payload hash, envelope and byte length are checked. Missing
files and no-longer-authorized replies yield text-free unavailable entries;
malformed data, integrity failures and other I/O failures block preparation.
There are no history, Work IQ, Graph, scoring, provider or new capture operations.
Source/current-state checks surround asynchronous reads; final Save retains the
existing board lock. A change discovered during rendering, review or Save rejects
the prepared context rather than quietly replacing approved text with a new gap.

All text uses `projectReportCopy`: the same masking patterns, mandatory credential
removal, manual terms, edit and omit rules as selected prompts. Partial sources
remain partial; unavailable text cannot be restored through an edit. Identical
recorded messages share one review/edit key across anchors and selected prompt
occurrences. Conflicting retained copies fail explicitly rather than selecting a
convenient version. Rebuild invalidates disclosure approval; review and final local
Save are still separate actions.

**Analytical boundary:** `createReportScope.resolve`, `reportPopulationNote`,
`selectionScope`, `records[]` membership, call IDs, evaluation memberships, counts,
timing samples and original verdict scopes do not expand. Context is never pushed
into those analytical populations to reuse a renderer. Selected prompt-copy keys
can be shared for the same recorded event; this does not merge interaction groups.

**Frozen consumer contract (native-report owner):** schema-v3 report snapshots may
add `recordedContext` with its own `schemaVersion: 1`. The manifest freezes the same
object plus `recordedContextHash`; the hash participates in normal integrity and
privacy checks. Absence retains the legacy contract. Existing saved bytes,
manifests and format readers are not migrated or regenerated.

| Frozen field | Meaning |
|---|---|
| `boundary`, `limitation` | Versioned fixed statements of the reader's bounded, incomplete context. |
| `anchors[]` | Selected `scenarioRef`; `groups[]` with original `scenarioRef`, per-anchor `relation` and `entryKeys`; overall chronologically ordered `entryKeys`; `gaps`; `authorExcludedGroups`. One globally shared message may have different relations to different anchors. |
| `entries[]` | Unique `key`, original `scenarioRef`, nullable scoped `eventRef`/opaque `observationRef`, `kind` (`prompt`, `follow-up`, `response`), `timeStatus`, source `status`, `representation`, projected `text` or null, `omitted`, masking `changes`, safe `label`, and `finality`. Prompts also carry qualified `authorship`/`originKind`; replies always have unverified finality and no invented prompt author. |
| `coverage` | Unique included groups/entries; included, omitted, unavailable and partial entries; author exclusions counted per anchor; `sourceBytes` and `projectedBytes` in UTF-8. These are context-copy counts, not analytical denominators. |

Scenario references use existing report pseudonyms. Event references are keyed
over chat plus recorded event ID; a missing event ID stays null. Existing validated
HMAC observation references identify retained replies. No payload filenames,
`textRef`, raw source IDs/paths, deletion keys or private dependency digests are
exported. Source timestamps are used for ordering but remain withheld; unknown
time is labeled and ordered after known times without claiming a measured position.

The optional preview `contextReview` contains only additional distinct copies.
Selected copies remain in `promptReview`; the normal Review UI combines the two
without duplicate edit keys. The closed validator checks references, per-anchor
relationships/order structure, source/finality vocabulary and coverage. HTML and
Markdown append a minimal **Recorded context** block; PDF uses the same escaped
HTML, and JSON stores the frozen structure. These adapters consume frozen facts
only, without live lookups. A future native layout can reposition these blocks
without changing their contents or analytical meaning.

There is no new 500-anchor or 1500-group restriction on normal report scope.
Context has the reader's per-anchor one-hop bound and the existing 3000-copy /
4 MiB budget applied to the **combined selected and contextual** copies, deduplicated
by stable edit key. Both original source text and final projected text are bounded
in UTF-8, including non-ASCII text and overrides. Context coverage counts its own
unique text bytes (including selected copies referenced there); do not add those
numbers to selected coverage as if disjoint. Existing raw-source and metadata
scanner limits still apply. Oversize reports fail explicitly, never silently trim.

Private context dependencies cover retained groups, message/link identities,
per-anchor membership/order, reply content/availability, consent, source and
deletion state. They are re-resolved after preparation and at review/Save.
Browser drafts use the same selector and conservatively require fresh review
on a new stored revision when context is enabled, because payload fingerprints
are not exposed. The rendered context keeps its own accepted revision/basis even
after edit/rebuild clears the active preview. Older status responses cannot clear
a newer valid context, and delayed preview/file work cannot repopulate invalidated
copies. Known source/consent/deletion changes scrub contextual originals and the
preview iframe, including during a pending local-save response. Only privacy-status
reading continues during such a context-bearing write; its receipt, lock and
no-replay behavior are unchanged.

Source-bound reply-copy overrides are removed when their context becomes
unverified. Ordinary prompt edits and unrelated options survive. Authorized
edit/rebuild remains available without rereading sources; it cannot restore
missing or revoked reply text. Independently saved artifacts/readers remain
unchanged. Hidden selected requests remain selected; pending/failed reads still
block approval and Save.

New readable reports and comparisons explain the checks in **How to read these
results** or **Reading notes**. HTML/PDF, Markdown and the comparison reader reuse
the report presenter's wording: coverage belongs to each check, missing results
are excluded from pass percentages, tool outcomes are not answer correctness,
and action matching is not proof of a person's permission. Timing boundaries and
timed-call/request counts stay separate. Exact model/rubric origins remain beside
their saved results. These explanations do not change facts or older saved files.

**Open saved report** reads the registered, disclosure-reviewed HTML file after
checking its manifest and exact file hash. The reader names its preparation time,
prompt mode and report ID and leaves any unfinished draft untouched. It does not
regenerate the report from current activity. Missing HTML is explicit; other saved
formats remain downloadable. The sandboxed reader blocks external resources and
out-of-document links (including the companion JSON link); use the saved download
buttons for companion files. In-document section links remain usable. These reader
safety restrictions never modify saved bytes, including historical Cost content.

### Prompt author evidence

The Copilot SDK [message source contract](https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts)
supports explicit `source: "user"` and `source: "agent-..."`, independent of delivery mode,
and documents the default user source when this option is omitted.
WIRE retains only normalized actor/basis values, not the agent source identifier. Recorded `source: "autopilot"`
or `isAutopilotContinuation: true` identifies automatic agent continuation. Contradictory fields stay unverified.
System/skill injection is not automatically a User or Agent prompt. `parentAgentTaskId`, `agentMode`,
message role, writing style and typed `<cross_session_message>` tags are not authorship evidence on their own.

The normalized assessment reader carries the same `{ actor, basis }` in
`interaction.message.authorship`; its coarser `origin` field is not a replacement for that evidence.
Consumers use the shared `promptAuthorship.read/reason` helper on the message, just as on a retained
prompt. Missing sender fields, unsupported source, conflicting evidence, invalid metadata and
explicit system context therefore keep their distinct explanations rather than becoming an
unexplained unverified author. The standalone transport validator checks actor/basis pairs and
their agreement with `origin`. Legacy messages without this optional field still validate unchanged;
no old report bytes or author labels are rewritten. This read-only projection does not change
classification, collection/qualification bounds, analytical membership or assessment fingerprints.

Ordinary app input often omits `source` in the original event. WIRE supports that recording path
only when the original `transformedContent` contains the exactly anchored displayed `content`, with the
supported host-added envelope outside it: a `current_datetime` within one second of the event,
valid message ID, delivery and mode metadata, and no other injected block for default user input.
The supported neutral `canvas-context` suffix may follow that exact body. Its body is opaque,
untrusted attachment data: it supplies no author evidence or instructions. Arbitrary trailing
markup, duplicate/extra wrappers and malformed boundaries are not accepted as the direct-input path.
The fixed host image-attachment `system_reminder` is also supported, only with its
exact known notice outside the matched displayed body. Other reminder text, added
attributes, duplicate wrappers and extra suffixes are rejected. This does not
relax the message ID, timestamp, mode, delivery or agent-created-first-message checks.
An eligible standalone chat need not have a workspace creation row; missing fields
alone never qualify it without the complete supported input envelope.
That combination is **Your prompt** in the app, not an assertion that a named person was authenticated.
A host-added `cross_session_message` envelope with valid sender fields is **Agent prompt**.
The parser never inspects tags inside the displayed content as provenance: a user copying an agent
message still has the direct-input envelope. Malformed, unsupported or conflicting envelopes stay
unverified. The full transformed text is neither retained nor exported.

For an untagged child kickoff, the schema-validated app adapter (inspected generations
156/166/174) optionally reads `workspaces.created_by` and `creator_session_id` from
the already-approved metadata source. Both must remain ordinary `TEXT` columns;
missing or incompatible optional fields do not establish authorship or block
otherwise-compatible collection. Agent attribution additionally
requires the actual first message from a history read that began at the start, an eligible unambiguous
creator, and an exact text match to that creator's earlier `external_tool.requested` / `create_session`
`arguments.kickoff.prompt`. A default-user envelope on an agent-created first message is not enough
to label that kickoff User; explicit host sender or creator proof remains separate.
Only existing bounded collection participates: no click-triggered scans,
response capture or inspection, discovery expansion or new source grant. Correlation retains at most 2,000 keyed
text fingerprints locally; reports carry only the normalized actor and basis.

Field absence alone is **not** positive human evidence. Older retained records also lost source
and transformed-envelope metadata; legacy `human-authored`
or `coordinator-message` strings alone are not promoted to verified attribution. Existing checkpoints
are not rewound or reports rewritten. Normal collection can qualify old retained messages against
their exact original event identity, timestamp and text before interpreting the original host metadata.
This distinguishes a genuinely omitted source in the original supported input path from metadata
discarded by an old checkpoint. Agent-created first messages can additionally use their eligible
creator's kickoff proof. Qualification reads the source's 64 KiB identity/first-message prefix and
starts with the existing bounded tail. If retained target dates predate that sample, it may use a
bounded beginning window for those exact IDs, then return to its saved tail position for newer
targets. Dates only locate a window; original file identity plus exact event ID, time and text decide
whether a record matches. This is not a backward sweep over unrelated sources. All windows and
repeated prefix/anchor reads share the 64 MiB cumulative source limit and remaining 32 MiB
collection-cycle limit, with the unchanged line limit. At most two candidate chats across both paths are checked per cycle; unfinished scans
resume their own bounded position, separate from the main collection cursor. Cached outcomes are not
rescanned for unrelated appends; source rotation, changed retained targets or a changed/missing-to-present
history identity invalidates the relevant cache. A local classifier version prevents re-reading
freshly classified unsupported original events as though their metadata had been lost.
The lookup version also prevents an earlier tail-only miss from masquerading as a completed broader lookup.
Completed lookup caches also carry the classifier version. An earlier unsupported
format must not strand the exact retained record after a supported envelope is added.
Current unsupported formats are not repeatedly rescanned. Explicit system-supplied
context remains author-unverified, with a specific reason, even if its prose resembles
a user request or agent handoff.
Missing originals or proof outside the approved window/bounds remain unverified.
This author-only correction cannot restore deleted content or rewrite frozen report membership. A new
author-filtered view or report can reflect corrected origin metadata. Other missing
historical evidence still needs separately approved bounded recovery, never a default-human guess.

Editing or omitting a prompt copy disables approval until you select **Rebuild preview** and review again. Edits change only the draft copy, not saved files or captured sources. Scope, contents and source changes still require a current scan.

### Finding and opening saved reports

**Reports** opens on the saved library, not the creation wizard. Choose **Create
a report** to enter the existing four-stage flow, or **Continue draft** to return
to unfinished choices and review. **Saved reports** switches back without clearing
selection or invalidating an otherwise unchanged prepared review. Browser Back
and Forward restore these tasks and the saved-library search/page. The explicit
Activity create action opens creation directly. `#reports?task=create` (and the
legacy `#report` link) opens creation; reloading still starts a new empty draft,
not an inferred selection. Existing source, permission and evidence checks remain.

Saved history already paginates; it is not an endless list. **Saved reports** shows
six items per page, the current range and total, Previous/Next, and a **Page / Go**
control to jump directly to a distant page. When comparisons are present, the
library names them explicitly and counts reports and comparisons separately.
Search covers safe metadata across every page, not just the visible six items:
IDs, preparation dates, formats, prompt modes and time zones. It does not read
stored report bodies or prompts.

Rows show preparation time, prompt mode and format availability. **Open** reads
the registered frozen HTML directly; **Manage** reveals full identity, request-group
count, preparation details, downloads, comparison and individual deletion actions.
No saved HTML is regenerated. Missing HTML and unknown metadata remain explicit.
**About saved reports** holds the search/privacy boundary and **Refresh stored data**;
refresh retains its existing draft/review guards.

Preparation time is not the activity period. Reports appear newest-prepared first;
exact timestamp ties use newest registration first. Unknown dates follow in original
registration order, without guessing from private contents or file modification times.
Identical summaries include the ID; every expanded entry retains its full ID.

Saving returns the current history search to its first page without clearing its query or other filters. Background refreshes preserve the history page and disclosures. Deleting the displayed saved report replaces its ready message and downloads with an unavailable state, including when another tab's deletion is observed. Unrelated deletions leave newer saved results and unfinished report drafts intact.

## Comparing two reports

Choose an earlier report and a later report explicitly. Reading the comparison does not create an export or run an assessment against the APIs again.
Choices lead with preparation date and time, followed by saved request-group counts and prompt mode,
not a long report ID. Formats and the full ID remain available as secondary
option text and in the selected report's details. Unknown metadata stays unknown;
preparation time is never presented as the activity period.

New comparisons keep the four current metric results (including the two trust checks),
exact denominators, and matching technical patterns aligned. Different timing boundaries
stay separate. A new comparison omits retired Cost even when its source reports include
it; compatible Accuracy, Speed and Trust values still compare independently. Frozen
source copies in that new comparison carry the explicit current projection marker,
while the source report identities/hashes and original files remain unchanged.
Reports containing Graph evidence are labeled in terms of recorded sites, returned
API entries or owned HTTP records, not silently converted into Work IQ calls.
Recorded outcome pairs lead, followed by measures with a value on either side.
Measures unavailable on both sides are named in a compact disclosure; opening it
shows their separate reasons, origins and exact coverage. A one-sided measured
value is never folded away as missing. New HTML/PDF/Markdown comparisons follow
the same value-first order; PDF includes the expanded missing-measure detail.

Matching uses saved technical metadata and versioned definitions, not private prompt similarity. New and absent patterns remain visible. An absent pattern is not a zero failure rate and does not mean an issue was fixed.

Different traffic proportions can change the overall percentage without any individual pattern changing. The comparison calls this out and preserves the matched rows. Repeated calls and updated records are disclosed; matching strings from unverified identifier namespaces do not establish overlap. There is no automatic causal claim about a fix or statistical significance.

Older reports remain readable. Supported frozen JSON can provide a read-only outcome comparison, but a readable-only legacy report cannot reconstruct complete membership from a chart or PDF. Missing definitions, incompatible versions or absent structured facts are explained rather than guessed.

If a measure exists on only one side, that side retains its value, coverage and origin label; the other side says **Not saved**, and no change is calculated. An older saved comparison that omitted this summary can restore its display from its own validated frozen source facts. The view labels that restoration; it does not reassess current activity, replace explicitly withheld values, recalculate the saved comparison, or rewrite any saved file.

To save a comparison, select its formats, review its disclosure, and confirm Save. The comparison keeps its own frozen results and projected source facts, bound to the exact source report IDs and hashes. It is self-contained.

## Deletion and retained copies

These actions have different meanings:

- **Discard draft / clear selection** clears unsaved work, not recorded activity or saved reports.
- **Delete collected activity** removes the approved activity scope and its unsaved derived data. Saved reports and comparison exports retain their reviewed copies.
- **Delete report** removes one logical saved bundle: its managed formats, manifest, embedded facts and recognized managed copies. It does not delete the source interaction, another report, or an external download.
- **Delete all saved reports** previews every saved report bundle across all pages,
  regardless of the current search. A bundle counts once, not once per format.
  The separate confirmation names the report/file/copy counts and retained
  comparisons. It excludes saved comparisons, collected activity, draft reports
  and external downloads. Unsaved comparisons using a deleted input report become
  invalid, including their preview and disclosure approval. Cancel does not delete anything.
- **Delete saved comparison** removes that comparison bundle, not either source report.

Deleting an original report does not silently delete a saved comparison that already contains frozen information from it. Confirmation discloses those retained comparisons. Their bytes remain unchanged; the live original-report link becomes unavailable.

Source deletion, permission revocation and deletion of a selected source report invalidate affected unsaved comparisons and approvals. A stale save cannot recreate a deleted artifact. Incomplete cleanup has a recoverable operation status; the UI checks that operation rather than blindly repeating a destructive request.

Bulk confirmation binds the exact membership and hashed managed inventory from its
two-minute preview. New reports saved after that preview are never swept in. Changed
members, copies, retention dependencies or deletion state require a fresh preview.
The batch reuses the saved-artifact ownership checks, recovery-index updates and
deletion tombstones in one guarded operation, not a directory purge or repeated
individual delete requests. Reports become unavailable together when the operation
is sealed, but file cleanup is **not** an all-or-nothing filesystem transaction.
An interruption can leave partial cleanup. The panel retains its recovery details.
Use **Check deletion result** (also available after panel reload); it reads the original
operation without resubmitting deletion. Runtime restart recovery finishes only
that sealed plan and refuses changed files. A receipt reporting no committed
operation permits a new deliberate preview, never an automatic retry.
