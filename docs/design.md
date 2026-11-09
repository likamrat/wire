# Product design

WIRE helps a person recognize a recorded request, inspect what happened and
choose evidence for a report. Design around those reading and decision tasks,
not around the implementation's status objects.

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

## One coherent workspace

| Surface | Reading and navigation role |
| --- | --- |
| Sliding left sidebar | Analyze, Reports and Compare periods as peer destinations; Account/Settings at the bottom |
| Expanded, collapsed and narrow navigation | Same nodes and destinations; Settings works without a profile |
| Analyze | Charts and one interaction list; report selection stays independent of browsing |
| Right contextual surface | Interaction reading and saved-item inspection; one header, scroll area and fixed action region |
| Main workspace | Prepared and saved report reading |

Opening the contextual surface reduces the main column's actual width.
It does not scale content or mount a second reader; narrow/enlarged layouts
use the same native modal.

Keep existing route, reading-position and focus owners. A return restores the
actual origin only while its authority and reading intent remain current.
Later user input wins over delayed navigation, reads and motion callbacks.
Pointer presses must not trigger older scroll restoration that moves the
targeted control before release.
Private Search state never becomes a copied public URL or a broader fallback.
Peer destinations have no fabricated Analyze / Reports breadcrumb. Subordinate
reading keeps one return to its actual origin. Entering Compare opens it rather
than toggling it off; Analyze and Compare retain independent accepted scopes.

## Reading hierarchy

| Element | Visual treatment |
| --- | --- |
| Screen type | Bundled Asta Sans and shared screen roles |
| Metadata label/value | Same regular weight and size; use placement and neutral label contrast for hierarchy |
| Prompt | Regular, not bold italic |
| Exact code and API path | Deliberate monospace |
| Icon | Official Lucide paths/viewBox, unchanged |

Keep the label with its value, the explanation with its evidence and the action
with its task. Missing optional facts need no empty row. Missing or conflicting
evidence that limits a conclusion must remain explicit. Do not repeat the same
fact in a badge, paragraph, warning and disclosure.

Compact identity summaries show at most two tool names and two known service
names. More tools/services flows inline with matching typography, not as a
separate control. Full reading preserves exact identities. Tool, service,
author and outcome are different meanings and must not share inferred labels.

Current palette, material roles, font scale and geometry live in
[`web/tokens.mjs`](../web/tokens.mjs) and the existing component styles.
Dark screens use the ink-blue material roles.
Screen-only `screenTokens` and `screenFontStack` stay separate from
report-facing tokens, typography and frozen output.

The screen and README use the same self-contained `wire-lockup` SVGs: the
unchanged cable wordmark and its integrated Asta Sans descriptor. Regenerate
them with `node scripts/build-brand-lockups.mjs` after an intentional asset
change. The font and its license are embedded so GitHub does not substitute
another face. Keep the compact W and the report-only `wire-wordmark` assets
unchanged; report readers clone those from their own template, not the header.

Decorative glyphs fit their text line without acquiring control-sized
whitespace. Keep official Lucide's 24-unit viewBox; painted navigation glyphs
use 18px at the default text size, reader utilities and chart labels use 18px,
and compact cues retain their 16px role. Other established utility roles remain
20px. The simple panel-left glyph keeps its changing accessible expand/collapse
name and state.
Interactive targets stay usable independently of their smaller painted face;
preserve the established
44px targets, focus indications and wrapping labels.

Use one restrained screen hierarchy throughout the application. Routine Analyze
charts sit on the workspace without filled card frames; individual interactions
remain distinct, and contextual readers and open menus carry the stronger surface.
Resting panels have no drop shadow. Navigation uses neutral selection without
an outlined card or redundant Workspace caption. Settings follows the shared
page and section type scale.

Toolbar buttons, selects and numeric fields use a compact painted face inside
their full target. Keep text/icon baselines aligned and let targets grow with
enlarged text. Number fields size to their page digits rather than taking a
wide fixed slot. A direct page jump keeps its native validation, Enter behavior
and visible Go to page action. PDF paging keeps its existing commit behavior.
Checkboxes and switches use the setting-state color, not outcome green.
Keep hover, pressed, selected and keyboard focus distinct; a smaller painted
control is not permission to remove its focus ring or hit area.

Outcome words/icons accompany color. Completed calls use the current success
role; failures use red, partial states retain their separate warning role and
missing evidence stays neutral. Service colors identify services, not health.
Agent and user authorship use their own roles, not service or quality colors.
Forced colors retain explicit words, shapes and system focus.

## Analyze and filters

