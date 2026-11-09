# Create and compare reports

A report preserves selected interactions and their recorded Work IQ calls.
Use it to explain repeated errors, operations and working patterns, then give
product teams examples from which they can create eval cases. WIRE does not
generate evals or rate answer quality.

For report schemas, membership and privacy, see the
[report contract](report-contract.md).

## Open a report

Open **Reports > Create a report**, choose a period, then choose a report.
The report opens immediately. **Save report** saves its current files locally;
there is no required setup or text-review checklist.

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

A fresh report is independent of Analyze filters. For a deliberate narrower
entry, expand **Use selected interactions or the Analyze view**:

| Scope | Includes |
| --- | --- |
| Selected interactions | Your deliberate picks, including selections hidden by later filters or another page. |
| Current Analyze view | Every matching interaction across pages, with its complete eligible evidence, not just the individual calls matching a chart. |
| All collected activity | Retained reportable activity independently of Analyze dates, filters, Search and paging. It does not collect new history or include complete original chat transcripts. |

Selected entry keeps all chosen dates initially. Changing report dates does
not remove your picks. In a Current-derived report, changing dates replaces
only that restriction; applicable filters and authorized Search membership
remain. Analyze itself does not change.

## Read and adjust

The report shows its period, scope and recorded patterns. An error report
can say, for example, that 12 of 80 interactions contained a recorded error.
Only those 12 cases contribute prompt or diagnostic copies. The other
interactions supply the frozen reference count, not additional disclosed text.

Every included interaction remains accessible. **Add a note or edit this
example** lets you explain what you expected, change a prompt copy or omit it.
Notes are the report author's context; they do not change recorded outcomes or
metrics. Select **Update note** or **Update prompt copy** to apply an edit.

The toolbar changes the report name, personal-detail treatment and file formats.
**Change what's included** holds author/service/outcome choices and optional
linked context. **Inspect or edit report text** provides original/copy
inspection and edits for the other included text. **Inspect prepared files**
shows exact output. These controls are optional.
Choose **Update report copy** after editing text in the inspection area.

| Choice | Effect |
| --- | --- |
| Leave out prompts and replies | Omits originating request, follow-up, tool-question and linked reply text. Authored notes still have detected personal details hidden. |
| Hide personal details | Uses retained wording with local masking. This is the default; WIRE may miss names or sensitive context. |
| Keep chat details | Includes recorded wording in local files. Detected credentials are still removed. |
| Include linked requests and replies | Adds available, authorized context up to one linked request before and after each included interaction. It is not the whole chat or a reply-saving permission. |
| Include error messages from the calls | Adds already-retained error details, always masked. Error reports start with it on. It does not add raw response bodies or unrelated source descriptions. |

Choose HTML or PDF for reading, JSON for complete structured records, or Markdown
for portable text. You can select more than one. PDF generation needs the
[optional local browser setup](development.md#pdf-and-browser-tools); the other
formats do not. Titles are always masked metadata. Changing the name, text,
notes or formats regenerates prepared files while keeping the original
interaction cohort. Save is unavailable until the update finishes.

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

New receipts record local-save intent, not an assertion that someone reviewed
every copy. Older reports retain their original disclosure attestations.

Choose **Open saved report** to read the saved file. To find it later, open
**Reports** and choose the report in the library. The file selector changes
formats; **Download** retrieves the original saved file.

![The saved HTML report open in WIRE with its title, selected scope, separate evidence counts and Download action.](images/saved-report.png)

Saved reports retain their frozen facts, text choices and time context.
Later collection, browsing filters or screen-theme changes do not rewrite them.
In the Reports library, search finds saved metadata; global Search can also
find supported saved-file content.

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

Use **Analyze > Compare periods** for two retained date ranges without making
reports first. Choose each range, keep the relevant shared filters, then
explicitly compare. Dates include both selected days in the display time zone.
**Create comparison report** opens a report of the accepted pair, ready for
the same local Save action.

![Two retained periods showing a higher failed-call share alongside faster recorded tool latencies, with unequal-length and unavailable-result qualifications.](images/compare-periods.png)

Different period lengths or incomplete evidence can limit what a change means.

For existing reports, open **Reports > Compare saved reports**, choose
**Earlier report** and **Later report**, then **Compare reports**. This uses
their frozen facts, not current history. Different definitions, missing facts
or incompatible identities can prevent a comparison.

The comparison opens with HTML prepared. Change its name or formats if needed,
then select **Save comparison**. Its frozen copy can remain readable after an
input report is deleted. Notes remain authored context, not comparable metrics.

## Remove a saved copy

**Delete report** or **Delete saved comparison** removes that managed bundle
after its own confirmation, not original source activity or external downloads.
**Delete all saved reports** previews all report bundles across pages and search,
not just visible rows; saved comparisons remain.

Deleting collected activity is a separate Settings operation and does not
remove independently saved reports. For an interrupted deletion, read its
original result rather than confirming a new operation.
