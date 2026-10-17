# Reports and comparisons in WIRE

**Current projection:** new reports keep report-envelope schema v3 and use the
independent metric projection **v4**. They contain recorded outcomes, source and
service facts, canonical membership and observed timing, not AI or personal
judgments, generated check recitals, unsupported-quality placeholders or attempt
recaps. There is no personal-feedback section or navigation. New comparisons use
compatible retained observations and timing, with explicit one-sided/unavailable results.
New presentation metadata is version 2 and has no assessment grading bands;
historical version-1 presentation definitions remain unchanged.

Saved reports/comparisons are not migrated. Their HTML, PDF, JSON, Markdown,
manifests, definitions and hashes stay unchanged; legacy JSON-only reading keeps
its original interpretation. The historical review terminology below remains a
reference for those saved formats, not a current scoring feature. Removing AI
review does not settle unknown billing or rewrite approval/receipt evidence.

WIRE describes your approved, recorded interactions. It does not require a synthetic benchmark or an expected-answer dataset, and it does not replay Work IQ or Graph requests.

## Report identity and saved originals

**Report title** belongs to Contents, or to the copy options for a saved-report
comparison. It accepts one line up to 200 input characters. A blank title uses a
factual scope/type name. Titles are always masked metadata, including when prompt
text is omitted or retained in original wording; manual masking terms still apply.
Changing a title requires a newly prepared copy and disclosure review. It does not
change selected interactions, period cohorts or file formats.

New schema-v3 snapshots, manifests and indexed artifacts carry the same `title`.
The library, inspector, reviewed page, saved result and generated files use that
identity. The title appears before bulk records in JSON. Older files are not
retitled: their indexed title is used when present, otherwise the interface combines
known type/scope and preparation metadata without presenting that fallback as an
original title.

Verified reads expose optional `canonicalTitle` only when the verified manifest
declares it and its indexed binding agrees. This applies to ordinary/comparison
file reads, ordinary document reads and `readSavedComparison()`'s facts result.
It is absent for undeclared titles; indexed labels and extracted document headings
are not substitutes. Declared JSON titles must also agree with their manifest.
Search consumes this carrier after its existing file checks, not a second title rule.

**View original** is separate from verified Open. It supports an indexed,
nondeleted ordinary legacy bundle in the `files/` layout with the supported
unanchored v3 manifest: no modern verification fields or reviewed timestamp,
strictly true legacy reviewer flags, a valid snapshot hash and exact per-file
`{bytes, sha256}` descriptors. These legacy flags do not establish historical
approval. False, malformed, partial or conflicting verification stays closed.

The explicit `POST /api/report-original` accepts only `{bundleId, kind, format}`.
Capability/origin checks, managed path/link/size checks, fatal UTF-8 decoding,
read-only board gates and a fresh indexed-identity check apply. The response is
`legacy-original` / `unverified`, with a current-read digest, never a historical
verification receipt. An explicit click is required before reading; there is no
Search fallback or automatic downgrade from broken verified files. HTML uses the
existing opaque, network-free sandbox; JSON/Markdown are literal text; PDF is only
an explicit download. Reads do not rewrite files, receipts or the index and cannot
make a legacy report eligible for comparison.

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
not only chart-matching calls. Activity shows the matching-call count separately
from full report counts. **Selected** keeps hidden selections; **All collected
activity** includes all sessions with retained reportable activity, regardless of
Analyze Dates, filters, search or pagination. It includes current and preserved
eligible evidence, not metadata-only sessions or complete original chats, and
does not fetch new activity. Distinct included session counts come from canonical
reportable interactions after the report's author choice; multiple interactions
and known aliases do not multiply a session. A known empty selection has zero
sessions; unavailable identities do not establish zero. Report author/privacy
rules, preview approval and frozen artifacts are unchanged. This is not the later
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
| Answer correctness | Passed reviews divided by passed plus failed reviews, with reviewed request coverage alongside. Personal feedback and AI reviews remain separate. |
| Speed | The named recorded timing boundary, such as median tool latency or time to HTTP response headers. Different boundaries are not blended. |
| Answer support | Evidence-supported answer reviews or explicitly labelled personal feedback. Citation presence alone does not establish support. |
| Tool use vs. request | A saved AI review of whether recorded tool use fit what was asked. It is not proof of permission, successful retrieval or task completion. |
| Permission for tool use | Personal feedback about permission, not the model's request-match review and not a permission grant. |
| Saved review (type not recorded) | Saved values whose check/version/origin cannot establish the review's meaning. Exact original identifiers remain available; their meaning is not guessed. |

Local observations alone do not judge semantic answer quality. Separately approved
model reviews can assess answer correctness, answer support and tool use vs. request from recorded
evidence, with model/rubric origin and exact interaction coverage. No result is
**No saved review**, not zero or tool-success rate. Insufficient evidence and reviewer
errors remain distinct. Optional personal feedback is not a required grading workflow.

Historical metric projection v2 omitted the original Cost metric, placeholder
and definition. V3 additionally excluded machine-generated review facts;
current v4 also excludes personal-rating lanes.
Supported older facts remain readable without alteration. Retained evaluator
spending and unknown-billing evidence is unchanged; omission never means zero
spending or improvement.

