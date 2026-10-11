# WIRE

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/wire-wordmark-dark.svg">
  <img src="assets/wire-wordmark.svg" alt="WIRE cable wordmark" width="316" height="100">
</picture>

**Work IQ Request Explorer**

**[User guide: where to click and how to create a report](README-USER.md)**

A local personal evidence and learning app for GitHub Copilot. Explore recorded
Work IQ activity, trace a GitHub Copilot chat through its prompts and calls, and prepare short
reports with an explicit choice to omit, mask or locally include original prompt text.

The maintained [product design contract](docs/design.md) records the user
journey, Taste-informed choices and interaction acceptance criteria.

## Set up on another machine

Install Git, Node.js **24 or newer**, and npm **11.17.0** (the version declared in
`package.json`). Authenticate Git access to this private repository with your
personal GitHub account; repository access is separate from Copilot authentication.
Clone into a stable local folder, not a temporary Copilot worker checkout:

```powershell
git clone https://github.com/likamrat/wire.git
Set-Location wire
npm ci
npm start
```

Open `http://127.0.0.1:47831/` in a browser. No build, copied `node_modules`,
private release directory, Copilot sign-in or evidence migration is needed to
start the empty app. Keep this terminal running. For an existing clone, stop
only its own runtime before `git pull --ff-only` and `npm ci`, then restart it.

The repository transfers **source only**. A new machine has its own empty private
store and requires its own source approval in **Settings > Connection &
permission**. Do not copy histories, prompts, responses, exports, credentials or
the previous machine's private configuration into the checkout. Response saving
and automatic scoring remain off until separately approved on the new machine.
Connecting local history requires the supported local Copilot app metadata and
history files described below; starting WIRE alone does not connect them.

PDF export is optional. After `npm ci`, install its local browser with
`npx playwright install chromium`; HTML, JSON and Markdown do not need it.

## Optional Copilot canvas

For the canvas, install a Copilot host that supports extensions and canvases.
Copilot supplies `@github/copilot-sdk/extension` when launching the extension;
do not add a machine-specific SDK folder to the project's dependencies.
Keep the local runtime running, then open a **second terminal in the clone**
and install the user-scoped canvas entry:

```powershell
npm run install:canvas
```

Reload Copilot extensions and open **WIRE**. The installer points to this
clone's `extension.mjs`; keep the clone at that location, or rerun the installer
after moving it. It backs up a different existing entry before replacing it.
The browser-only app does not require canvas installation.

The runtime owns its loopback listener and private state. Closing a canvas or
reloading an extension does not stop it. The canvas adapter only connects over
HTTP; it cannot create a second store writer. `npm start` uses a fixed port and
refuses a conflicting listener rather than silently starting on a random port.
This installation does not create a scheduled task or an OS startup service.
After restarting the computer, start the runtime again with `npm start`.

Browser clients obtain distinct, in-memory capabilities. Reconnecting establishes
a fresh owner, invalidating old previews. Read requests can be revalidated; review,
recording and export mutations are never automatically replayed after an uncertain
response. Disclosure reviews belong to the browser that performed them; an
agent-created preview cannot borrow another panel's attestation.

## Source and private data

WIRE is the new display name for Work IQ Evidence. This is a visual rebrand, not a
storage migration. The existing `work-iq-evidence` folder/package, `workiq-evidence`
extension installation, `workiq-evidence-board` canvas ID, private data location,
environment variables and saved display preferences remain compatible. Historical
records and previously exported files keep their original content. New HTML/PDF
reports include the local logo; Markdown uses the WIRE name. New evaluation reports
also persist versioned frozen facts across formats; missing legacy facts are not
reconstructed from current histories.

The approved middle-bar artwork lives in `assets/wire-wordmark.svg` and
`assets/wire-wordmark-dark.svg`; the cable forms the W and completes the E.
The header shows **Work IQ Request Explorer** beneath the wordmark.
`assets/wire-icon.svg` supplies the compact, face-free W for browser tabs.
`lib/branding.mjs` supplies the shared names and inline theme variants with
independent local paint IDs. No remote image or font is required.

This folder is the maintained application source. It contains no real prompts,
chat inventory, event logs, evidence snapshots, pseudonym keys or exports.
Tests use invented records in isolated temporary directories.

Private state defaults to `%LOCALAPPDATA%\WorkIQEvidence\data` on Windows. It is
independent of a Copilot conversation or checkout. `WORKIQ_EVIDENCE_DATA_DIR` can
select another absolute private location; never point it inside this source
folder, and never share a writable directory between application processes.

The store keeps immutable content-addressed evidence snapshots separately from
atomic review state. Exact original prompts and follow-ups are available locally
when an interaction is opened. An adjacent follow-up is an inferred association, not proof of causal
intent. API response entity bodies and credential-shaped captures are excluded.

### Personal interaction insights

**View interaction** opens automatically derived facts for the retained request,
with separate accuracy, speed, answer-trust and action-trust results.
Successful execution is not correctness or authorization. Missing evidence is
unassessed/not measured, never a fabricated zero or failure. Personal feedback is
optional and revisioned; it does not edit recorded outcomes or saved reports.

Real Accuracy, answer-trust and action-trust measurement remains incomplete.
Synthetic evaluator tests do not establish real answer quality; approved model
assessments have a separate origin and do not prove human authorization.
The original Cost metric is retired, not zero; evaluator allowance, observed
spending and unknown-billing guards remain in score-processing controls.
Optional scoring requires a separately configured local Copilot SDK/executable,
Copilot authentication and explicit evidence/spending approval; cloning and
starting WIRE do not perform those steps.

Additional response evidence is off until explicit setup consent. In
**Settings > Collection preferences > Recorded replies**, **Save Copilot replies
locally** and **Turn on response saving** permit bounded,
credential-screened, already-recorded assistant text from the same approved source.
No new source discovery, API replay, citation fetch or remote judge is introduced.
**Turn off and delete responses** purges dependent optional payloads through sealed
cleanup without deleting base activity. Usage/authorization categories remain
unavailable where the supported adapter has no typed evidence.
Older `#settings?section=evidence` links still open the Recorded replies row in
Collection preferences. They do not create a separate category or grant consent.

The [personal evaluation contract](docs/personal-evaluation.md) documents the
measurement definitions, evidence-only revision, capture bounds, read-only receipt
recovery and persistence/deletion interfaces. Reports freeze exact membership and
facts; comparisons use compatible technical patterns, not raw-prompt similarity.

### Delete collected activity

Open **Settings > Data management > Delete collected activity**, or use the
same shortcut in **Activity**. Choose **Custom date range** (initially blank) or
**All collected activity**, then **Preview deletion**. The separate red-accented
confirmation names the exact count, scope and consequences. **Cancel** or Escape
before confirmation changes no stored activity. **Change scope** revokes the
preview. View filters, Clear selection, Reset view and Refresh never delete.

Deletion counts distinct calls, Graph sites/code references and HTTP diagnostics,
not the sum of overlapping analytics layers. Canonical call/start-event aliases
are removed together. Retained-only recovery records and supporting copies are
disclosed separately from current request groups. Ranges include both civil dates
in the applied IANA display zone (including 23/25-hour DST days), using start time,
not completion. As with existing call filters, calls without a start use recorded
group capture time; Graph sites never borrow another layer's clock. Unknown or
invalid times stay for ranges; All includes them. Valid future dates can be empty.
Spanning groups keep their out-of-range records and shared prompts; references
to deleted calls are pruned without altering surviving request metadata.

The purge covers active/private evidence snapshots, associated review state,
collector prompt/script/context copies, HTTP files and diagnostic receipts,
known local recovery states, linked response evidence and personal feedback,
unsaved derived caches/comparison drafts, and the managed migration backup named by this
store's manifest. Remaining records are preserved; content-addressed copies and
recovery pointers are rebuilt before obsolete files are removed. Source approval,
configuration, cursor offsets, source roster and reading receipts remain.
Linked-insight counts are separate from source-record counts.
**Saved reports and saved comparisons retain their frozen copies**, including files in managed backups.
Exports/downloads and unmanaged or external original migration sources are not
deleted. This is logical and filesystem deletion, not secure forensic erasure.

