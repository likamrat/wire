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

| Surface | Reading and navigation role |
| --- | --- |
| Sliding left sidebar | Analyze, Trends, Reports and Compare as peer destinations; Account/Settings at the bottom |
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
| Metadata label/value | Same regular weight and size; use placement and neutral label contrast for hierarchy |
| Prompt | Regular, not bold italic |
| Exact code and API path | Deliberate monospace |
| Icon | [React Icons](https://react-icons.github.io/react-icons/), Lucide family, official 24-unit viewBox |

Keep the label with its value, the explanation with its evidence and the action
with its task. Missing optional facts need no empty row. Missing or conflicting
evidence that limits a conclusion must remain explicit. Do not repeat the same
fact in a badge, paragraph, warning and disclosure.

On interaction cards, identify the prompt author with a high-contrast label
and its Human, Agent or unverified icon. Put recorded tool outcomes in the
same second header slot, above the prompt, for every author. Green/check
indicates recorded tool completion; red/cross marks failed calls. Neither
is a verdict on the prompt or the task. Returned issues keep a separate link.
Keep provenance in Source details; name a source on the card when
it distinguishes activity. Keep date and availability quieter. Group tool
names separately from requested targets, operation and missing attribution. Keep
the glyph beside its label. Separate the identity key from the prompt with a
rule; inside a field, grouped names wrap back to one value edge without
separators. Show repeats with a readable unit such as “2 calls.” On a returned
result layer the unit is results, not calls. The reader retains every record.

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

The React evaluation pairs its compact overview above full-width interaction
rows. In the Work IQ list the prompt leads. An adjacent identity key stacks below
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

Current palette, material roles, font scale and geometry live in
[`web/tokens.mjs`](../web/tokens.mjs) and the existing component styles.
Light screens use quiet cool-neutral surfaces; Dark uses separately designed
petrol-neutral surfaces. Controls, selection and focus remain neutral rather
than borrowing outcome colors. Dark service inks retain their identity hues
with added lightness for contrast on selected surfaces.
Petrol & coral remains the default. Settings > Themes separately chooses
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
Retain WIRE branding, authorized profile imagery and actual chart data marks
as their own assets: none is a substitute for an action or an outcome.

Decorative glyphs fit their text line without acquiring control-sized
whitespace. Keep official Lucide's 24-unit viewBox; painted navigation glyphs
use 18px at the default text size, reader utilities and chart labels use 18px,
and compact cues retain their 16px role. Other established utility roles remain
20px. The header's simple 20px panel-left glyph sits beside the brand and keeps
its changing accessible expand/collapse name and state. Its 44px target remains
beside the compact mark without widening the collapsed rail or reserving an
empty navigation row.
Interactive targets stay usable independently of their smaller painted face;
preserve the established 44px targets, focus indications and wrapping labels.
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
trailing chevron belongs at the field edge, not next to the last word.

The main Analyze, Trends, Reports and Compare headings use their existing
navigation glyph, at 24px with a 10px text gap. Keep the heading/focus node mounted
and update its text separately. These icons are decorative, not extra controls.
Settings, contextual readers and saved report headings do not acquire one.

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
first; a fresh sidebar entry starts on Tool calls. Keep the dated population
beside the measure name. An incomplete service name is a limit on that count,
not a general warning below every chart. Put the counting details in Data table.
Named legend controls change what is drawn without changing the population.
Columns use a zero baseline and a separate bar for each series, even when
services or models overlap. Straight lines use the same observations; a missing
measurement breaks the line. Chart type, unit, population and selection are
independent. Select a value to reach its exact calls without maximizing.

Period opens the 7/14/30/custom choices. Never substitute a pending date or
filter for the last accepted facts. Compare measures adds charts on the same
dates without copying a second scope. **All charts**, available within the
comparison chooser, retains the full-width overview and its sizing controls.

The same chart owner serves overview and maximized reading. Every daily date
is labeled with month and day, except Today; hover supplies the exact date.
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