Current comparison headings and new HTML, PDF and Markdown use the shared
check/version/origin-aware wording resolver. Request matching and personal
permission are never merged because they share an internal dimension. Mixed
or unfamiliar old definitions retain their values, origin and coverage with an
explicit meaning gap. Reading or generating a new report does not rewrite any
previously saved file, JSON fact, model rubric or verdict.
Period comparison detail names the actual assessed or timed population and
distinguishes incomplete coverage from a reduction in coverage. An absent
comparison peer is a missing comparable review or measure, not a zero result.
Unknown saved warning IDs and unknown review definition IDs remain identifiable
in secondary detail.
If earlier and later review definitions differ, the retained check ID/version
is shown beside its own value. Matching model metadata can be shared, but an
earlier check version never labels the later result. Identical definitions
remain shared once; compatibility and deltas still come from unchanged facts.

Pass-share colors use versioned presentation bands: below 50%, 50% to below 75%, 75% to below 90%, and 90% to 100%. Exact counts and coverage are retained. Displayed percentages do not round across a color boundary. These bands are not a combined quality grade, statistical confidence, or a score for a person or team.

## Saving a report

The **Activity -> Contents -> Review & save** flow stays deliberate and empty-first.
Activity places Selected/Current/All membership above its interaction picker.
**Authors in report** sits beside **Find an interaction**, using the same shared
filter presentation as Analyze. Counts use the full canonical population across
all pages and distinguish included chats from interactions. One action area follows
the picker, with the included count, outside-page count when needed, Clear selection
and Continue. An outside-page count is not an outside-Analyze count; browsing never
changes membership. Detailed evidence units remain in Scope and exclusions.
Footer actions wrap according to their label widths, including nested Back/Clear
actions. Enlarged text may wrap between words, not into fragments; targets and
text are not shrunk to make controls share a row.
**Continue to contents** opens **Report
setup** in the same right sidebar used for interaction details. The Activity picker
stays visible and interactive beside it on desktop. Setup holds the existing prompt
modes, optional linked text, four formats and additional masking. Reports navigation
still opens the library.

Picker checkboxes only select; **View interaction** only inspects. Inspecting while
setup is open replaces that panel's content, not the picker or draft. **Back to report
setup** restores the same fields, reading position and focus. In Selected scope,
Add/Remove uses canonical membership and keeps hidden selections. Current/All and
paired-period peeks explain inclusion instead of offering a misleading membership
toggle; return to Activity (or Change comparison in Analyze) to change their scope.
Author exclusions still apply to all selected activity and optional context.
These Back actions are creation-specific. Inspecting an interaction from Search
while browsing the saved library keeps the existing Add/Continue to report actions.

The picker uses the same regular prompt and equal-weight fact conventions as the
interaction reader. Its prompt uses the paper surface and a restrained leading edge;
My/Agent labels and edges share their blue/purple cues, while unverified stays neutral.
View/Read targets occupy a separate utility column without inflating the author line;
narrow/enlarged prompts retain the full row width. Read expands the exact retained
text, including partial fragments, without reconstructing missing text. Optional facts
show Copilot Chat and qualified time when known. Exact tool names, supported service
cues and outcome pills share the Analyze/sidebar vocabulary, using full-interaction
canonical Work IQ rows, not only the calls matching the current Analyze filter.
Tools, services/purpose/gaps and recorded call outcomes occupy separate compact
rows, matching the interaction sidebar and Analyze cards. Metadata icons stay
within the text line box without extra blank spacing; real controls keep their
full targets. Compact identity groups show up to two tool names and two known
service names, with More tools / More services flowing within their own row using
the same separators and typography.
All outcome buckets and missing/partial-service qualifiers stay visible; inspection
retains complete identities. Known zero tool calls and unavailable counts remain
distinct, and neither implies missing non-tool activity. Missing optional metadata is omitted;
missing prompt text and unverified authors remain explicit.

Closing setup keeps its memory-only choices without a confirmation. Continue to
contents reopens it; picker search and pagination do not close it or clear selection.
The main continuation is absent while the setup flow owns its action area, including
a temporary interaction peek. Native Close exposes it again and restores focus;
an interrupted exit cannot hide or focus a newer owner. Closing Contents does not
add a report-draft Save/Discard gate. On narrow or enlarged
views the same sidebar is a modal overlay: use Back to activity or Close to reach the
picker, rather than interacting through the overlay.

Each stage has a local Back/next action area. Missing prerequisites appear there;
scope/exclusion detail is supporting information, not another gate. Optional
classification actions remain outside report creation. Reports has no analytical Reset.