Only hashes of existing identities/events, not their text or a blanket date
cutoff, remain to prevent automatic recollection. Polling, reconciliation, restart, rotation,
late completion and source/window changes cannot reimport deleted
identities. Genuinely new calls, including in the same chat/date window, remain
collectible; a deleted prompt is unavailable rather than reconstructed for them.
Previously unread history is not part of the confirmed set and may still arrive.
There is no undo or backup recovery. The separate explicit recollection flow
below can reread selected, still-available approved source history.

Confirmation is panel-bound, expires after two minutes, and rechecks the sealed
revision, identities and supporting-file hashes. Collection/recorder work and the
store writer are coordinated. A durable operation journal precedes file cleanup;
an interrupted purge blocks activity/export access until restart completes that
same hash-guarded plan. Changed/linked/unrecognized files fail closed. A timeout
or reconnect offers **Check deletion result**, which only reads the original
operation receipt and never resends deletion. Activity-deletion recovery retains
the opaque receipt ID. Assessment and saved-artifact recovery additionally use a
scoped read-only receipt token, cleared from the panel after a terminal result;
the server persists only its hash. It never authorizes mutation replay.
Scans admit up to 20,000 files / 2 GiB, with a 16 MiB
per-file limit. Repeated record versions are interned; coverage and checkpoint
content is processed one file at a time instead of keeping every historical
copy in memory. Separate 64 MiB unique-record and 32 MiB compact-metadata budgets
fail explicitly before mutation. The volume regression processes more than
512 MiB of retained copies under a 192 MiB Node heap, checks preview/cancel byte
preservation and canonical counts, then verifies the isolated purge. No source
database, chat history or arbitrary manifest source path is opened for writing.

Records without source identifiers use a stable retained start/request
fingerprint, never their current array position. Anonymous local records are
qualified separately from verified distinct calls. If selected anonymous
occurrences cannot be distinguished, or old positional markers are ambiguous,
deletion stops with an explicit error and changes nothing rather than guessing.
Unfinished activity-deletion plans sealed by the older positional implementation
are also blocked before file cleanup; keep their journal and recovery copies for
review, and do not force-replay them. Identifiable calls, Graph records and HTTP
records keep their existing identity rules. A running process must be replaced
with the verified corrected runtime before this safety fix takes effect.

### Recollect activity

Use **Settings > Data management > Recollect from approved sources**.
Find eligible local Copilot chats with **Find a chat** and the paged list.
**Show selected** reviews choices across searches/pages; the selected count
remains visible. Search stays in the panel and does not change the chosen scope.
Select inclusive dates in the current display zone, then **Preview available evidence**.
Dates use the existing display format, naming a single day only once.
Actual request-start bounds are
intersected with the existing approved 7/30/90-day window; this never approves
another source, broader window or optional response capture. The preview shows
available canonical request records, previously deleted versus newly available
records, already-present records that will not be duplicated, and history gaps.
Unavailable/unsupported logs, bounded tails, incomplete lines and excluded
credentials are disclosed, not reconstructed. Anonymous local-only records and
owned HTTP diagnostics are not recoverable from this source reread.

**Also restore original prompts for these requests** is an independent
choice, initially unchecked. When selected, the preview names the number of
still-available deleted original prompts (including associated follow-ups) that
will be retained again. It can also restore prompts for already-recollected
selected records without duplicating their calls. Without this choice, deleted
prompt text stays unavailable. Existing prompt-origin metadata is preserved;
this does not invent authorship or reconstruct missing history.
The reread passes first-message context to the shared author classifier:
an agent-created kickoff cannot become "User" from the default host envelope
alone. If the source prefix cannot establish the first message, default
envelopes in that agent-created source remain unverified. Normalized author
metadata is retained, not the transformed host-envelope corpus.

**Cancel**, Escape and **Change scope** before confirmation do not write
evidence, markers or source files. **Recollect N records** separately confirms
the exact preview, including the prompt choice. Confirmation rereads the source
and revalidates its file stamps, eligible mapping, approval, evidence revision,
two-minute expiry and exact canonical target. Changes fail closed and require
another preview. Scans use the existing read-only source adapter, credential
screen, extractors and bounded reader: at most 128 selected chats, 32 MiB read
per preview/confirmation, the last 64 MiB of each file, and 20,000 candidate
records. These limits may produce an explicitly partial preview.

Only selected canonical record aliases are removed from suppression, atomically
with the content-addressed evidence pointer and a hash-protected receipt.
Recollected units carry the operation ID and whether they were previously
deleted; normal new activity does not carry this authorization. Event and
context-call guards are **not cleared**. Prompt opt-in adds hash-only grants
pairing an original prompt event with the selected record aliases, so unrelated
records cannot restore that text. Deleting the authorized units again revokes
their grants and cleans their copies through the existing sealed deletion flow.
Optional response captures and personal feedback remain deleted; their separate
guards are unchanged. Current counts/insights/report eligibility are recomputed.
Saved reports, saved comparisons, source files, collector offsets and settings
are unchanged. Create a **new** reviewed report from the resulting evidence.

An uncertain response offers **Check recollection result**, a read of the
original receipt, including after panel reload/runtime restart. It never repeats
confirmation. A scoped receipt token is saved in this tab and only its hash in
the store. Atomic publication either commits evidence and authorization together
or leaves the earlier store authoritative; restart never begins a recollection.
Existing pending/legacy deletion cleanup must be resolved first and is not
bypassed by this feature.

### Delete one saved report or comparison

The contextual **Delete** action in Reports is separate from deleting collected
activity. Its named-object confirmation removes only that saved bundle, recognized
app-managed copies and index entry. Source activity, other reports and external
downloads are untouched. Large saved files are verified with bounded streaming
rather than treated as source-evidence snapshots.

Deleting an input report does not cascade into a saved comparison: the comparison
keeps its frozen facts and bytes, with an **Original report deleted** source link.
Dependent unsaved comparison previews become invalid. Deleting a saved comparison
does not delete its source reports. Uncertain outcomes use status lookup, not a
second delete, and hash-only reservations prevent stale index/write resurrection.

### Connect a live local collection

**When → All retained dates** is the default, not the original experiment's
fixed collection window. Its chart dates come from the accepted evidence in
the selected collection and filters. **Custom dates** includes both dates in
the display time zone; use the same From and To for one day. The request uses
local midnight through the next day's midnight, so daylight-saving days can
contain 23 or 25 hours. Daily/Weekly/Monthly changes aggregation, not the selected
dates. Last 7/30 days include today and are recalculated on a read; explicitly
chosen custom dates survive checks, navigation and reload without expanding.

Date selection filters retained evidence. It does **not** query Work IQ/Graph
or authorize reading older history. A period outside the latest checked window,
including a partly checked boundary day, shows a coverage warning and a link to
the existing history preferences. New checks keep the approved paths, history
window and limits. Empty results mean no matching retained evidence, not proof
that no activity occurred. Older retained evidence is not removed.

**Refresh** reads the currently approved local Copilot metadata and histories,
then applies the stored view. Its single control is available across Analyze,
Reports and Settings. **Source** opens
the approved paths in Settings; **Collection settings** opens the existing
history-window and cadence pane. With no approval, Refresh reads stored activity
only; **Review source & connect** opens source review separately. Refresh never
connects, approves, expands the history window or resumes paused collection.

The action checks for newly **recorded** calls and results. It does not run new
Work IQ/Microsoft 365/Graph queries, replay prompts, scan repository contents or
make hosted internal HTTP visible. Response saving, assessment and the reviewed
report-saving flow remain independently controlled.

