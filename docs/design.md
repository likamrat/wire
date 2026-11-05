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
| Sliding left sidebar | Analyze/Reports under Workspace; Analyze tools in their own group; Account/Settings at the bottom |
| Expanded, collapsed and narrow navigation | Same nodes and destinations; Settings works without a profile |
| Analyze | Charts and one interaction list; report selection stays independent of browsing |
| Right contextual surface | Interaction reading, report setup and saved-item inspection; one header, scroll area and fixed action region |
| Main workspace | Prepared and saved report reading |

Opening the contextual surface reduces the main column's actual width.
It does not scale content or mount a second reader; narrow/enlarged layouts
use the same native modal.

Keep existing route, reading-position and focus owners. A return restores the
actual origin only while its authority and reading intent remain current.
Later user input wins over delayed navigation, reads and motion callbacks.
Private Search state never becomes a copied public URL or a broader fallback.

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
whitespace. Utility, navigation and compact roles use their 20/24/16px geometry.
Interactive targets stay usable independently of their smaller painted face;
preserve the established
44px targets, focus indications and wrapping labels.

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
not select, approve or save. Broader report scopes explain membership instead
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

Reports opens the saved library. Create and Compare are explicit tasks;
an active task offers Back to Reports instead of competing navigation.
Rows lead with title, registered formats and Open/unavailable status.
Inspection does not read a file, download or delete it.

Creation is Activity -> Contents -> Review & save. Activity owns full scope,
authors, selection and paging; Contents uses the contextual sidebar beside the
picker. Inspecting an interaction temporarily replaces that panel without
discarding the draft. Close retains memory-only choices and does not invent a
Save/Discard gate.

Prepare opens the actual document in the main reading workspace with
Report/Text/Files views. Original/copy text is selectable.
Edits and omissions require rebuild.
Disclosure approval and Save stay separate actions in the same workspace.

Saved reading uses actual files, a clear title/format toolbar and one Download
action. HTML remains opaque; Markdown/JSON/PDF use their existing safe local
viewers. Departure/withdrawal retires text, pixels, workers and pending reads.
Prepared measurement privileges do not transfer to saved HTML.

For report meaning and actions, link to the [user guide](reporting.md); for
membership, frozen facts and privacy, use the [report contract](report-contract.md).
Screen paint changes do not restyle saved documents.

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

Docked motion changes actual main-column geometry on the same clock, including
reversal. Anchor compensation yields to new input. Replacement keeps the current
owner rather than replaying entrance; authority loss clears private content
immediately instead of retaining an exit animation.

Reader width/maximize controls belong only to interaction reading. They preserve
the current visible text anchor and mounted disclosure/focus owners; report
setup and saved inspection do not inherit them. Narrow modal focus remains
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