Prepare report runs the existing local preview controller. Its loading/error state
and the actual prepared document occupy the main workspace, with the sidebar closed
for reading room. Review presents flat Report/Text/Files views. Text copies
and privacy findings stay available without nested comparison disclosures.
Selection and disclosure review are reading tasks, not clipboard utilities.
Their exact text remains selectable, without automatic Copy toolbars on prompts,
original/report pairs, code snippets or file contents. Intentional prompt/response
copying in the interaction reader is unchanged. Edit/omit belongs to the report
column. Scanner counters and byte totals remain in the manifest, not the review UI.
Both columns use regular screen typography and a restrained leading edge, not
gray text cards or the frozen document's separate font rules.
Files shows each exact filename once as its disclosure, without an additional
heading repeating the selected tab. Retained partial, unavailable and mandatory
credential-removal notices are not condensed away.
Create and Compare are library entry choices. Once a task is active, its header
offers Back to Reports rather than a competing task switch. Existing step/back,
disclosure, Save and uncertain-outcome recovery actions remain available.
**Approve for local saving** records disclosure; the text-only **Save report** is a
separate action in that same reading workspace, not a fourth page repeating scope.
Back to contents reopens setup and retains an unchanged prepared snapshot. Changing
membership, options or source authority invalidates that review as before; copy
edits/omissions require Rebuild preview and a fresh disclosure approval.

**Authors in report** is an explicit membership choice in Activity, separate from
No prompts / Masked / Original. It intersects the chosen Selected requests, Current view or All
collected activity base scope. My prompts excludes agent-originated and unverified interactions,
including their complete calls and optional context; select the unverified category explicitly to include it.
My + Agent is not All: All includes unverified authors. Human-origin groups keep calls executed
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
- New readable reports label attributable originating text **User prompt** or **Agent prompt**, using the same retained author evidence as the app's **My prompt** and **Agent prompt**. Known chat origin with an unverified author is **Copilot chat prompt**; genuinely unverified/non-chat origin remains **Prompt**. Compact app cards say **Author unverified** without repeating source explanations. This owner-facing vocabulary does not change report output or rewrite frozen artifacts. Captured question/query/filter fields are **Recorded tool argument**, not assumed to be human-authored. The prompt's author does not establish who initiated or authorized subsequent calls.
- New readable reports embed the approved WIRE mark, font and presentation rules. They do not fetch live styling or assets that could change their appearance later.
- Changes to selected evidence, relevant captured evidence, feedback or permission state can invalidate a draft. Unrelated activity does not change a report whose exact selected evidence remains unchanged.

Saved reports are immutable. A new assessment or a new visual design does not rewrite an existing HTML, PDF, JSON or Markdown file.

### Reading new reports critically

Human HTML, PDF and Markdown translate unavailable metric states through the
existing reason-specific formatter. For example, an unsupported local check
explains that tool outcomes cannot establish answer correctness; unverified
final-answer timing and insufficient saved evidence keep different explanations.
JSON retains the original reason codes and all frozen facts.

Each metric row names its recorded origin/model/rubric once, with passed/assessed
or timed/eligible counts beside the value. Different comparison origins stay
on their corresponding sides or in separate one-sided lanes; they are not
combined to shorten the report. Findings still carry their own provenance.
The default app/comparison formatter is unchanged; report tables explicitly
omit a repeated origin only when it is already present in the same row.

Period reports distinguish matching-call counts/timing from full-interaction
assessment coverage near the numbers. A higher pass percentage with fewer
assessed requests is a descriptive difference between subsets, not proof of
improvement. Existing precision, valid deltas, zero values and missing states
remain unchanged. There are no new sample-size thresholds or causal claims.

Normal report examples remain bounded. A link or reference to
`product-report.json` appears only when JSON was selected. Without it, the
report points to operation detail as an **aggregate summary**, not as the
missing full records. Prompt/context copies, exact matching-record tables,
source references and the coverage manifest remain the available evidence paths.
Repeated timing definitions live in the timing section, not again in quality
detail; this does not remove recorded limitations or create missing explanations.

Period scope is also described from the frozen selection in ordinary language.
Current retained, earlier-snapshot-only, and both-collection membership stay
distinct. Named service choices are OR alternatives; missing/unusable-detail
context is not a confirmed service match. A further “within every named service”
selection is an AND refinement applied afterward. With no service filter,
unknown-service records remain in the population rather than being described
as an extra expansion. Explicitly selecting **Service not shown** instead makes
that category's rows selected matches, even without optional missing-detail
context; it does not confirm a downstream service. The optional context choice
can add other gap-bearing records, and the within-every-service refinement still
applies afterward. The report retains raw keys and opaque references under
**Technical frozen filter details**, without resolving current source data.

Print grouping keeps short warnings and reading notes intact, chart headings
with their marks, and table introductions/headers with the first data row.
Tables can continue with repeated headers; long source copies can flow across
pages instead of reserving a blank area for a whole copy. No data-specific page
breaks, smaller fonts, page-count target, or warning deletion is used. Readability
proof renders every page of the bounded report set plus an oversized table/copy
control; page bounds alone are not evidence of coherent pagination.

### New native reports

New ordinary HTML, PDF and Markdown lead with the report's actual title, concise
scope/preparation metadata and evidence-backed distribution statements. **Activity**
shows exact nonempty evidence layers and tool/service breakdowns; **Timing**,
**Examples**, **Operations** and included **Report text** follow. Counts are no
longer buried in coverage. Empty prompt sections and repeated section destinations
are omitted. Coverage, definitions and technical identities have one supporting
location. Period reports use the same title-first shell, side-by-side A/B activity
and separate matching-call versus full-interaction timing. Saved-report comparisons
keep overlap, one-sided coverage and incompatible definitions without a repeated
subtitle stack. No new output revives retired assessment or personal-feedback lanes.
HTML disclosures are native keyboard controls.
PDF expands every disclosure and copy. JSON retains the factual snapshot rather
than an inferred narrative.

