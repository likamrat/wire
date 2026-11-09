# Create and compare reports

A report preserves selected interactions and their recorded Work IQ calls.
Use it to explain repeated errors, operations and working patterns, then give
product teams examples from which they can create eval cases. WIRE does not
generate evals or rate answer quality.

For report schemas, membership and privacy, see the
[report contract](report-contract.md).

## Open a report

Open **Reports**, choose a period, then choose a report. Saved reports are
directly below the five choices. Choosing a tile opens the report in the main
reading area. **Save report** saves its current files locally; there is no
required setup or text-review checklist.
Each choice has a help icon available by pointer, keyboard or touch.

![Reports with five report choices, period controls and saved reports below.](images/report-choices.png)

| Report | Includes |
| --- | --- |
| All activity | Your prompts and agent prompts, with Work IQ calls and results. Eligible interactions with an unverified author remain included. |
| Errors & failures | Interactions with any recorded failed call or explicit application/API error, including mixed results. |
| Completed calls | Interactions with at least one recorded call, all calls completed and no recorded errors. This does not establish task success. |
| My prompts | Interactions whose originating prompt is recorded as user-authored. |
| Agent prompts | Interactions whose originating prompt is recorded as agent-authored. |

New reports default to **Last 7 days**, including today in the display time
zone. **Last 14 days**, **Last 30 days** and **Custom dates** are also available.
Custom dates opens the calendar directly; Cancel leaves the accepted dates
unchanged. Undated activity is not assigned to a dated period.

A fresh report is independent of Analyze filters. To narrow an open report,
use **Change what's included > Change activity selection**:

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

Every included interaction remains accessible. Open it, then **Add a note or edit this
example** lets you explain what you expected, change a prompt copy or omit it.
Notes are the report author's context; they do not change recorded outcomes or
metrics. Select **Update note** or **Update prompt copy** to apply an edit.

![An interaction's optional note and editable prompt copy, with separate update controls.](images/report-example.png)

The toolbar changes the report name, personal-detail treatment and files to save.
**Change what's included** holds author/service/outcome choices and optional
linked context. **Inspect or edit report text** provides original/copy
inspection and edits for the other included text. Choose **Update report copy** after editing text in the
inspection area. These controls are optional.
To hide a specific name or phrase throughout the copies, open the personal-detail
control, expand **Additional masking**, and enter one exact term per line.

| Choice | Effect |
| --- | --- |
| Leave out prompts and replies | Omits originating request, follow-up, tool-question and linked reply text. Authored notes still have detected personal details hidden. |
| Hide personal details | Uses retained wording with local masking. This is the default; WIRE may miss names or sensitive context. |
| Keep chat details | Includes recorded wording in local files. Detected credentials are still removed. |
| Include linked requests and replies | Adds available, authorized context up to one linked request before and after each included interaction. It is not the whole chat or a reply-saving permission. |
| Include error messages from the calls | Adds already-retained error details, always masked. Error reports start with it on. It does not add raw response bodies or unrelated source descriptions. |

**Save as** chooses HTML, PDF, JSON or Markdown files; you can select more than
one. **View** changes what you are reading: **Report** is the readable page,
while a file choice shows that actual format. PDF has page controls, JSON has
a field tree, and HTML and Markdown offer Preview/Source. Switching views does
not prepare new activity or download anything. PDF generation needs the
[optional local browser setup](development.md#pdf-and-browser-tools); the other
formats do not. Detected personal details in report names are hidden in every
text mode. Changing the name, text, notes or formats regenerates prepared
files while keeping the original interaction cohort. Save is unavailable
until the update finishes.

![PDF selected under View, with page navigation and a separate Save as control.](images/report-file-preview.png)

Additional masking terms, edits and omissions affect report copies only.
Missing or partial text stays qualified; editing does not recover source text.

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
**Reports** and select its name beside the view icon. JSON-only reports also
open as readable pages, using their verified saved facts. No download is needed.
**Files** opens a specific saved format. The mark beside the name explains how its text was treated; missing
older metadata stays unrecorded. **Options > Inspect details** shows its other
metadata. In the reader, choose **Report** to return from a file preview, or
**Download** to retrieve that file's original bytes.

![A saved report open inside WIRE with section navigation and expandable evidence.](images/saved-report.png)

Older unverified reports keep their warning before **View report**. Missing,
altered or unsupported saved content remains unavailable; WIRE does not rebuild
it from current activity or silently open another format.

Saved reports retain their frozen facts, text choices and time context.
Later collection, browsing filters or screen-theme changes do not rewrite them.
The saved list's search finds metadata; global Search can also find supported
saved-file content. **Back to Reports** restores the list's search, order, page
and reading position. Page controls are below the saved rows.

If Save is unconfirmed, use **Check save status** rather than Save again.
A missing receipt is not proof that nothing was written. Review files before
sharing outside WIRE: local saving is not permission to publish, and pattern
masking cannot recognize every confidential detail.

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

## Compare

Open **Compare periods** in the left sidebar. It starts with all eligible
activity from the saved collection, independently of Analyze filters. The
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
or incompatible identities can prevent a comparison.

The comparison opens with HTML prepared. Change its name or formats if needed,
then select **Save comparison**. Its frozen copy can remain readable after an
input report is deleted. Notes remain authored context, not comparable metrics.

## Remove a saved copy

Open a saved row's **Options** and choose **Delete report** or **Delete saved
comparison**. Its confirmation removes that managed bundle, not original source
activity or external downloads. **Saved-report options > Delete all saved
reports** previews all report bundles across pages and search, not just visible
rows; saved comparisons remain.

Deleting collected activity is a separate Settings operation and does not
remove independently saved reports. For an interrupted deletion, read its
original result rather than confirming a new operation.
