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
| <a id="compare-periods"></a>Compare periods | [Ranges and chart actions](interaction-design.md#compare-periods) |
| <a id="settings-collection-and-consequential-actions"></a>Settings, collection and consequential actions | [Setting search, account and confirmation behavior](interaction-design.md#settings-collection-and-consequential-actions) |

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

Outcome words/icons accompany color. Completed calls use the current success
role; failures use red, partial states retain their separate warning role and
missing evidence stays neutral. Service colors identify services, not health.
Agent and user authorship use their own roles, not service or quality colors.
Forced colors retain explicit words, shapes and system focus.

Current palette, material roles, font scale and geometry live in
[`web/tokens.mjs`](../web/tokens.mjs) and the existing component styles.
Dark screens use the ink-blue material roles.
Screen-only `screenTokens` and `screenFontStack` stay separate from
report-facing tokens, typography and frozen output.

### Icons and controls

Decorative glyphs fit their text line without acquiring control-sized
whitespace. Keep official Lucide's 24-unit viewBox; painted navigation glyphs
use 18px at the default text size, reader utilities and chart labels use 18px,
and compact cues retain their 16px role. Other established utility roles remain
20px. The simple panel-left glyph keeps its changing accessible expand/collapse
name and state.
Interactive targets stay usable independently of their smaller painted face;
preserve the established 44px targets, focus indications and wrapping labels.

Toolbar buttons, selects and numeric fields use a compact painted face inside
their full target. Keep text/icon baselines aligned and let targets grow with
enlarged text. Number fields size to their page digits rather than taking a
wide fixed slot. A direct page jump keeps its native validation, Enter behavior
and visible Go to page action. PDF paging keeps its existing commit behavior.
Checkboxes and switches use the setting-state color, not outcome green.
Keep hover, pressed, selected and keyboard focus distinct; a smaller painted
control is not permission to remove its focus ring or hit area.

### Brand assets

The screen and README use the selected Magenta Human Path symbol and custom
WIRE path lettering in the self-contained `wire-lockup` SVGs. There is no
expanded-name tagline in the artwork; the README explains Work IQ Request
Explorer in surrounding text. The application keeps Asta Sans for ordinary UI.

`assets/wire-brand.json` is the current vector artwork and palette source.
Regenerate current lockups and compact icons with
`node scripts/build-brand-lockups.mjs`. The full and compact assets share
symbol coordinates so the sidebar glide stays registered. The favicon supports
the system color scheme; the inline compact mark follows WIRE's chosen theme.

The older `wire-wordmark` SVGs are immutable historical report inputs. New
reports declare `presentation.brandVersion: 1` for the Human Path identity.
Preserve old assets, rendering and theme handling when adding a later identity;
do not apply current branding globally to historical report snapshots.

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