The summary names the most frequent supported service associations without
claiming that a bounded list contains every service. Targetless retrieval is Search
by tool purpose; the existing category definition retains that distinction. No
classifier or facts change.
When frozen service involvement is available, human output does not append the
different legacy category glossary or a contradictory tool-category warning.
Both definitions and their original data remain in JSON. Operation tables reserve
space for paths and scroll within the document on narrow screens. Printed period
record tables use the full page width rather than squeezing four columns into
half a sheet; text copies keep a restrained leading edge instead of form-like boxes.
Short complete prompt copies appear once, with their representative call sequence;
only longer or additional copies need the appendix. Each copy keeps author,
availability, representation and mandatory-removal qualifications. Long examples
remain bounded excerpts linked to complete copies, never truncated audit content.

Unavailable timing keeps each distinct boundary and timed/eligible count in a
concise note instead of repeating empty median/P95 cells. The nearest-rank method
paragraph appears only when timed samples exist; a measured zero remains a real
sample. Full definitions remain in machine-readable output. Current tool start-to-completion
displays use **Tool latency**; request-to-final-response and HTTP timing remain
distinct. Supported historical review formats retain their qualified interpretation.
API-status coverage, service-overlap methodology, scope and privacy explanations
each have one home. Full definitions, transformations and hashes remain in the
manifest; canonical JSON facts are unchanged. Print omits screen navigation
controls, not evidence or limitations. Ordinary
reports consolidate coverage into one account instead of repeatedly appending
caveats; there is no page cap or smaller type.

New native output embeds the existing licensed Asta Sans font and defines its
own neutral light/dark presentation, isolated from screen styles. Shared heading
roles, control/copy radii and semantic outcome capsules remain; failures are red.
Both theme wordmarks remain local. Bars use exact linear fractions from zero,
without minimum paint or perspective; shared service colors retain their
distinct meanings. No separate chart engine is added. Rounded tracks
do not alter count-derived widths, segment boundaries or zero/tiny values.
Counts/shares and exact tables are readable
without hover. A prepared report ignores narrower browsing filters: its complete
selected interactions own every denominator. Returned API units, Graph sites,
owned HTTP records and tool calls remain distinct.

New native breakdowns separate bars from their outcome pills, separate wrapped
pills, and keep a larger gap between adjacent rows. Spacing uses the existing
small/large tokens with text-scaled floors: half a rem for bar/pill and pill/pill
gaps, one rem between rows. At standard and 200% text this preserves visible
grouping without fixed spacing compressing enlarged text. Print uses a compact
0.65em row margin instead of inheriting the larger screen gap; this prevents a
short report's coverage from being pushed onto an almost-empty last page.
Font sizes, every body character and long-copy pagination are preserved.
These rules also apply to new period-report bar rows;
they do not change counts, bar proportions, Markdown/JSON facts or saved files.

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
Print uses the selected report's output palette. PDF generation embeds the
report's local fonts and their
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

### Creation consumer contract

`createReportJourney` is presentation-only: steps 1/2/3 are Activity/Contents/Review
& save. `beginScan` opens stage 3; only the controller's confirmed disclosure response
calls `reviewed()`, without moving the document. The separate Save transition owns
the local write. Contents alone is not an active review and does not defer reads.
No report persistence, schema, preview/review/export endpoint or permission contract changes.

The journey's `presentStep` callback supplies the existing Contents node and action
footer to the shared presentation host. These nodes are moved, not cloned or rebuilt;
inactive content remains mounted in a hidden parking host so existing field handlers
and IDs stay authoritative. The client keeps one report-owned setup return context,
containing only focus/scroll and the interaction-return intent. The shell has no report
selection, consent or receipt state. Transitions retain report-write and
disclosure guards; there is no personal-feedback departure gate. The setup
host owns its visibility during the exit glide: fields and footer stay painted
until it closes, then focus returns to the main journey unless newer user input
has already moved it.
`setContentsPresented` is an idempotent presentation notification, not a new stage
or permission state. It changes only the existing main continuation's visibility
and does not recurse into `presentStep`. Report-owned show/close/return transitions,
including the unchanged peek-close fast return, synchronize it from the actual
host/peek ownership. Selection, preparation, disclosure and save authority stay
with their existing controllers.
If setup replaces an interaction that is still exiting, the presenter first settles
that interaction's cleanup and native-history ownership. The new form must not
inherit an inert panel or a deferred cleanup that can erase its footer.
Browser Back from report creation restores the existing caller reading anchor before
focusing the returned interaction. Viewport/text adaptation retains its pre-reflow
position while ordinary main-workspace scrolling updates that position. Unchanged
accepted summaries are not repainted on Close; pending summaries still resume after
the exiting owner releases them.
Revisiting an already-opened setup remains possible after its last member is removed;
zero or unavailable membership still blocks preparation. Neither Close nor a field
change prepares, approves or saves anything. A pending/unknown dispatched save cannot
be cleared or called cancelled by panel navigation; only its original receipt settles it.