Progress distinguishes checking from applying the view. A completed check returns
its own ID, committed revision, added/updated evidence identities and coverage
limits. The client accepts completion only after applying that revision or later
with the same approved source configuration. It reports no-change, late-result
updates, partial checks and changes outside the current filters/evidence layer
without widening the view. A failed check or snapshot read retains the previous
visualization; **Retry** reads status and the stored snapshot, applying a confirmed
check without repeating collection. In-progress edits, frozen disclosure review
and save recovery retain their existing guards. Ordinary refresh uses the
background read path so unrelated updates do not discard report drafts.

The existing collector protocol does not correlate a lost response to a client
request ID. A newer `lastCheck`, idle status, new revision or renewed connection
therefore cannot establish the outcome of that request or unlock another source
dispatch. This panel remains read-only after an unknown check outcome; neither
Refresh nor Retry replays it. Status receipts are never adopted as this attempt's
receipt. This conservative limitation is intentional; no backend protocol was
expanded.

Before dispatch the client writes and verifies the tab-scoped
`workiq-evidence.source-check.v1` sessionStorage sentinel (`pending` only). Reload
restores the read-only latch. A directly correlated validated receipt or guaranteed
pre-dispatch rejection can clear it; failed storage reads/writes/verification
block source dispatch explicitly. A failed clear keeps source dispatch blocked
without denying an already confirmed receipt. This is tab-session protection,
not cross-tab or durable runtime-wide correlation; status cannot resolve it.

Settings consumers: `checkActivity` is the visible unified **Refresh** control;
the `collect-now` setting/search alias targets it without dispatching.
`collectNow` is a hidden compatibility event alias with existing
edit/uncertain/stale guards, not an independent settings mutation.
`refreshBtn`, `collectionRetry` and `[data-stored-refresh-retry]` are read/status
recovery only. `freshActivity` exposes its phase and confirmed check ID/revision;
`unconfirmed` is not success or completeness. Source setup remains
`#settings?section=connection&setting=source`.

Home and Activity group the check button with **Source and collection**, with
the result directly below. Status length cannot push source help to the page edge.
**No new recorded activity** describes novelty; the separate **Chat history**
link names known unavailable, limited, pending or unchecked chat counts and opens
**Collection status**. The manual result and its completion time stay together
through polling, rather than borrowing the latest background-check time.
**Source and collection** uses that receipt's primary reason groups and shared
coverage explanations without fetching a personal issue inventory. Each affected
chat belongs to one primary group but may have other limits; pending and unfinished
counts may overlap. Current chat-by-chat issues are fetched only on visiting
Collection status and are not represented as the earlier manual inventory.

Coverage is source-wide across eligible chats, with reads bounded by the approved
collection window, not scoped to the view's dates, services or result filters.
The diagnostic cannot establish whether absent activity belongs in the current
view. Exclusions, deletion suppression, no Work IQ calls and missing tool
completions are not history-read failure categories. Readable history is not a
promise of complete history. A check with zero eligible sources says so. An
unchanged history may be checked in milliseconds using its saved file stamp;
background collection may already have caught up. No artificial delay or
invented progress is added.

Small spinning indicators acknowledge actual initial/view reads, local checks,
snapshot application, first scoped issue reads, Settings writes/reads, and
report scan/review/save operations. Labels stay readable and previous charts
remain available. Reduced motion uses a static dotted indicator with the same
status text. Waiting for a person to close a frozen report review is not shown
as spinning work; healthy idle polling has no spinner. Newer date submissions
supersede pending reads, identical pending submissions do not duplicate reads,
and unfinished date edits are not overwritten by incoming snapshots.
Prompt text already travels with the accepted snapshot; expanding its local
reader is synchronous and intentionally has no fake loading state.

Each manual check is one bounded cycle, not a promise to drain all history.
Overlapping manual requests share a reconciled cycle after any active background
cycle. Paused collection stays paused. Remaining backfill, unfinished entries,
missing histories and read/enumeration limits are explicit partial outcomes.
The most recent confirmed manual receipt survives runtime restart in
`collector/last-check.json`; no-op checks still leave evidence and cursor files
unchanged. Routine polling timestamps are not live announcements.
Novelty uses canonical call/start-event and Graph activity identities, not raw
legacy aliases. A no-op committed revision cannot claim added/updated evidence.
Version-2 receipts preserve this distinction, including in-scope result updates
that do not change counts; view membership uses those same canonical identities.

Home's **Recorded result** dropdown sits above the count and chart group and
filters all its views without leaving Home. It reuses the rounded, compact
listbox with arrow keys, typeahead and Space/Enter to toggle choices. **Apply**
updates the view once for the union of selected statuses; choices remain a
private draft until then. **Cancel**, Escape and outside dismissal leave the
accepted view unchanged. An empty draft cannot be applied. Every canonical outcome
remains available, including zero counts, with its label and Fluent color/icon.
The trailing **Clear recorded result filter** button (or **Select all results**
followed by **Apply**) clears
only this field, preserving dates, service, project, collection and private
search. The same control appears with Activity's filters; there is no duplicate
Result selector in More filters or detached Result chip.

Choice rows contain the full label, exact count, status glyph and selected mark,
not explanatory paragraphs. The **Recorded result** info button explains the
selected results and count scope. **Scope and result definitions** groups labeled
scope facts, concise result meanings, and optional **Reading counts and dates**.
Scope columns follow their content rather than splitting the whole panel in half;
result meanings use a bounded reading width and compact gaps. Reading guidance
uses the same body-size text and ink as the definitions, including enlarged text
and narrow layouts. These layout choices do not shorten or remove evidence facts.
It retains all six definitions, including structural-zero outcomes, and explicitly
separates matched calls from Insights' full retained interactions. Tool completion
is not answer correctness. Six distinct 20px Fluent glyphs and theme-aware outcome
colors are shared by menus, charts, status badges and newly generated reports;
the smaller help glyph and already saved report bytes are unchanged.

Supporting disclosures share one text and spacing role across Home, evidence
notes and Reports: reading-size Asta text, strong weight, consistent dividers and
section gaps, and a minimum 44px summary target. Wrapped or enlarged text grows
naturally; primary section headings retain their separate hierarchy. Disclosure
choices survive navigation; toggling reading help does not change filters.

Menu counts keep the other current filters but are calculated **before** result
selection. Counts, columns and percentages below use the selected result union from
the same accepted snapshot. **Worked only** can therefore show 100% Worked
without claiming overall health. Pending and failed reads keep the last applied
selection, charts and counts together; a newer selection or local clear can
supersede pending intent. Code references explain why result filtering is
unavailable and allow an inherited result filter to be cleared. Chart and
Activity result links still provide deliberate request drilldowns.
Single-result links remain compatible; multi-result links use a canonical,
deduplicated `result=success,failure` list. Individual result links deliberately
choose that one result. Current-view report membership follows the matching
request-group union; Selected and All report scopes remain independent.

Analyze shows **Tools** and **Services** together, with flat bars, exact counts
and shares of the declared canonical scope. Services use supported
`serviceInvolvement` v1 associations, not the single legacy activity category.
One multi-service call can appear under several services but counts once in the
view denominator. Service shares may sum above 100%; there is no service donut.
Missing/unsupported service details and discovery/preparation are named separately,
never assigned to Files or inferred from an assistance call.

**Recorded outcomes** uses a flat circular composition because each record has
one outcome. Tool, service, category and operation bars and outcome slices keep
linear, unrounded geometry; tiny values are not enlarged. Exact counts and
`<0.1%` / `>99.9%` labels avoid false zero/100% shares. A zero denominator is
explicitly not applicable. Worked means recorded tool completion, not task
correctness or proven Graph HTTP success.

Tool/outcome labels and chart marks filter the same Analyze cohort. Service
marks add a removable **Mail within current scope**-style intersection, retaining
the current Service-menu OR set and any separately labeled missing-service context.
Repeated service marks intersect; an explicit Service-menu choice replaces these
chart refinements. Back and stored-data refresh preserve the named predicates,
not a frozen list of IDs. Current-view reports still include the matching full
interactions, with matching-call and full-interaction counts distinguished.

