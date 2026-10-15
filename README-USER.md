# WIRE: user guide

Open [WIRE](http://127.0.0.1:47831/) (local runtime required).

On a new machine, follow [source checkout and setup](README.md#set-up-on-another-machine)
first. The clone contains no collected activity or private configuration. Approve
that machine's source in Settings; response saving and automatic scoring each
need separate approval and are not enabled by installing WIRE.

| Page | Use |
| --- | --- |
| Analyze | Filter the overview, read interactions directly, inspect calls and select report requests. |
| Reports | Find, open and manage saved reports, or switch to creating a report. |
| Collection status | Check whether collection is running, find chats with history gaps and see any available next step. |
| Settings | **Connection & updates**, **Privacy & saved data**, **AI reviews**, **Display** and **Troubleshooting**. |

The left sidebar keeps Analyze, Reports and Settings available. Collapse it to
an icon rail for more workspace; your choice is saved without changing filters,
selections or report drafts. On narrow screens, **Open navigation** slides out
the same destinations. Escape or **Close** returns focus to that button.
Search is centered in the workspace toolbar, separate from the sidebar branding.
The brand and time-zone shortcut move into the drawer on narrow screens.
Reduced-motion preferences remove the slide. Earlier Home and Activity links
open Analyze; no chat chooser is required before reading interactions.

The screen uses locally bundled Asta Sans, the font verified in the linked
IQOS source, with system-font fallbacks for unsupported scripts. It needs no
font download; its open font license ships with WIRE. Dark mode
uses charcoal and gray surfaces; light mode uses white and light gray. Text,
controls and focus indicators stay neutral, while colors distinguish recorded
results and services. Tool failures use red, not the amber used for partial
results and warnings. Saved report styling is unchanged.

In **Settings > Connection & updates**, the approved source and collection state
come before **History and frequency**. **View source** opens the exact approved
database and history-folder paths; **Change source** is available there.
Opening either view grants no permission and does not resume paused collection.
If status cannot be read, Settings marks the displayed connection as **Last known**
and blocks collection changes. **Read current connection** checks status without
repeating a save or source check; unsaved preferences are kept.

## Inspect an interaction

**Refresh** checks approved local histories and reads the latest stored activity
without rerunning Work IQ or Graph queries. Automatic collection keeps its current
configuration; paused collection stays paused. Before source approval, Refresh
only reads stored activity. **Review source & connect**, inside **Source and
collection**, remains a separate action.

Accepted results, filters and report selections stay while updating. Finish an
open report review or save/cancel Settings edits before refreshing. A failed
source-path or metadata check offers **Review source**. Reading stored activity
does not repair that source. **Read stored activity** appears beside Refresh for
a failed stored read or an unconfirmed check; it never repeats a source check or save. If a
source-check response is lost, its outcome stays unconfirmed even when newer
stored activity is available; Refresh and recovery remain read-only in this tab,
including after reload. Browser recovery-storage failures also block source
checks explicitly. This protection does not correlate operations across tabs.

**No new recorded activity** means that manual check added no records or updates;
it does not mean every history is available. **Chat history** shows the known
unavailable, limited or still-reading chat counts from that check. Open
**Source and collection**, beside Refresh, for its recorded primary
reasons, reading limits and possible next steps. **View current history issues**
opens the existing chat-by-chat details; later background checks may have changed
that list.

Coverage is across eligible chats in the approved source, not just your current
filters. WIRE cannot tell whether missing activity would match this view.
Previously collected evidence stays. An absent file cannot be recreated by
checking again; a file or entry size limit is not removed by a wider date window.
Pending history can continue on later checks, and unfinished entries need Copilot
to finish saving them. These gaps are not failed Work IQ calls. Excluded chats,
deleted records, out-of-window activity and a chat with no Work IQ calls are not
history-read failures.

**Collection status** is a health and coverage page, not a repair queue. If
collection is active, no action is needed to keep it running. Look under **Chat
history** only when you want to understand missing activity: search all affected
chats, open a reason, then open a chat for its retained activity or additional
limits. Each chat is counted once, even when several limits apply.
Paused or disconnected collection points to the relevant existing Settings
control. Current collection errors stay visible; **Technical details** holds
the full timestamps and limits. **Refresh** stays above the page. **Read stored
activity**, or **Retry** for a separate status failure, offers safe read-only recovery. The optional network
diagnostic does not check collection and is not a required next step.

The main filter row shows **Dates, Tool, Service, Outcome, Author**. **Dates** sets one shared date range for every Analyze widget and its underlying records. **More filters** keeps **Category, Project, Chat, Activity, Collection** available. Applied choices stay visible below, even when More filters is closed, and can be removed individually. The same controls work throughout Analyze, including a scoped chat. On smaller screens or with larger text, fields and selected values wrap rather than disappearing offscreen; Tab reaches each control.

The filters share one area with Refresh and collection status.
**Source and collection** also contains history-gap details and the optional
**Delete collected activity** action; deletion still requires its separate review
and confirmation. Below the filters, the matching total sits beside **View records**
and **Compare periods**. Recorded outcomes and the time/category/path view share
one chart row, followed by **Work IQ tool calls** and **Services**. All use the same
applied filters. **Chart data and definitions** is the single place for exact
chart tables, scope and explanations; its tables stay current when filters change.
When no records match, Analyze shows one empty result with the available filter
recovery and coverage information instead of repeating empty charts and timing
cards. Report selections and their actions stay available; Reset Analyze restores
the ordinary summaries. No matches is not proof that no real activity occurred.
**Over time**, **By category** and **By path or operation** regroup the same matching
records; they do not change the filters or report selection. Outcomes stay beside
the chosen chart, with Tools and Services side by side below it. The chart can
grow for more dates or groups, but switching views does not rearrange those panels.
Long desktop lists scroll within the chart; **Show all** still includes every group,
and keyboard focus scrolls each selected group into view.

Choose **Dates > Custom dates**, enter **From/To**, then **Apply dates**. Dates are inclusive; **All dates** means all retained dates in the chosen collection, not a new scan. In **Outcome**, tick one or more statuses, then **Apply**. The view stays unchanged while you choose; **Cancel**, Escape or clicking outside discards your draft. **Clear** beside the label restores all results without clearing other filters. An empty draft cannot be applied. Choices within Author or Outcome combine with OR; different filters combine with AND. The chart's time-scale control is available in **Over time** only.

**Activity over time** uses flat, linear columns: twice as many matching records
means twice the height. Daily, Weekly and Monthly follow the display time zone;
weeks start Monday. **Time scale** only groups the columns in this widget; it is
not a date filter, creates no applied-filter chip, and stays unchanged when you
use Reset Analyze. Choosing another grouping leaves other widgets and their
records unchanged. Colors retain their recorded-result meaning. Small columns
and result sections are not enlarged; their exact count links and the table in
**Chart data and definitions** remain usable. Choosing a column or table date
narrows the same Analyze slice, retaining search, Author, Outcome and service
context; Back restores it. Partial date ranges remain bounded by your selection.
Undated records stay in the matching total but are listed separately, never
assigned a date. A zero bin means no matching retained records in that bin, not
proof that no real activity occurred. Separate count/percentage views retain
their existing choices and denominators.

**Service** matches recorded service associations, including calls with multiple targets. Choosing Files declares **Files + calls with missing service details**: known matches and separately counted context, with no duplicate calls. Remove the **Calls with missing service details (context)** chip for Files-only matching; the scope then offers an explicit way to include context again. Discovery stays preparation, not missing-service context. **Category** still provides the original exclusive category breakdown, including Discovery, multi-service calls and Service not shown; existing category links keep their meaning.

Use **Author** to choose **Your prompts**, **Agent prompts**, or both, then **Apply**. **All authors** also includes **Author unverified**; choosing just Your + Agent leaves unverified authors out. The same choice works inside a conversation and combines with dates, results, services and projects. Cancel, Escape or clicking outside keeps the previous view. Clear restores all authors without changing the other filters.

The information buttons explain the current choices. **Category** distinguishes Discovery (finding APIs, schemas or agents), search, service targets, multi-service calls and **Service not shown**. In **Activity**, **Graph API call sites** are recorded invocation sites, not measured network calls; **Graph statuses** are the subset with visible HTTP statuses. **Returned API entries** are tool-returned results, not additional calls. **HTTP recorder** is a separate diagnostic source; **Graph code references** do not prove execution. These views overlap, so do not add their counts.

Choosing **Service not shown** explains the matching tools and why their service cannot be identified. For example, **Copilot assistance** identifies an `ask` call even when its record has no downstream API path. The call's technical details show which path, method and version are missing from that record; a question or attached file does not establish which service was used. Missing details do not prove that no service was used or that the call failed.

**Your prompt** is the user-input side of your connected Copilot collection. **Agent prompt** is recorded agent-originated input. Their muted blue and violet labels distinguish sources, not quality. An unverified author stays neutral; **Copilot chat prompt** describes a known chat source without guessing who wrote it. Calls made by an agent stay with the originating interaction.

Each status has its own icon and color. **Tool failed** is different from **Connection failed**; **No result recorded** means missing evidence, while **Other HTTP status** means a recorded informational or redirect status. **Chart data and definitions** explains these distinctions. **Worked** means tool completion, not answer correctness.

Choose **View interaction** directly from Analyze. A compact source row names the Copilot chat, project and recorded time, followed by the saved prompts, calls and replies in order. The selected prompt or exact call is marked. Long prompts and retained follow-ups need no extra expand step. At most one linked group before and after the selection is included, using recorded message IDs and consistent timestamps, never a guessed task or a whole-chat dump. The nearby-message note explains that linked messages may be separate work. Missing text, unknown times and missing, conflicting or unsupported sender details stay explicit.

**Reviews and record details** brings secondary information together below the exchange. Each interaction keeps its own counts, saved reviews, feedback controls and technical source record; nothing is pooled or reassessed against a later request. Analyze's filter form, filter chips and reset controls are not repeated in the reader. **Back to results** restores them unchanged when you want to adjust the view.

**Filter to chat: [name]** narrows Analyze to records from that recorded source; it does not open the chat. **Back to results**, beside the page heading, returns to the previous results, filters and page. Removing the chat filter keeps other applied filters. The reader uses the same return control, or **Back to search** when opened from Search. A directly opened reader without an earlier results view offers **Back to Analyze** instead of pretending to restore a previous list.

For a slow, failed or specific recorded call, switch Analyze to **Calls**. **Slowest first** is the default; **Fastest first** reverses only measured durations. Equal durations use stable record-ID order, and unavailable durations stay in a separate group at the end, across pages. A duration belongs to the listed evidence unit, never the sum of concurrent calls or total task latency. API results, Graph request sites, visible statuses, code references and owned HTTP records retain their separate meanings; code references do not establish execution.

**Open exact call in context** (or **Open exact record in context** for other evidence) focuses the selected record inside the same retained chronology. A returned API entry opens under its actual recorded parent, even if it was not the first result. Matching actions are distinguished from other retained context; the rest of the interaction is not removed. Back restores filters, private search, duration order, result page, reading position and focus without discarding report selections. Native modified-click links retain the exact record ID, but never include private search text. A missing record or parent is explicitly unavailable, not replaced with a nearby action. Opening a call does not refresh source data, issue a downstream service request or run an assessment; already-retained replies keep the existing authorization and Hide behavior.

Returned API-entry links are tied to the stored snapshot revision because their existing identities are positions within retained tool metadata. After the stored revision changes, reopen the entry from Calls; an old link is unavailable rather than risking a different entry. Other call/record links use their stable recorded identities.

The reader puts the text before its Copy and Hide controls. **Read prompt** shows the complete retained text. **Hide prompt** collapses only that text, keeping your place and report selection. **Copy prompt** copies that full original body, unmasked: not its preview, chat details, warnings, response or the whole page. The action reports success only after the clipboard write succeeds; denied or unavailable access shows an error and a manual-selection alternative. **About this prompt & copying** explains author uncertainty, partial text and clipboard implications. **Technical source record** keeps exact timestamps, identifiers and source codes separate from that reading help.

**Notes on full interactions** keeps useful recorded failure reasons and missing-evidence or review problems beside Analyze's outcomes, without repeating the outcome totals. Full-interaction totals and the absence of saved reviews remain in the existing saved-review details. The reader keeps each call's result and recorded failure reason beside that call; **What the record shows** and saved assessments stay under each original request in **Reviews and record details**. Each check keeps its own counts. Sign-in, timeout and access-denial wording describes the historical call, not your current access. A failed lookup can have a correct explanatory answer. If a reason behind a saved verdict was not retained, WIRE says so rather than inventing an explanation or running another AI review.

**Time to recorded final response** appears beside each prompt in Interactions
and in the opened interaction. It runs from that recorded message to its final-answer
timestamp, when matching turn-completion metadata confirms the answer. It is not
the time to display the answer on screen or proof that every call finished inside
that interval. **Not recorded** means no qualified timing is available; a recorded
zero remains zero. Timing metadata does not require saving the answer's text.

Individual call durations stay beside calls in **Calls** and the reader. Use
**Slowest first** or **Fastest first** to compare them; WIRE does not judge a long
call as bad or flag a speed threshold. Missing call timing says **Not recorded**
and sorts last in either direction. There is no detached timing widget or default
median/P95 summary. **Saved reviews** remains separate, retaining its original
interaction scope, status and controls.

When no reviews or attempts are saved and automatic scoring is off with no
approval, this area says **No saved reviews for these requests**. **Measure
definitions** keeps the recorded counts, definitions and reading help available;
automatic scoring remains in **Settings > AI reviews**. Pending, failed,
uncertain or revoked reviews, unavailable history and existing feedback keep
their status and controls rather than being treated as an empty state.

Open **Saved assessment details and counts** for tool outcomes and exact saved review counts, percentages and coverage. For example, **2 of 108 requests assessed**, **2 passed**, and **106 not assessed** describes two judgments, not a 100% quality score for 108 requests. **Answer correctness** asks whether the answer met the request using saved evidence. **Answer support** asks whether that evidence supports the answer. **Tool use vs. request** is an AI review of whether the recorded tool use fit what was asked, not proof of permission. Each check keeps its own request count.

**Permission for tool use** is separate, optional **Your feedback**: Given, Not given or Not sure. Saving that opinion does not grant or revoke permission. Its automatic local check may say permission is not checked automatically; it never borrows an AI request-match verdict. Older or unfamiliar definitions show **Saved review (type not recorded)** rather than guessing what they checked. Context findings and saved verdicts stay with their original request group when a later request changes direction.

Opened saved details stay open when the same scope or request is redrawn or revisited with Back. Different scopes and original request groups keep independent disclosure state.

**Reported outcomes** can show that a call succeeded or failed even when its completion event reference was not retained. **Completion-evidence checks** in saved details use that stricter evidence boundary, so a reported success may still have **No qualified outcome**. WIRE explains the gap without changing either count or inventing missing evidence; partial outcome context is labelled with its actual coverage.

**No saved review**, **Not enough saved evidence**, and **Review could not finish** describe different states. None is a failed answer or an instruction to grade it yourself. Missing historical attempt information stays unknown; it does not mean no review was attempted or that one is queued.

**Measure definitions** retains exact subset percentages, denominators, recorded timing samples and boundaries, model and rubric. These optional full-interaction aggregates can cover more calls than the filtered Calls list. HTTP response-header and transport-error timing remain separate measurements. Never sum concurrent calls, average medians, infer retry chains or treat a recorded response interval as the duration of a person's entire task. **Details and feedback** on a single interaction also offers optional personal verdicts and **Withdraw feedback**. Use the panel's header **Close** or **Escape** to leave. Closing feedback does not cancel a submitted update; check its existing result rather than repeating it. **Worked** means tool completion, not verified correctness.

In Analyze, scoped search and filters select the request groups used by counts and Insights, across every page. Each displayed response duration still belongs to its full original recorded message interval, not a filtered call subset. Calls, API entries and HTTP records remain separate units. No matching groups means no interaction metrics, not the all-activity summary. Legacy private search keeps its browser-history compatibility. New Search text stays in panel memory and the on-device local runtime, never in links, logs or browser storage. Earlier Home and Activity links both open Analyze.

Reply saving is off unless previously approved. To keep recorded replies in WIRE, open **Settings > Privacy & saved data > Recorded replies**, select **Save Copilot replies locally**, then **Turn on response saving**. **Discard change** restores your current choice. The source and capture limits appear before you confirm the change. Deliberately opening an interaction immediately reads only its displayed context's already-retained, currently authorized replies. Analyze and hover do not preload them; explicit Search reads only already-authorized retained replies through the same permission gates. Every reply is checked independently against current access; opening context never turns saving on or reads the original source. **Copy response** copies only that response body and **Hide response** collapses it; an explicit hidden state is respected on rerender. Missing responses remain unavailable, read errors offer an explicit retry, and partial or unverified final-answer status is not upgraded. Turning response saving off removes optional text and dependent unsaved insights; activity and saved reports remain. This does not authorize model assessment.

## Search

Type in the header's **Search** field; matching results appear as you type,
without Submit or autocomplete. **POWER** finds **PowerPoint**, and **owerp**
also finds it in the middle of the word. A multiword query matches that literal
phrase, not those words scattered through a record. Search ignores case but
does not guess intent, expand synonyms or correct spelling. For example,
**repair the car** also finds **did not repair the car**.

**Everywhere** searches existing interactions, prompts and follow-ups, authorized
retained replies, recorded calls, saved report/comparison content, tools, services,
views and settings across all pages. Saved report titles and bodies are searchable.
Each row shows its category and source, with the matching original text visibly
marked. There are no AI-generated answers or Related suggestions.

Enter or click opens the verified item; Back restores your query, category, page
and focused result. Settings opens the named setting without operating its control.
**Filters** provides optional scope/type choices and stays closed until you open it.
Focusing an empty field does not open another form or move the Search field.

Choose **Current Analyze scope** (also available through **Search this Analyze
scope**) only when you want the matching population to refine Analyze. Global
navigation hits never become report membership. Pending, stale or partial membership
shows unavailable measures, not fabricated zero counts. Partial navigation matches
remain labelled, but cannot establish an analytical population or current-view report. Selected/All report
choices and hidden selected requests remain separate.

Search is deterministic and local, with **no AI or model setup**. It never enables
collection, runs a tool or assessment, saves replies or downloads assets. A busy runtime,
disconnection or permission/source change clears results rather than retaining
clickable stale targets. Saved HTML/JSON/Markdown open their verified frozen copy;
explicit PDF Open downloads the verified saved PDF. Nothing is regenerated.
Missing or unreadable content is reported as incomplete/unavailable, not a claim
that everything was searched and nothing matched. See [text-search details](docs/live-search.md).

## Compare retained periods

In **Analyze**, choose **Compare periods**, enter the inclusive start/end dates
for **Period A** and **Period B**, then choose **Compare periods** in the paired
controls. No preliminary reports are needed. Both periods come from one accepted
stored revision in the displayed time zone. This is a stored-data read, not a
source refresh or a new assessment.

Tool, Service, Outcome, Author and More filters apply to both sides.
**Search this comparison** opens the single Search field in analytical
scope without changing either period. Meaning/exact matches cover the full retained
corpus, not just the ordinary Analyze dates or visible page. A retained legacy
phrase is an additional intersection; only its canonical narrowing IDs enter the
paired request, never the phrase text. Each Outcome choice
shows separate A/B counts before that outcome filter; overlapping periods are
not added together. Opening or ticking a menu does not apply its draft.

The comparison temporarily replaces ordinary date controls, charts and rows.
**Stop comparing** restores them, including their previous dates and private
query. **Exact matching records** opens the existing record/context reader; Back
restores the paired periods and opened assessment details. Report selections
remain separate. **Create comparison report** prepares this exact accepted pair
through Activity, Contents, then Review & save. Disclosure approval and local saving
remain separate actions. No earlier reports
are required, and the saved copy is not regenerated when reopened.

Read the matching-record counts separately from **full retained interaction**
findings. An interaction can have calls outside the selected dates or filters,
or can appear on both sides. Its saved quality checks and request-to-final-response
time still cover that full interaction; context never expands the matching-call
denominator. Service associations can overlap, but a canonical record counts
once on each side. Missing-service context remains explicitly identified.

Differences are **B minus A**. Shares change in **percentage points**, not percent.
Unequal periods, different activity and incomplete assessment coverage do not
prove improvement or causation. Median/P95 matching-call comparisons are available
for Work IQ calls and use retained raw samples. Full-interaction timings keep
their separate named boundaries. Zero, one measured sample, missing timing,
unassessed checks, insufficient evidence and evaluator failures remain distinct.
An empty period has no inferred percentage. Changes to evidence or permissions
clear the live comparison; read the current stored view before comparing again.

## Create a report

1. **Activity:** Open **Reports > Create a report**. Choose **All saved sessions**, **Current Analyze view**, or individual **Selected interactions** in the report's list. All saved sessions ignores Analyze dates, filters and search; it uses saved reportable activity, not complete chat transcripts. Counts distinguish chats from interactions. Prompt-author choices include or exclude whole interactions and keep hidden selections. Continue to Contents.
2. **Contents:** Choose **No prompts**, **Masked prompts** or **Original prompts**, optional linked requests/replies, and the files to save. HTML is the existing default; PDF, JSON and Markdown are also available. **Prepare report** creates the actual copies for inspection without saving them.
3. **Review & save:** Read the flowing report. **Text** shows originals, masked copies and removals; **Files** exposes the exact prepared files. Editing or omitting a copy requires **Rebuild preview**. Check the disclosure box and **Approve for local saving**, then separately click **Save report locally** in the same workspace.

Back and the next action stay together. Scope details are optional, not another gate.
Back to Contents keeps an unchanged preview;
changing report choices or relevant source data requires a new scan and disclosure review.
Unrelated browsing keeps the draft. A pending or failed read blocks saving until the
report basis is verified again; an uncertain save is checked in saved history, never repeated automatically.

After saving, **Open saved report** is the main action; downloads and **View saved reports**
remain nearby. The library shows scope, preparation date and available formats, with
**Files & actions** for secondary operations. Search and paging work across older reports.
Opening one reads its frozen copy; it does not rerun an assessment. **Create a report**
starts a new empty selection after a completed save, while **Continue draft** preserves unfinished work.

New reports lead with **At a glance**: the recorded work represented, common tool/service
patterns and supported findings. Examples use reviewed prompt text when included.
Exact counts, distinct timing boundaries and coverage remain available; missing reviews
are not failed scores. HTML, PDF, Markdown and JSON use the same frozen facts.

Review masked copies too. Detected credentials are removed even in Original mode. Saving uploads nothing.
Author membership and prompt text are separate: **No prompts** hides text, not interactions.
Changing report authors requires a fresh preview and disclosure review. Saved files use neutral
**User prompt** wording for the cohort called **Your prompts** in the app; they do not identify a named person.

## Compare or delete

Reports opens on the saved library. Search across all pages, use **Previous/Next**
or **Page / Go**, and choose **Open** to read a frozen report. **Manage** holds
downloads, comparisons and individual deletion. Search uses report metadata,
not private report contents or prompts. Switching to **Continue draft** keeps
your unfinished report choices and otherwise unchanged review.

Choose **Manage > Compare saved reports**. Choose **Baseline report** and **Later report**, then **Compare reports**. These use frozen facts. To save, choose formats, **Prepare comparison copy**, review and **Confirm disclosure**, then **Save comparison**.

**Delete report** or **Delete saved comparison** removes that item and managed copies. Source activity, other reports and external downloads remain; saved comparisons survive deletion of an input report.

**Delete all saved reports** previews all report bundles across every page,
regardless of search, before a separate count-labeled confirmation. Saved
comparisons, collected activity, draft reports and external downloads remain.
Unsaved comparisons using deleted reports become invalid. Cancel deletes nothing.
Deletion is permanent; interrupted cleanup can leave files behind. Use
**Check deletion result**, including after reopening the panel, rather than
repeating confirmation. New reports saved after the preview are not included.

For collected records, use **Settings > Privacy & saved data > Delete collected activity**. Opening it deletes nothing. Choose **All collected activity** or dates, then **Preview deletion**. Review counts before **Delete N records**. **Cancel** changes nothing; **Change scope** requires another preview. Copilot sources and saved reports remain. Red outlines identify destructive entries and confirmations, not ordinary previews or cancellation.

## Recollect activity

After deletion, ordinary refresh and collection checks do not bring deleted records back.

1. Open **Settings > Privacy & saved data > Recollect from approved sources**.
2. Use **Find a chat** or the paged list, then enter **From/To** dates. Choices stay selected across searches and pages; **Show selected** reviews them. Only the already-approved source and history window can be read.
3. If wanted, select **Also restore original prompts for these requests**. This is off by default. Deleted response captures and personal feedback are not restored.
4. Select **Preview available evidence**. Review the exact records, prompt choice and **Source availability and limits**. Missing history cannot be recovered. **Cancel**, Escape or **Change scope** makes no stored change.
5. Select **Recollect N records**. Then create a new report from the recollected requests. Existing saved reports and comparisons are unchanged.

If the result is uncertain, use **Check recollection result**, even after reopening the panel. Do not repeat confirmation. Recollection is a deliberate source reread, not an undo, backup restoration or new Work IQ query.

After an uncertain result, use its result/status check. Do not repeat the change. [Technical and privacy details](README.md).