Ordinary reports and saved-report comparisons share one backend preview owner.
An admitted new Prepare invalidates only the other task's transient preview,
in-flight preparation generation and approval. Its selection/pair, formats and
copy edits remain. The late result of replaced preparation cannot restore review
authority. Reading a comparison, switching tasks or returning to an unchanged
preview does not invalidate its peer or prepare again.
Before invalidating anything, each Prepare checks the other controller's actual
dispatched/unconfirmed save state. The check runs at dispatch as well as in
button/rebuild availability, with a visible reason. Existing in-flight navigation
gates remain unchanged; the bridge adds no broad navigation lock, and read-only
return, verified saved Open and recovery remain available when those gates permit.
Only exact original-save recovery clears an unresolved-save preparation block.
Source/consent invalidation still owns revocation; peer preparation is not a new
permission grant or a reason to retain revoked text.

Prepared frames reuse the existing frozen-document sanitizer and restrictive CSP.
Only these frames permit `allow-same-origin`, so trusted parent code can measure
natural height and mirror text size; scripts, forms, popups, external resources and
top navigation remain blocked. Frame-bound observers disconnect on replacement,
invalidation and removal. Non-settling viewport-dependent layouts fail explicitly.
Borders are accounted for so a two-pixel internal scrollbar is not left behind.
Saved/Search/comparison readers keep the existing opaque `sandbox=""` default.

`createReportScope.resolve` supplies canonical requests, aliases, base membership,
author exclusions and full-interaction counts. `updateSelection` synchronizes this
with `createReportDraft`; private search stays browser-only and is represented to
report APIs by IDs, never query text. Pending/failed reads gate review/save without
discarding copies. Accepted reads compare selected source content and aliases,
base/included membership, author/options, time/date basis, source permissions,
retained evidence/deletion revisions and interaction mapping. Unrelated source/browsing
changes can keep verified approval; same-count identity swaps cannot. Permission
invalidations remain conservative. New v4 inputs contain no rating dependencies;
historical definitions are not rewritten. Backend validation is authoritative.
The catalogue's `responseTiming.sourceRevision` is transport freshness, not a
changed selected timing fact. Its revision alone does not revoke an unchanged
ordinary selection; timing identity, boundary, status, value, selected source and
review revisions remain in the fingerprint. Context retains its conservative
revision-bound invalidation.

Mounted picker checkboxes are synchronized from resolved Selected-base membership,
not just the explicit ID that was clicked. Removing an alias-expanded owner removes
its contributing selection aliases, while unrelated hidden selections, page and
focus remain. Analyze checkboxes retain their explicit-ID semantics. Both mounted
surfaces reconcile in place after accepted or rejected mutations, so a rejected
native toggle is restored without replacing the focused control.
The local `reportRequestSelection(id)` and
`setReportRequestSelected(id, checked)` helpers expose this same state and guarded
mutation for the coordinated reader action. `continueSelectedReport(id)` requires
that interaction in Selected membership, then explicitly opens Activity without
clearing text/format preferences, auto-adding activity or saving. Paired-period
membership cannot be changed through these ordinary-selection helpers.
Explicit Continue also reveals that interaction's canonical picker row: it keeps
a matching picker search or clears only a search that hides the target, selects
the existing page containing it, and focuses the checked row in view without
triggering a checkbox tooltip. The next action stays visible alongside the row
when both fit; enlarged/narrow views reveal the row without covering it with
sticky controls.
Author-excluded selected rows remain visible with their exclusion note, without
changing the author policy or accepted count. Ordinary library/draft visits retain
their paging; this named continuation intent alone overrides picker presentation.
Reader/Card Back keeps its original position and focus.

An export whose response is lost stays **Save not confirmed**. Its outcome is
separate from draft/context validity: later revisions still invalidate disclosure
and scrub contextual replies, but cannot turn a dispatched write into an unsaved
draft. **Check save status** reads current saved history for the original allocated
bundle ID for ordinary and period reports alike. It never scans, approves or
exports again. An unavailable/missing receipt stays unconfirmed; a verified
registered receipt opens the saved result and its frozen files. New preparation
and selection clearing stay blocked until that outcome is resolved. Late recovery
cannot replace a superseded journey.
Copy edit/omit controls are disabled and their handlers are guarded during a
dispatched write or unknown outcome, including copies mounted through pagination.
A dispatched save settles its matching bundle receipt independently of subsequent
draft-token invalidation. A confirmed write followed by an unavailable history
read still uses receipt-only recovery; it never becomes a fresh unsaved draft.

Only the transport's proven `request_rejected` disposition from the export request
itself establishes that no write was dispatched. That case allows Activity/clear and
a fresh scan/disclosure after current-state validation; it does not wait for a
nonexistent saved receipt. Arbitrary errors, HTTP 409s, lost responses and failures
after the export response (including saved-history reads) retain outcome recovery.

### Bounded recorded context

**Include linked requests and replies** is a separate, initially unchecked Contents
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
checking its manifest and exact file hash. If HTML was never declared, it reads a
declared JSON or Markdown file literally, or offers an explicit PDF download.
Declared but broken HTML never falls through to another format. The reader leads
with report identity and leaves any unfinished draft untouched; it never
regenerates the report from current activity. The sandboxed reader blocks external resources and
out-of-document links (including the companion JSON link); use the saved download
file selector and Download action for companion files. In-document section links remain usable. These reader
safety restrictions never modify saved bytes, including historical Cost content.

