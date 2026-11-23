# Product design

WIRE helps a person recognize a recorded request, inspect what happened and
choose evidence for a report. Design around those reading and decision tasks,
not around the implementation's status objects.

This reference covers shared screen design. For a particular screen's controls,
states and return behavior, use [Interaction design](interaction-design.md).
Evidence definitions and frozen-file requirements remain in the
[report contract](report-contract.md).

## Find a screen's behavior

| Screen or task | Reference |
| --- | --- |
| Navigation and return state | [Destinations, loading and Back](interaction-design.md#navigation-and-return) |
| <a id="analyze-and-filters"></a>Analyze and filters | [Accepted scope and chart reading](interaction-design.md#analyze-and-filters) |
| <a id="interaction-cards-and-reading"></a>Interaction cards and reading | [Cards, results, disclosures and Copy](interaction-design.md#interaction-cards-and-reading) |
| <a id="search"></a>Search | [Typed results and exact Open](interaction-design.md#search) |
| <a id="reports"></a>Reports | [Preparation, saving and saved reading](interaction-design.md#reports) |
| <a id="compare-periods"></a>Compare | [Ranges and chart actions](interaction-design.md#compare) |
| <a id="settings-collection-and-consequential-actions"></a>Settings, collection and consequential actions | [Setting search, account and confirmation behavior](interaction-design.md#settings-collection-and-consequential-actions) |

## One coherent workspace

When changing a control, compare it with a shipped WIRE control that does the
same job. Use the same icon role, label treatment and interaction states unless
the action has a different meaning. Review both in their full screens at rest,
on hover, when selected and with keyboard focus; a component preview alone
cannot show whether it fits its surroundings.

Keep choices that only change the current view beside the content they affect.
For example, open period presets at the date control and let Custom dates expand
there, with the current chart still in view. Cancelling must leave the applied
range and reading position intact. Reserve a separate workspace or blocking
dialog for a distinct task or a decision that must be resolved before continuing.

| Surface | Reading and navigation role |
| --- | --- |
| Sliding left sidebar | Analyze, Trends, Reports and Compare as peer destinations; account, Help, Feedback and Settings at the bottom |
| Expanded, collapsed and narrow navigation | Same nodes and destinations; Settings works without a profile |
| Analyze | Charts and one interaction list; report selection stays independent of browsing |
| Trends | Seven visible measure names beside one daily chart; optional aligned charts share the accepted period |
| Right contextual surface | Interaction reading and saved-item inspection; one header, scroll area and fixed action region |
| Main workspace | Prepared and saved report reading |

Opening the contextual surface reduces the main column's actual width.
It does not scale content or mount a second reader; narrow/enlarged layouts
use the same native modal.

## Reading hierarchy

| Element | Visual treatment |
| --- | --- |
| Screen type | Bundled Asta Sans and shared screen roles |
| Failure reasons and action guidance | Regular body type (`--type-body`) with 1.5 line height. Keep reasons distinct from timestamp captions; do not shrink an action's consequences into fine print. |
| Settings task headings | Peer tasks use the same strong reading-size heading (`--type-reading`), whether the control is a button or a gallery. |
| Metadata label/value | Same regular weight and size; use placement and neutral label contrast for hierarchy |
| Prompt | Regular, not bold italic |
| Exact code and API path | Deliberate monospace |
| Icon | [React Icons](https://react-icons.github.io/react-icons/), Lucide family, official 24-unit viewBox |

Keep the label with its value, the explanation with its evidence and the action
with its task. Missing optional facts need no empty row. Missing or conflicting
evidence that limits a conclusion must remain explicit. Do not repeat the same
fact in a badge, paragraph, warning and disclosure.

On interaction cards, identify the prompt author with a high-contrast label
and its Human, Agent or unverified icon. Align the date to the author's text
baseline, not the icon. When it wraps, start it under the author text.
Give the prompt and its eye separate columns inside one link. Below the prompt,
keep the recorded outcome with the affected calls and their explanations. When a
reason covers the full badge count, place its call numbers and tool beside that
count. Use one **Problem** area for the card, with different reasons under
their own call numbers. Start each explanation at the same text inset and
heading gap; place its exact evidence link below it. A link's touch target
must not push the explanation down or sideways. Omit the
area on clean cards. A code-only failure that repeats its entry's code need
not repeat it on the card; the reader retains both records. Missing reasons are plain text. Green/check
indicates recorded tool completion; red/cross marks failed calls. Neither
is a verdict on the prompt or the task. Returned issues keep a separate link.
Keep provenance in Source details; name a source on the card when
it distinguishes activity. Keep date and availability quieter. Group tool
names separately from requested targets, operation and missing attribution. Keep
the glyph beside its label. Separate the identity key from the prompt with a
rule. In the Tools summary, show exact names as plain text without icons,
badges or bullets. These are list items, not filters or reader links. Keep a
repeat count inside its tool’s label, as in `workiq-retrieve (2 calls)`;
a single call reads `workiq-fetch`. Wrap labels as units where they fit and
allow long names to break rather than truncate. On a returned result layer
the unit is results, not calls. Keep the card's two actions with these facts,
not beneath the taller of the prompt and metadata columns. Use the same text
scale for labels, targets and operations. Name the recorded operation for the
reader (for example **Reply-all draft**); its exact API path remains in the
call reader.

Tool names and counts also use plain text in chart legends, filters, reader
headings and comparison tables. Keep the glyph for an operation such as
**Asked Copilot**, not for the tool identifier `workiq-ask`. Search keeps its
result-category icon; a link or disclosure keeps its navigation cue.

### Surfaces and color

Use one restrained screen hierarchy throughout the application. Routine Analyze
charts have separate quiet surfaces with each heading inside its group.
Use a visible tone boundary and restrained edge in both themes; keep chart
heights content-sized and avoid nested card frames around individual rows.
Individual interactions remain distinct, and contextual readers and open menus
carry the stronger surface.
Resting panels have no drop shadow. Navigation uses neutral selection without
an outlined card or redundant Workspace caption. Settings follows the shared
page and section type scale.

In React Analyze, the heading and controls, chart group, list heading and
interaction list use the same workspace edges as the sidebars resize. The
charts and the list each have one rounded surface; a single divider separates
adjacent rows, without individual card borders or shadows. The prompt leads
and keeps its shorter reading measure. An adjacent identity key stacks below
it in narrow columns. A tool failure and a separate returned issue each lead to
their own evidence; routine rows need no four-state ledger.
The four supporting breakdowns use paired,
content-sized columns, becoming a single column when needed.

Screen headings use sentence case, including **Work IQ**. Keep branding,
genuine acronyms and recorded identifiers unchanged. In the interaction reader,
each call leads with its ordinal, tool and outcome. Its returned entries form a
subordinate group with aligned facts; call service, result service and their
separate duration evidence retain their own meanings.

Outcome words/icons accompany color. Card, reader and Analyze tool outcomes
use green for recorded completion and red for failure; partial states retain
a separate gold warning role and missing evidence stays neutral. Completion
does not establish answer quality. Service colors identify services, not health.
Agent and user authorship use their own roles, not service or quality colors.
Forced colors retain explicit words, shapes and system focus.

Carry the role with the fact, not the page. Recorded **tool completion** and
**tool failure** use `--tool-positive` and `--tool-negative` in the chart,
card, search result and reader. A **returned API issue** uses
`--screen-returned-issue` even when its parent call completed. Partial or
unconfirmed is `--warning`; unknown is `--unknown`. A count of interactions
with *either* kind of problem uses a neutral chart ink, not a failure verdict.
Service and author colors identify the subject; selected, pending and disabled
controls use interaction roles rather than success or failure colors.

**Keep chat details** uses `--disclosure-risk` (red), **Mask detected details**
uses `--disclosure-masked` (blue), and omitted text is neutral. Use the same
ink for the label, icon and action edge through the choice, preview and
confirmation. Tint a disclosure action with 7% risk ink mixed into its own
paper. A modal scrim dims only the background; never compensate by brightening
the underlying warning. A destructive commit has its own filled danger action.
These are screen roles, not new inks for saved documents.

Current palette, material roles, font scale and geometry live in
[`web/tokens.mjs`](../web/tokens.mjs) and the existing component styles.
Light screens use quiet cool-neutral surfaces; Dark uses separately designed
petrol-neutral surfaces. Controls, selection and focus remain neutral rather
than borrowing outcome colors. Dark service inks retain their identity hues
with added lightness for contrast on selected surfaces.
Use tonal layers: give navigation its own rail, the workspace a ground, and
widgets and readers distinct reading surfaces. Charts need a track or plot well
that remains legible inside the widget; tool-name labels must not disappear
when their enclosing row is selected. Test an outcome's text **on its fill**
and its fill and edge **against the actual card or reader**. A passing text
ratio does not mean a layer is visible. Palette-specific green and red still
mean tool completion and failure; keep the check, cross and count.
Petrol & coral remains the default and the fallback. Settings > Themes separately chooses
Linen & graphite, Blueprint, Field notes or Midnight in either Light or Dark.
The screen palette catalog (`web/screen-palettes.mjs`) maps materials,
control states, widget marks, series, services and authors to CSS roles;
names, result glyphs and count geometry are not color-derived. The same
roles paint compact, unbranded material samples without reading a user's activity.
Screen-only `screenTokens` and `screenFontStack` stay separate from
report-facing tokens, typography and frozen output.

### Icons and controls

Use the role map in `web/icon-roles.mjs` for navigation, actions, authors, outcomes and
services. A role identifies what the icon means, not its color or file name.
React controls and the static SVG adapter use the same React Icons components
and expose `data-icon-role` on the SVG. Keep icons decorative beside text;
give an icon-only control an accessible name on the control itself.
Screen icons use a 1.5-unit stroke on Lucide's 24-unit grid, with round caps
and joins. That gives a 16px cue a 1px line and a 24px heading a 1.5px line.
Set weight in `iconProps`, not in page styles. Do not thin a glyph by fading
it, shrinking its target or changing its weight when selected. Keep compact
author and outcome cues at least 16px beside their text.

A circled check identifies a recorded success. A bare check at the trailing
edge of an option marks the selected value, even if that value is a failure.
Keep the leading glyph and its ink when hovering or selecting the row. Compare's
mixed **Errors & failures** starting point uses an attention triangle, not a
failed-call cross. Human and Agent prompt glyphs keep their author inks. A
service glyph keeps its service ink even in Search, outside the chart legend.
Navigation and ordinary actions inherit their control's ink; they are not
additional data categories.

Screen operation roles live in `web/operation-icons.mjs`. A recorded tool name
identifies the tool, not a service, a result, or proof that a referenced API
was called. API discovery, schema lookup, agent discovery, retrieval and
Copilot assistance use different glyphs. A named Graph action or function
uses its own glyph only on a matching recorded action/function call. A schema
argument, code reference, returned status, or unknown name does not acquire
an execution glyph. The role coverage test follows the analytics allowlists.

This rule is for screen glyphs, not all SVGs. WIRE and provider marks, profile
imagery, chart geometry and the versioned artwork embedded in reports retain
their own paint. Native form controls keep their platform affordances.

Decorative glyphs fit their text line without acquiring control-sized
whitespace. Keep official Lucide's 24-unit viewBox; painted navigation glyphs
use 18px at the default text size, reader utilities and chart labels use 18px,
and compact cues retain their 16px role. Other established utility roles remain
20px. The header's simple 20px panel-left glyph sits beside the brand and keeps
its changing accessible expand/collapse name and state. Its 44px target remains
beside the compact mark without widening the collapsed rail or reserving an
empty navigation row.
Interactive targets stay usable independently of their smaller painted face.
The footer's three utilities use 32px-wide, 44px-high targets in a horizontal
row on fine-pointer devices without touch. Touch and the stacked rail keep
44px squares. Preserve focus indications, wrapping labels and the width
available for the account name.
On activity cards, a trailing arrow opens supporting evidence. A completed
count opens all the calls it counts, preserving any filter and original call
numbers. A failure opens its recorded call; a returned issue opens its own
entry. Hover and press tint only the arrow; keyboard focus outlines the link.
Noninteractive outcome labels have no arrow.
Prompt openers keep the passage itself unpainted and selectable. Their eye
cue signals reading; hover and press change the cue, not the text. Do not put
a tooltip over the passage. Call disclosures similarly emphasize the chevron.
In a choice field, align the leading icon to the *first line* of the value;
use the same glyph slot and text gap in the popup and closed field. The
trailing chevron belongs at the field edge, not next to the last word. Reserve
one centered 16px Lucide chevron, an 8px gap and a 12px trailing inset.
Choice fields use the screen field radius. A native picker keeps its native
input, keyboard and touch behavior; replace only its painted arrow, never
display both. An open listbox points up; a dialog opener is still a button.

The main Analyze, Trends, Reports and Compare headings use their existing
navigation glyph, at 24px with a 10px text gap. Keep the heading/focus node mounted
and update its text separately. These icons are decorative, not extra controls.
Settings, contextual readers and saved report headings do not acquire one.

Choose the button treatment by what happens **here**, not by its label or HTML
tag. Fill the main next step (for example **Prepare preview**); fill does not
mean a file was saved. Outline a secondary command such as **Choose chats**.
Use a quiet link with a trailing arrow for a shortcut to another workspace.
**Review deletion** is a cautionary outline; reserve the filled destructive
treatment for the final deletion. Green on an eligible update means an update
is available, not that it has run. Tabs, switches, icon-only utilities and
chart marks keep their own interaction patterns.

Use the shared `.primary` role for a filled CTA, including in studies using
WIRE styles. Its label and inset `::before` face need the same role; changing
only the text color can leave white lettering on the ordinary paper face.
Check contrast against the **paint under the letters** in rest, hover, press,
focus and pending states, including ancestor opacity. Keep normal-size button
text at 4.5:1 or higher; mute the boundary, not the legibility, when disabled.

Ordinary text actions share an 8px corner, 12px side padding and an 8px
icon-to-label gap. At default text size a 32px face sits inside a 44px target;
let the target grow with wrapped or enlarged text. Keep widths content-sized
and preserve geometry when focus, hover, press or pending paint changes.
Hover and press tint the existing face, not the transparent space around it.
For a directional row, keep its arrow visible and tint its surface or ink on
hover/press; don't underline or embolden the label. Keyboard focus keeps an
outline. The underline below an active section marks location; an underline
inside prose or evidence identifies a link even without hovering.
Keep hover paint close to its subject. Section links highlight just the icon
and label; sidebar utilities highlight a small face around their glyph, not
the full target. A navigation or search result row can highlight its
whole surface when activating anywhere on that row opens the same item.

Use the same 44×26px track and round, sliding thumb for a binary setting.
Keep its target at least 44px high. On/off is visible in position and
theme-aware contrast. In the header and Settings, the theme switch leaves
10px between its 16px sun and moon. Its 20px disc centers on the selected
icon, with 4px of space inside the track border. Disabled
inputs retain their state, with a dashed boundary; pending copy stays with
the setting. A reply-saving draft previews the requested choice. From submission
until confirmation the switch shows the last confirmed setting; an unknown
outcome is not a rejection. A list option, radio, disclosure or section link
is not a switch.

Toolbar buttons, selects and numeric fields use a compact painted face inside
their full target. Keep text/icon baselines aligned and let targets grow with
enlarged text. Number fields size to their page digits rather than taking a
wide fixed slot. A direct page jump keeps its native validation, Enter behavior
and visible Go to page action. PDF paging keeps its existing commit behavior.
Checkboxes and switches use the setting-state color, not outcome green.
On painted choice rows, leave the same 12px inside the leading and trailing
edges as in filter menus. Align a leading radio or checkbox with the **first
line of the label**, not the middle of its explanation. The label owns the
full target; enlarging the target should not stretch the glyph. Dense chart
legends use the smaller 8px inset and keep their value tracks separate.
Keep hover, pressed, selected and keyboard focus distinct; a smaller painted
control is not permission to remove its focus ring or hit area.

Compare a new control panel with the **Trends → Period → Custom dates** editor and
the **Reports → Formats** menu. A field label belongs above its input, clear of
the painted focus ring; a checkbox label belongs beside its box within one
clickable row. Align peer field edges, give groups more room than a label and
its value, and align Apply/Cancel to the panel's trailing inset. Reflow fields
when text grows rather than shrinking labels or widening every panel.
Check keyboard focus on each field in the *open workspace*, not only in a crop.

### Brand assets

The screen and README use the selected Magenta Human Path symbol and custom
WIRE path lettering in the self-contained `wire-lockup` SVGs. There is no
expanded-name tagline in the artwork; the README explains Work IQ Request
Explorer in surrounding text. The application keeps Asta Sans for ordinary UI.
Hover or keyboard focus on the existing logo-home link shows
**WorkIQ Request Explorer** through the shared tooltip owner. This brand
description stays separate from the neighboring navigation control's help.

`assets/wire-brand.json` is the current vector artwork and palette source.
Regenerate current lockups and compact icons with
`node scripts/build-brand-lockups.mjs`. The full and compact assets share
symbol coordinates so the sidebar glide stays registered. The favicon supports
the system color scheme; the inline compact mark follows WIRE's chosen theme.
Contours use deliberate lines and curves, not pixel-by-pixel raster traces.
Inspect at README size and enlarged scale as well as in the compact sidebar.

The older `wire-wordmark` and `wire-report-brand-v1` SVGs are immutable
historical report inputs. New reports declare `presentation.brandVersion: 2`
for the clean-contour Human Path artwork. Version 1 retains the original
Human Path rendering; unversioned snapshots retain the older wordmarks.
Do not apply current branding globally to historical report snapshots.

## Chart reading

| Measure | Encoding |
| --- | --- |
| Amount | Linear from zero, without perspective, minimum slices or inflated tiny bars |
| Zero | No data paint |
| Overlapping service associations | Bars, not a 100% composition |
| Exclusive recorded outcomes | May use a ring |
| Tiny mark | Exact counts and accessible table links remain usable |

The [Chart guide behavior](interaction-design.md#chart-guide) connects each
visualization to its definitions and exact values.

Trends places a visible measure index beside the working chart. At narrow widths
the names wrap above the chart, not into a chooser. Errors & failures comes
first. A fresh sidebar entry starts on Overview with Errors & failures. The
section row pairs each icon with a label; an underline identifies the current section.
Keep the dated population
beside the measure name. An incomplete service name is a limit on that count,
not a general warning below every chart. Put the counting details in Data table.
Named legend controls change what is drawn without changing the population.
Columns use a zero baseline and a separate bar for each series, even when
services or models overlap. Straight lines use the same observations; a missing
measurement breaks the line. Chart type, unit, population and selection are
independent. Select a value to reach its exact calls without maximizing.

Keep Period, Filters and the guide together at the chart column's leading
edge. Place display choices together by the measure title. The plot shares
the chart card's surface, not a second palette-colored rectangle. An empty
period uses a compact dated explanation and optional jump to real activity.
Period opens the 7/14/30/custom choices. Never substitute a pending date or
filter for the last accepted facts. Compare measures uses one accepted scope
for both series. Overlay only matching units and denominator bases; otherwise
align dates on separate scales. **All charts**, available under **Arrange charts**,
retains the full-width overview and its sizing controls.

The same chart owner serves overview and maximized reading. Daily ticks use
month and day, except Today; the compact index may show fewer tick labels
while preserving the full set of dated marks. Hover supplies the exact date.
Measure label widths at the screen's 14px axis role and scroll locally instead
of thinning dates, shrinking text or scaling an old SVG. Isolated observations
may use a small dot; never connect across an unknown day. Author rows remain
aligned. Keep "Search and retrieval" whole, moving its value/bar below when
needed. Avoid explanatory subheaders: titles, named measure controls and units
carry the meaning; consequential uncertainty stays visible. Use "Tool calls"
for the daily-call widget. Collapsed widgets show their title, applied range and
sizing controls, never metric figures or explanatory labels. Keep row heights consistent.
Center sizing glyphs in separate targets of at least 44px, with an 8px gap;
do not offset the glyph independently of its hover or focus surface.

Count/share widget rows show the percentage first, then the count in parentheses.
Use the complete qualifying population, never the visible rows or largest bar.
Response models use all matching interactions, including missing model names;
models and services can overlap. Live period outcomes keep their pre-outcome-filter
denominator and comparison precision. Time-bucket totals, standalone totals,
durations, unavailable or incompatible shares, exact-data columns and frozen
report presentation keep their own meaning.

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