Time scales, legacy **By category**, **By path or operation**, recorded-result
breakdowns and exact tables remain reachable. All tool and service rows stay
visible; **Exact data and definitions** includes every outcome, including zero.
Full labels provide 44px keyboard targets even when data paint is too small to
click. Panels sit side by side at usable widths and stack at narrow/enlarged text.
Existing typography, Fluent glyphs and semantic theme roles remain.
New HTML/PDF reports retain the existing glass
column presentation, disclosed readability scale and exact counts; previously
saved report bytes are never rewritten.
General history/hosted-Graph limits live once in **About this evidence**, not an
unconditional footer. Actual source errors and incomplete-collection feedback
remain visible in their existing context.

Open **Settings** in the sidebar or mobile navigation (`#settings`). Choose
**Review source & connect**, review the suggested `data.db` and `session-state`
paths and collection preferences, then deliberately choose **Approve source and
start collection**. The 7/30/90-day initial window and 5/15/30/60-second cadence
use the same compact dropdowns as the rest of the app; their defaults and
collection limits remain in the field help. No inventory JSON,
worker artifacts, seeded evidence, authentication or administrator permission is
required. An empty private store starts empty. The source chooser uses
`COPILOT_HOME`, or the documented `~/.copilot` default; if either named source is
missing, enter the absolute paths to your local Copilot installation. It never
searches the home directory, repositories or credential files.

An already approved source shows **Connected / Approved** and one pair of plain
source values. **Change source** replaces those values in place with a local
draft, never a second copy underneath. The metadata database identifies Copilot
chats; the history folder contains their recorded events. Both paths remain
fully readable and selectable: long read-only values wrap instead of hiding
their endings behind horizontal scrolling.
**Approve and switch source** validates the replacement before switching. An
enabled collection starts using the replacement immediately; a paused one stays
paused. Cancel restores the current values and returns focus to **Change source**;
it makes no request and leaves the existing connection untouched.
**Save preferences** applies only to the existing approved source and preserves
its active/paused state; full configuration writes still require `approved: true`
and the backend's source/schema validation. The UI sends the last-read
`expectedConfigVersion`; stale writes are rejected instead of overwriting another
panel's changes. Failed or uncertain responses never replay a write: **Read current
connection** reconciles status before another attempt.

Settings separates browser-local **Display** preferences from **Connection &
permission** and **Collection preferences**. **Collection status** has its own
main-navigation entry for reading results, affected Copilot chats and technical
details; Settings links there instead of embedding operational diagnostics.
A left category navigation opens one dedicated configuration pane on wide screens;
the same links become a compact **Category** disclosure in narrow panels or with
enlarged text. Category switches keep unsaved source and preference fields in
memory. Inactive panes are hidden from both keyboard navigation and screen readers.
Routine collection status, freshness and historical gap counts live in
Collection status. Home, Activity and Reports show a short contextual notice only for
setup, pause, an initial import without evidence or a current blocking failure;
retained evidence remains explorable without connecting. Unsaved settings stay
in panel memory across navigation, Back/Forward and polling, with a return notice
and explicit save/cancel. Reload warns about unsaved changes. Source approval
never grants report disclosure approval; changing configuration invalidates the
panel's frozen report preview, and every report still requires its separate review.

**Search settings** finds setting names, descriptions and aliases such as
`time zone`, `city`, `pause`, `cadence` and `missing history`. Results name the
category and explain the setting or its current unavailability. Choosing a result
only opens the category/disclosure and focuses its control or review entry:
it never changes a value, starts collection or approves a source.
Clear or Escape restores the category view.
Activity search, Settings search and scoped issue/report searches keep their
clear action at the right of the relevant input, with a field-specific accessible
name. Clearing a list search never changes report membership or saved reports.

Category URLs are `#settings?section=display`, `connection` or `collection`;
an optional `setting` identifies a fixed control destination.
Back, Forward and reload restore the category. Plain `#settings` opens Connection;
unknown categories explicitly fall back there. Existing `#settings?section=display`,
`#settings?section=history` and `#settings?issues=1` links remain supported;
the latter two canonicalize to Collection preferences' history window and
`#collection-status?setting=issues`. Legacy `section=diagnostics` opens
Collection status; `setting=advanced` and `setting=collection-details` open its
Technical details. Search results for issues, missing history and status navigate
there without changing collection. Back, Forward and reload preserve the target
and visible focus.

Collection status answers whether collection is running, which chats have gaps
and whether an action is needed. Routine active collection explicitly needs no
action; pause, disconnection and current errors provide state-specific guidance.
Settings links navigate without resuming, approving or checking a source.
The page shows readable chats out of eligible chats, with unavailable/limited
counts under **Chat history**. Pending reads are shown separately because an
importing chat can already have readable entries.
The source inventory counts locations verified from Copilot metadata, not files
successfully read. Archived, nonlocal and unverified chats are exclusions, not
failed reads. Each affected chat is counted once, with unavailable history taking
precedence over limits. Closed reason groups explain which file, entries, older
history or request-to-action links are affected, and the actual next step.
For example, **History file not found** does not infer deletion
or promise that another check recreates the file. Previously collected evidence
stays. Technical codes and chat identifiers remain secondary support details.
The closed **Technical details** section labels counters with their units and
explains the unchanged history window, file/entry read limits and context limits.
The shared **Refresh** action stays above the page; **Retry** appears only for
safe stored-view/status recovery, not as a second refresh choice.
With no reported gaps the search and empty reason list are hidden. Unchecked,
importing and failed states never become a successful empty-history message.

### Local search scopes

There is no duplicate global search or raw-transcript index. Each search names
the thing it finds, operates on its entire retained scope before paging, and
keeps query text in this browser's history state rather than a URL, server log,
export, telemetry or new persistent index. New metadata searches match words
across their named fields, ignoring case, accents and punctuation. Activity keeps
phrase matching within a field, with the same normalization, rather than widening
one numbered request into unrelated word matches. Clear and Escape are available;
no-result counts remain explicit.

| Surface | Search decision and scope |
| --- | --- |
| Settings | Fixed setting metadata and useful synonyms; navigation only, never source paths or control actions. |
| Activity / chat analysis | Keep and clarify **Find a Copilot chat or request group**: retained request text, titles, chat/project names and chat IDs, intersected with existing filters before chat/request paging. Canonical evidence counts and metadata-only chats stay distinct. |
| Requests already in a report | **Find a request in this report** filters the full current membership list by retained request text and chat/project identity. Matching and included totals are separate; hidden requests remain included. It cannot add/remove requests or change a frozen preview. |
| Previously saved reports | **Find a saved report** searches all saved IDs, prepared dates, formats, prompt modes, file names and time-zone/locale metadata. It does not open report contents, original prompts or private file paths. |
| Collection status | **Find a chat with gaps** searches the entire currently reported issue list by chat/project name, identifier, availability status (unavailable or limited history), short or full reason label or common alias, before reason grouping and six-row paging. Unavailable takes precedence when a chat also has limits; each affected chat is counted once. While searching, counts state matching versus all affected chats. Names are fetched only on visiting Collection status. |
| Home / charts and request details | Keep existing date/service/result filters, chart drilldowns, exact-data disclosures and bounded request/action pages. No redundant search per card or universal evidence index. Request-detail actions are not a new full-text search scope. |
| Long select lists | Keep keyboard typeahead and full option identities, including city-based time zones. Names wrap without clipping; short finite lists need no extra search box. |

New list-query scopes start at their first page; clearing restores the unsearched
list's prior page where still valid. These scoped queries survive ordinary
navigation, Back/Forward and reload in the same history entry. Report draft
membership itself remains panel-memory only and still resets on reload.
No search fetches Work IQ/Graph data, scans additional files or expands report
membership. Browser history can retain private query text locally; copied URLs
contain only shareable routes and destination identifiers.