### Report a retained-period comparison

**Create comparison report** in Analyze takes the currently accepted paired view
directly to **Activity -> Contents -> Review & save**. It does not prepare or invent two
source reports. The action appears beside **What differs**, only after a current
comparison with matching records is accepted. Changing either date, waiting for
Search, or losing current evidence removes the action until the comparison is
ready again; one empty side is allowed, but two empty sides cannot create a report.
Activity names both inclusive local date ranges, the timezone and
each exact matching-record count using its validated evidence unit. Two read-only
Period A / Period B groups replace disabled scope and author forms; calendar dates
are formatted as civil dates, not shifted through UTC into the viewer's timezone.
Authors are a read-only value. Scope and author membership are fixed for this
draft: use the single **Change comparison in Analyze** action to change them. Ordinary report
scope/author choices are unchanged.

None / Masked / Original, manual terms, copy edits and omission remain independent
disclosure choices. Optional bounded recorded context uses the comparison's
frozen author policy, including explicit unverified-author inclusion where chosen.
It cannot enlarge either measured cohort. Activity and the actual report distinguish supporting
copy groups from analytical membership. Unmapped interactions and unavailable
context remain gaps, not reconstructed evidence.

The initial `/api/preview` input supplies `periodComparison` instead of
`selection`/`scenarioIds`; mixing them is rejected. The controller compares every
field against `buildPeriodComparison` at the expected accepted stored revision
before reading optional contextual copies. Only validated per-side pooled
`assessment.metrics[].createdAt` preparation instants differ between successive
read-model builds; these are not source-event times. All canonical identities,
bases, definitions, raw samples, outcomes, coverage, observed-time evidence and
comparison results must match. Frozen metrics retain the accepted preparation
instants and withhold raw source times using the existing report projection.

When live semantic search supplies the selection, the request also carries
`semanticSelection: { receipt, withinScenarioIds? }`. The existing search owner resolves that exact
receipt inside the accepted state gate, once at initial preview. Caller-supplied
hit arrays never authorize export. An interaction hit includes its matching
records; an action hit includes only that canonical layer record, not all calls
in its parent. Broader parent identities are used only for the existing returned
API parent-coverage population. Pending, partial, stale or non-whole-corpus
selection cannot prepare a paired report. No query text or operational receipt is
frozen. Clearing or browsing search after a legitimate preview does not itself
revoke that prepared report.

Optional `withinScenarioIds` retains a simultaneous legacy interaction phrase
filter as an explicit intersection. Its IDs must be unique and present in the
accepted complete roster; they can only narrow receipt-authorized hits and
broader API parents. Omission means no added narrowing, while `[]` means empty.
The saved shape uses `selection.withinScenarioRefs` and names this extra scope
without disclosing the phrase. The same qualifier must accompany initial report
admission; it is not reread from the search UI during Review or Save.

New schema-v3 **report** artifacts optionally carry
`periodComparison: { kind: "retained-period-report", schemaVersion: 1, ... }`
and the identical hash-bound field in the manifest. This closed shape contains
the accepted revision, safe source availability/revision, time/definition bases,
projected filter/author selection, and exact per-side keyed rows and scenario
associations. Each side separately freezes existing validated full-interaction
evaluation facts, review statuses, raw timing samples, original per-check
eligible/covered identities and unavailable lanes. Exact outcome and metric
comparisons are derived by `comparePeriodCohorts`, not a second delta engine.
No synthetic bundle IDs, `sourceReports` or union `evaluationFacts` are added.
`records[]` contains permitted supporting copies with empty analytical arrays;
the per-side rows, not these copies, own matching-record denominators.
The ordinary single-range `dateSelection`/`dateRange` envelope is absent for this
subtype; only the two explicit frozen period bounds describe its date scope.
Returned-entry reports also retain keyed eligible parent-call/result/status
identities and recomputed broader API coverage, separately from selected rows.

HTML/PDF/Markdown lead with supported differences, exact two-side counts and
timing, then explicitly labelled full-interaction findings, context and definitions.
They reuse native/shared typography and paint; PDF is generated from the supported
light document with the existing offline embedded-font reader contract.
JSON freezes the same facts, not a regenerated screen. Incompatible or absent
lanes withhold deltas, overlap is explicit, and no causal improvement or blended
grade is inferred.

Relevant source, permission, selected evidence, assessment, author or contextual
changes invalidate preparation/approval. Unrelated accepted updates preserve
valid prepared work. Review and final Save remain separate; a lost save response
offers **Check save status**, a read-only lookup of the already allocated report
ID, never a replay of Save. One registered artifact is safely reopenable,
downloadable, searchable in all four formats and deletable through existing
verified inventory handling. It is labelled **Period comparison report** and
cannot be treated as a single source in the ordinary saved-report comparison:
`period-report-has-two-cohorts-not-one-source`. Old reports and saved comparisons
remain readable and byte-for-byte unchanged.