Lead with accepted recorded outcomes and activity patterns. The outcome ring
and right-side legend share a row when the widget has sufficient width; small
layouts stack without squeezing values. Model, tool and service widgets use
content-sized layout, not equal-height filler or hidden rows for symmetry.

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

### Chart reading

| Measure | Encoding |
| --- | --- |
| Amount | Linear from zero, without perspective, minimum slices or inflated tiny bars |
| Zero | No data paint |
| Overlapping service associations | Bars, not a 100% composition |
| Exclusive recorded outcomes | May use a ring |
| Tiny mark | Exact counts and accessible table links remain usable |

The Chart guide has one stable reading panel and exact-data destination.
Definitions and table counts use the same accepted facts. A row finder filters
only table labels, not analytical membership or totals. Overflow remains
local, keyboard/touch accessible and truthful; do not shrink type or hide data.

## Interaction cards and reading

Cards show author/origin, an authorized prompt excerpt, services/operations,
recorded problems/results, then quiet time/count metadata. Prompts use up to
two actual line boxes, not an arbitrary character cap. Read more appears only
on real overflow; it opens the reader at the prompt's top. Other valid reader
returns can retain their prior position.

A card is one native link without nested Copy, checkbox or duplicate Open
controls. Report-picker checkboxes remain separate. Native modified-click and
text selection keep their established behavior.

Failure presentation keeps three boundaries:

- Each call owns its reasons and stable full-interaction ordinal. Matching prose
  does not merge different calls.
- Equivalent complete returned diagnostics within one call may share a reason
  only if all original entry identities remain. Missing/redacted/ambiguous facts
  cannot qualify that grouping.
- Cards and readers show all supported reasons under their call, without a
  first-N cap, "one more reason" disclosure or extra failure page.

Exact input/provenance disclosure is a separate action. Partial-response
coverage is separate from failure reasons and matching-call counts.

The reader's order follows the user's question:

1. Selected prompt: what was requested.
2. Recorded activity: calls and their own results, timing and errors.
3. Available Copilot reply.
4. Source details.

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

Prompt/response Copy uses the exact authorized original, not the excerpt,
metadata or report copy. Its icon and accessible name identify the subject and
unmasked text. Pending/success feedback replaces the existing glyph without a
new line or layout shift. Failure remains explicit with manual-copy guidance.
No Clipboard read is required.

The fixed reader footer owns Add/Remove and Continue to report. Reading does
not select or save. Broader report scopes explain membership instead
of silently switching to Selected.

## Search

Use one stationary rounded capsule with results as the user types.
Scope and type choices stay together beneath it. Clear belongs to the field;
Escape/outside dismissal does not silently clear the query.

Results group the complete authorized population by type before paging.
Original titles and actual matching excerpts/source labels identify each hit;
do not repeat equivalent unmatched captions. Missing fields create no blank
slots. Body-only matches must show the matching body, not an unrelated opening
paragraph. Match ranges come from the server and use inert text nodes,
preserving original graphemes and full visible matches.

Category cues, outcome cues and original text keep separate roles. Whole-row
Open and category/paging controls use the existing behavior. Partial coverage,
no match, failure and unavailable content stay distinct. See
[matching and lifecycle](live-search.md), rather than duplicating that contract.

## Reports

Reports is one workspace: report choices first, saved reports directly below.
There is no separate Create report navigation entry. Choosing a tile or a saved
name replaces the landing with full-area reading. Reports-origin reading has one
Back to Reports action; context-qualified entries retain their own origin.

The landing has five compact, equal-sized full-width tile rows: All activity, Errors &
failures, Completed calls, My prompts and Agent prompts. Compare periods has
its own primary destination. The report period is visible, defaults to Last 7 days, and offers 14/30/custom
choices. Custom dates opens its calendar directly. A fresh report ignores old
Analyze restrictions. Selected and Current remain available through inclusion
controls and their original context-qualified entries.

Saved rows align Report, Period and Files. The name opens the saved file; one
Files control offers registered formats. A privacy mark beside the name has
hover/focus/touch help without claiming complete anonymization. Missing metadata
is not inferred. A secondary Options menu preserves inspection and deletion;
the header menu preserves bulk deletion with its existing confirmation.
Inspection alone does not read, download or delete a file.
Every report choice has accessible help. Saved-report paging follows the rows
in visual and keyboard order. The view icon and report name open in-app reading;
Files remains a separate action.

Back restores saved search, order, paging, scroll and activating control.
It preserves the authorized unfinished copy without another visible resume
entry: choosing the same type with unchanged dates resumes that copy.
An unresolved Save remains visible and uses its original recovery owner.