The maintained runtime has no public, app-wide chat-enumeration interface.
The read-only adapter validates the source mapping, not an exact version allowlist.
The inspected mapping is shared by Copilot app SQLite generations `156`, `166`
and `174`. Generation `156` is the minimum; later version numbers alone neither
grant nor deny compatibility. Before enumerating sources, the adapter requires
ordinary `sessions`/`workspaces`/`projects` tables, their consumed ordinary `TEXT`
columns, and a sole `id` primary key. Required mapping values must retain their
text/null representation and IDs must remain enumerable. Additive fields/indexes
and version-only upgrades that preserve this contract do not interrupt collection.
Unknown host/location or workspace-type values never establish local eligibility.
Optional creator fields are used only as a compatible pair with explicit agent
and valid creator identity evidence; absent, malformed or unfamiliar metadata
does not establish a prompt author.

The existing `copilot-app-sqlite-v156` adapter identity stays stable: compatibility
does not change an approved source, reset cursors, renew consent or enable answer
capture/scoring. Missing or incompatible required mappings fail with the metadata
version and affected table/fields, without replacing retained evidence, cursors or
source approval. Unavailable files remain errors, not empty success; remote-only
histories remain unread. This is a checked local integration, not a stable public
API or a guarantee that future equal-shaped schemas preserve field semantics.
The root convention is documented by `copilot help environment` and GitHub's
[CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
No agent tools, session wake-ups or model loops are used by the runtime.

Current mappings are enumerated in 250-row pages every 30 seconds and on
**Refresh** of an approved source, up to 10,000 chats and 20,000 workspaces. Archive fields,
execution location, workspace host and actual app-to-CLI IDs determine eligibility.
Duplicate workspaces for one local source are read once; ambiguous projects,
unmapped chats, missing logs and nonlocal sources have explicit dispositions.
Filesystem log directories alone never establish active eligibility. Archive and
unarchive changes affect Current activity; prior records remain available in
Both collections and preserved history. Old report bytes are never rewritten.

Backfill reads at most the last 64 MiB of each eligible log, in 4 MiB chunks and
at most 32 MiB of event bytes per cycle. New events are tailed thereafter, not
rescanned from the beginning. Unchanged files get only a stat check; changed
files verify their startup and a hashed cursor boundary. Partial UTF-8/JSONL tails
are re-read until a newline completes them, without persisting raw fragments.
Unchanged tails are not re-read, and no-op checks update in-memory status without
rewriting durable checkpoints or evidence snapshots.
Oversized (>1 MiB) or malformed events, truncated initial tails and bounded
correlation-context evictions are reported. Per-source context is capped at
2,000 events/512 KiB; Graph script/fallback correlation cannot see evicted or
unrecorded context. Original prompts are retained privately under the existing
credential exclusions; entity response bodies are not retained.

Durable checkpoints follow atomic evidence commits. Replays after interruption
deduplicate source/call/event identities, and late completions upgrade unknown
results without adding calls. Rotation/truncation resets a bounded read while
preserving captured evidence. An exclusive, store-wide process lock prevents a
second runtime writer even on another port. A dead owner is recoverable; a live
PID fails closed. The first connection backs up state metadata in
`collector/before-dynamic-state.json`, and configuration changes retain
`collector/previous-config.json`. Evidence files, pseudonym keys, review labels,
import files and exports are preserved; no legacy files are deleted.

Collection is owned by the runtime, not a browser or chat. **Pause collection**
persists across restarts; **Refresh** is a deliberate one-cycle read even
while paused. Closing a canvas does not pause collection. Shutdown waits for the
current bounded cycle and releases its lock; restarting resumes from checkpoints
when enabled. No OS startup service or scheduled task is installed. Offline app
metadata/local logs can be read while the app is closed, but no new activity is
invented. Remote/cloud-only chats and hosted Work IQ internal HTTP remain
unobservable. Source failures retain the last good evidence and show diagnostics.

The page polls compact collection status every five seconds while visible and
fetches one consistent snapshot only when its revision changes. Filters, report
selection, scroll and timezone are retained. Updates defer while editing or
reviewing; **New data is available** identifies a frozen preview rather than
silently expanding its membership. These are polling cadences, not a guaranteed
capture latency: backfill, disk load and missing logs can delay availability.
`POST /api/collection/status` with `{ "details": true }` exposes local,
capability-protected discovery dispositions, cursor offsets, bounds and counters
for verification. It contains no event bodies or prompts.

**Collection status** separates **Last checked** (a local collection check)
from **Last new evidence** (newly collected evidence). No new activity does not
establish complete history. Its
direct link (`#collection-status?setting=issues`) shows only the
affected local chats, grouped by the known reason and paged six at a time.
Missing saved files, denied reads, other known file-read errors, unsupported
history and unknown causes are distinct from size/context limits. Each chat
appears in one group even if it has several limits; its detail lists the additional
limits, last recorded attempt and whether prior evidence exists. **Open chat
activity** uses the existing chat route; Back restores the gap search, page and
reading focus. Archived,
nonlocal and unmapped sources remain exclusions, not read failures.
Chat names and project context are fetched only when Collection status is visited.

These notices concern saved chat history, not failed Work IQ or Graph requests.
Reports may omit activity that could not be collected; available chats continue
and prior evidence is kept. Partial gaps stay inspectable in Collection status; an unavailable
collection source stays an error. When checks are running but all eligible
histories are unreadable, the page states both facts rather than confusing
collector activity with successful coverage. Initial import/checking and paused states stay explicit. **Refresh**
remains the existing bounded local read, not an API retry or missing-file repair.
Collection status retains full local timestamps, source inventory, check frequency
and technical limits. Source paths and approval stay in Settings.
Attempt-time-only changes do not rewrite durable checkpoints;
changes in coverage classification update snapshot coverage without changing
recorded action outcomes or previously saved report bytes.

## Development

Use Node.js 24 or newer and the npm version declared in `package.json`.

```powershell
npm ci
npm run check
npm test
```

PDF generation uses the pinned Playwright **runtime** dependency and a local
Chromium browser. Install it with `npx playwright install chromium` after
`npm ci` (or a production `npm ci --omit=dev`). No remote conversion service or
signed-in browser profile is used. If the browser is unavailable, PDF preview
fails explicitly; deselect PDF and prepare a new review or install the browser.
HTML, JSON and Markdown do not require Chromium. Browser regression tests use
the matching Playwright test dependency. The pinned PDF.js runtime dependency
also supports read-only text-layer extraction from verified saved PDFs for
search, including production `--omit=dev` installs; extraction does not require
Chromium, OCR, remote conversion, PDF scripting or external resource fetching.
For the longer twelve-cycle idle/reconnect check:

```powershell
$env:WORKIQ_ENDURANCE_CYCLES = '12'
$env:WORKIQ_ENDURANCE_IDLE_MS = '4000'
node --test tests\visibility.browser.test.mjs
```

The browser test exercises real timers, controls, Back, delayed reads and an
actual server restart. It injects the visibility event because headless browser
tabs do not reliably become hidden. That proves the application's recovery
handler, not every native Copilot host visibility transition.

The implementation uses native JavaScript modules, the Node HTTP server, and
Node's read-only SQLite API for approved history mappings. `check` validates
JavaScript syntax; this is not a TypeScript type-check. Runtime input schemas and
tests validate the data boundary. Copilot supplies its extension SDK at launch;
it is not an application dependency.

Ownership boundaries:

- `lib/store.mjs`, `migration.mjs`, `paths.mjs`: private persistence and migration.
- `lib/source-discovery.mjs`, `collector.mjs`, `collector-io.mjs`: approved current
  mappings, incremental collection, diagnostics, process lock and checkpoints.
- `lib/history.mjs`, `collection.mjs`: shared extraction and legacy offline import.
- `lib/analytics.mjs`: canonical identities, denominators and endpoint templates.
- `lib/activity-analytics.mjs`, `graph-history*.mjs`: service/time views and
  separately classified Graph request, output-status and code-reference evidence.
- `lib/graph.mjs`: opt-in metadata-only recording for an owned Fetch caller.
- `lib/privacy.mjs`, `prompt-projection.mjs`, `export.mjs`: local scan, prompt choices,
  immutable report snapshots and gated file commits.
- `lib/product-report.mjs`, `pdf.mjs`: standalone HTML/Markdown and offline PDF.
- `lib/server.mjs`, `render.mjs`, `extension.mjs`: local app and Copilot canvas.

## Migrating an existing private collection

Stop writes to the old collection first. The migration command requires explicit
private paths and refuses an existing destination:

```powershell
npm run migrate -- --source C:\Private\old-data --imports C:\Private\approved-import --session-root C:\Private\session-state --app-db C:\Private\app.db
```

The import folder must contain the approved `app-inventory.json` and
`history-window.json`. The latter provides a bounded window, at most 90 days.
Migration creates a write-once, read-only backup under the destination's sibling
`backups` directory, hashes every copied file, checks evidence and review counts,
preserves the pseudonym key and export bytes, then activates the new directory.
Only copied state metadata has its absolute export paths remapped. The original
source is never written. A failed migration leaves its named backup/staging
directory for inspection; it never silently merges or overwrites user data.

## Reading the evidence

### Copilot chat terminology and count units

Source conversations are **GitHub Copilot chats**, whether standalone or
associated with a project. Independently encountered labels and counters use
**Copilot chat/Copilot chats**; introductions use the full GitHub brand.
The project remains separately labeled. Missing names say **Copilot chat name
not recorded**. Missing source identities remain unattributed request groups,
without invented chat names, project associations or analysis links.

This is authored product copy, not an entity migration. Technical contracts keep
`sessionId`, `sourceSessionId`, JSON coverage keys such as `distinctSourceSessions`,
database `sessions` tables, API/tool names, `session` route/query keys,
`session-state` paths, `session.start`, keyed pseudonyms and `ghapp://sessions`
links. Panel authentication/runtime sessions and hosted Work IQ conversation IDs
are different concepts, not user source chats; panel errors call them connections.
Original prompts, historical names, recorded arguments, raw errors, API payloads
and preserved scan notes remain verbatim, even when they contain "session".
Existing export bytes never change. Only newly generated report wording changes;
all four formats retain their schema, privacy choices, frozen scope and timezone.

**Request groups are not API requests.** For current history, extraction groups
activity under the nearest preceding recorded `user.message` event within its
source Copilot chat. This is temporal association, not proven human authorship
or causality. A following message can be retained as context; if it triggers
calls, those calls form a separate group. A missing origin uses the call-start
event as a fallback group identity and stays unverified. Legacy request groups
retain their recorded grouping rather than being reinterpreted as single prompts.

Home and collapsed Activity connect the units: **1 request group with 3 Work IQ
tool calls**, or **6 request groups with 14 Work IQ tool calls**, followed by
**12 Worked / 2 Tool failed**. Both numbers and outcome pills use the same
current-filter/private-search subset, across every page; they do not claim to
count each group's full evidence. Full request details explicitly say, for
example, **1 of 3 Work IQ tool calls in this request group match this view**.
Analysis totals omit only the result filter and disclose that scope above the
filtered details. Reports expand chosen groups to their complete eligible,
deduplicated evidence and freeze that selection; they never recalculate a
different ad-hoc metric from excerpts.

One semantic violet title color per theme identifies original Copilot chat
names, not outcomes, service categories or selection. The standalone label,
weight and full wrapping title remain non-color cues. Recorder-only source
identities and unknown origins are not promoted to Copilot chats.

Work IQ executions, intermediary-reported API results, and owned Graph HTTP
records are different units. They must not be added together. A multi-target
Work IQ fetch is one invocation; response-array positions do not establish
per-target correlation. Missing status is unknown, not success. Tool or HTTP
success does not establish task correctness.

The public Graph `$metadata` demonstration is not Office workload evidence.
Hosted Work IQ internals are not observable here. Imported evidence reports its
actual source, status availability and limitations; it does not replay historical
commands, acquire credentials, or manufacture downstream HTTP traffic.

Open **Analyze** to see the overview and matching interactions together.
**Results** moves keyboard focus and reading position directly to the list, without
changing the route or filters. Each row opens its exact recorded interaction;
choosing or expanding a chat is not required. Top navigation is **Analyze,
Reports, Settings**, including on narrow screens. The wordmark returns to Analyze.
Reports opens the saved library, with unfinished drafts still available.

**Apply dates** retains accepted results until an updated snapshot is ready,
keeps focus on Apply, and applies the same scope to charts, rows and current-view
report membership. A failed update labels the previous results; a late response
cannot replace a newer route. The existing **About this evidence** disclosure
starts closed and explains recorded results and interaction-group boundaries.
**Collection status → Technical details** distinguishes Work IQ calls, returned
API metadata and separately recorded Graph requests. Tool names and service
categories do not prove requests or HTTP status. The evidence-adjacent scope
note remains visible. Polling does
not collapse help, move focus or announce routine check timestamps.

**Dates, Tool, Service, Outcome and Author** stay in the main filter row.
**More filters** retains Category, Project, Chat, Activity and Collection.
Its active count and removable chips retain the selected values even when closed;
**Reset Analyze** and Back/Forward remain independent.
A period filters **already collected** evidence, not source history. When the
period extends beyond the known checked window, a visible warning names that
window and links to history preferences in Settings (`#settings?section=history`);
it never widens backfill or grants approval automatically. Empty results do not
claim that no activity occurred. Source errors remain visible outside the filters.

Analyze pages eight **interactions**, not eight chats. Rows retain the available
prompt excerpt, author, source chat/project, tools, service/category and matching
outcomes. Source names are optional context links; **Chat** in More filters also
keeps sources without matching evidence available for coverage inspection. The
results list never adds metadata-only chats to its analytical population.

**Interactions / Calls** switches the same exact analytical slice. Calls reuses
the existing recorded-action renderer and pages canonical rows, without treating
service associations or legacy aliases as additional calls. It opens the existing
interaction reader; dedicated call sorting and exact-action context navigation
are separate work, not implied by this entry.

**Search these interactions** keeps the existing local phrase matching across
retained prompts, titles and chat/project context. It is not global or semantic
search. Charts, summaries, rows and current-view report IDs share the same
all-page matched membership. Insights and ordinary reports still include full
selected interactions; their scope notes distinguish them from matching calls.
Private queries stay in browser history state, never URLs or browser storage.
Back/Forward restores the mode, filters, query, page, scroll and focused row;
report selection hidden by later filters remains selected.

Canonical entry is `#analyze`; `#analyze?mode=calls` opens Calls. Existing
`#home`, `#overview`, `#activity` and `#calls` links normalize to equivalent
Analyze scope. Legacy chat/result Activity links open Calls. Request, Reports,
saved-library, draft, Settings and Collection status routes remain available.

The focused analysis names the chat and project, the recorded count and
results, the date/service scope and any known history gaps. The header supplies the display time zone. The
**Worked** and **Tool failed** pills are non-underlined links to only that
chat's matching canonical successful or failed actions, retaining the dates,
services, project, evidence layer and private search. Failed actions include
retained error codes/statuses; if the reason was not retained, the app says so.
Worked means recorded tool completion, not verified task correctness.
**Open full request** explicitly includes nonmatching actions;
Back returns to the same result slice. Unknown completions and code references
never become success/failure links. Unreadable or empty chats show collection/coverage
options, not invented results. Archived sources can inspect preserved activity.
The search input keeps a concise placeholder and a visible label; its adjacent
help explains chat/project/request matching. Long queries remain editable in
the native input and are never copied into URLs.

Analyze retains Work IQ activity over time and the existing outcome,
category/service, timing and answer-insight summaries. Switch to categories or API paths,
then select a chart row or time period to narrow its interaction list. Dates,
projects, services, results and activity layers are encoded in local routes.
Small info buttons explain service categories, results and report choices on
hover, keyboard focus or tap without changing filters. An expandable service
glossary is available in Analyze. The filters use local rounded
popups with concise choice rows and full keyboard navigation. Definitions belong
in field help and existing details, not in each choice or a per-option tooltip.
The shared renderer accepts `data-detail` only for distinguishing identity
(such as the device time zone or saved report ID), and `data-disabled-reason`
for an unavailable choice. Those details and long labels wrap in full.
Only Recorded result opts into multi-selection; the other finite selectors
remain single-choice. Each choice keeps its canonical value; activity
layers remain separate units, not a combined count. Exported reports include only the service
definitions present in their selected evidence, including readable PDF text.
Charts use the available main-content width rather than the reading/form width
limit. Their category spacing responds to the actual chart container, including
narrow embedded panels and hidden views opened after text enlargement. Columns,
icons and type are not stretched to fill wide screens; spacing has a deliberate
upper bound for sparse charts. When all categories cannot fit readably, only the
chart scrolls horizontally, with keyboard/touch access, measured overflow guidance
and the exact-data alternative. Show all/Other grouping and recorded counts do
not change just because the window changes size. Reports retain their separate
document-width and print grouping constraints.
Expanded Home explanations use 16px reading text and a two-column service
glossary on wider screens. Exact chart data separates total and result counts
into centered numeric columns shared by headers, values and totals, with
layer-specific status labels; code references have a total only, never invented
outcomes. Date/category labels stay left-aligned. Content-sized columns and
compact rows keep 44px actions and readable text without stretching a small
table across the screen. Tables scroll locally on narrow screens. Captions name
the unit and calendar meaning (Monday-starting weeks or the
first of each month); current filters still apply to partial periods.
**Total (all rows)** covers all matching chart rows, not only the current
24-row page, and excludes explicitly labeled records without dates.
**About this evidence** explains recorded results and request groups in short,
consistently wrapped paragraphs. **Collection status → Technical details**
holds collection windows, exact check times and original scan notes. Source
scans and currently eligible sources are separate counts, not a progress
fraction. The visible scope note distinguishes missing chat history from hosted
Work IQ's internal Graph requests, which local logs cannot reveal. Neither
limitation changes a recorded action's result.
Request pages show bounded retained context immediately: the selected group,
at most one exact-message-linked neighbor in either direction, and the selected
group's retained follow-up when it is not already a displayed origin.
Same-chat message IDs and consistent recorded times support adjacency, not
task membership or causality. Browser Back/Forward restore the route.
**Prompt** shows at most 170 graphemes in a body-size paragraph with a
bounded reading width, ending at a word boundary when possible. **View
interaction** is a separate native link. **Read prompt** expands the exact
retained value in place when it differs; **Hide prompt** closes the local
original without navigating, changing selection or copying it. Partial/missing
source text is labeled, never filled in; existing copy buttons copy their exact
authorized source or report-copy value. List previews mount originals on demand;
the opened request reader mounts available text immediately, including long
prompts. Explicit Hide choices survive refresh and Back.

The complete **Prompt** reader keeps explicit **Read prompt**/**Hide prompt** controls and
**Copy prompt**. **Author not verified** means the retained record does not
verify who wrote it; a user-role message, coordinator message or legacy
human-authored attribution is not proof of identity. **Prompt provenance**
keeps the original attribution available. Missing text says **Prompt not
available**. Tool arguments and assistant responses remain separate.
Displayed replies use only the existing consent- and basis-checked retained-text
endpoint after deliberately opening the request, never overview/search preload,
source rereads, new capture or AI. Recorded response timestamps determine their
positions without asserting finality. Missing reply text is shown with its own
group; missing timestamps are not reconstructed. Counts and saved verdicts remain
scoped to their original groups. No report context producer is added.

Request cards now show **matching results**, not an overall verdict on the
request. For example, a failure slice can show **1 of 3 Work IQ tool calls in this request group match this view**
and **1 Tool failed**. The full-request page separately shows all three
canonical actions, including ones outside the service, result or date slice.
Worked, Tool failed and No result recorded describe tool outcomes only;
returned API results, Graph request sites, visible statuses and owned HTTP keep
their own units and status labels. Code references say **Execution not observed**.
Unavailable counts are labeled, never treated as zero.

The compact viewing context keeps the source unit, count, result, service,
project, date range and collection visible through Home, Activity, requests and
Reports. Request drilldown does not add a chat filter; **Back to filtered
activity** retains the originating slice and page. Private search remains in
browser `history.state`, not copied routes or report prose. Report selection
rows distinguish the matching slice from each full eligible request, without
changing All/Current/Selected expansion or disclosure review.

Dates default to the browser's detected IANA time zone and locale, not the runtime's.
One compact header link (for example **Los Angeles time**) identifies the applied
view; its keyboard/pointer tooltip gives the full IANA name and opens
**Settings > Time zone** (`#settings?section=display`, retained for existing links). Date ranges, chart help and
exact-table captions inherit this context instead of repeating the zone.
Exact timestamps retain their per-instant offsets; report previews and saved
artifacts retain their own explicit frozen context.

Request cards and investigations show one **Message recorded** date and minute
from the associated source message, not the action start or proof of who asked.
Without a valid message timestamp, **First timed action** uses the earliest valid
retained action start; absent both, time is explicitly unrecorded. Neither label
claims request bounds or duration. Actions remain in recorded chronological order;
their exact starts, ends, recorded durations and raw values are in **Technical
details**. **Prompt provenance** keeps readable origin/text-coverage labels,
raw source codes/IDs and association limits together in one closed disclosure.

**Time zone** uses the existing keyboard-typeahead list of browser-supported
IANA zones. Its single heading labels a content-sized control; one short impact
sentence stays visible, with browser scope and reset guidance in **About this
time zone**, inside the same setting row. A globe-and-clock icon identifies the
category. Collection preferences stack vertically inside their active category.
Choosing **Device default** removes the override. The non-sensitive
choice uses local storage (`workiq-evidence.time-zone`) for this browser profile
and app origin, synchronizing its open panels; it is not a device-wide preference.
An unset preference causes no storage write. Invalid/unavailable choices and
storage failures are visible; if saving fails, the choice lasts only in that panel
until reload. A browser without zone-list support offers Device default, UTC and
any saved valid zone rather than accepting ambiguous typed abbreviations.

The choice governs date labels, calendar filters, relative periods, all buckets,
detail and collection timestamps, and new frozen report previews. From/To remain
calendar dates interpreted in the selected zone. Header and data change together
only after a successful snapshot; failed reads keep the last applied context.
Changing time context invalidates pending previews/reviews, not report membership
or source history. Saved report bytes are never reinterpreted or re-exported.
Historical daylight-saving and fractional offsets follow each instant's named-zone
rules. Missing browser timezone/locale is explicitly labeled as UTC/en-US fallback.
Focus, visibility, reconnect, loads and the existing live tick recheck device
defaults. No OS clock, collection permission, retention or collector cadence changes.

**Last 7/30 days** means today plus the preceding 6/29 local calendar days,
not the end of the recorded collection. Custom date bounds are inclusive in the
UI: the ending date maps to the next local day's start, exclusively (including
23/25-hour days). Weeks start Monday. Chart drilldowns stay inside both the
displayed local bucket and the current date slice. Date-only URLs remain calendar
dates; older timestamp URLs retain exact offset-qualified instant boundaries.
Recorded UTC evidence, original prose and timestamp literals in API arguments
are never rewritten.

Graph code references are not executions. A direct request site is not a measured
wire request count, and an output-visible status is not an owned HTTP capture.
The latter is a subset of request-site evidence, never an additional request.
Platform metadata is hidden from the ordinary personal activity view. Empty
direct-Graph views do not mean there was no Office activity through Work IQ.

History import rechecks the approved inventory against current archive mappings,
reads only mapped local logs, and reports missing files, truncation and exclusions.
This legacy migration path is not used by runtime collection. The normal app
connects directly to approved current metadata; continuous local collection is
an explicit setting with pause/resume controls.

The legacy Work IQ reader caps each log at its last 64 MiB; its separate Graph reader is
bounded by 500 mapped sources, 384 MiB per file and 8 GiB total. Oversized events,
unresolved dynamic targets, missing logs and nested-agent visibility remain
explicit limitations under **About this evidence**. An approved history refresh
can take up to two minutes; a timeout is not a reason to replay a mutation.

For a previously verified private Graph scan, stop the runtime and run
`node scripts\import-graph.mjs --file C:\Private\graph-import.private.json`.
The offline importer reserves the same fixed writer endpoint and preserves
existing Work IQ evidence, review identities and prior exports. It never loads
source code from the scan file.

## Reports and disclosure

Open **Reports** in top navigation to find saved reports or continue/create a
draft. There is no redundant global Export button. Analyze, Reports and Settings
retain filters and the current draft; the same full navigation labels wrap on
narrow screens without a drawer.

From a focused analysis, **Create report for this Copilot chat** replaces the draft
membership with only that chat's canonical eligible request groups, across
all pages and aliases. This deliberately includes each full request across all
retained dates and services, not just the analysis slice. The context is explicit
before scanning; newly collected requests are not added to this selection.
Selection alone writes nothing.

Reports follows four numbered stages: **Requests**, **Contents**, **Review**,
and **Save**. Continue from the request scope to prompt/privacy and format
choices, then **Scan and preview**. Review the formatted document inline, with
top navigation still available, and open the prompt-copy comparisons as needed.
An unchecked attestation and **Complete disclosure review** lead to the separate
final **Confirm local export** action. Success exposes the actual local file
downloads; an uncertain response never retries or claims a successful save.
Back revisits choices without granting consent. Changing choices requires a new
scan and review; navigation away invalidates review while retaining draft choices.

Alternatively, deliberately choose **All collected activity**, **Current view**,
or **Selected requests** in Requests (the broader scopes are under a disclosure).
New panels and reloads start with **Selected requests**, empty. Opening Export
never opts into the whole collection. Deliberate selection and scope choices
last while navigating this panel, including Back/Forward, not across reloads.
**Scan and preview** prepares one report; the adjacent summary names the canonical
requests included, not a number of reports. Saved report counts are separate.

**Clear selection**, beside report membership and throughout the report flow,
empties the selection across all pages, returns All/Current to empty Selected,
and discards the preview, attestation, chat report context and per-copy edits. Captured evidence,
review labels, saved bundles, analytical filters and theme stay unchanged.
Prompt mode, formats and additional masking terms stay in this panel; reload
resets report options too. Nothing about opening, clearing or cancelling writes
an export or scans history. **Reset view** changes the analytical view, not the
chosen report scope or explicit selection.

The counts before preview describe canonical request groups and separate Work IQ,
returned API, Graph request-site, visible-status, owned HTTP and code-reference
units. Current view includes every matching page and private-text search, not
just visible cards. Reports include complete eligible evidence for the matching
request groups, so they may contain actions outside the individual chart slice.
All includes available identifiable preserved evidence as well as current
activity, not a new history scan. Known aliases are deduplicated; synthetic,
diagnostic, unidentifiable and unknown-source records have explicit exclusions.
Missing project context stays unscoped, not excluded. The chosen scope/counts
and exclusions are frozen into every format and the manifest.

Review labels are optional classifications, not export eligibility. Opening,
selecting, previewing or cancelling does not modify source records, review labels
or filters. A local report requires an all-field scan of the exact snapshot, a
separate explicit disclosure review, then final confirmation. No report is
written at preview time. Changing
the selected evidence or its review state invalidates an outstanding preview.
Unrelated incoming evidence does not invalidate or expand the frozen selection,
including a preview originally prepared from All. Automated tests
exercise the gate only with synthetic evidence; they are not a human review of
real workplace data.

**Prompts in this report** is an explicit choice before preview:

- **No prompts:** no originating request, follow-up or tool question/query prose.
- **Masked prompts** (default): retained wording with local pattern masking, not
  generated summaries. Add exact names/phrases to mask across prompt copies.
- **Original prompts:** retained personal wording in local files, after reviewing
  disclosure. Detected passwords, access tokens, private keys, credential URLs
  and other recognized credentials are still removed, with mandatory-removal
  labels. There is no raw-credential bypass.

The preview pairs local originals with the report copies and highlights masked
spans, categories and counts. In No prompts mode originals require a separate
local disclosure. Each available copy can be edited or omitted. Rebuilding
rescans edits, so detected credentials cannot be restored this way. Source
records never change. Partial/unavailable text is labeled and never reconstructed;
previous import-time credential exclusions remain unavailable. Arbitrary names
and confidential business meaning cannot be fully recognized by patterns. The
user must review them; the app sends no raw text to a model or scanning service.

Select one or more of **HTML, PDF, JSON and Markdown**. Every file derives from
one frozen snapshot: a compact report with charts/tables and readable prompt
sections, and full projected records in the JSON format when selected. HTML is
self-contained and escaped, with no scripts, remote fonts or external resources.
PDF is rendered locally from that same HTML with wrapping and pagination.
Preview generates files only in memory. The separate disclosure action changes
only the manifest attestation, never the report bytes. Final confirmation names
the mode and formats. Mode, formats, manual edits, selection, selected evidence, navigation
or panel connection changes invalidate the current review. No reusable consent flag or
personal masking terms are persisted as preferences.

`coverage-and-redaction-manifest.json` schema 3 records mode/formats, snapshot
hash, source and prompt coverage, per-prompt category transformations, file
SHA-256 hashes and the explicit attestation. It contains no matched snippets or
manual masking terms. The JSON report is a valid schema-3 object, not JSONL.
Legacy bundles are preserved unchanged. New writes exclusively reserve a bundle
directory, write all selected files in private staging, then atomically rename
the complete directory into its `files` subdirectory before appending separate
export history. New exports and downloads never mark source records exported
or change existing classifications. Earlier exported labels and bundles remain
unchanged; the optional manual review-label controls are still available.
Legacy callers that supply only `scenarioIds` retain the ready-selection gate,
but their completed exports also leave review labels unchanged. The explicit
`selection` API uses `kind`, the current `revision`, and request IDs for
current/selected scopes; all scope needs no ID list.
A failure is explicit and may leave unlinked staging/reservation files;
it never overwrites an older bundle. Downloads are available only for already
committed report files, not previews.

Saved reports lead with **At a glance**: separate layer counts, recorded outcomes,
used services and missing-status coverage. Bounded representative requests connect
reviewed excerpts to calls in retained order, with links to their complete prompt
copies. Excerpts are navigation aids, never generated summaries or task-correctness
judgments. One overview chart and exact per-layer tables avoid repeating the same
data visualization. HTML folds full prompt copies and detailed coverage into
script-free disclosures; PDF expands all included wording and adds page numbers.
Markdown uses linked sections and inert prompt blocks. JSON places a shared
`summary` before complete projected `records`; it is a JSON object, not JSONL.
No prompt mode is shortened silently: long Masked or Original copies can still
make PDFs and Markdown long. Include JSON for complete technical record payloads.

An empty retained string marked full or partial is explicitly unavailable in the
report, with its original `sourceStatus` and an `availabilityNote`; the private
source stays untouched. Unknown statuses and invalid non-string text remain
blocked. Pattern scanning, owner-bound review and exact-byte confirmation still
apply to every export.

Every new snapshot and manifest freezes `timeContext` (IANA zone, locale and
explicit fallback flags), `preparedAt` (UTC), `preparedAtDisplay`, `dateSelection`
and its resolved `dateRange`. All four formats use that same context, including
the locally generated PDF. A timezone/locale change requires fresh preview and
disclosure review; saved files are never reinterpreted for a later recipient.
Date selection describes the originating view, not a new filter on the explicit
report selection. Existing privacy projection excludes non-prompt source event
timestamps in every mode; this remains unchanged. Dates inside retained prompt
wording are not converted. Non-browser callers that omit time context get an
explicit UTC/en-US fallback, never the server process's timezone.

Pattern scanning is not perfect DLP or privacy certification. Local inclusion
does not authorize publishing or uploading. This app does neither. Cancelling
before final confirmation writes nothing; after confirmation, the accepted write
cannot be cancelled. An uncertain response is never automatically replayed.

The loopback server's host, origin, JSON and per-client capability checks protect
the browser boundary. They are not isolation from another process running as the
same operating-system user.