Paired draft authority is tracked separately from its disclosure-copy basis:
changing bounded context or None / Masked / Original revokes the relevant preview,
not the accepted comparison. A new preview still requires actual review.
Broader returned-API parent coverage has a separate private dependency signature
over the fixed eligible parents and their canonical returned-result/status
evidence. The producer's shared parent-selection helper is reused at preview
completion, Review and Save. Changed parents reject the prepared report without
adding parent-only interactions to measured rows, metrics or supporting copies;
new unrelated interactions do not invalidate unchanged frozen parent evidence.

Focused proof: `tests/period-report.test.mjs`,
`tests/period-report-semantic.test.mjs`, and
`tests/period-report.browser.test.mjs`. The browser proof uses invented ephemeral
stores and the normal UI through registered reopen, including lost-response
recovery, strict PDF font/text/page checks and narrow 200% output. Optional
`WIRE_PERIOD_REPORT_PROOFS` keeps private output artifacts outside the repository.

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
That combination is **My prompt** in the app, not an assertion that a named person was authenticated.
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
a report** to enter **Activity -> Contents -> Review & save**, or **Continue draft** to return
to unfinished choices and review. **Back to Reports** switches back without clearing
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

Rows prioritize actual title, known scope and interaction count, preparation time and Open.
Prompt mode and format availability remain compact secondary metadata.
Selecting a row opens its safe indexed metadata in the shared right sidebar:
known scope/count, preparation time, prompt mode and timezone. The inspector
offers Open and the existing named Delete action, not another file-management
toolbar or locale setting. Downloads belong to the opened report or completed
Save result. Technical identifiers remain in saved metadata, not the
reading lead. Selection never reads the full file, downloads or deletes.
The independent row **Open** bypasses inspection. Preparation order can be newest
or oldest first; unknown dates remain last. The current search, page and order stay
in place while inspecting.
The outer library is not collapsible. Open also supports declared JSON/Markdown,
or a PDF-only state requiring an explicit download. Missing metadata is never
inferred from current activity. Registered filenames remain declarations when
optional legacy format metadata is absent; registered or format-declared HTML
always wins, and a broken declaration never falls through. Downloads still require
the complete registered format inventory; an incomplete old record is readable
without exposing a download that cannot pass those checks. A labelled **Saved file** selector and one
**Download** action keep file access secondary to the report; the manifest is last,
not the default when a report representation exists. Compare and Delete
are separate text actions; Delete retains its existing named confirmation and
original-operation receipt recovery.

A completed comparison's Open action follows authoritative saved inventory.
Deleting that comparison shows an unavailable result without erasing its unchanged
source-pair choices. Failed reads do not imply deletion, and pending/unconfirmed
Save recovery remains bound to its original dispatched identity.
A matching Save receipt settles the write, not current availability. A successful
post-save inventory that omits the comparison cannot be overwritten by that older
receipt. Failed refreshes retain recovery; cached or pre-save choices are never
used as evidence that the newly saved comparison was deleted.

The saved reader occupies the full-width Reports main workspace, with the
contextual pane closed and focus on its heading. It keeps the old opaque sandbox,
a short preparation caption and **Back to report library**, restoring the list's
search/page/order/focus and its inspector only when one was open. Direct row Open
does not create an inspector on return. Opening from the completed Save result
still returns to the library, without discarding another in-memory draft.
This applies to ordinary reports and saved comparisons: no saved HTML is
regenerated or restyled, including historical typography and missing facts.
Unavailable files and unknown metadata remain explicit; supported unanchored
legacy originals require the separate action described above. **About saved reports** holds the search/privacy
boundary. The single **Refresh** retains its existing source and draft/review
guards; read-only **Retry** appears only when recovery is needed.

`POST /api/artifact-file` accepts only `{bundleId, kind, format}`, with `kind`
`report` or `comparison` and `format` `html`, `pdf`, `json`, `markdown` or
`manifest`. There is no caller-supplied path or filename. The read-only board
gate calls `readSavedArtifactFile`; `readSavedComparisonFile` is the comparison
consumer adapter. The result identifies the artifact, format, filename, media
type, file SHA-256, registered manifest hash and index fingerprint alongside the
exact bytes (base64 over HTTP). Registered ownership, independent disclosure,
closed index/manifest inventory, manifest hash and file hash/length must agree.
Manifest downloads return the original hash-checked manifest itself.

The library no longer uses the legacy `/api/report-file` download path. Corrupt,
unregistered, missing or unverified legacy files produce an explicit error, never
a regenerated copy or automatic alternate-format fallback. A source-reply
permission change does not revoke an independently permitted saved file; removing
that saved artifact does. Pending reader responses cannot replace a newer reader.

Preparation time is not the activity period. Reports appear newest-prepared first;
exact timestamp ties use newest registration first. Unknown dates follow in original
registration order, without guessing from private contents or file modification times.
Identical summaries include the ID; every inspector retains its full ID.

`#reports?inspect=<bundleId>` and `#reports?bundle=<bundleId>` identify indexed
inspection and frozen reading; `#report?bundle=<bundleId>` is compatible. Invalid
identities are removed. Private search text, files, consent and receipts never
enter URLs. Same-tab Back/Forward restores owned origins; direct/reloaded entries
without a surviving origin return safely to Reports. The native Navigation API,
where available, traverses the known parent entry rather than an opaque frame's
section-link history; older hosts replace with the sanitized origin.

