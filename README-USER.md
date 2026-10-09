# WIRE: user guide

Open [WIRE](http://127.0.0.1:47831/) (local runtime required).

On a new machine, follow [source checkout and setup](README.md#set-up-on-another-machine)
first. The clone contains no collected activity or private configuration. Approve
that machine's source in Settings; response saving and automatic scoring each
need separate approval and are not enabled by installing WIRE.

| Page | Use |
| --- | --- |
| Home | Check for new activity; filter dates and results. |
| Activity | Choose a Copilot chat, inspect interactions and select requests. |
| Reports | Find, open and manage saved reports, or switch to creating a report. |
| Collection status | Check whether collection is running, find chats with history gaps and see any available next step. |
| Settings | **Connection & permission** for source approval; **Time zone**, collection and capture settings. |

Use **Collapse navigation** at the top of the sidebar for an icon rail and more
content space. Hover or focus an icon for its name; **Expand navigation** restores
the full labels, including by touch. The sidebar and page glide together; reduced
motion uses an immediate change. The browser remembers this display choice
without changing filters, selected requests or unfinished forms. On narrow
screens, **Menu** opens full navigation; **Escape** or **Close** returns to the page.

## Inspect an interaction

**Check for new activity** reads approved local histories without rerunning Work IQ or Graph queries. **Refresh stored data** rereads collected evidence.

**No new recorded activity** means that manual check added no records or updates;
it does not mean every history is available. **Chat history** shows the known
unavailable, limited or still-reading chat counts from that check. Open
**Source and collection**, beside the check button, for its recorded primary
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
the full timestamps, limits and **Refresh stored data**. The optional network
diagnostic does not check collection and is not a required next step.

All analytical filters are visible in one row: **When, Result, Author, Category, Project, Activity, Collection**. On smaller screens or with larger text, scroll the row sideways; Tab reaches each control, and arrow keys scroll the focused row. Titles and selected values stay on one line without truncation. The same row works in Home, Activity and a scoped chat.

Choose **When > Custom dates**, enter **From/To**, then **Apply dates**. Dates are inclusive; **All dates** means all retained dates in the chosen collection, not a new scan. In **Result**, tick one or more statuses, then **Apply**. The view stays unchanged while you choose; **Cancel**, Escape or clicking outside discards your draft. **Clear** beside the label restores all results without clearing other filters.

Use **Author** to choose **Your prompts**, **Agent prompts**, or both, then **Apply**. **All authors** also includes **Author unverified**; choosing just Your + Agent leaves unverified authors out. The same choice works inside a conversation and combines with dates, results, services and projects. Cancel, Escape or clicking outside keeps the previous view. Clear restores all authors without changing the other filters.

The information buttons explain the current choices. **Category** distinguishes Discovery (finding APIs, schemas or agents), search, service targets, multi-service calls and **Service not shown**. In **Activity**, **Graph API call sites** are recorded invocation sites, not measured network calls; **Graph statuses** are the subset with visible HTTP statuses. **Returned API entries** are tool-returned results, not additional calls. **HTTP recorder** is a separate diagnostic source; **Graph code references** do not prove execution. These views overlap, so do not add their counts.

Choosing **Service not shown** explains the matching tools and why their service cannot be identified. For example, **Copilot assistance** identifies an `ask` call even when its record has no downstream API path. The call's technical details show which path, method and version are missing from that record; a question or attached file does not establish which service was used. Missing details do not prove that no service was used or that the call failed.

**Your prompt** is the user-input side of your connected Copilot collection. **Agent prompt** is recorded agent-originated input. Their cyan and violet labels distinguish sources, not quality. An unverified author stays neutral; **Copilot chat prompt** describes a known chat source without guessing who wrote it. Calls made by an agent stay with the originating interaction.

Each status has its own icon and color. **Tool failed** is different from **Connection failed**; **No result recorded** means missing evidence, while **Other HTTP status** means a recorded informational or redirect status. **Scope and result definitions** separates current counts, short result meanings, and optional reading guidance. **Worked** means tool completion, not answer correctness.

Click **Choose a Copilot chat**, expand a chat, then **View interaction**. The detail page leads with the chat/source context, prompt and available response, followed by **Insights**, **Recorded actions** and **Report selection**. One request group can contain several calls. Supported author metadata identifies **Your prompt** or **Agent prompt**; a chat source alone does not prove who wrote it.

**Read prompt** shows the complete retained text. **Hide prompt** collapses only that text, keeping your place and report selection. **Copy prompt** copies that full original body, unmasked: not its preview, chat details, warnings, response or the whole page. The action reports success only after the clipboard write succeeds; denied or unavailable access shows an error and a manual-selection alternative. **About this prompt & copying** explains author uncertainty, partial text and clipboard implications. **Technical source record** keeps exact timestamps, identifiers and source codes separate from that reading help.

Insights leads with how many requests have a result for each check. **Results for 1 of 69 requests**, followed by **1 passed · 0 failed**, describes only that one request, not 69 successful requests. Accuracy, answer support and actions matching the request are separate checks. When all three AI checks cover the same requests, WIRE says so; their counts must not be added. Each check keeps its own coverage when the requests differ. Missing results are not failures or a promise of queued work. Personal feedback stays separate from AI results, and action alignment does not prove a person gave permission.

Speed shows seconds, with separate timed-call and timed-request counts. One request can contain several tool calls; do not add the two times. **How to read these results** explains AI limits and median timing once. **Measure definitions** retains exact percentages, passed/failed counts, milliseconds, definitions, model and rubric; **Details and feedback** on a single interaction also offers optional personal verdicts and **Withdraw feedback**. Use the panel's header **Close** or **Escape** to leave. Closing feedback does not cancel a submitted update; check its existing result rather than repeating it. **Worked** means tool completion, not verified correctness.

In Activity, private search and filters select the request groups used by both counts and Insights, across every page. Insights use those groups' full retained interactions; a call-level filter can therefore show fewer matching calls than the interaction's timing or completion denominator. Calls, API entries and HTTP records remain separate units. No matching groups means no interaction metrics, not the all-activity summary. Search stays in this browser's history, not in links or backend text queries. Home uses its chart filters, not Activity's private search.

To keep recorded replies in WIRE, open **Settings > Collection preferences > Recorded replies**, select **Save Copilot replies locally**, then **Turn on response saving**. **Discard change** restores your current choice. **What gets saved** explains the source and limits. **Read response** opens already-retained local text; **Copy response** copies only that response body and **Hide response** collapses it. Copy/Hide do not run Work IQ or retrieve new source content. Missing responses remain clearly unavailable, and partial or unverified final-answer status is not silently upgraded. Turning response saving off removes optional text and dependent unsaved insights; activity and saved reports remain. This does not authorize model assessment.

## Create a report

1. **Requests:** Open **Reports** in navigation (on mobile, open **Menu > Reports**), choose **Create a report**, then **Choose requests in Activity**. Tick requests and return via **Review selection** or **Reports > Continue draft**. **Add to report** works from interaction details. Selection starts empty; other scopes are under **Use current view or all collected activity**. Use **Prompt authors in this report** to narrow that scope, then **Apply**. Your-only leaves out agent-originated interactions, including their calls and scores; unverified authors are a separate choice. Browsing filters do not discard hidden selected requests. Review the included/excluded group counts, then click **Continue to contents**.
2. **Contents:** Choose **No prompts**, **Masked prompts** or **Original prompts**, and HTML, PDF, JSON or Markdown. Click **Scan and preview**.
3. **Review:** Read the preview, prompt copies and privacy findings. **Inspect exact files** and **Included evidence and preparation details** show the underlying copies and counts. **Edit or omit this report copy** affects only exports; then **Rebuild preview**. Check approval and **Complete disclosure review**.
4. **Save:** Check the approved requests, prompt mode and formats, then click **Confirm local export**. Use **Open saved report** or **Download**. Reopen files through **Saved reports > Open**.

Back and the next action stay together in each step. Opening scope details and
optional request labels is not a required step. Back to Contents keeps an unchanged preview;
changing its choices requires a new scan and disclosure review.

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

For collected records, use **Settings > Data management > Delete collected activity**. Opening it deletes nothing. Choose **All collected activity** or dates, then **Preview deletion**. Review counts before **Delete N records**. **Cancel** changes nothing; **Change scope** requires another preview. Copilot sources and saved reports remain. Red outlines identify destructive entries and confirmations, not ordinary previews or cancellation.

## Recollect activity

After deletion, ordinary refresh and collection checks do not bring deleted records back.

1. Open **Settings > Data management > Recollect from approved sources**.
2. Use **Find a chat** or the paged list, then enter **From/To** dates. Choices stay selected across searches and pages; **Show selected** reviews them. Only the already-approved source and history window can be read.
3. If wanted, select **Also restore original prompts for these requests**. This is off by default. Deleted response captures and personal feedback are not restored.
4. Select **Preview available evidence**. Review the exact records, prompt choice and **Source availability and limits**. Missing history cannot be recovered. **Cancel**, Escape or **Change scope** makes no stored change.
5. Select **Recollect N records**. Then create a new report from the recollected requests. Existing saved reports and comparisons are unchanged.

If the result is uncertain, use **Check recollection result**, even after reopening the panel. Do not repeat confirmation. Recollection is a deliberate source reread, not an undo, backup restoration or new Work IQ query.

After an uncertain result, use its result/status check. Do not repeat the change. [Technical and privacy details](README.md).
