# Product design

WIRE helps a person recognize a recorded request, inspect what happened and
choose evidence for a report. Design around those reading and decision tasks,
not around the implementation's status objects.

The released source policy is GitHub Copilot-only. Settings has no Microsoft
Connect/Enable/Collect controls, source-mode chooser or incubation tutorial.
Account keeps the local WIRE sign-in/out action and stays neutral without a
qualified desktop-selected GitHub profile. Experimental surfaces belong to
[incubation](incubation/microsoft-native-host.md), not ordinary onboarding.

## One coherent workspace

Keep the sliding left sidebar: Analyze and Reports under Workspace, the existing
Analyze tools in their own group, and Account plus Settings at the bottom.
Expanded/collapsed and narrow-drawer states use the same nodes and destinations.
Settings remains reachable when no profile is available.

Analyze contains its charts and one interaction list. There is no separate
Calls mode, fastest/slowest view, duplicate records shortcut or additional
Search launcher. Old routes keep valid filters while discarding obsolete call
sorting/page offsets. Report selection is independent of browsing.

The right contextual surface serves interaction reading, report setup and
saved-item inspection, with one header, scroll area and fixed action region.
Opening it reduces the actual main-column width; it does not scale content or
mount a second reader. Narrow/enlarged layouts use the same native modal.
Prepared and saved report reading use the main workspace.

Keep existing route, reading-position and focus owners. A return restores the
actual origin only while its authority and reading intent remain current.
Later user input wins over delayed navigation, reads and motion callbacks.
Private Search state never becomes a copied public URL or a broader fallback.

## Reading hierarchy

Use the current bundled Asta Sans, official Lucide icons and shared screen
roles. Metadata labels and values share regular weight and size; hierarchy
comes from placement and neutral label contrast. Prompts are regular, not
bold italic. Exact code and API paths keep their deliberate monospace role.

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
Ordinary dark screens use the current ink-blue material override; earlier
charcoal/navy/marketing-reference palettes are not competing instructions.
Screen-only `screenTokens` and `screenFontStack` stay separate from
report-facing tokens, typography and frozen output.

Lucide's original paths/viewBox remain unchanged. Decorative glyphs fit their
text line without acquiring control-sized whitespace. Utility, navigation and
compact roles use their existing 20/24/16px geometry. Interactive targets stay
usable independently of their smaller painted face; preserve the established
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

Filters opens one panel containing the existing controls, applied chips and
separate View group. Dates governs the complete analytical slice; Over time,
By category and By path or operation only regroup it. There is no second date
picker on a widget. Outcome/Author choices remain drafts until Apply;
Cancel/Escape/outside dismissal leaves the accepted selection unchanged.

Applied chips provide the settled removal action. Inline cancellation is only
for a first pending restriction without an applied chip. Reset filters remains
beside applied restrictions and preserves report selection/data/preferences.
Fields and labels wrap; accepting a restriction must not move the focused field.

The count, scope caption, charts, rows and current-view report membership use
one accepted population. Pending or failed ordinary reads retain its prior
scope rather than relabel it with requested filters. Partial/unbound analytical
Search withholds measures instead of inventing zeros. Access withdrawal clears
private results rather than keeping stale content visible.

Calendar presets and custom dates use the selected IANA zone. Custom dates
are inclusive civil days; buckets are clipped to that scope. Undated records
stay explicit. Missing history cannot be assigned to the current filtered
slice from source-wide diagnostics.

Chart marks encode exact linear amounts from zero, without perspective,
minimum visible slices or inflated tiny bars. Zero has no data paint.
Service associations overlap and therefore use bars, not a 100% composition.
Recorded outcomes can form an exclusive ring. Exact counts and accessible
table links remain usable even when a mark is too small to hit.

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

Each failed call owns its reasons and stable full-interaction ordinal.
Different calls never merge because their prose matches. Equivalent complete
returned diagnostics within one call may share a reason only with all original
entry identities preserved; missing/redacted/ambiguous facts cannot qualify
that grouping. All supported failure reasons remain visible on both compact
cards and ordinary readers, grouped under the owning call, without a first-N
cap, separate "one more reason" disclosure or extra failure page. Expanding
technical details for exact input and provenance is a distinct action.
Partial-response coverage is separate from failure reasons and matching-call
counts.

The reader leads with the selected prompt, Recorded activity, an available
Copilot reply and Source details. Exact call arguments are built only when
their disclosure is open and cleared when it closes. Returned entries retain
their own path/status/identity, never a sibling's input or inferred parent cause.
Linked context belongs in its existing separate disclosure and cannot
transfer intent or outcomes between interactions.

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

Keep one stationary rounded capsule with typed results, no Submit, enlargement,
ghost completion, separate Search screen or Related results.
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

Prepare opens the actual document in the main reading workspace with flat
Report/Text/Files views. Original/copy text is selectable; do not add automatic
Copy toolbars or scanner-counter recitals. Edits and omissions require rebuild.
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

Source review combines the actual paths and preferences in one draft. Same-source
changes use Save preferences; changed paths require Approve and switch source.
Cancel discards the draft. Display preferences apply immediately and are
separate from permission changes. Recorded replies has its own draft and
confirmation. No AI-review category remains.

Refresh sits in Analyze and the existing connection/status task, using one
dispatcher and its real pending state. There is no sidebar Activity updates
menu. Read stored activity is a different, clearly named effect. Completion
and coverage stay separate; a no-change receipt does not prove complete history.
Do not promise that retry recreates a missing file or removes a read limit.

Deletion/recollection dialogs keep the question, body-only scroller and fixed
actions. Preview and actual confirmation are different stages; Cancel receives
safe initial focus. Destructive paint belongs only to deletion, not a read-only
result check or recollection. Unknown results preserve original recovery
identity and cannot be dismissed into a new mutation.

## Motion, focus and text

The left rail, narrow drawer, Filters, Chart guide and right contextual surface
share the existing reversible 320ms glide. This explicit navigation policy runs
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

Hover, persistent selection/current page and keyboard focus are different states.
Tooltips use one dismissible, hoverable owner and do not obscure actions.
Activation dismisses old help without stealing focus. Long labels/values wrap;
code can scroll locally. Source content is never shortened to satisfy a layout
assertion, and typography/target sizes are not shrunk to make a screenshot fit.

## Finish a change

Use the real renderer and invented data for the affected journey, including
its Back/Close/return and relevant failure or unavailable state. Check actual
paint, text edges, glyphs, focus and in-flight geometry where they matter,
not only CSS values or a green test.

Relevant existing owners include activity-reader, report-sidebar, Search,
period-comparison, navigation, Settings and withdrawal browser suites.
Choose representative widths/themes/text enlargement, not a Cartesian gallery.
A screenshot proves its visible state, not motion, provider acquisition,
full source coverage or frozen-file correctness. Preserve those distinctions
when reporting completion.
