# Product design

WIRE helps a person recognize a recorded request, inspect what happened and
choose evidence for a report. Design around those reading and decision tasks,
not around the implementation's status objects.

This reference covers shared screen design. For a particular screen's controls,
states and return behavior, use [Interaction design](interaction-design.md).
Evidence definitions and frozen-file requirements remain in the
[report contract](report-contract.md).

**Contents:** [Find a screen's behavior](#find-a-screens-behavior) ·
[One coherent workspace](#one-coherent-workspace) ([dates](#dates)) ·
[Reading hierarchy](#reading-hierarchy) ([interaction cards](#interaction-cards),
[surfaces and color](#surfaces-and-color), [icons and controls](#icons-and-controls),
[brand assets](#brand-assets)) ·
[Chart reading](#chart-reading) ([Trends layout](#trends-layout),
[workspace toolbar](#workspace-toolbar), [count and share rows](#count-and-share-rows)) ·
[Motion, focus and text](#motion-focus-and-text) ·
[Check a screen change](#check-a-screen-change)

## Find a screen's behavior

| Screen or task | Reference |
| --- | --- |
| Navigation and return state | [Destinations, loading and Back](interaction-design.md#navigation-and-return) |
| <a id="analyze-and-filters"></a>Analyze and filters | [Accepted scope and chart reading](interaction-design.md#analyze-and-filters) |
| Trends | [Daily measures, comparisons and supporting calls](interaction-design.md#trends) |
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
dialog for a distinct task or a decision that must be resolved before
continuing.

### Dates

Reports, Trends, Compare and Analyze Filters use the same Dates control.

- Show the applied range on the closed button.
- Keep the presets visible when Custom dates expands.
- Inside Analyze Filters, expand in place rather than opening another panel.
- Reuse the same labeled fields and calendar when choosing dates for **Delete
  collected activity** or **Read history again**. Embed the editor in the
  operation itself. Choosing dates doesn't preview, delete or reread anything.
- Single-day recovery shows **Day** instead of a second, unused field.
- Settings defaults choose a rolling duration; saved report dates describe a
  frozen report. Neither is a date picker.

Routine controls, tooltips and chart captions inherit the Regional time zone
without repeating it. Show the zone when choosing it, explaining a fallback or
mismatch, or reviewing exact operation bounds or saved report metadata.

| Surface | Reading and navigation role |
| --- | --- |
| Sliding left sidebar | Analyze, Trends, Reports and Compare as peer destinations; Documentation above the account, Help, Feedback and Settings controls |
| Expanded, collapsed and narrow navigation | Same nodes and destinations; Settings works without a profile |
| Analyze | Charts and one interaction list; report selection stays independent of browsing |
| Trends | Eight visible measure names beside one daily chart; optional aligned charts share the accepted period |
| Right contextual surface | Interaction reader and prepared report preview; Close or Back returns to the original task |
| Main workspace | Report setup, saved library and verified saved reading |

Opening the contextual surface reduces the main column's actual width.
It does not scale content or mount a second reader; narrow/enlarged layouts
use the same native modal.

## Reading hierarchy

| Element | Visual treatment |
| --- | --- |
| Screen type | Bundled Asta Sans and shared screen roles |
| Failure reasons and action guidance | Regular body type (`--type-body`) with 1.5 line height. Keep reasons distinct from timestamp captions; do not shrink an action's consequences into fine print. |
| Settings task headings | Peer tasks use the same strong reading-size heading (`--type-reading`), whether the control is a button or a gallery. |
| Documentation navigation | Group titles use strong section type above the guide links. Indent the current guide's section links; the selection mark shows where the reader is, not a new group. |
| Metadata label/value | Same regular weight and size; use placement and neutral label contrast for hierarchy |
| Prompt | Regular, not bold italic |
| Exact code and API path | Deliberate monospace |
| Icon | [React Icons](https://react-icons.github.io/react-icons/), Lucide family, official 24-unit viewBox |

Keep the label with its value, the explanation with its evidence and the action
with its task. Missing optional facts need no empty row. Missing or conflicting
evidence that limits a conclusion must stay explicit. Don't repeat the same fact
in a badge, paragraph, warning and disclosure.

### Interaction cards

Author and date:

- Identify the prompt author with a high-contrast label and its Human, Agent or
  unverified icon.
- Align the date to the author's text baseline, not the icon. When it wraps,
  start it under the author text.
- On local Analyze cards the prompt is selectable text.

Outcome and **Problem** area:

- Below the prompt, keep the recorded outcome with the affected calls and their
  explanations.
- When a reason covers the full badge count, place its call numbers and tool
  beside that count.
- Use one **Problem** area for the card, with different reasons under their own
  call numbers. Omit the area on clean cards.
- Start each explanation at the same text inset and heading gap, and place its
  exact evidence link below it. A link's touch target must not push the
  explanation down or sideways.
- A code-only failure that repeats its entry's code need not repeat it on the
  card; the reader keeps both records. Missing reasons are plain text.
- Blue/check indicates recorded tool completion; coral/cross marks failed calls.
  Neither is a verdict on the prompt or the task. Returned issues keep a
  separate link.

Sources:

- When only the Copilot app supplies activity, omit the source picker and
  repeated source labels.
- Name the app when someone is choosing which history WIRE can read.
- Keep provenance in saved reports, and name a source on the card when it
  distinguishes activity.

Layout:

- Keep date and availability quieter.
- Group tool names separately from requested targets, operation and missing
  attribution. Keep the glyph beside its label.
- On Analyze, use a gutter between the prompt and the details. When they stack,
  use a horizontal rule above the details. Don't run a divider beside the report
  actions.
- In the card and call reader, align field labels with their first value and
  list targets vertically, one icon and name per line. In the reader the outcome
  belongs to the call, not to its targets.
- Keep the card's two actions with these facts, not beneath the taller of the
  prompt and metadata columns.
- Use the same text scale for labels, targets and operations.
- Name the recorded operation for the reader (for example **Reply-all draft**);
  its exact API path stays in the call reader.

### Tool names

In the Tools summary, show exact names as plain text without icons, badges or
bullets. These are list items, not filters or reader links.

- Keep a repeat count inside its tool's label, as in `workiq-retrieve (2 calls)`;
  a single call reads `workiq-fetch`.
- Wrap labels as units where they fit, and let long names break rather than
  truncate.
- On a returned result layer the unit is results, not calls.

Tool names and counts also use plain text in chart legends, filters, reader
headings and comparison tables. Keep the glyph for an operation such as **Asked
Copilot**, not for the tool identifier `workiq-ask`. Search keeps its
result-category icon; a link or disclosure keeps its navigation cue.

### Surfaces and color

Use one restrained screen hierarchy throughout the application.

- Routine Analyze charts have separate quiet surfaces with each heading inside
  its group.
- Use a visible tone boundary and restrained edge in both themes. Keep chart
  heights content-sized and avoid nested card frames around individual rows.
- Individual interactions stay distinct, and contextual readers and open menus
  carry the stronger surface.
- Resting panels have no drop shadow.
- Navigation uses neutral selection without an outlined card or redundant
  Workspace caption.
- Settings follows the shared page and section type scale.

#### React Analyze layout

The heading and controls, chart group, list heading and interaction list use the
same workspace edges as the sidebars resize.

- The charts and the list each have one rounded surface. A single divider
  separates adjacent rows, without individual card borders or shadows.
- The prompt leads and keeps its shorter reading measure. An adjacent identity
  key stacks below it in narrow columns.
- A tool failure and a separate returned issue each lead to their own evidence;
  routine rows need no four-state ledger.

The time chart, tool call results and usage each span the workspace in their
own row. Keep the daily call plot compact. Its labeled, linear axis starts
at zero and fits the dates in view; counts and outcome segments share it.

Give Analyze's activity and token charts the same card surface, heading inset,
column width and space between the baseline and its dates. Activity stacks
recorded outcomes and labels each total above its column. Token usage uses
one quantity color and a labeled token scale, with a baseline dot for a
measured zero and no mark for unavailable metering. Its reading and the
activity chart's tooltip share the floating surface, regular type and quiet
edge: exact date first, then the recorded count. Keep the pointer and date
axis clear; outcome colors still describe recorded completion or failure.

Label dates and counts on the time chart; the selected date range
belongs above the widgets. The four supporting breakdowns use paired,
content-sized columns, becoming a single column when needed.

Within a wide Work IQ tool calls or Response models card, four or more entries
read across in pairs: name, percentage and count together, bar underneath.
Narrow cards and shorter lists use one entry per row. Prompt authors always
uses one list. Services and operations keeps its service icons and bar layout.

#### Widget insets

Keep a balanced exterior inset above the first painted heading or control and
below the last painted row, track or axis label, including both model readings.

- Account for header hit areas, font leading and plot-frame whitespace rather
  than equating CSS padding alone.
- Use the established Services card as a peer. Don't stretch short cards or
  change plot scales to manufacture symmetry.
- The same rule applies to Trends' overview, chart and comparison-introduction
  cards.
- Settings forms, contextual dialogs and frozen report output keep their own
  spacing contracts.

#### Headings and the call reader

Screen headings use sentence case, including **Work IQ**. Keep branding, genuine
acronyms and recorded identifiers unchanged.

In the interaction reader, each call leads with its ordinal, tool and outcome.
Its returned entries form a subordinate group with aligned facts. Call service,
result service and their separate duration evidence keep their own meanings.

#### Outcome colors

Outcome words and icons accompany color.

- Card, reader, Analyze, Compare and Trends tool outcomes use a calm blue for
  recorded completion and a softened coral for failure. No result is a hatched
  neutral. Partial states keep a separate gold warning role, and missing evidence
  stays neutral.
- Every palette derives these from its own blue and failure hues in
  [`web/outcome-paint.mjs`](../web/outcome-paint.mjs): a deeper text shade for
  labels and a lighter mark shade for rings, strips and bars. Token counts and
  breakdown bars use one quiet quantity ink.
- Completion doesn't establish answer quality.
- Service colors identify services, not health.
- Agent and user authorship use their own roles, not service or quality colors.
- Forced colors keep explicit words, shapes and system focus.

Carry the role with the fact, not the page:

| Fact | Role |
| --- | --- |
| Recorded **tool completion** / **tool failure** | Text: `--tool-positive` / `--tool-negative`. Marks: `--tool-positive-mark` / `--tool-negative-mark` |
| Token counts and breakdown bars | `--outcome-quantity` |
| A **returned API issue** | `--screen-returned-issue`, even when its parent call completed |
| Partial or unconfirmed | `--warning` |
| Unknown | `--unknown` |
| Interactions with *either* kind of problem | A neutral chart ink, not a failure verdict |

Service and author colors identify the subject. Selected, pending and disabled
controls use interaction roles rather than success or failure colors.

#### Disclosure colors

- **Keep chat details** uses `--disclosure-risk` (red).
- **Mask detected details** uses `--disclosure-masked` (blue).
- Omitted text is neutral.

Use the same ink for the label, icon and action edge through the choice, preview
and confirmation. Tint a disclosure action with 7% risk ink mixed into its own
paper. A modal scrim dims only the background; never compensate by brightening
the underlying warning. A destructive commit has its own filled danger action.
These are screen roles, not new inks for saved documents.

#### Palettes and tokens

Current palette, material roles, font scale and geometry live in
[`web/tokens.mjs`](../web/tokens.mjs) and the existing component styles.

- Light screens use quiet cool-neutral surfaces. Dark uses separately designed
  petrol-neutral surfaces.
- Controls, selection and focus stay neutral rather than borrowing outcome
  colors.
- Dark service inks keep their identity hues with added lightness for contrast
  on selected surfaces.

Use tonal layers: give navigation its own rail, the workspace a ground, and
widgets and readers distinct reading surfaces.

- Charts need a track or plot well that stays legible inside the widget.
  Tool-name labels must not disappear when their enclosing row is selected.
- Test an outcome's text **on its fill**, and its fill and edge **against the
  actual card or reader**. A passing text ratio doesn't mean a layer is
  visible.
- Each palette's blue and coral still mean tool completion and failure; keep
  the check, cross and count.

Petrol & coral stays the default and the fallback. Settings > Themes separately
chooses Linen & graphite, Blueprint, Field notes or Midnight in either Light or
Dark.

- The screen palette catalog (`web/screen-palettes.mjs`) maps materials, control
  states, widget marks, series, services and authors to CSS roles.
- Names, result glyphs and count geometry aren't color-derived.
- The same roles paint compact, unbranded material samples without reading a
  user's activity.
- Screen-only `screenTokens` and `screenFontStack` stay separate from
  report-facing tokens, typography and frozen output.

### Icons and controls

Use the role map in `web/icon-roles.mjs` for navigation, actions, authors,
outcomes and services. A role identifies what the icon means, not its color or
file name. React controls and the static SVG adapter use the same React Icons
components and expose `data-icon-role` on the SVG.

- Keep icons decorative beside text. Give an icon-only control an accessible
  name on the control itself.
- Screen icons use a 1.5-unit stroke on Lucide's 24-unit grid, with round caps
  and joins. That gives a 16px cue a 1px line and a 24px heading a 1.5px line.
- Set weight in `iconProps`, not in page styles. Don't thin a glyph by fading
  it, shrinking its target or changing its weight when selected.
- Keep compact author and outcome cues at least 16px beside their text.

#### What a glyph means

- A circled check identifies a recorded success. A bare check at the trailing
  edge of an option marks the selected value, even if that value is a failure.
- Keep the leading glyph and its ink when hovering or selecting the row.
- Compare's mixed **Errors & failures** starting point uses an attention
  triangle, not a failed-call cross.
- Human and Agent prompt glyphs keep their author inks. A service glyph keeps
  its service ink even in Search, outside the chart legend.
- Navigation and ordinary actions inherit their control's ink; they aren't
  extra data categories.

Screen operation roles live in `web/operation-icons.mjs`. A recorded tool name
identifies the tool, not a service, a result or proof that a referenced API was
called.

- API discovery, schema lookup, agent discovery, retrieval and Copilot
  assistance use different glyphs.
- A named Graph action or function uses its own glyph only on a matching
  recorded action/function call.
- A schema argument, code reference, returned status or unknown name doesn't
  acquire an execution glyph.
- The role coverage test follows the analytics allowlists.

This rule is for screen glyphs, not all SVGs. WIRE and provider marks, profile
imagery, chart geometry and the versioned artwork embedded in reports keep their
own paint. Native form controls keep their platform affordances.

#### Glyph and target sizes

Decorative glyphs fit their text line without acquiring control-sized
whitespace. Keep official Lucide's 24-unit viewBox.

| Role | Painted size |
| --- | --- |
| Navigation glyphs at the default text size | 18px |
| Reader utilities and chart labels | 18px |
| Compact cues | 16px |
| Other established utility roles | 20px |

- The header's simple 20px panel-left glyph sits beside the brand and keeps its
  changing accessible expand/collapse name and state. Its 44px target stays
  beside the compact mark without widening the collapsed rail or reserving an
  empty navigation row.
- Interactive targets stay usable independently of their smaller painted face.
- The footer's three utilities use 32px-wide, 44px-high targets in a horizontal
  row on fine-pointer devices without touch. Touch and the stacked rail keep
  44px squares.
- Preserve focus indications, wrapping labels and the width available for the
  account name.

#### Evidence links and openers

- On activity cards, a trailing arrow opens supporting evidence.
- A completed count opens all the calls it counts, preserving any filter and
  original call numbers. A failure opens its recorded call; a returned issue
  opens its own entry.
- Hover and press tint only the arrow; keyboard focus outlines the link.
- Use the shared tooltip on an outcome link, anchored to its arrow.
  Noninteractive outcome labels have no arrow.
- Prompt openers keep the passage itself unpainted and selectable. Their eye cue
  signals reading; hover and press change the cue, not the text. Don't put a
  tooltip over the passage.
- Call disclosures similarly emphasize the chevron.

#### Choice fields

- Align the leading icon to the *first line* of the value. Use the same glyph
  slot and text gap in the popup and closed field.
- The trailing chevron belongs at the field edge, not next to the last word.
  Reserve one centered 16px Lucide chevron, an 8px gap and a 12px trailing
  inset.
- Choice fields use the screen field radius.
- A native picker keeps its native input, keyboard and touch behavior. Replace
  only its painted arrow; never show both.
- An open listbox points up; a dialog opener is still a button.

#### Page headings

The main Analyze, Trends, Reports and Compare headings use their existing
navigation glyph, at 24px with a 10px text gap. Keep the heading and focus node
mounted and update its text separately. These icons are decorative, not extra
controls. Settings, contextual readers and saved report headings don't acquire
one.

#### Button treatment

Choose the button treatment by what happens **here**, not by its label or HTML
tag.

| Treatment | Use |
| --- | --- |
| Filled | The main next step (for example **Prepare preview**). Fill doesn't mean a file was saved. |
| Outline | A secondary command such as **Choose chats**. |
| Cautionary outline | **Review deletion**. Reserve the filled destructive treatment for the final deletion. |
| Quiet link with a trailing arrow | A shortcut to another workspace. |

Green on an eligible update means an update is available, not that it has run.
Tabs, switches, icon-only utilities and chart marks keep their own interaction
patterns.

Use the shared `.primary` role for a filled CTA, including in studies using WIRE
styles.

- Its label and inset `::before` face need the same role. Changing only the text
  color can leave white lettering on the ordinary paper face.
- Check contrast against the **paint under the letters** in rest, hover, press,
  focus and pending states, including ancestor opacity.
- Keep normal-size button text at 4.5:1 or higher. When disabled, mute the
  boundary, not the legibility.

#### Text actions and hover paint

Ordinary text actions share an 8px corner, 12px side padding and an 8px
icon-to-label gap.

- At default text size a 32px face sits inside a 44px target. Let the target
  grow with wrapped or enlarged text.
- Keep widths content-sized and preserve geometry when focus, hover, press or
  pending paint changes.
- Hover and press tint the existing face, not the transparent space around it.
- For a directional row, keep its arrow visible and tint its surface or ink on
  hover and press. Don't underline or embolden the label. Keyboard focus keeps an
  outline.
- The underline below an active section marks location. An underline inside
  prose or evidence identifies a link even without hovering.

Keep hover paint close to its subject. Section links highlight just the icon and
label; sidebar utilities highlight a small face around their glyph, not the full
target. A navigation or search result row can highlight its whole surface when
activating anywhere on that row opens the same item.

#### Switches

Use the same 44×26px track and round, sliding thumb for a binary setting.

- Keep its target at least 44px high. On and off are visible in position and
  theme-aware contrast.
- In the header and Settings, the theme switch leaves 10px between its 16px sun
  and moon. Its 20px disc centers on the selected icon, with 4px of space inside
  the track border.
- Disabled inputs keep their state, with a dashed boundary. Pending copy stays
  with the setting.
- A list option, radio, disclosure or section link isn't a switch.

A reply-saving draft previews the requested choice:

1. From submission until confirmation, the switch shows the last confirmed
   setting. An unknown outcome isn't a rejection.
2. After Save, the switch shows the confirmed choice but stays disabled until
   WIRE rereads the source and its reply-saving settings.

#### Toolbars, fields and choice rows

- Toolbar buttons, selects and numeric fields use a compact painted face inside
  their full target. Keep text and icon baselines aligned, and let targets grow
  with enlarged text.
- Number fields size to their page digits rather than taking a wide fixed slot.
- A direct page jump keeps its native validation, Enter behavior and visible Go
  to page action. PDF paging keeps its existing commit behavior.
- Checkboxes and switches use the setting-state color, not outcome colors.
- On painted choice rows, leave the same 12px inside the leading and trailing
  edges as in filter menus. Dense chart legends use the smaller 8px inset and
  keep their value tracks separate.
- Align a leading radio or checkbox with the **first line of the label**, not
  the middle of its explanation.
- The label owns the full target. Enlarging the target shouldn't stretch the
  glyph.
- Keep hover, pressed, selected and keyboard focus distinct. A smaller painted
  control isn't permission to remove its focus ring or hit area.

#### Control panels

Compare a new control panel with the **Trends > Dates > Custom dates** editor and
the **Reports → Formats** menu.

- A field label belongs above its input, clear of the painted focus ring.
- A checkbox label belongs beside its box within one clickable row.
- Align peer field edges, give groups more room than a label and its value, and
  align Apply/Cancel to the panel's trailing inset.
- Reflow fields when text grows rather than shrinking labels or widening every
  panel.
- Check keyboard focus on each field in the *open workspace*, not only in a
  crop.

### Brand assets

The screen and README use the selected Magenta Human Path symbol and custom
WIRE path lettering in the self-contained `wire-lockup` SVGs.

- There's no expanded-name tagline in the artwork; the README explains Work IQ
  Request Explorer in surrounding text.
- The application keeps Asta Sans for ordinary UI.
- Hover or keyboard focus on the existing logo-home link shows **WorkIQ Request
  Explorer** through the shared tooltip owner. This brand description stays
  separate from the neighboring navigation control's help.

`assets/wire-brand.json` is the current vector artwork and palette source.
Regenerate current lockups and compact icons with
`node scripts/build-brand-lockups.mjs`.

- The full and compact assets share symbol coordinates so the sidebar glide stays
  registered.
- The favicon supports the system color scheme; the inline compact mark follows
  WIRE's chosen theme.
- Contours use deliberate lines and curves, not pixel-by-pixel raster traces.
- Inspect at README size and enlarged scale as well as in the compact sidebar.

The older `wire-wordmark` and `wire-report-brand-v1` SVGs are immutable
historical report inputs.

- New reports declare `presentation.brandVersion: 2` for the clean-contour Human
  Path artwork.
- Version 1 keeps the original Human Path rendering; unversioned snapshots keep
  the older wordmarks.
- Don't apply current branding globally to historical report snapshots.

## Chart reading

| Measure | Encoding |
| --- | --- |
| Amount | Linear from zero, without perspective, minimum slices or inflated tiny bars |
| Zero | No data paint |
| Overlapping service associations | Bars, not a 100% composition |
| Exclusive recorded outcomes | May use a ring |
| Tiny mark | Exact counts and accessible table links remain usable |

### Hover and readings

Every chart mark, legend row, value and bar uses one reading on the shared
floating surface: the name first, then the share with its count of the true
denominator, then what the row means.

- Reading a mark keeps its exact geometry. Other marks in the same chart recede;
  never add a stroke, brightness change, scale or plate.
- A reading never covers the figures it explains or a neighbouring control. Rows
  with a bar read above the bar.
- The ring's total is part of the ring: a circular target in the hole with an
  ink change and a hairline circle, never a tile behind the figures.
- Paper gaps separate ring slices and stacked segments without widening them.
- Trends lines mark only where a run ends or stands alone; the day being read
  gains its point and a dashed guide.
- Readings fade in briefly; reduced motion shows them at once.

[Analyze Guide](interaction-design.md#chart-guide) connects values to definitions
and exact evidence. Trends has its own [Chart guide](interaction-design.md#trends).

### Trends layout

Trends places a visible measure index beside the working chart.

- At narrow widths the names wrap above the chart, not into a chooser.
- Errors & failures comes first. A fresh sidebar entry starts on Overview with
  Errors & failures.
- The section row pairs each icon with a label; an underline identifies the
  current section.
- Keep the dated population beside the measure name. An incomplete service name
  is a limit on that count, not a general warning below every chart. Put the
  counting details in View daily values.

### Marks and series

Named legend controls change what is drawn without changing the population.

- Columns use a zero baseline. Center each day's bars together above its date,
  in legend order. A service with no bar must not leave a hole between its
  neighbors.
- Keep numeric labels on their bars, with names in the legend and exact reading.
- Straight lines use the same observations; a missing measurement breaks the
  line.
- Chart type, unit, population and selection are independent.
- Select a value to reach its exact calls without maximizing.

### Workspace toolbar

Keep workspace commands at the right content edge on Analyze, Trends and
Compare. Keep accepted scope on the left where it adds information; don't repeat
it just to fill the row.

- Filters uses the same outlined button.
- Keep Guide with navigation and display choices by the measure title.
- The plot shares the chart card's surface, not a second palette-colored
  rectangle.
- An empty period uses a compact dated explanation and optional jump to real
  activity.
- Dates opens the 7/14/30/custom choices. Never substitute a pending date or
  filter for the last accepted facts.
- Compare measures uses one accepted scope for both series. Overlay only
  matching units and denominator bases; otherwise align dates on separate
  scales.
- **Show or hide charts** belongs in the workspace toolbar. Its checkboxes add
  separate charts below the selected measure; **Open all charts** opens the
  full-width stack with sizing controls.

### Axes, labels and collapsed widgets

The same chart owner serves overview and maximized reading.

- Daily ticks use month and day, except Today. The compact index may show fewer
  tick labels while keeping the full set of dated marks. Hover supplies the exact
  date.
- Measure label widths at the screen's 14px axis role, and scroll locally instead
  of thinning dates, shrinking text or scaling an old SVG.
- Isolated observations may use a small dot. Never connect across an unknown
  day.
- Author rows stay aligned. Keep "Search and retrieval" whole, moving its value
  and bar below when needed.
- Avoid explanatory subheaders: titles, named measure controls and units carry
  the meaning. Consequential uncertainty stays visible.
- Use "Tool calls" for the daily-call widget.
- Collapsed widgets show their title, applied range and sizing controls, never
  metric figures or explanatory labels. Keep row heights consistent.
- Center sizing glyphs in separate targets of at least 44px, with an 8px gap.
  Don't offset the glyph independently of its hover or focus surface.

### Count and share rows

Count/share widget rows show the percentage first, then the count in
parentheses. Use the complete qualifying population, never the visible rows or
largest bar.

- Response models use all matching interactions, including missing model names.
  Models and services can overlap.
- Model rows show a display name formatted only from a fully recognized recorded
  ID (for example GPT-5.1 or Claude Sonnet 4.5). An unrecognized ID is shown
  exactly and never merged or renamed; Analyze labels it Unrecognized model, and
  its reading says WIRE has no display name. The recorded ID appears on hover and
  keyboard focus; filters, saved reports and attribution keep it unchanged.
- Live period outcomes keep their pre-outcome-filter denominator and comparison
  precision.
- Time-bucket totals, standalone totals, durations, unavailable or incompatible
  shares, exact-data columns and frozen report presentation keep their own
  meaning.

## Motion, focus and text

The left rail, narrow drawer, Filters, Chart guide and right contextual surface
share a reversible 320ms glide.

- This navigation policy runs under either browser motion preference and has no
  separate user setting.
- Other controls and reader folding keep their own reduced-motion behavior.
- Don't change operating-system preferences.

Menus enter with a short opacity fade, and controls use restrained paint
transitions.

- Selected navigation and open selects may have a faint top sheen. Don't apply it
  to data marks, resting panels or frozen reports.
- Added decorative motion is removed under reduced motion.
- Don't animate an exit at the expense of immediate private-content clearance.

Docked motion changes actual main-column geometry on the same clock, including
reversal. Anchor compensation yields to new input. Replacement keeps the current
owner rather than replaying entrance; authority loss clears private content
immediately instead of keeping an exit animation.

| Interaction state | Treatment |
| --- | --- |
| Hover, persistent selection/current page, keyboard focus | Visually distinct meanings |
| Tooltip | One dismissible, hoverable owner on the floating surface; no obscured action |
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
