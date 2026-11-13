# Create and compare reports

A report preserves selected interactions and their recorded Work IQ calls.
Use it to explain repeated errors, operations and working patterns, then give
product teams examples from which they can create eval cases. WIRE does not
generate evals or rate answer quality.

Go to [report choices](#open-a-report), [text and privacy options](#read-and-adjust),
[saving and reopening](#save-and-reopen) or [comparisons](#compare).
Contributors changing report behavior should also read the
[membership and frozen-output contract](report-contract.md).

## Open a report

Open **Reports**, choose a period and check **Report text** before opening a report.
The default, **Mask detected details**, keeps the wording with local masking.
You can leave out prompts and replies or keep chat details instead.
This choice applies to the readable report and its saved files.
Choose a tile to open the report in the main reading area. **Save report** saves
its current files locally without a required setup or text-review checklist.
Saved reports sit below the five choices. Each choice has a help icon available
by pointer, keyboard or touch.

![Report text is available before the five report choices; saved reports appear below.](images/report-choices.png)

| Report | Includes |
| --- | --- |
| All activity | Your prompts and agent prompts, with Work IQ calls and results. Eligible interactions with an unverified author remain included. |
| Errors & failures | Interactions with any recorded failed call or explicit application/API error, including mixed results. |
| Completed calls | Interactions with at least one recorded call, all calls completed and no recorded errors. This does not establish task success. |
| My prompts | Interactions whose originating prompt is recorded as user-authored. |
| Agent prompts | Interactions whose originating prompt is recorded as agent-authored. |

If a returned status and its diagnostic disagree, both remain visible. Recorded
error evidence on either side qualifies for **Errors & failures**; a disagreement
without an error does not. The tool's recorded completion stays unchanged.

New reports default to **Last 7 days**, including today in the display time
zone. **Last 14 days**, **Last 30 days** and **Custom dates** are also available.
Custom dates opens the calendar directly; Cancel leaves the accepted dates
unchanged. Undated activity is not assigned to a dated period.

A fresh report is independent of Analyze and Trends filters. After
[inspecting a dated Trends point](user-guide.md#inspect-a-change), choose the
report's period and activity explicitly. To narrow an open report, use
**Change what's included > Change activity selection**:

| Scope | Includes |
| --- | --- |
| Selected interactions | Your deliberate picks, including selections hidden by later filters or another page. |
| Current Analyze view | Every matching interaction across pages, with its complete eligible evidence, not just the individual calls matching a chart. |
| All collected activity | Retained reportable activity independently of Analyze dates, filters, Search and paging. It does not collect new history or include complete original chat transcripts. |

Choose the scope, select interactions if needed, then use **Show report**.
You can also use **Add to report > Continue to report** in an interaction reader.
Reading or selecting an interaction alone does not save a report.

**Back to Reports** returns to the choices and saved list. It keeps an unfinished
copy in memory. Choose the same tile again without changing its dates to resume
that copy, including its name and notes. Choosing another type replaces the
unfinished copy. Reports entered from Analyze keep their contextual return.

**Selected interactions** initially includes your picks across all dates.
Changing report dates does not remove those picks. If you start from
**Current Analyze view**, changing the report dates replaces only the date
restriction. Other applicable filters and authorized Search membership stay
in place; Analyze itself does not change.

If WIRE later corrects who sent a prompt, reports already prepared or saved
stay unchanged. Prepare a new report to use the corrected author.

## Read the findings

Start with which activity the report includes and which facts were available.
Read interaction, tool-call and returned-API counts separately.
Then read the tool and service patterns, failures and timings. A completed
tool call does not establish a correct answer, and a returned API error does
not automatically explain its parent call's outcome. Service associations
can overlap.

Timing keeps its recorded boundary and measured population. Missing model
names, timing or recorded application results remain unavailable, not zero.
Examples connect permitted prompt copies with recorded calls; they are not
generated explanations of intent or task success.

**Tool results** lists every call included in the report, including calls with
no retained diagnostic. **WIRE interpretation** explains supported conditions
and evidence limits beside those results. It is separate from original error
text and report-author notes, and does not recommend next steps.

## Read and adjust

The report shows its period, scope and recorded patterns. An error report
can say, for example, that 4 of 12 interactions contained a recorded error.
Only those 4 cases contribute prompt or diagnostic copies. The other
interactions supply the frozen reference count, not additional disclosed text.

![An error report with its frozen frequency, section links and separate Save as and View controls.](images/report-preview.png)

Use the section links to jump to patterns, interactions, timing or coverage.
Open a section or interaction to read its full evidence. **Expand sections**
opens everything; collapsing changes only the view, not the report's contents.
The reader keeps its navigation visible while you scroll. **Report details**
under Coverage holds the preparation and time-zone metadata.

![An expanded report interaction with its prompt and recorded calls below the section navigation.](images/report-expanded.png)

Every included interaction remains accessible. Open it, then **Add a note or edit this
example** lets you explain what you expected, change a prompt copy or omit it.
Notes are the report author's context; they do not change recorded outcomes or
metrics. Select **Update note** or **Update prompt copy** to apply an edit.

![An interaction's optional note and editable prompt copy, with separate update controls.](images/report-example.png)

The toolbar changes the report name, **Report text** and files to save.
The text control stays blue for masking, gray when prompts and replies are
left out, and red with a warning icon when chat details are kept. Labels and
icons identify each state without relying on color. Masking can miss names
or sensitive wording.

**Change what's included** holds author/service/outcome choices and optional
linked context. **View > Report text** opens optional text inspection.
It shows one **Report copy** at a time, with its interaction and recorded author.
**Local original** switches to the retained source; it is not an extra copy
included in the report. **Edit or omit this report copy**, then **Update report
copy**, changes only that report copy. The original stays unchanged.
Return to **Report** or a file through **View**.

![Report text showing one included copy, its author and a separate Local original choice.](images/report-text.png)

To hide a name WIRE missed, open the **Report text** control in the toolbar,
expand **Hide specific words**, and enter one name or phrase per line.
Adding `Avery Chen`, for example,
hides that text throughout the report copies, including notes. Matching ignores
case; other spellings stay. This optional step does not change original chats.

![Report text choices and the optional Hide specific words field with Avery Chen entered.](images/report-privacy.png)

| Choice | Effect |
| --- | --- |
| Leave out prompts and replies | Omits originating request, follow-up, tool-question and linked reply text. Notes and selected error messages remain, with detected personal details hidden. |
| Mask detected details | Uses retained wording with local masking. This is the default; WIRE may miss names or sensitive context. |
| Keep chat details | Retains recorded wording in the report and saved files. Detected credentials are still removed. |
| Include linked requests and replies | Adds available, authorized context up to one linked request before and after each included interaction. It is not the whole chat or a reply-saving permission. |
| Include error messages from the calls | Adds already-retained error details, always masked. Error reports start with it on. It does not add raw response bodies or unrelated source descriptions. |

Masking, edits and omissions still control the diagnostic copies. A fixed WIRE
interpretation can remain when you leave out error-message text; it does not
restore the omitted wording or read prompts, replies or arguments.

**Save as** chooses HTML, PDF, JSON or Markdown files; you can select more than
one. **View** changes what you are reading: **Report** is the readable page,
while a file choice shows that actual format in its own reading pane. Text
inspection stays out of the file view. PDF has page controls, JSON has
a field tree, and HTML and Markdown offer Preview/Source. Switching views does
not prepare new activity or download anything. **Manifest file** shows the
report's coverage, disclosure choices and file hashes; it accompanies the
selected output files.
Hover or focus a viewer icon to see **Preview**, **Tree** or **Source**.
PDF pages keep their fixed layout; use zoom when **Fit width** makes text too small.

PDF generation needs the
[optional local browser setup](development.md#pdf-and-browser-tools); the other
formats do not. Detected personal details in report names are hidden in every
text mode. Changing the name, text, notes or formats regenerates prepared
files while keeping the original interaction cohort. Your selected file and
Preview/Source mode stay selected during these updates and after changing the
report period or call filters. Removing that file
from **Save as** returns to **Report**. Save is unavailable until the update finishes.

![The actual HTML file in a full reading pane, with Preview and Source controls.](images/report-file-preview.png)

Additional masking terms, edits and omissions affect report copies only.
Missing or partial text stays qualified; editing does not recover source text.
Changing Report text keeps edits and omissions for included copies. Leaving out
prompts also turns off linked context; edits to that excluded context are retired.
Changing the choice on Reports does not prepare a report until you open a tile.
Reopening the same unfinished report keeps its frozen activity.

<a id="approve-save-and-reopen"></a>

## Save and reopen

Use **Save report**. The default masked report saves without another step.
If you chose **Keep chat details**, a warning names the prompts, replies, notes
and sensitive information that may be included:

| Choice | Effect |
| --- | --- |
| Hide details and save | Regenerates masked copies and saves that exact new bundle once. |
| Save with chat details | Confirms this particular local save with chat details kept. |
| Go back | Writes nothing. |

![The keep-chat-details warning offering Hide details and save, Save with chat details, and Go back.](images/report-save-warning.png)

The save receipt records your choice to save locally, not a claim that you
reviewed every copy. Older reports keep the review confirmation recorded
when they were saved.

Choose **Open saved report** to read it inside WIRE. To find it later, open
**Reports** and select its name beside the document icon. Supported JSON-only
reports also open as readable pages, using their verified saved facts. No download is needed.
**Files** opens a specific saved format. **Report text** shows the saved text
treatment beside its icon; missing older metadata stays unrecorded.
**Inspect details** on the row shows its other
metadata. In the reader, choose **Report** to return from a file preview, or
**Download** to retrieve that file's original bytes.

**Prepared** is when the report was created. **Report period** is its saved date
selection; **All retained dates** means no date restriction. Older saved-list
entries may not include a period, even when dates appear inside the report.
WIRE does not replace a missing period with the preparation time or current filters.

![A saved report opened at an interaction, with its prompt and recorded calls beneath the section navigation.](images/saved-report.png)

Older unverified reports keep their warning before **View report**. Missing,
altered or unsupported saved content remains unavailable; WIRE does not rebuild
it from current activity or silently open another format.

Saved reports retain their frozen facts, text choices and time context.
Later collection, browsing filters or screen-theme changes do not rewrite them.
**Report** selects a readable WIRE logo for the report's background. Original
file views and downloads keep their saved artwork, even if an older logo has poor contrast.
Reopening an older report does not add newer interpretations. New reports need a
compatible WIRE reader; an older version may refuse to open them.
The saved list's search finds metadata; global Search can also find supported
saved-file content. **Back to Reports** restores the list's search, order, page
and reading position. Page controls are below the saved rows.
Use Previous/Next, or enter a page and choose **Go to page**. Enter submits the
same page choice; an out-of-range number does not change the page.

If Save is unconfirmed, use **Check save status** rather than Save again.
A missing receipt is not proof that nothing was written. Review files before
sharing outside WIRE: local saving is not permission to publish, and pattern
masking cannot recognize every confidential detail.

## Compare

Open **Compare periods** in the left sidebar. It starts with all eligible
retained activity, independently of Analyze filters. The
first result compares the last seven complete days, ending yesterday, with
the preceding seven days in the display time zone.

![Compare periods with the accepted dates, outcome counts and shared reading actions.](images/compare-periods.png)

**Last 14 days** and **Last 30 days** use the same complete-day rule.
**Custom dates** opens both calendars; each range includes its start and end
days. **Cancel** leaves the accepted comparison unchanged. Unequal or overlapping
ranges are allowed and remain labeled.

The compact activity choice offers All activity, Errors & failures, Completed
calls, My prompts and Agent prompts. **More options** retains source, tool,
service, category, author, outcome, project, chat, evidence-layer and collection
choices, plus path, service-intersection and timing-interval controls. Choices
apply directly. **Use Analyze view** deliberately imports Analyze's non-date
filters and authorized Search selection; it replaces only the dates.

Switch **Outcomes**, **Timeline**, **By tool** or **Timing** inside the chart.
These views keep the same accepted pair. Hover or focus a mark for its exact
values; select it to inspect supporting records. **View calls** opens the
paired activity, while **View numbers** shows the values for the current chart.
Missing results and timing remain unavailable. Different period lengths,
overlap and incomplete evidence can limit what a change means.

**Create report** freezes the accepted pair and opens the existing report
experience with the same formats, masking, optional notes and local Save.
**Back to comparison** restores its dates, choices and reading position while
access remains valid.

For existing reports, open **Reports > Compare saved reports**, choose
**Earlier report** and **Later report**, then **Compare reports**. This uses
their frozen facts, not current history. Different definitions, missing facts
or incompatible identities can prevent a comparison. A saved two-period report
already contains a comparison; it cannot serve as one of these ordinary report
inputs.

The comparison opens with HTML prepared. Change its name or formats if needed,
then select **Save comparison**. Its frozen copy can remain readable after an
input report is deleted. Notes remain authored context, not comparable metrics.

## Remove a saved copy

Choose **Delete report** or **Delete saved comparison** on its row.
Its confirmation removes that managed bundle, not original source
activity or external downloads. **Saved-report options > Delete all saved
reports** previews all report bundles across pages and search, not just visible
rows; saved comparisons remain.

Deleting collected activity is a separate Settings operation and does not
remove independently saved reports. For an interrupted deletion, read its
original result rather than confirming a new operation.