Search uses the same main reader through a presentation callback, not the library's
read authority. Its current receipt, source, panel, sequence and visibility checks
still fence the verified result. Invalidation clears the document and its actions;
reload or Forward without a current Search payload offers reopening Search, never
an automatic library-read fallback. An independently permitted library copy remains
readable after live-source/capture changes. Late reads/downloads cannot paint or act
for a different inspector/reader.
Opening a Search document from an interaction still requires its current verified
payload, including exact-call entries. There is no personal-feedback departure
gate. Changing Search or revoking access invalidates the payload without borrowing
library permission. Back retains the
sanitized interaction/call origin and restores Search focus only while its return
marker remains valid, including hosts without the Navigation API.

Saving returns the current history search to its first page without clearing its query or other filters. Background refreshes preserve the history page and disclosures. Deleting the displayed saved report replaces its ready message and downloads with an unavailable state, including when another tab's deletion is observed. Unrelated deletions leave newer saved results and unfinished report drafts intact.

## Comparing two reports

Choose an earlier report and a later report explicitly. Reading the comparison does not create an export or run an assessment against the APIs again.
Choices lead with preparation date and time, followed by saved interaction counts and prompt mode,
not a long report ID. Formats and the full ID remain available as secondary
option text and the shared saved-item inspector. Inspect earlier/later report
does not select, swap or complete a pair. Comparing facts and preparing the actual
copy close that contextual pane and keep the chooser, compatibility explanations,
wide results and separate disclosure/Save in main. Sidebar Close is not Discard
comparison. Unknown metadata stays unknown;
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
the same value-first order and shared scope/overlap/matched-pattern coverage notes.
The PDF and ordinary browser print both include unopened missing-measure details.
New comparison print styles keep a short reading-note paragraph intact when it
fits and keep a disclosure summary, table caption and column headings with the
first data row. Oversized metric tables still continue naturally with repeated
column headings; there is no whole-table keep rule, data-specific page break,
text removal or font/page-size reduction. These rules are scoped to the saved
comparison document, independently of native normal/period report pagination.
Proof inventories follow the parsed PDF page count, not stale images from an
earlier run, and cover every actual page of the unchanged seven-pair comparison.
The app comparison supports its current light/dark theme. Newly generated frozen
HTML explicitly uses light (not an implicit dark-mode feature); PDFs use that same
light source. Manually changing a frozen HTML theme attribute is not an app route
or supported saved-file theme setting. Current marks consume the shared orange
failed-call fades, with exact proportions and readable counts unchanged.

Matching uses saved technical metadata and versioned definitions, not private prompt similarity. New and absent patterns remain visible. An absent pattern is not a zero failure rate and does not mean an issue was fixed.

Different traffic proportions can change the overall percentage without any individual pattern changing. The comparison calls this out and preserves the matched rows. Repeated calls and updated records are disclosed; matching strings from unverified identifier namespaces do not establish overlap. There is no automatic causal claim about a fix or statistical significance.

Older reports remain readable. Supported frozen JSON can provide a read-only outcome comparison, but a readable-only legacy report cannot reconstruct complete membership from a chart or PDF. Missing definitions, incompatible versions or absent structured facts are explained rather than guessed.

If a measure exists on only one side, that side retains its value, coverage and origin label; the other side says **Not saved**, and no change is calculated. The existing structured comparison API can restore an omitted legacy display summary from validated frozen source facts and labels that compatibility display. Library **Open** does not use that reconstruction: it reads the original saved file, including any **Not preserved** result. Neither path reassesses current activity, replaces explicitly withheld values, recalculates the saved comparison or rewrites saved files.

**Compare saved reports** in the Reports header opens the dedicated
`task=compare` workspace. Earlier/Later are explicit saved choices, not an
automatic pair. Library, creation and comparison stay separate; Back preserves
the exact task and saved-source inspector. Opening a source says **Back to
comparison** when that is its actual origin. An unchanged task return reuses
the existing choices/frame/approval without another artifact read.

To save a comparison, select its files and **Prepare comparison copy**.
The prepared workspace has flat **Report** and **Files** views: read the formatted
copy or inspect each exact file without an outer file-disclosure gate. The PDF
stays in memory until Save. **Back to comparison choices** retains an unchanged
preview; **Return to review** neither prepares it again nor records approval.
Changed choices require a fresh preview. **Approve for local saving** records
disclosure; **Save comparison** remains a separate action.
The saved comparison keeps its own frozen results and projected source facts,
bound to the exact source report IDs and hashes. It is self-contained. If the Save
response is lost, **Read saved comparisons** checks the library without repeating
Save or manufacturing a new disclosure approval.
The draft keeps the dispatched comparison's exact identity separately from its
current source choices. A missing, malformed or mismatched save receipt remains
unconfirmed. Changing the pair, formats, discarding or preparing another copy
cannot replace that pending save, even if a source report disappears. Reading
saved copies and returning remain available. Recovery accepts only the original
comparison ID and artifact kind; an absent entry is not proof that no write
occurred. Source refreshes and late reads cannot discard the unresolved result.

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