Choosing a tile opens the actual report immediately. A compact toolbar owns its
name, period, personal-detail choice and formats, with Save beside the name.
The name updates the document heading without remounting its input. Optional
changes regenerate files; Save stays unavailable while the preview is stale.
The report surface and border complement the current screen theme without
changing frozen output. Example notes and copy edits stay beside their evidence.
Report view uses a contained reading pane with persistent section links,
collapsible sections and individual interaction disclosures. All evidence stays
reachable; a pattern link opens its exact interaction. Keep only scope and dates
at the top. Older layouts' companion charts belong inside their section's
disclosure, not below a closed marker. Keep other metadata
under Report details in Coverage. Recorded
failure/success/partial words retain their semantic colors.

Save as chooses output files. View chooses Report or an actual format preview,
with PDF pages, a JSON tree or HTML/Markdown Preview/Source. Returning from a file
to the same authorized HTML report keeps its open sections and reading position.
JSON-only saves can render a readable page from their verified frozen snapshot.

Hide personal details and HTML are defaults. Errors & failures visibly includes
retained masked error details. Notes are authored context, never recorded facts.
Keep chat details invokes one warning at Save, with equal-sized Hide details
and save / Save with chat details actions. Go back has a small arrow and safe
initial focus. Hide-and-save must regenerate real masked bytes before writing.
New saves do not claim a human text review.

Use explicit nearby help icons only for meaningful limits: mixed errors,
completed calls versus task success, masking and file formats. Card hover and
the period control do not open help. Labels and focus outlines have sufficient
shared spacing at enlarged text sizes. Keep Asta Sans, official Lucide geometry
and the existing navigation owners.

Saved reading uses actual files, a clear title/format toolbar and one Download
action. HTML remains opaque; Markdown/JSON/PDF use their existing safe local
viewers. Departure/withdrawal retires text, pixels, workers and pending reads.
Prepared measurement privileges do not transfer to saved HTML.

For report meaning and actions, link to the [user guide](reporting.md); for
membership, frozen facts and privacy, use the [report contract](report-contract.md).
Screen paint changes do not restyle saved documents.

## Compare periods

Fresh entry opens Outcomes for all eligible saved activity, without importing
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

The four categories are Connection & updates, Privacy & saved data, Display
and Troubleshooting. Keep one task-oriented pane and the same narrow category
disclosure, not another application sidebar. Search finds fixed setting
metadata and navigates; it never clicks an action or reads private path values.

| Settings change | Commit boundary |
| --- | --- |
| Same-source paths/preferences draft | Save preferences |
| Changed source paths | Approve and switch source |
| Cancel source review | Discard the draft |
| Display preference | Apply immediately, separately from permission |
| Recorded replies | Its own draft and confirmation |

Source review keeps paths and preferences in one draft.

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

## Motion, focus and text

The left rail, narrow drawer, Filters, Chart guide and right contextual surface
share a reversible 320ms glide. This navigation policy runs
under either browser motion preference and has no separate user setting.
Other controls and reader folding retain their own reduced-motion behavior;
do not change operating-system preferences.

Menus enter with a short opacity fade and controls use restrained paint
transitions. Selected navigation and open selects may have a faint top sheen;
do not apply it to data marks, resting panels or frozen reports. Added decorative
motion is removed under reduced motion. Do not animate an exit at the expense
of immediate private-content clearance.

Docked motion changes actual main-column geometry on the same clock, including
reversal. Anchor compensation yields to new input. Replacement keeps the current
owner rather than replaying entrance; authority loss clears private content
immediately instead of retaining an exit animation.

Reader width/maximize controls belong only to interaction reading. They preserve
the current visible text anchor and mounted disclosure/focus owners; report
creation and saved inspection do not inherit them. Narrow modal focus remains
independent of the navigation drawer.

| Interaction state | Treatment |
| --- | --- |
| Hover, persistent selection/current page, keyboard focus | Visually distinct meanings |
| Tooltip | One dismissible, hoverable owner; no obscured action |
| Activation | Dismiss old help without stealing focus |
| Long text | Labels/values wrap; code may scroll locally |

Never shorten source content to satisfy a layout assertion or shrink typography
and targets to make a screenshot fit.

## Check a screen change

Use the normal renderer and invented data. Follow the affected task through
Back/Close and any failure or unavailable state. Check focus, scrolling and
layout during transitions, plus both themes and a narrow or enlarged-text view.

Activity-reader, report-sidebar, Search, period-comparison, navigation, Settings
and withdrawal browser suites cover these paths. For report-output changes,
also inspect the saved files using the [report contract](report-contract.md).
