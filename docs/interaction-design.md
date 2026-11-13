# Interaction design

Use this reference when changing a screen's controls, reading order or return
behavior. [Product design](design.md) owns shared typography, surfaces, targets
and motion. For user instructions, use [Use WIRE](user-guide.md) or
[Create and compare reports](reporting.md).

| Surface | Behavior |
| --- | --- |
| [Navigation](#navigation-and-return) | Accepted destinations, loading and return state |
| [Analyze](#analyze-and-filters) | Filters, scope and chart reading |
| [Trends](#trends) | Chart-first daily patterns, sizing and exact supporting evidence |
| [Interaction reader](#interaction-cards-and-reading) | Cards, call results, disclosures, Copy and selection |
| [Search](#search) | Typed results, excerpts and exact Open |
| [Reports](#reports) | Choices, prepared copies, saving and saved reading |
| [Compare periods](#compare-periods) | Accepted ranges, refinements and chart actions |
| [Settings](#settings-collection-and-consequential-actions) | Setting search, account presentation and consequential actions |

## Navigation and return

Keep existing route, reading-position and focus owners. A return restores the
actual origin only while its authority and reading intent remain current.
Later user input wins over delayed navigation, reads and motion callbacks.
Pointer presses must not trigger older scroll restoration that moves the
targeted control before release.
Private Search state never becomes a copied public URL or a broader fallback.
Peer destinations have no fabricated Analyze / Reports breadcrumb. Subordinate
reading keeps one return to its actual origin. Entering Compare opens it rather
than toggling it off; Analyze and Compare retain independent accepted scopes.
When a destination needs a new stored read, select it and show its loading
state immediately. Do not present the old charts as its accepted population.
Failed reads restore the accepted origin; later navigation wins over held reads.

The [runtime-access contract](runtime-access.md#client-publication-and-withdrawal)
defines when pending reads and return state lose permission to publish.

## Analyze and filters

Lead with accepted recorded outcomes and activity patterns. The outcome ring
and right-side legend share a row when the widget has sufficient width; small
layouts stack without squeezing values. Model, tool and service widgets use
content-sized layout, not equal-height filler or hidden rows for symmetry.

Prompt authors is a compact, noninteractive breakdown of canonical originating
interactions across the complete accepted slice, before paging. My prompts,
Agent prompts and Author unverified use the shared author vocabulary and screen
colors; all three remain visible when the population is nonempty, including
known zeros. Its visible denominator names interactions rather than calls.
Incompatible Microsoft 365 conversations stay separately unavailable. Exact
counts and provenance definitions live in Chart guide, not another drilldown.

Filters opens one panel with the existing controls, applied chips and separate
View group. Fields/labels wrap; accepting a restriction must not move focus.

| Control or action | Effect |
| --- | --- |
| Dates | Governs the complete analytical slice; no second widget date picker |
| Over time, By category, By path or operation | Regroup that same slice |
| Outcome/Author | Draft until Apply; Cancel/Escape/outside dismissal preserves accepted selection |
| Applied chip | Settled removal action |
| Inline cancellation | Only a first pending restriction without an applied chip |
| Reset filters | Stays beside restrictions; preserves report selection, data and preferences |

The count, scope caption, charts, rows and current-view report membership use
one accepted population. Pending or failed ordinary reads retain its prior
scope rather than relabel it with requested filters. Partial/unbound analytical
Search withholds measures instead of inventing zeros. Access withdrawal clears
private results rather than keeping stale content visible.

Calendar presets and custom dates use the selected IANA zone. Custom dates
are inclusive civil days; buckets are clipped to that scope. Undated records
stay explicit. Missing history cannot be assigned to the current filtered
slice from source-wide diagnostics.

Prepare chat-name/reference lookups once for the current render, including the
full source roster. Keep every option, exact name and shortest distinguishing
ID suffix. Reuse that lookup only within the render; do not retain private
catalogs across source updates or access withdrawal.

### Chart guide

The Chart guide has one stable reading panel and exact-data destination.
Definitions and table counts use the same accepted facts. A row finder filters
only table labels, not analytical membership or totals. Overflow remains
local, keyboard/touch accessible and truthful; do not shrink type or hide data.
Use the shared [chart encodings](design.md#chart-reading) for those facts.

## Trends

Trends is a peer destination, not another Analyze widget. Opening it immediately
shows the chosen period's charts, not a marketplace or a supported-change gate.
Tool usage is dominant, with period totals and per-tool percentages/counts in
its left column. A compact side column holds the exclusive prompt-author
composition and daily call activity. Services, errors, models and duration
support them below. Empty Today does not discard useful earlier data or turn
the screen into unavailable rows. Unknown and incomplete evidence stays explicit.
Use the full workspace at wide CSS viewports without scaling text. Supporting
columns flow independently instead of leaving empty rows beneath shorter charts.
The date-range button shows the accepted dates beside the presets and opens
the existing calendar. Today is labeled as still in progress, not as a history gap.

Maximize uses the same chart and shared controls, with a selected-date breakdown
and exact evidence. Back to overview restores the activating control and reading
position. Collapse/expand and Collapse all/Restore all preserve each chart's
measure, series choices and date reading. Filters and dates remain available
while maximized. Do not introduce a generic chart builder or a new analytics layer.

Keep the 7/14/30/custom date family, defaulting to seven days. Every civil day
remains separate in the selected IANA zone. Every daily axis label remains
visible in its scrollable plot, including all 30 dates in a 30-day range.
Use month and day for past dates, Today for the current day and an exact date
in hover. Measured label widths set minimum day spacing at a stable screen
font size; maximization never magnifies SVG text. New ranges open at their
latest dates; measure/size changes preserve horizontal reading position.
Gap days keep labels without invented bars. Long ranges still page at 90 days
after establishing complete membership, without a new range limit.
Date filtering never approves collection.

Use prominent period counts, appropriate percentages with supporting counts and
one measure label. Avoid repeated source captions, explanatory subtitles and
prose narrating values already drawn. Keep necessary coverage qualifications;
definitions belong in Chart guide. Differences in shares are percentage points.
History warnings describe the saved-chat read/import problem using retained
coverage facts. Those facts cover the source, not a particular analytical
period: explicitly say when the affected dates are unknown. Do not equate an
unreadable file, an unfinished import or missing prompt links with a failed call.
Selected-date bars use the same measure and zero-based scale as the chart:
reach is not call share, and count views use the count axis rather than percent
widths. Hiding series does not rescale that axis.

Population filters require Apply; Cancel preserves the accepted scope.
Series visibility does not change membership, rates or exact-data tables.
Keep controls mounted, plot geometry and scroll anchors stable, and reserve the
selected-date area's established height during same-view changes. No refocus or
page jump after toggling a series. Daily marks have deliberate spacing; scroll
the plot rather than shrinking labels, smoothing values or combining days.
Measure selectors reserve their longest option's intrinsic width. Responsive
layout updates settle the selected-date geometry before the next interaction;
unchanged parent renders do not remount a chart or dismiss its hover value.
Chart type scales with text size, and long recorded names wrap without truncation
in legends, selected values and hover cards.

Hover/focus belongs to a bar segment or nearby line sample,
not a full-column invisible target. Use one compact, hoverable, dismissible card.
Use plain solid lines and bars, with stable labeled colors. A hovered legend
or sample can emphasize its series; it does not select or filter evidence.
Tool reach pairs interactions with call counts; service/model cards preserve
overlap; errors separate tool failures and result signals; timing names available
samples. Blank space cannot activate another mark. Escape, departure, scrolling,
view changes and access withdrawal retire hover content. Keyboard arrows inspect
dates/series; Enter and touch/click select the exact dated series for evidence.

The selected subject and current measure remain visible above the date breakdown.
View evidence uses that mark's exact supporting call identities, not the union
of other shown series. Hiding its series preserves this selection and labels it
hidden; changing measures preserves the series/date under the newly named measure.
Before a mark is selected, the scope is explicitly the shown series for the day.
The evidence dialog separates matching calls from the full interaction opened
in the existing reader. Wider parent context does not expand the chart measure.
Leaving or returning preserves only currently authorized state. Late responses
cannot republish withdrawn data.

## Interaction cards and reading

### Cards

Cards show author/origin, an authorized prompt excerpt, services/operations,
recorded problems/results, then quiet time/count metadata. Prompts use up to
two actual line boxes, not an arbitrary character cap. Read more appears only
on real overflow; it opens the reader at the prompt's top. Other valid reader
returns can retain their prior position.
The reader offers a longer exact preview, not a second summary.

A card is one native link without nested Copy, checkbox or duplicate Open
controls. Report-picker checkboxes remain separate. Native modified-click and
text selection keep their established behavior.

### Call results

Failure presentation keeps three boundaries:

- Each call owns its reasons and stable full-interaction ordinal. Matching prose
  does not merge different calls. Card explanations name the recorded tool and
  normalized requested paths when available; these are not proof of downstream
  API execution or a mapping between batch targets and returned entries.
- Equivalent complete returned diagnostics within one call may share a reason
  only if all original entry identities remain. Missing/redacted/ambiguous facts
  cannot qualify that grouping.
- Cards and readers show all supported reasons under their call, without a
  first-N cap, "one more reason" disclosure or extra failure page. Keep the
  distinguishing middle of a retained diagnostic, not just its beginning and end.

A retained code does not hide a privacy, size or format gap in the rest of the
diagnostic. Source-absent details and details WIRE did not retain stay distinct.
The reader explains completed calls through their recorded completion evidence,
without claiming the answer was correct or the overall task succeeded.

When a terse error needs context, the same **WIRE interpretation** appears beside
its recorded reason on the card and reader, and travels in newly prepared reports.
It explains the supported mechanism and remaining unknowns without replacing the
code, status or full diagnostic. Opening exact evidence keeps that interpretation
visible. A clear source explanation needs no duplicate glossary paragraph.
WIRE interpretations do not generate next checks, troubleshooting or remediation
advice, or messages for product teams. Timeout explanations do not infer a
downstream cause.

Exact input/provenance disclosure is a separate action. Partial-response
coverage is separate from failure reasons and matching-call counts.

### Reader disclosures

The reader's order follows the user's question:

1. Selected prompt: what was requested.
2. Recorded activity: calls and their own results, timing and errors.
3. Available Copilot reply.
4. Source details.

A quiet date/time line beneath the selected prompt matches its card's recorded
time and display zone. Any first-action fallback stays explicitly labeled.

Selected prompts exceeding six rendered lines start with those six lines visible.
This keeps a useful exact excerpt above the recorded activity without a nested
scroll area. Short prompts have no toggle. **Show full prompt** reveals all retained
text; **Show less** is available above and below the expanded text and returns to
the prompt's beginning. Width/font changes recheck actual overflow. The choice
belongs to that interaction's in-memory reading state, never its stored evidence.
Search opens the full selected prompt so the preview cannot hide matching text.
Authorship, exact Copy and report text are unchanged.

Build exact call arguments only while their disclosure is open; clear them
when it closes. Returned entries keep their own path/status/identity, never
a sibling's input or inferred parent cause.

Linked context stays in its existing separate disclosure. It cannot transfer
intent or outcomes between interactions.

Tool latency and qualified prompt-to-final-response timing stay beside their
subjects. Display milliseconds first, preserve zero/precision, and do not sum
concurrent calls or infer a missing end timestamp. Model provenance remains
interaction-scoped. An automatic continuation with no new message is distinct
from an unavailable prompt, and its author remains independently qualified.

### Copy and selection

Prompt/response Copy uses the exact authorized original, not the excerpt,
metadata or report copy. Its icon and accessible name identify the subject and
unmasked text. Pending/success feedback replaces the existing glyph without a
new line or layout shift. Failure remains explicit with manual-copy guidance.
No Clipboard read is required.

The fixed reader footer owns Add/Remove and Continue to report. Reading does
not select or save. Broader report scopes explain membership instead
of silently switching to Selected.

### Reader size

Reader width/maximize controls belong only to interaction reading. They preserve
the current visible text anchor and mounted disclosure/focus owners; report
creation and saved inspection do not inherit them. Narrow modal focus remains
independent of the navigation drawer.

## Search

Use one stationary rounded capsule with results as the user types.
There is no Submit or expanded Search mode.
Scope and type choices stay together beneath it. Clear belongs to the field;
Escape/outside dismissal does not silently clear the query.

Results group the complete authorized population by type before selecting a
20-item page. Categories follow their first ranked match and keep server order
within each category; this changes presentation order, not membership or receipts.
Original titles and actual matching excerpts/source labels identify each hit;
omit equivalent unmatched captions, never a matched field or distinct record.
Missing fields create no blank slots. Body-only matches must show the matching
body, not an unrelated opening
paragraph. Match ranges come from the server and use inert text nodes,
preserving original graphemes and full visible matches.

Title, excerpt and source wrap independently; no clamp hides the actual match.
Use original ranges and a single boundary ellipsis where text is omitted.
Formats provide disambiguation, not invented metadata.

Category/service/outcome cues and original text keep separate roles. Whole-row
Open and category/paging controls use the existing behavior. Partial coverage,
no match, failure and unavailable content stay distinct. The
[matching and lifecycle contract](live-search.md) defines query behavior and
result authority.

## Reports

### Landing and saved list

Reports is one workspace: report choices first, saved reports directly below.
There is no separate Create report navigation entry. Choosing a tile or a saved
name replaces the landing with full-area reading. Reports-origin reading has one
Back to Reports action; context-qualified entries retain their own origin.

The landing has five compact, equal-sized full-width tile rows: All activity,
Errors & failures, Completed calls, My prompts and Agent prompts. Compare periods
has its own primary destination. The report period is visible, defaults to
Last 7 days, and offers 14/30/custom choices. Custom dates opens its calendar
directly. A fresh report ignores old Analyze restrictions.
Selected and Current remain available through inclusion
controls and their original context-qualified entries.

Saved rows align Report, Report text and Actions. The name and its leading document
icon open in-app reading. Preparation time is a secondary line under the name,
not part of a generated title. Known saved periods appear there separately.
A single list note identifies missing period metadata instead of repeating
"Not recorded" in a mostly empty column. It does not infer a period from preparation time.
Files, Inspect details and Delete stay together as visible, labeled row actions.
A padded title target owns its hover and keyboard-focus background. Keep the
text-treatment icon and its explanation in their own column. This secondary,
regular-weight text stays visible and readable without hovering; it makes no
anonymization guarantee, and missing metadata is not inferred.
Delete uses a quiet text treatment; its confirmation retains the destructive action.
The header menu preserves bulk deletion with its existing confirmation.
Inspection alone does not read, download or delete a file.
Every report choice has accessible help. Saved-report paging follows the rows
in visual and keyboard order. Privacy and file actions keep their separate
meaning. Rows share column widths; narrow layouts stack identity/dates, text
treatment and actions without shortening their contents.

### Returning to an unfinished report

Back restores saved search, order, paging, scroll and activating control.
It preserves the authorized unfinished copy without another visible resume
entry: choosing the same type with unchanged dates resumes that copy.
An unresolved Save remains visible and uses its original recovery owner.

### Preparation and reading

Choosing a tile prepares the report and shows pending feedback until it is ready.
A compact toolbar owns its name, period, personal-detail choice and formats,
with Save beside the name.
The name updates the document heading without remounting its input. Optional
changes regenerate files; Save stays unavailable while the preview is stale.
The report surface and border complement the current screen theme without
changing frozen output. Example notes and copy edits stay beside their evidence.
Report view uses a contained reading pane with persistent section links,
collapsible sections and individual interaction disclosures. All evidence stays
reachable; a pattern link opens its exact interaction. Keep only scope and dates
at the top. Older layouts' companion charts belong inside their section's
disclosure, not below a closed marker. Keep other metadata under Report details
in Coverage. Recorded failure/success/partial words retain their semantic colors.

Use explicit nearby help icons only for meaningful limits: mixed errors,
completed calls versus task success, masking and file formats. Card hover and
the period control do not open help. Labels and focus outlines have sufficient
shared spacing at enlarged text sizes. Keep Asta Sans, official Lucide geometry
and the existing navigation owners.

### Formats

Save as chooses output files. View chooses Report or an actual format preview,
with PDF pages, a JSON tree or HTML/Markdown Preview/Source. Returning from a file
to the same authorized HTML report keeps its open sections and reading position.
JSON-only saves can render a readable page from their verified frozen snapshot.
File modes use one compact segmented icon control, with a distinct selected
surface and named Preview/Tree/Source actions on hover and keyboard focus.
Report, file and optional Report text views share the reading space. Text
inspection shows the included copy first; Local original switches to its retained
source without adding that source to exports. Editing replaces the displayed copy
with its editor, rather than showing the same long text twice.
Content regeneration retains the selected file/mode and the inspected copy.

Transient menus, selects and Search dismiss when focus enters an embedded
document, including an opaque saved file. The shell observes frame focus, not
document contents. Modal and consent dialogs retain their own close rules.
Report date presets close their chooser when accepted; Cancel leaves custom
dates unchanged. Leaving the workspace closes its remaining option panels.

### Privacy and Save

Hide personal details and HTML are defaults. Errors & failures visibly includes
retained masked error details. Notes are authored context, never recorded facts.
Keep chat details invokes one warning at Save, with equal-sized Hide details
and save / Save with chat details actions. Go back has a small arrow and safe
initial focus. Hide-and-save must regenerate real masked bytes before writing.
New saves do not claim a human text review.

### Saved reading

Saved reading uses actual files, a clear title/format toolbar and one Download
action. The [frozen-file contract](report-contract.md#frozen-files-and-saved-reading)
defines verification and safe format viewers.
Long titles and enlarged text can extend the page; the document keeps its
reading area while the header scrolls above it.
Departure/withdrawal retires text, pixels, workers and pending reads.
Prepared measurement privileges do not transfer to saved HTML.
Report reading selects the approved WIRE wordmark variant for its own theme,
including older implicit themes and single-variant headers. This presentation
change is limited to the known WIRE header; original file views and downloads
retain their saved artwork.

The [reporting guide](reporting.md) explains the user workflow; for
membership, frozen facts and privacy, use the [report contract](report-contract.md).
Screen paint changes do not restyle saved documents.

## Compare periods

Fresh entry opens Outcomes for all eligible retained activity, without importing
Analyze filters. Seven complete civil days ending yesterday are compared with
the preceding seven; 14/30-day choices follow the same rule. Custom dates uses
the shared calendar, with independent inclusive ranges and cancellation that
keeps the accepted pair.

Use the compact, report-colored five-choice menu. Keep Outcomes, Timeline,
By tool and Timing visible inside the chart and More options in its corner.
Optional refinement retains every supported selector and combination, with
local option finding and immediate selection. Additional restrictions appear
once beside the accepted dates; pending reads must not relabel old facts.

One mounted footer owns View calls, View numbers and Create report. Chart
switching and mark inspection do not change the pair. Exact values qualify
their unit, period, denominator and missing evidence. Timings keep call latency
and full-interaction clocks separate. The comparison-origin report return is
Back to comparison, including the accepted scope and reading position.

## Settings, collection and consequential actions

### Categories and setting search

The four categories are Connection & updates, Privacy & saved data, Display
and Troubleshooting. Keep one task-oriented pane and the same narrow category
disclosure, not another application sidebar. Search finds fixed setting
metadata and navigates; it never clicks an action or reads private path values.

While a Settings query is present, replace the category list with grouped
destinations. Show each category once, followed by indented setting names.
Keep description and keyword matches even when the name has no matching word;
full help and consequences stay at the destination. An unavailable action
gets a short status, but its result remains a link to the setting and explanation.

Use a flat, compact field face inside a full input target, scoped to Settings.
Keep the global retained-content Search field unchanged.
Results use regular Asta Sans, plain Lucide category icons and no filled cards.
Distinguish hover underline, selected-location mark and keyboard outline.
Tab and Enter reach the existing control; Clear or Escape restores the category
list. Back restores the query and activating link, including after visiting
Collection status.

Settings categories use a compact neutral selection mark and transient text
hover/press feedback, not competing full-row gray blocks.

### Account and profile

The supported source is local GitHub Copilot app history. Settings should expose
only supported connections. Account keeps the local WIRE sign-in/out action.
Sign-out names this instance and explains that collection stops and saved
activity is hidden, not deleted; GitHub and Copilot sign-ins are unchanged.

The profile inherits the approved Copilot app source's recorded account and
cached avatar. It is display context, not authentication or ownership of
history. Do not replace it with a CLI account or a manually chosen username.
Missing, ambiguous or unsupported profile data keeps the neutral fallback.
The sidebar shows the display name and avatar without a second handle line.
Keep the handle in the opened account menu; use it as the sidebar fallback only
when the source has no display name.
Renew a still-current profile before its deadline without clearing or remounting
the avatar. Failed reads, expired identity and access withdrawal still clear it.
The [collection contract](collection.md#account-profile) defines the profile's
source mapping and qualified reads.

The account avatar keeps the same internal horizontal alignment throughout
sidebar motion. Its image, name and chevron stay mounted; fade and clip the
copy with the moving footer rather than switching its grid to a centered
alignment before the rail has moved. Reversals start at the painted position.

### Saving preferences

| Settings change | Commit boundary |
| --- | --- |
| Same-source paths/preferences draft | Save preferences |
| Changed source paths | Approve and switch source |
| Cancel source review | Discard the draft |
| Display preference | Apply immediately, separately from permission |
| Recorded replies | Its own draft and confirmation |

Source review keeps paths and preferences in one draft.

### Refresh and consequential actions

Refresh sits in Analyze and the connection/status task, using one
dispatcher and its real pending state. Read stored activity is a different,
clearly named effect. Completion and coverage stay separate; a no-change
receipt does not prove complete history.
Do not promise that retry recreates a missing file or removes a read limit.

Deletion/recollection dialogs keep the question, body-only scroller and fixed
actions. Preview and actual confirmation are different stages; Cancel receives
safe initial focus. Destructive paint belongs only to deletion, not a read-only
result check or recollection. Unknown results preserve original recovery
identity and cannot be dismissed into a new mutation.

The [collection contract](collection.md#operations-and-permissions) defines the
permissions and retained effects behind these controls. Check changed journeys
with the shared [screen-change criteria](design.md#check-a-screen-change).
