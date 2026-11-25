# Use WIRE

Use WIRE to inspect recorded Work IQ activity, find saved text and prepare
reports from your local GitHub Copilot app history.

Follow [setup](../README.md#getting-started) first. For WSL or a second instance beside
Windows, see [platform setup](development.md#windows-wsl-and-linux).

**Contents**

- [Pages and addresses](#pages-and-addresses)
- [Connect local history](#connect-local-history)
- [Analyze](#analyze): [charts](#read-the-charts), [prompt authors](#prompt-authors),
  [failed calls](#failed-calls-and-returned-entries), [filters and dates](#filters-and-dates),
  [services](#services-and-operations), [activity over time](#activity-over-time),
  [token usage](#token-usage), [Guide](#analyze-guide), [homepage layout](#homepage-layout)
- [Inspect an interaction](#inspect-an-interaction): [calls and results](#calls-and-results),
  [tokens](#tokens-and-returned-text), [prompt sender](#prompt-sender),
  [reader size](#resize-or-maximize-the-reader), [hide and restore cards](#hide-and-restore-cards)
- [Trends](#trends): [period and activity](#choose-the-period-and-activity),
  [measures](#read-the-measures), [inspect a change](#inspect-a-change),
  [several charts](#show-several-charts)
- [Compare](#compare)
- [Make a report](#make-a-report)
- [Find saved text](#find-saved-text)
- [Settings](#settings): [search settings](#search-settings), [update WIRE](#update-wire),
  [themes](#themes), [defaults](#wire-defaults)
- [Collection, privacy and account](#collection-privacy-and-account)
- [Help, Feedback and the sidebar](#help-feedback-and-the-sidebar)

## Pages and addresses

**Analyze is the home page.** Open the address printed by WIRE as-is. Trends,
Reports, Compare and Settings have their own addresses (`/trends`, `/reports`,
`/compare` and `/settings`). You can bookmark a page or a Settings category.
Dates and filters change the results, not the address. Copying the address opens
the destination in a fresh tab with its own defaults, not your filtered results.
Older date and filter links still open their original scope with a clean address.

You can copy an ordinary interaction's address or refresh its reader. WIRE
opens the same record only if it is still available in the same local store.
The address does not contain its chat or record ID. Search words, exact calls
and source-specific filters are private. Use **Back** in the same tab to return to them.
If you refresh or copy a private view, WIRE may ask you to reopen its original
record or repeat your Search rather than showing a broader result.

## Connect local history

WIRE prompts you to connect when you first open an unconfigured instance.

1. Choose **Review and connect** in the welcome. **Not now** closes it and leaves
   the connection prompt in Analyze. You can also use **Settings > Source
   access > Review source & connect**.
2. Check **Copilot metadata database** and **Chat history folder**. These must
   point to the supported local Copilot installation whose history you want to read.
   Choose **Change paths** if either location is wrong.
3. Choose **History to include** and **Check frequency**, then select
   **Approve source and start collection**.
4. Choose **View activity** to open Analyze. The first read may take a few
   minutes; activity appears as it is saved. If expected calls are missing,
   open **Collection status** to see known history gaps.

![The first-use welcome offers Review and connect or Not now.](images/first-connection.png)

The welcome stays dismissed in this browser at this WIRE address. Dismissing it
does not connect a source. Configured instances open normally, and Pause stays
paused. A missing source or failed read shows its own explanation instead of
asking you to keep waiting.

If Settings says the source settings were not saved, correct the paths or
restore local access and approve again. If it says the change is **unconfirmed**,
read the current connection first; do not repeat the write.

Repeat source approval in each independent instance. They keep separate
collection progress, settings, consent and saved reports. Collection can be on
while older history is still catching up; **Collection status** shows pending,
blocked, missing or bounded history rather than guaranteeing complete coverage.

Approval lets WIRE read that local history; it does not rerun prompts or make
new Work IQ requests. WIRE does not connect to Microsoft 365 Chat or Cowork.
Saving Copilot reply text is a separate choice under
**Settings > Privacy & saved data > Recorded replies** and starts off.

<a id="read-the-overview"></a>

## Analyze

**Analyze** shows recorded outcomes, activity over time, token usage, tools,
services and available response-model names, plus prompt authors. The
interaction list follows the same filters. Open **Filters** to narrow the view
by Dates, Tool, Service involved, Outcome or Prompt author; **More filters**
holds the additional choices.

![Analyze Results with daily tool calls, recorded outcomes, daily token usage and the interactions behind them.](images/analyze.png)

### Read the charts

On opening Analyze, the charts build to the recorded counts. This is not collection progress.
With reduced motion, the final values appear immediately. In **Tool call results**,
the donut shows the total. The strip shows how the calls split across outcomes;
each label gives the percentage and exact count, even for a share too small to see.
Choose the donut total to list the matching calls, eight per page. Open a call
by its tool or path. Its outcome describes the tool execution; returned entries
keep their own statuses in the call reader. **Show all matching activity**
returns to the interaction list.

Hover or focus a chart row for its meaning. Select a model or author to see
matching interactions. Select an outcome or a segment of a dated bar for
that result; the number above the bar includes all results for the interval.
A zero opens the chart definition instead of a list of records.

An interaction groups a prompt with its recorded calls. One interaction can
contain several calls, and one call can involve several services. Service
shares can therefore overlap. Tool completion means the source recorded
completion, not that the answer was correct. Returned API entries, Graph call
sites and HTTP recorder captures have their own units; do not add them to
tool-call totals. Missing model names mean no name was recorded, not zero usage.
Breakdowns show the percentage first, with the count in parentheses. On wide
tool and model cards, read each pair from left to right, then down. Model
percentages use all matching interactions, including those without model names;
an interaction with several recorded models counts under each.

### Prompt authors

**Prompt authors** counts each originating interaction once across all matching
pages. **Human prompts** came from a person; **Agent prompts** came from an
agent. **Sender unclear** means WIRE can't tell which one sent the prompt from
the saved record. Select that row to see the reason on each card. These prompts
still count. Calls and follow-ups do not add prompts, and missing prompt text
alone does not make the sender unclear.
In the reader, **Source** distinguishes a direct link to the prompt from
grouping by message order. Seeing a skill or system message before a call
doesn't tell you who asked for the work.

### Failed calls and returned entries

Find the prompt in the list and follow its outcome link to see the tools,
services and results in the right-hand reader. A note such as **1 tool call failed** or
**Reported result issue** helps identify exceptions. These are different:
a completed tool call can return an error for an individual item.

On an Analyze card, **2 tool calls failed** opens both failed calls. The
**Problem** area names the affected calls and shows what went wrong. If no
reason was saved, the card says so.
**Returned entry 2 · HTTP 400** opens that particular result, not the first
error or another entry with the same status. Open the reader for the full retained
wording, code and status. A completed tool can still return an error. A missing
completion does not establish that anyone cancelled the call.

### Filters and dates

In Analyze Filters, Trends, Reports and Compare, open **Dates** to choose a preset.
Choose **Custom dates** to edit below the presets. **Apply dates** uses your range;
**Cancel** keeps the previous one. In Compare, select a period's date label to
edit just that period. Dates filter retained activity; they do not approve older source reads.
Custom dates include both days in the time zone chosen under
**Settings > Regional > Time zone**. Select a start and end on the calendar,
or type them. Today is the latest date you can use. **This week** and **This
month** also end today. Missing history and records without qualified
times remain explicit. No matches means
no matching retained evidence, not proof that no activity occurred.

Author and Outcome choices remain a draft until **Apply**. **Reset filters**
clears browsing restrictions, not collected activity or report selections.

Open **Filters** to check how much history WIRE has checked. A routine partial
check stays there while results are available. An empty result can explain
what history was checked; an actual read error still appears with the results.

To read one conversation, open **Filters**, expand **More filters** if needed,
and choose **Chat**. Type part of its title in a long list, then choose the
row. Typing narrows the choices; Escape leaves the selection alone. A chat is
a conversation recorded by the Copilot app. A WIRE sign-in session controls
access to this local instance. Choosing a chat does not switch accounts,
sign out or read new history.

### Services and operations

In **Services and operations**, **Search endpoint** means the recorded path
identifies a search endpoint. **Search requested** means the tool requested
a search without naming a target app. **Business app not named** means the
recorded path was `/businessapps/me`; WIRE cannot identify the app. Each row
opens its matching records. A call with several targets can appear in more
than one row.

On an interaction card, an operation or service detail with a right arrow
opens the matching call. **API discovery**, for example, opens the call that
looked for available paths, not a later call that fetched data. Without a
matching retained call, the label has no link. **Exchange ID conversion** identifies a request to
convert item IDs; it does not identify the mailbox item. If several calls match,
the link says **first of N calls**.
In the reader, expand a numbered call to see its target and result.
To inspect a path, use **Guide > Paths and operations > See exact numbers**,
select the path or batch, then inspect the matching interaction. Read the targets and
outcome on the individual call rather than inferring them from the interaction summary.

### Activity over time

The **Work IQ tool calls over time** chart shows individual calendar days by
default, even with All dates or a long range. If the days don't fit across the
chart, scroll horizontally to see the other days. Long timelines show up to 90
intervals at a time, starting with the latest dates. Scroll within that window,
or use **Earlier dates**, **Later dates**, **First dates** and **Latest dates**
to reach the rest. The window names its dates; totals and filters still cover
the whole selected period. Paging does not change which interactions a report includes.
If an old link points outside the current dated activity, **First dates** or
**Latest dates** returns to its recorded dates without clearing your filters.
**Guide > Activity over time > See exact numbers** has the window's exact
daily rows and the full selected-period dated total.
A zero is no qualifying retained calls that day, not proof that no
activity occurred. Undated calls stay outside the timeline. Existing links
that explicitly request weekly or monthly grouping keep that interval when dates
change. Compare's separate Day/Week/Month control does not change Analyze.

### Token usage

**Token usage** labels each day in the chosen range, including
days without a count. Scroll along the date axis on narrow screens or long
ranges; periods over 90 days have earlier and later windows. Each measured day
has a vertical column. Hover over a column
to see its date and token count beside the pointer. Tap a day or use the arrow
keys to inspect it. A dot on zero is a measured zero. For a gap,
the date reading distinguishes activity without a count from no matching activity.
WIRE leaves gaps between measured days; it doesn't estimate the missing usage.
Click or tap to hold a reading, then select its date to open the evidence in
Trends. Choose **View by day** for the whole period.

Choose **Most tokens** in **Sort** above the Analyze list to find the
interactions that used the most. Each metered card shows its total.
In **Response models**, choose **Token share** to compare each model's share
of the recorded tokens. Select a model to see only the interactions with token
counts for that model. **Interactions** also includes uses without token counts.

In **Interactions** mode, choose a model to show its cards. Open **Filters** to
see or remove that model under **Applied filters**. This narrows the card list;
the chart still shows all models in your date range and other filters.

### Analyze Guide

Under **Analyze**, choose **Results** to inspect activity or **Guide** to read
about recorded outcomes. The underline marks the current section. **Refresh**
and **Filters** apply to Results and stay out of the Guide.
Pick another topic beside the explanation, or use **Topics** on a narrow
screen. Worked examples illustrate distinctions such as a completed call
returning an error for one item; they are not records from your activity.
Choose **See exact numbers** for values in your current scope and matching
records where available. Choose **Results** or use browser Back to return to
the same filtered results and reading position. In
**Settings > Analyze > Open Guide to**, you can choose recorded outcomes (default)
or the last topic read in this tab. This preference does not change the charts.

<a id="analyze-homepage-layout"></a>

### Homepage layout

Use the arrow at the right of any Analyze widget, including Interactions, to
collapse or expand it. Its heading and View trend or View by day link stay
available. Collapsing does not hide individual interactions, change report
selection or filter the data. Your choices stay while you browse in this page;
reloading starts with every widget expanded.

In **Settings > Analyze > Homepage layout**, use the arrows to move a widget or the
**Interactions** list. The preview outlines the section you moved and shows which
breakdowns share a row. The time chart, tool call results, token usage and
Interactions each keep their own row.
Your browser remembers each move. Choose **View Analyze** to open the homepage.
**Restore WIRE Default Layout** returns the sections to their original order.
An older custom layout keeps its order and adds the usage widget at the end.
**Default interaction sort** sets the starting order; sorting above the list
changes this visit only. Neither setting changes your filters or activity.

## Inspect an interaction

The count above the cards follows your filters. **Collection status** shows
the contributing chats, projects and source coverage. An actual coverage
warning stays beside the affected activity.

Hover highlights the card, but the card itself is not a link.
Select the outcome below the prompt preview to open
the right-hand reader. Hover over its arrow or focus the link to see **View call details**.

![The View call details tip beside 1 tool call failed on an Analyze card, with the failed call and its returned HTTP 403 in the reader.](images/interaction.png)

### Calls and results

In the reader, choose **Prompt** to read and copy the retained original.
**Human prompt**, **Agent prompt** or
**Sender unclear** describes the prompt’s origin, not its app. A label such
as **1 tool call failed** opens the failed call; it does not mean the whole
request failed. **4 tool calls completed** opens those four calls. If filters
exclude other calls, they stay out of that list. A completed call can still
contain a returned API error. Repeated tools show a count with its unit. Tools, requested targets and operations
are separate; a search or Copilot request does not confirm which apps were used.
When a tool fails and another call returns an issue, use their separate links.

Long prompts start with a six-line preview so recorded activity stays close.
Use the chevron beside the prompt author to expand or collapse the text in place.
**Copy prompt** still copies the whole retained prompt. Search opens the full
prompt rather than hiding a match behind the preview.
Use **Prompt**, **Activity** or **Source** at the top of the interaction to jump
to that section. **Reply** appears when the selected interaction has a recorded reply.

Each call shows its own outcome, such as **1 tool call completed**, even if
one returned entry reported an error. **Call duration** measures the whole call.
Returned entries stay in order and carry their own statuses and timing. If an
error message is shortened, **Full diagnostic** opens its saved wording.
Open the call for its exact input; **Source details** holds provenance and
identifiers. Close or Back returns to the originating results.

**WIRE interpretation** explains a recorded condition or evidence gap separately
from the source diagnostic. It uses fixed local rules, without AI or provider
calls, and explains what the evidence establishes without suggesting fixes or
next steps. A clear source explanation needs no additional interpretation.

**Tool latency** is the recorded call interval. **Prompt to final response**
measures from the originating message to its recorded final response when
that link is available. Concurrent calls are not added into a task duration.
Missing timing is not zero.

A file attachment may appear as a label such as `notes.md` rather than its
contents. WIRE keeps the text recorded in Copilot; it does not open the attachment
or add its local path.

Copy controls copy the exact retained original, unmasked. A saved Copilot reply
is the assistant's text, not a tool result. Enabling reply saving does not
restore previously omitted replies.

### Tokens and returned text

On an interaction card or in the reader header, read the count or **Tokens
unavailable**. Select the header reading for the breakdown or the known reason.
The breakdown separates fresh input, cache reads, cache writes and output.

To inspect a particular invocation, open **Call details** for its
numbered row. **Tool operation tokens** shows what the tool service reported
for that call, when available. **Returned text (estimate)** describes the size
of its response. Neither figure is a share of the model's token total.

For a report on one interaction, choose **Add to report** on its card and add
it to a new draft. Open that draft in Reports to save the same total. Adding
more interactions gives you their combined total and how many had token counts.

### Prompt sender

The sender label tells you who asked, not who carried out each call. Choosing
Human and Agent excludes prompts whose sender is unclear.
Those cards show the saved reason separately from the call result. In
**Analyze > Guide > Recorded prompt authors**, **Why the sender is unclear**
counts those reasons across all pages of the current view and shows the saved
rule version when available. In the reader, **Source details** shows the selected
prompt's saved rule version and whether its calls link directly to that prompt.
Neither view rereads chats or changes an author. For
example, WIRE may not recognize the host's message format even when the prompt
text and tool result were saved. Older records may lack that specific reason.

### Resize or maximize the reader

Drag the reader's left edge or use its minus/plus buttons to change its width.
Choose **Maximize interaction** to read the calls across the workspace. Each
call shows its operation and outcome together. A recorded failure reason stays
with the call it explains; **Call details** opens that call's evidence.
**Restore reader width** keeps your place. **Close interaction** returns to the
previous view. On a narrow screen, the reader uses one pane without sizing controls.

![Four calls in a maximized interaction. The fetch has two returned entries; the separate Ask Copilot call shows its recorded timeout.](images/interaction-maximized.png)

### Add to a report

Use **Add to report** on the card or in its reader. Choose a draft to add the entire interaction without
leaving Analyze. Reopen the picker to add it to another draft or remove it from
one. See [Keep interactions in a draft](reporting.md#keep-interactions-in-a-draft)
to prepare, save or delete that selection.

### Hide and restore cards

On a local Copilot interaction card in Analyze, choose **Hide**. To bring it
back right away, choose **Undo hide** above the list. Later, open **Hidden
cards** and choose **Restore** beside a card. If several are hidden, **Restore all**
below the list brings them all back.

![Hidden cards lists each card by number and the time you hid it, without showing its prompt.](images/hidden-cards.png)

Cards stay hidden until you restore them. For a shorter duration, go to
**Settings > Analyze > Keep hidden cards out of view** and choose **Only in
this tab**. The setting applies the next time you hide a card.

Hiding a card leaves the counts in Analyze, Trends and Compare unchanged.
Its prompt and call details stay out of view, including in Search. A report
draft keeps its selection, but WIRE won’t show a preview that could reveal
the card. While any card is hidden in this tab, **all saved reports and
comparisons** stay closed in WIRE and out of Search: even a report about
other work can quote the hidden interaction. Files you’ve saved or shared
don’t change.

## Trends

Choose **Trends** in the sidebar. By default, **Overview** shows how many
interactions had a recorded error or failure each day. A cross at zero means no matching
dated calls; a circle at zero means there was activity but no recorded error.
**Charts** lists eight measures. **Token usage** shows how many tokens the
metered interactions used. Narrow by prompt author or tool to see the
whole interactions that match.
Choose **Usage question** to chart Human, Agent and unverified prompts, tools in
interactions with at least 30,000 or 60,000 tokens, or the models that read
from cache. **View daily values** shows daily readings and coverage. Tool groups
overlap: an interaction that used both fetch and retrieve appears in both,
but its tokens count only once in the period total.
**Chart guide** explains the units.

On Analyze, choose **View trend** on a widget to open its corresponding measure. With
**All dates**, the trend spans the first through last dated calls in the
current view. **Response models** opens interaction counts or measured tokens
by model according to the switch on the widget. From
**Tool call results**, WIRE asks before showing **Errors & failures**: that
chart counts affected interactions, not call outcomes. **Back to Analyze**
restores the original widget.

![Trends Overview showing daily interactions with errors and the choice to compare two measures.](images/trends-overview.png)

### Choose the period and activity

Open **Dates** for **Last 7 days**, **Last 14 days**, **Last 30 days** or
**Custom dates**. With no period selected, Trends starts with the last seven
days. If that week is empty and older dated calls exist, **Latest activity**
shows the seven days ending on the most recent matching call. An explicit
period or Analyze widget never moves automatically. An empty period can offer
**Show week ending …** without dropping the active filters.

The period control shows the accepted dates while a new read is pending.
The address can reopen the Charts section, not a chart's settings. Reloading
the same tab keeps its chart measure and ordinary date choices; private filtered
selections stay in the original visit.
If WIRE cannot restore a private selection, reopen the result from its original
tab. To continue without that selection, choose **Open this view without the
private selection**. Neither action deletes saved activity.
Every civil day is available in **View daily values**. Long single-series charts
space out date labels to show more of the period at once. If the chart
scrolls, the dates in view are shown below it; the index initially shows
the span with the most calls. Custom ranges over 90 days page through
days without changing full-period totals. The table caption identifies the daily
rows shown. Use **Earlier days** or **Later days** to change pages; at either
end, keyboard focus moves to the direction still available. Dates use the display time zone and
include both endpoints; choosing older dates does not collect older history.

**Filters** changes the activity included, even while a chart is maximized.
Apply author, tool and service choices together; Cancel leaves the scope alone,
and **Clear filters** restores the unrestricted period. The series checkboxes only
show or hide series; they do not recalculate percentage denominators.

### Read the measures

Period breakdowns summarize the whole chosen range. A dated point uses that
day's matching population. **Count / Percentage** changes compatible measures;
tool percentages can use calls or originating interactions. Duration remains
in milliseconds. **Columns / Lines** changes the drawing, not the values.
**Compare measures** lets you choose two readings for the same dates, or start
from an example on Overview. For example, compare **Errors & failures ·
interaction share** with a tool's **interaction reach**. Both count matching
interactions that day, so they can share one graph. Call share uses a different
denominator; call volume and duration use different units. These use aligned charts.
Aligned charts share a vertical scale when their units and denominators match.
**Share within week** marks each week boundary; its line stops there because the
next point uses a different denominator. Select a date to see that week's selected dates.

Select a point for its exact daily reading and matching calls. **Remove
comparison** drops the second measure; **Collapse chart** keeps your choices.
**Daily values** includes both measures on the current date page. The optional
correlation describes that page's paired daily values, not causation or
individual calls. **Compare periods** instead compares this period with the
preceding period of equal length. Review the dates and scope before opening
Compare; **Back to Trends** returns to the pair and selected day.
Grouped columns sit above the date they belong to. Their colors match the
legend. Select a column for its name and exact reading. One zero under a date
means all **shown** series are zero.
Unavailable measurements use a dash instead. If none of the matching interactions has a token count, WIRE shows the coverage instead of an empty plot.
**Token usage** starts as a line. A measured zero is on the zero axis; a dash
marks work with no reading for that day. A date without matching calls stays blank.
Select a measured day to open its contributing calls. On an unmetered day,
open a call to see why its interaction has no count. Later calls from an
interaction already counted on an earlier date do not add its tokens again.
**View daily values** includes daily numbers and period
totals, including series hidden in the chart.

| Chart | Measure |
| --- | --- |
| Tool usage | **Interactions %** shows the share of matching interactions that used a tool at least once (its reach). **Calls %** shows the tool's share of matching calls; **Calls** shows the count. Several tools can reach the same interaction. |
| Prompt authors | Matching originating interactions, split into Human prompts, Agent prompts and Sender unclear. Prompts with an unclear sender still count. |
| Tool calls | Matching tool calls per day. **Share within week** uses the matching calls in that calendar week within the selected dates. Point context names that week and denominator; a short rule along the date axis marks partial weeks. |
| Services | Matching calls involving each service, as a share of all matching calls. One call can involve several services, so shares can overlap. Missing service detail and preparation calls remain separate. |
| Errors & failures | Matching interactions with a failed call or recorded application/API error, as a share of all matching interactions. Unknown call outcomes are separate; a tool can complete while its result contains an error. |
| Response models | Each model counts once per matching interaction. An interaction can use several models. Percentages include interactions without a verified model in the denominator. In **View daily values**, select a partial, missing, unverified or conflicting model count to open its matching calls. The interaction reader shows what was recorded. |
| Call duration | Median and 95th percentile of recorded durations, in milliseconds. A blank date has no matching calls; a dash means calls had no recorded duration. **View daily values** shows both the number of calls and how many were timed. |
| Token usage | Each matching interaction contributes its tokens once, on its first matching call date in the period. The coverage count shows how many interactions have a token reading. |

Prompt authors counts interactions with activity that day, not every message
sent in Copilot. One interaction can appear on several days but counts once in
the whole period. Call duration shows Median and 95th percentile together; its
header buttons are shortcuts for the same series checkboxes. Hiding either
series leaves the timing sample and coverage unchanged. Missing or partial
history, undated calls and unavailable measurements remain distinct from zero.
Collection status covers source-wide read/import problems; those do not establish
which dates are affected. Limits specific to the chart remain beside its values.

### Inspect a change

Hover or focus a dated mark to read its values. Arrow keys move between dates
and series. Select a point, then choose the action showing its matching call
count. There is no need to maximize first. Selection
keeps the chart in place; maximizing retains the selected point. Other series'
calls are not added to this list.
Hover a legend entry to emphasize its line without filtering the activity.

Open a call to read its result and full parent interaction. That parent context
can contain calls outside the chart selection. Closing the reader returns focus
to the supporting-calls action; reopening the list returns to the call you were inspecting.
Changing the scope retires that return position. Hiding the selected series does
not change its evidence. The list's title and Close stay available while it scrolls.

Choose **View daily values** below the chart. On a narrow screen, scroll within
the table; keyboard users can focus it
and use the arrow keys. Dates and column headers stay attached to the values.

### Show several charts

To read several separate charts for the same dates, choose **Show or hide charts**
above the chart, check the ones to show below it and choose **Apply**.
Uncheck them all to keep just the current chart. Choosing another measure in
the index starts with that chart alone. These extra charts are not saved on reload.

For the full-width stack choose **Show or hide charts > Open all charts**.
**Back to selected charts** returns to your selection. From a maximized chart,
**Back to all charts** returns to its row. **Collapse all** folds the current
stack; **Expand all** opens every chart in it. Neither changes your measures,
series choices or selected date.
Collapsed widgets show their names and applied dates. Click anywhere on a collapsed row to
open it, or the open widget's header to close it. The arrow button does the same
with Enter or Space; the other controls keep their own actions.

![Collapsed Trends rows with their applied date range and sizing controls.](images/trends-collapsed.png)

These are retained Work IQ patterns, not a census of Copilot prompts,
answer-quality judgments, productivity scores or evidence of causation.
For a two-period comparison or a saved copy, use
[Compare](#compare) or [Reports](reporting.md).

<a id="compare-periods"></a>

## Compare

Choose **Compare** in the sidebar to compare two periods. To compare two
measures over *one* period, stay in Trends. See [Compare two periods](reporting.md#compare)
for baseline and selected dates, missing values, token usage and the calls behind a change.

## Make a report

In **Reports**, select a named draft or start a **New report**. Check its
activity, dates, text and formats, then choose **Prepare preview**. Preparing
does not save any files. Read the finding and its examples before choosing **Save
report**. Open an existing report by name in **Saved library**.

[Create and read reports](reporting.md) covers scope, text masking, file
inspection, and what happens when you delete a draft or a saved copy.

## Find saved text

Type in the stationary **Search** field. Results appear as you type; there is
no Submit step. `POWER` and `owerp` both find `PowerPoint`. A phrase matches
that literal sequence, not scattered words, inferred intent or synonyms.

![Search for POWER returning two interaction matches and a matching excerpt from a saved report.](images/literal-search.png)

**Everywhere** searches authorized retained content and navigation destinations
across pages. **Current Analyze scope** deliberately narrows the analytical
population and current-view report membership. Selected interactions and All
collected activity report scopes remain separate. Availability notices identify
content Search cannot include.

Open a result to inspect its exact verified destination. Back returns to the
matching row while it remains available. If you start a new search while the
reader is closing, WIRE keeps the new query. Missing, changed or unreadable
content is not silently replaced with a nearby result. Search runs locally,
without AI, providers, new collection or credit spending. Its query is not
placed in URLs or saved as a persistent Search index.

<a id="find-a-setting"></a>

## Settings

Open **Settings** at the bottom of the left sidebar. It opens in **General**,
which shows your WIRE version, update status and last successful check.

Below updates, **Current theme** shows your palette name, Light or Dark mode,
and a preview with its colors.
Select **Change theme** to open **Themes**, or select **Time zone** to open
**Regional**. **Back to General** returns to the shortcut with your current choice.

### Search settings

Type in **Search settings**. Matching destinations appear under their categories.
Search includes setting descriptions and keywords:
`record` finds reply saving, deletion, rereading history and the network
diagnostic; `city` finds Time zone.

![Settings search groups record-related destinations under Privacy & saved data and Collection status.](images/settings-search.png)

Select a result, or use Tab and Enter, to reveal and focus the existing setting.
Its help and consequences stay beside that control. Selecting a result never
changes a setting, deletes activity or starts collection or a diagnostic.
Unavailable actions remain findable, with their explanation at the destination.
Clear the field or press Escape to return to the categories. Browser Back
returns to the query and link you came from.

This search runs on-device over fixed setting information. It is separate from
the main Search field for saved activity and reports, and does not read private
path values.

### Update WIRE

On [supported installations](development.md#updating-wire), automatic checks
are on by default. You can turn them off and still choose **Check for updates**
in **General**. The button shows **Checking** while it looks for an update.

Choose **Update and restart** in General or in the update notification. Leave
your tabs open: each participating window shows **WIRE is updating**, then
reloads its own page. If a window has an unfinished edit, save or cancel it
there before updating. If a window doesn't confirm it's ready, WIRE stops
before restarting. That message alone doesn't mean you left an edit unfinished.

When an update is available, **Check open views** in General asks the registered
views whether they have unfinished work. It doesn’t install anything. If a view
doesn’t answer, keep your windows and work intact; another update click won’t
tell you which view was missing. WIRE checks again when you choose to restart.

Dismissing the notification leaves the update available in General. If installation
fails, General shows **Update not installed** and the reason. Away from General,
look for the same message in the notification. If your copy can't check for updates,
General links to **Update instructions** instead.

### Themes

In **Themes**, choose Light or Dark and one of five color palettes for this browser.
Change the time zone separately in **Regional**. The toolbar switch changes only Light/Dark. Select a palette card to
change the screen immediately; **Compare Light and Dark** shows the selected
palette in both modes. **Reset palette** restores Petrol & coral without
changing mode. If storage is unavailable, the choice applies to this panel
only. Changing appearance does not rewrite saved reports or their original time zone.

![Themes with five compact palette previews. Petrol & coral is active in Light mode.](images/settings-display.png)

### WIRE defaults

Under **WIRE defaults**, choose how views open and new reports and comparisons start in this browser:

| Category | What you can change |
| --- | --- |
| Analyze | Open on All dates (the initial default) or the last 7, 14 or 30 days, including today. **View Analyze** and the sidebar use this range for a fresh view and keep any dates or filters you chose in an existing view. This filters saved activity. Start the list with **Most recent** or **Most tokens**, choose Guide's opening topic, or [reorder the homepage widgets and Interactions](#homepage-layout). |
| Trends | Choose the trend chart to show on a fresh visit. Changing measures within Charts does not change its address. |
| Reports | Preselect HTML, PDF, Markdown or JSON (at least one), and the last 7, 14 or 30 days including today. These choices start a fresh draft; they do not prepare or save files. |
| Compare | Start with the last 7, 14 or 30 complete days, ending yesterday, versus the preceding period of the same length. A comparison from Trends keeps its chosen dates. |

Defaults do not rewrite a view you return to, an existing draft, or a saved
report. If the browser cannot save a preference, Settings tells you that the
choice applies only to the current panel.

<a id="keep-collection-and-saved-data-separate"></a>

## Collection, privacy and account

**Settings > Source access** shows which paths WIRE can read. **Collection**
sets the history window, check frequency and Pause. Edit the values to show
**Save preferences** and **Cancel changes**. **Refresh** checks approved local history;
**Read stored activity** only rereads WIRE's retained view. Paused collection
stays paused after a deliberate local-history check. **Collection status**
explains missing files, bounded reads and other known coverage gaps.

If **Collection cannot check history** appears, open **Collection status** for
the failing operation and reason. Retained activity stays available.
In Collection status, **HTTP recorder** shows any saved diagnostic. Normal WIRE
launches cannot start a new network test. A saved diagnostic is separate from
Copilot collection status.

Collector updates improve supported reads; they do not automatically repair
older retained activity or rewrite saved reports.

In **Privacy & saved data**, **Review deletion** previews the activity you
choose before you confirm deletion. **Read history again > Choose chats**
checks selected approved history for missing activity. It cannot restore
deleted calls or prompts in a normal installation. Neither Reset filters nor
Refresh performs these actions. Saved reports and external downloads can
retain copies after activity deletion.

If a change's result is uncertain, use its offered status/result check rather
than repeating the action. The [collection and recovery reference](collection.md)
explains each operation's effects and limits.

**Account > Sign out of this instance** stops collection and hides saved private
activity in every tab of that WIRE instance, without deleting it. It does not
sign out of GitHub, the Copilot app or another independent WIRE instance.
Open **Account** at the bottom of the navigation (inside the navigation drawer
on small screens). WIRE reads the GitHub name and avatar from the approved Copilot app
source: the recorded workspace's linked account, otherwise the app's GitHub
default. This display profile does not control access to history. A neutral
icon means the profile is unavailable, not that collection needs a different
GitHub CLI login.

## Help, Feedback and the sidebar

Open **? (Help)** at the bottom of the sidebar for **Prepare a report**,
**Find missing activity**, **Understand activity counts**, or **Read tool results**.
Select a topic to read its answer. Your browser’s Back and Forward buttons
revisit topics and earlier pages. Chart definitions and examples stay in the Analyze and Trends guides.

Use **Feedback** beside Help to report a WIRE bug or suggest a feature.
Enter a title and, optionally, a description. **Open on GitHub** fills in
those fields on WIRE's new issue form. The issue is public only after you submit it.

Drag the sidebar's right edge to resize it. With the divider focused, use the
left and right arrow keys. WIRE remembers your width in this browser;
double-click the edge or press Enter on it to restore the default.
