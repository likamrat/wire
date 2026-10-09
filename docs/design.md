# Product design

## Saved report library

Reports opens directly on the saved library, expanded by default. The top-level
**Saved reports / Create a report** links separate browsing from the unchanged
Requests / Contents / Review / Save flow; users do not pass the wizard to find
search. **Continue draft** returns to unfinished work and **Saved report details**
returns to the most recent save state. Activity's explicit create action goes
straight to creation. `#reports?task=create` and the legacy `#report` creation
link remain direct entries; the main Reports navigation opens the library.

Switching tasks within the same Reports context preserves choices, selection,
prepared review and disclosure approval. Browser Back restores the task and
library search/page. Relevant source, permission, filter and evidence changes
still invalidate previews; switching tasks does not bypass their checks.
The saved library remains separate from Requests / Contents / Review / Save.
It uses the existing metadata search and six-item paginated history, not another
list or search implementation. Reports and comparisons have explicit labels and
separate counts. The range and Previous/Next remain together; the saved-library-only
Page / Go control reaches distant pages without serial scrolling. Other pagers
retain their previous behavior.

Search says **Search saved reports**; the metadata-only limitation stays in help.
It has a bounded desktop width and a visible label. A compact row aligns the
report's preparation identity, prompt mode, format availability, **Manage** and
direct **Open**. Manage holds membership count, full identity, download, comparison
and individual deletion controls. Repeated frozen-copy/search prose and stored
refresh move into **About saved reports**. Missing HTML has an explicit no-HTML
state rather than an inert Open action. Unknown metadata stays unknown.

**Delete all saved reports** is available beside search, never interpreted as
delete visible/search-matching rows. Its existing saved-artifact dialog previews
the exact report-bundle/file/copy counts and comparison preservation, focuses
Cancel first and requires a separate count-labeled confirmation. Confirmed
membership is fixed. New reports, saved comparisons, source activity, draft
reports and downloads are not swept in. Affected unsaved comparisons and their
approvals become invalid; the confirmation distinguishes them from preserved
draft reports. The confirmation names permanent deletion
and possible partial cleanup. Comparison retention is explained once; the UI
retains recovery details and offers **Check deletion result**, without requiring
users to manually keep a receipt or repeat a destructive request.

Search, page, disclosures and Back retain their prior state; deletions clamp
the surviving page. Loading and failed snapshot states disable the new bulk
entry. The immutable saved reader and refresh/draft guards are unchanged.
Layout retains Asta Sans, Fluent, light/navy tokens, visible focus and 44px
controls, wrapping at narrow widths and 200% text without truncating labels.

The supplied screenshot and Distill playbook informed this simplification.
Local catalogue execution was unavailable (no Python runtime); the installed
UI/UX accessibility guidance and existing design system were used instead.
Synthetic proof covers a 1,001-report / 167-page library, small/empty/no-match
states, direct navigation and frozen reading, named and bulk cancellation,
confirmed report-only removal, stale previews, lost responses and sealed
restart recovery. This is not a claim of human acceptance or a live release.

## Analytical filter row

Home, Activity and scoped chats share one always-present horizontal row:
**When, Result, Author, Category (or Service), Project, Activity, Collection**.
There is no More filters disclosure or secondary panel. Default choices fit the
supplied desktop content width. At constrained widths, 200% text, or with long
selected values, only the row scrolls horizontally. Its named, focusable region
supports arrow keys, Tab and touch scrolling; no heading or selected value is
wrapped, shrunk or ellipsized. Custom dates and an unavailable-result explanation
stay below the row.

Intrinsic field widths preserve complete text; active Clear actions may widen a
field but never consume its dropdown's reading space. Labels align above the
controls and use the existing 4px help gap, transparent 44px targets and 8px
glyph-to-popup anchor. Select menus remain portaled outside the scrolling region,
with 44px choices. A menu or tooltip closes when its anchor scrolls out of view.

Concise Activity names describe the same six evidence layers. **Graph API call
sites** are recorded invocation sites, not measured network calls; **Graph
statuses** are their visible-status subset. **Returned API entries** are not tool
calls, **HTTP recorder** is separate diagnostic capture, and **Graph code
references** do not establish execution. Counts retain their exact canonical
units. Category help explains available Discovery, search, services, multi-service
and missing-service choices; a selected category retains its shared definition.
No category rules, source evidence, report membership or saved files change.

## Fresh activity and history coverage

The check button and **Source and collection** form one left-aligned action row.
The result follows below, so long no-change, partial, pending and error messages
cannot push source help to the far edge. Narrow or enlarged-text containers stack
the same controls in reading order. Native disclosure, Asta/Fluent, light/navy
tokens, visible focus, 44px targets and reduced-motion behavior are retained.

Novelty and coverage are independent. The visible **Chat history** link names
known unavailable, limited, pending, unfinished or unchecked chat counts from the
accepted manual receipt. Help discloses that receipt's primary reason groups,
their existing explanations and recovery limits, not guessed causes. Each
affected chat has one primary reason group, while additional limits can overlap.
Current per-chat details remain in Collection status and may differ after polling.
Opening help never requests the personal issue list or reads source histories.

Coverage spans all eligible sources, not the applied view. Missing evidence
cannot be assigned to the current filtered view from these diagnostics.
Previously retained evidence stays; excluded/out-of-window/deleted records,
chats with no Work IQ calls and absent tool completions are not reclassified as
failed source reads. The check result retains its single timestamp. Refresh
stays inside source help and keeps the existing frozen-report guard.

The supplied screenshot and synthetic normal-renderer comparisons informed this
focused change. The local Python catalogue was unavailable; installed
accessibility/layout guidance and the existing product contract were used.

## Report creation journey

Reports uses one task surface for Requests, Contents, Review and Save. Its compact
step navigation, selection summary and current stage stay together. The existing
blue accent identifies the current step, visited steps and the next enabled
action; it is not a quality score. Analytical **Reset to Home** remains available
in its other contexts, not in Reports.

Requests starts empty. Scope and prompt-author membership sit side by side when
space allows, with matching labels, then stack at narrow or enlarged-text widths.
Prerequisites appear beside the local action area instead of below a disabled
future step. Clear selection appears only when there is a selection to clear.
Optional request labels and scope details follow the actions; neither is a gate.

Every stage keeps Back and its next action together. Review retains the formatted
copy, prompt comparison/edit/omit tools, scan findings and explicit disclosure
checkbox. Exact files and frozen evidence/preparation facts have named disclosures.
Save repeats the approved request membership, prompt mode and formats as aligned
facts, with a separate local-write confirmation. Successful saves lead with the
saved reader and downloads; history stays outside the unfinished task.

Equivalent disclosures use one reading role and 44px targets. The journey reuses
Asta, Fluent, existing light/navy tokens and help geometry. Local accessibility
guidance, the supplied screenshots and actual synthetic runtime states informed
the layout; no external screen-catalogue evidence was used. This is presentation
only: selection, author scope, preview lifetime, approval invalidation, receipt
recovery, refresh guards and immutable saved bytes are unchanged.

## Offline historical metadata maintenance

`scripts/maintain-historical-metadata.mjs` is an explicit offline maintenance
entry, not an HTTP API, recollection action, or automatic migration. Source
publication alone does not recover historical metadata. A coordinator must first
review the exact original-source attestations, stop the normal runtime cleanly,
verify recorder/evaluator quiescence and the current no-dispatch ledger, then
pin the composed source manifest and private metadata-only plan. No historical
source scan or provider call is performed by this entry.

The plan allows exactly two existing prompt/call pairs. It includes their source,
event and call identities, timestamps, complete retained-text hashes, record
preimages, normalized author metadata and bounded failure projections. It also
pins source configuration/index bytes, source approval identity/window,
`maintenanceStateGuard(state)`, every saved bundle file and any additional private
host receipts requiring preservation. Packet and already-completed predicate
recheck hashes are attestations, not permission to repeat that source read.
Unknown plan fields, raw error bodies, newer/conflicting metadata, absent or
ambiguous targets, expired windows, pending cleanup and active evaluations fail
closed. All private plan/journal files remain outside source control.

Run with `--mode prepare` and explicit `--data-dir`, `--plan`, `--plan-sha256`, `--journal`,
`--source-manifest` and `--source-identity` arguments. The manifest has
`{ root, files: [{ path, sha256 }], sourceIdentity }`; its identity is SHA256 of
`JSON.stringify(files)` in manifest order. The root must be this composed runtime
root, all listed bytes must match, and no runtime module may be omitted.
Preparation validates existing board/snapshot integrity before any helper can
initialize storage, acquires the existing collector owner with `timers: false`,
then uses `exclusiveActivity` and `exclusiveBoard`. It does not collect, configure,
reconcile scores, restore responses, or publish evidence. Its only durable output
is a new private hash-only pre/postimage journal and `reviewSha256`.

After reviewing that journal, run the same command with `--mode apply` and the
returned `--review-sha256`. Existing retained checkpoint events receive only the
approved metadata; evicted events are not recreated and context limits cannot be
met by evicting unrelated events. Checkpoint postimages are written first with
`atomicJson`, followed by `stageEvidenceSnapshot` and one board save/revision.
Unrelated snapshot fields, independent API results, cursors/index/configuration,
cards, deletion/capture state, all assessment ledgers and saved bundle bytes stay
unchanged. Genuine failure evidence still changes the assessment fingerprint;
author-only evidence does not. Existing scoring policy must supply a durable
pre-candidate no-dispatch gate; an empty candidate list alone is insufficient.

This is **not an all-files transaction**. Keep the normal runtime stopped after
any failure or uncertain result. Resume only with the same reviewed plan, source
and journal: every file must match an exact sealed preimage or postimage. Already
written checkpoints are recognized, and a confirmed board postimage is verified
without incrementing its revision again. Drift aborts before further writes;
there is no blind replay, automatic rollback, or deletion of evidence to make a
target eligible. The journal does not itself block an operator from starting the
normal runtime; maintaining the quiescent interval is the coordinator's duty.

Postflight uses normal board loading and exact file hashes. Only after confirming
completion may the coordinator close the maintenance interval and restart the
normal entry with a freshly verified no-dispatch baseline. Source-only synthetic
proof cannot substitute for that separate real-store acceptance.

### One-target retained sign-in signal

`scripts/maintain-failure-signal.mjs` is a separate offline entry for **one**
unassessed failed call. The existing two-target command still requires exactly
two targets; neither command accepts a dummy target. Both use the existing
collector owner, activity/board queues, hash-sealed journal, atomic checkpoint
write and snapshot staging transaction. There is no new server route.

The only allowed record change is an existing v1 failure projection with
`reason: "error-code-recorded"`, `code: "failure"`,
`messageStatus: "text-excluded"` and `messageSignal: null` gaining
`messageSignal: "workiq-sign-in-required"`. The complete record preimage binds
all other facts, including arguments, prompt, final-response timing and call
timing. Only the existing matching completion's signal changes in its retained
checkpoint. Missing events/checkpoints are not reconstructed. Conflicting
metadata, ambiguous identities, scored/attempted/enrolled targets and targets
inside the current automatic approval fail closed. A postimage is accepted only
with the same reviewed recovery journal, not as a fresh preparation.

The command uses the same explicit options and top-level plan/source/attestation
guards as the two-target command. Its `targets` array contains exactly one
`{ scenarioId, sourceSessionId, interactionRef, recordSha256, prompt, call }`.
`prompt` has only `sourceEventId`, `sourceTimestamp`, `textSha256`; `call` has
only `toolCallId`, `startEventId`, `startedAt`, `completionEventId`, `completedAt`.
It accepts no proposed prose, replacement score, authorship or configurable
signal. The attested `recheckSha256` identifies already-approved finite source
predicate evidence; it does not authorize or perform another original read.
Preparation returns only a new hash-only journal and review seal.

Execution requires separately reviewed current source pins, a stopped/quiescent
normal runtime, fresh exact retained-store preimages and preservation inventory,
and a second approval of the prepared journal before apply. Keep the runtime
stopped after any uncertain checkpoint/board write and inspect that same journal.
Recovery verifies exact pre/postimages and never increments an already-committed
revision twice. The old snapshot and unrelated evidence, model ledgers, personal
feedback, consent, configuration, source index/cursors and saved bundle bytes
remain unchanged. Synthetic proof is not permission for real preparation,
repair, source rereading, evaluation or restart, nor is it live UI acceptance.

## Failure evidence and technical facts

Tool failures, tool-returned API metadata and owned HTTP captures remain separate.
Newly collected completion errors retain a screened identifier-like code and
explicit evidence/withholding reasons, not raw messages, stacks or bodies. A
typed, credential-screened error message of at most 8 KiB can produce the
enum signal **Tool error mentions access denial** or the narrowly recognized
**Tool reported an MCP request timeout** (`MCP error -32001: Request timed out`).
The exact supported Work IQ MCP reauthentication wording can also retain the
finite `workiq-sign-in-required` signal. Its presentation says **Work IQ sign-in
was required** for that recorded attempt, not that sign-in is required now.
Beside the existing coverage-first request Insights, **Recorded execution** and
**AI quality assessment** explain the retained cause and the independent
assessment state. They retain the existing Asta/Fluent, light/navy, narrow,
enlarged-text and visible-focus behavior. Plain Copilot/MCP sign-in guidance is
not a retry action, source-configuration action or automatic authentication bridge.
The timeout signal alone establishes neither an HTTP status nor a downstream
cause; it is not HTTP 408/504 or a diagnosis inferred from elapsed time.
Independent retained API/HTTP evidence remains visible. Recognized negated or uncertain
wording does not produce that signal. The signal is a description of tool-error wording,
not a verified cause, policy, authorization judgment or observed HTTP status.
Oversized, credential-excluded, absent and unsupported message formats remain
distinguishable in Technical details.

Older retained calls without this provenance remain **Failure cause unavailable
in retained evidence**. Rendering does not reread source history, recover a
discarded error, backfill records or alter saved reports. API response arrays in
one MCP text block use the same bounded metadata projection as structured results;
entity bodies do not survive through the parallel status-line projection.

Payload recognition is independent of extracted API-result count. Missing or
empty arrays, malformed/fenced JSON, multiple text blocks and oversized payloads
never fall back to raw source lines. Plain display output retains only canonical
numeric status lines and fixed provenance blockers; structured status fields
must be HTTP-range integers. Error prose, stacks and entity bodies remain excluded.

Reprocessing an unqualified historical checkpoint does not add default
failure/parent/group provenance fields. The existing reader fallback supplies
the explanation without changing the recorded call or its assessment identity.
Completed scores remain current and do not become new automatic attempts solely
because of this normalization. Real evidence changes still invalidate them.

The technical definition list uses aligned rows and the same label/value type
scale. Identifiers inherit the reading font; API paths and exact arguments keep
their deliberate code role. Copy stays beside its identifier with a 44px target,
including after clipboard errors. Long values wrap, and narrow/enlarged-text
layouts stack labels above values. Clipboard completion, visible failure,
keyboard access and exact copied bytes keep the shared control behavior.

Parent absence distinguishes an inspected start event with no parent field from
unqualified retained history. Parallel grouping names the Copilot adapter's
collection limit, not serial execution. The existing adjacent help explains
these reasons without adding repeated warning paragraphs. Known retained parent
and group identifiers remain readable and copyable.

## Donut material on light surfaces

Outcome and activity-category donuts retain their glossy, extruded geometry and
existing semantic hues. On light paper, their broad caps use restrained highlights
mixed from the existing top and label tones instead of the near-white column cap.
More opaque faces and darker wall stops prevent white-background washout; reduced
rim/glint opacity keeps the gloss without glare. Hover and focus keep the stronger
outline and gently darken the faces instead of brightening them. Column charts
and new HTML/PDF column reports retain their existing materials. Saved files are
not rewritten. Exact counts, percentages, minimum visible slices, category icons,
labels, links and the exact-data disclosures are unchanged.

Donut inspection retains each cap and wall's resting transparency in both themes.
The previous opaque hover/focus override exposed the near-white neutral material;
navy's brightness multiplier then clipped it to white. Navy inspection now uses a
small 1.05 brightness change with the stronger outline, including full-circle,
mixed and minimum-size slices. The broad cap and front wall remain below the
near-white glare threshold. Normal materials, glass accents, geometry and service
hues are unchanged. Pointer-only SVG focus suppression remains narrowly scoped;
keyboard labels retain visible focus, native navigation and 44px targets.

Each percentage-chart heading includes its current unit in parentheses, such as
**Recorded outcomes (Work IQ tool calls)**, with the unit in secondary text.
There is no separate unit/enlargement caption. The existing exact-data disclosure
and accessible chart description retain the minimum-slice explanation; counts,
shares, materials and adjusted geometry are unchanged. Units update with the
selected evidence layer and keep their singular/plural wording.

## Inline help geometry

Help uses a shared 4px text-to-icon-box gap (`--help-gap`), a text-scaled
information glyph and a minimum 44px target (`--help-target`). The glyph sits at
the leading edge of its target: the trailing hit area does not separate it from
its label or extend over neighboring text. Inline field labels use balanced
wrapping rather than a separate icon column. Metadata retains its final-grapheme
attachment and uses the same geometry.

Analytical filter labels are the single-line exception: their horizontal row
scrolls rather than balancing or truncating text.

Information-help targets stay transparent on hover and press. Only the glyph
changes to the existing ink color while its tooltip appears; the large hit area
is not painted. Keyboard focus keeps its visible outline. Ordinary action-button
hover styling is unchanged.

Report format labels and help remain separate controls inside the existing choice
surface. Their grid reflows at text-relative container widths, without changing
format order or selection when help opens. Checkbox labels and help targets never
overlap. Native disclosures, Copy/Hide controls and source headers are unchanged.

The existing tooltip portal anchors information help to the glyph, with an 8px
gap (`--tooltip-gap`); action tooltips still anchor to their actual control.
Resize observation keeps the popup in place through text resizing and wrapping.
Hover, keyboard focus, explicit touch, Escape, outside dismissal and accessible
descriptions use the existing lifecycle. Popup padding remains the existing
8px/12px spacing tokens, not a compensating fix for label whitespace.

## Activity category meaning

Activity request-card metadata uses the existing local Fluent service cue and
semantic color alongside its visible category label. A request spanning categories
uses the existing multi-service grid cue and retains every recorded category label;
it does not infer a single service or change call classification. Discovery keeps
its preparation cue, and Service not shown keeps its neutral information cue,
separate from the smaller information-help glyph.

Only this request-card family combines the category label and information glyph
into one content-sized help control, with a minimum 44px target in both dimensions.
The label-to-information-glyph gap stays 4px. The separator follows the actual
control with the ordinary 4px metadata gap, rather than following 28px of unused
trailing hit area. The help target never covers the recorded-time text. Long labels
and dates wrap without truncation; the help glyph stays with the label's final
grapheme. The control opens category help, not navigation or filtering.

This is an opt-in exception to standalone help geometry. Other help/copy controls,
transparent hover/press surfaces, keyboard focus, glyph-anchored popups and their
existing lifecycle are unchanged. The service pictogram is decorative beside the
visible text; the help control has an explicit category/service-help name.

Work IQ tool views use **Activity category**, **By category** and **Activity categories**:
the existing service-oriented grouping also includes preparatory **Discovery**. Actual
API-result, owned-HTTP and Graph views retain Service wording and their separate units.
Discovery stays in the ordinary denominator, unlike existing platform diagnostics.
Switching to an API/Graph layer clears an active Discovery filter because that tool-only
category does not apply there; other service filters and existing route names are retained.

An action names **API discovery**, **Schema lookup** or **Agent discovery** beside its
tool name. The existing compact definition list carries a short purpose and **Data service:
Not applicable**; only schema lookup shows a **Schema path**. No missing API-path/status
warning is invented for a discovery-only action. Its actual completion/failure stays
visible, and technical details remain available. Copilot assistance explains missing
service details in that call's record without guessing from private text or changing Unknown into success.

Remaining `Unknown` activity is displayed as **Service not shown**, not a service failure.
The detail reader keeps **Copilot assistance** as a known purpose and names its data service
**Not in this record**. Other unknown records distinguish **Path not recognized**,
**Target format not supported**, and **No target recorded**. Short on-demand explanations
use only retained technical metadata; chart-definition and percentage disclosures describe
the reasons present in the applied slice. Outcome counts and the result cue stay separate.
The category uses a neutral information glyph in remaining donut/glossary cues, never a
new under-column icon row. Its canonical ID, color and filter value remain `Unknown`.

An applied **Service not shown** filter now explains the actual matching rows
above Home or Activity, without requiring a disclosure. It groups exact counts by
recorded tool and evidence reason, showing known purposes such as **Copilot assistance**
beside `workiq-ask`. The donut's neutral legend also names those tools and reasons.
Empty slices and other selected categories do not show the explanation. A full
request keeps its own technical context instead of inheriting the filtered count.
Hosted-call details explicitly mark the downstream API path, HTTP method and API
version as unrecorded; none is guessed from question text,
file attachments, conversation identifiers or other calls in the same request.
This describes the retained call, not a general limit of Work IQ or proof that
no downstream service was used.
Unsupported targets include invalid origins, not just absent paths.

This changes evidence presentation, not service classification or category v3.
Counts, layer boundaries, report patterns and assessment identities are unchanged;
opening an explanation does not collect, re-score or rewrite a saved report.

This narrow change reuses Asta/Fluent, current light/navy tokens, accessible help and
44px controls. Existing chart geometry is unchanged. Local design-search Python was
unavailable; built-in accessibility guidance and the existing product system were used.

## Prompt author controls

The shared filter row places **Author** beside When and Result, including inside
a conversation. It reuses the opt-in checkbox multiselect: draft choices do not change results,
Apply commits once, and Cancel/Escape/outside discard. All includes unverified authors; known
Your + Agent does not. Applied counts, charts, groups and Insights use the same author scope before
pagination and alongside existing filters. Pending and failed reads keep the last accepted selection
with its existing counts; a late response cannot replace a newer choice.

All seven analytical fields share aligned labels and consistent gaps. Existing
Clear actions sit in their field headers, without shrinking the dropdown or
leaving inactive clear-button gutters. Custom dates occupy a separate row.
Constrained widths and enlarged text use the horizontal scrolling behavior above.

The single author helper supplies **Your prompt**, **Agent prompt**, or a neutral source-qualified
**Copilot chat prompt**. Non-chat/unknown-source text retains the generic Prompt fallback.
`data-prompt-actor` carries only the normalized user/agent/unknown category for compact cyan/violet/neutral
cues rather than success/failure colors. Your prompt uses a dedicated cyan token: darker
on light surfaces and brighter on navy, distinct from ordinary blue links and violet Agent.
The list marker and detail heading share that token; prompt bodies retain normal reading colors.
Labels remain visible.
The report Requests flow has its own explicit author membership choice; it narrows the chosen base
scope without deleting hidden selections. Complete interactions, not agent-executed individual calls,
are the membership unit. Prompt-text disclosure remains a separate Contents choice.

## Interaction insights

One **View interaction** link opens the exact recorded prompt, available
response, compact insights and attributable actions. Prompt authorship uses
supported host provenance; inferred call association remains a separate fact. The
existing reader keeps its read/hide/copy controls and report selection stays
separate from reading.

Current Insights and new reports show Accuracy, Speed and Trust. Trust shows
answer and action states separately. Historical Cost facts and evaluation-spending
safeguards remain intact; Cost is not a current metric. Unsupported values stay neutral and unassessed/not measured;
their full reasons, definitions and coverage live in **Measure definitions**
beside the overview's Insights heading, and **Details and feedback** on a single
interaction, not repeated paragraphs above the request. Assessed values retain exact counts
and coverage. Timing shows its recorded boundary, never summed concurrent-call
wall time. Recorded and estimated cost stay separate from unpriced/missing
usage. The versioned red/orange/gold/teal pass-share bands are presentation
heuristics, not an overall grade or a correctness guarantee.

**Settings > Collection preferences > Recorded replies** is off until explicitly enabled. It explains
the supported category, approved source, bounded local retention and revocation.
Opening a page does not enable capture. **Read response text** reads only
already-retained, consented evidence; it does not revisit source histories or
fetch citations. Hidden/returning panels clear displayed responses before
checking current access. Personal feedback is optional, revisioned and
withdrawable without editing the original evidence. Pending updates preserve
the last applied state; uncertain results offer status lookup, never replay.
Single-interaction feedback uses the personal verdict wording, not an objective
percentage; aggregate summaries retain their assessed counts and coverage.

The shared app Insights summary leads each quality check with its request
coverage, then passed/failed counts or an honest unavailable state. **Results for
1 of 69 requests** is prominent; **1 passed · 0 failed** is subordinate, never a
dominant 100% suggesting all requests succeeded. Accuracy keeps **Answer
correctness**; Trust separates **Answer support** and **Actions match request**.
Personal action feedback keeps its distinct **Action authorization** meaning.
Origin labels remain explicit, and single-request personal verdicts stay words.
Shared-request copy appears only when all three model checks have identical
eligible and covered request identities, not merely equal counts. Otherwise
each check keeps its own coverage. Missing results are neither failures nor
evidence of queued work; no minimum sample threshold or combined grade is added.

Speed keeps separate call and request boundaries, displaying seconds with its
own timed coverage. Exact milliseconds and unchanged percentage/count facts,
definitions, models and rubrics remain in the existing details panel.
**How to read these results** explains repeated AI limitations and median timing
once. Automatic-score processing status stays visible after the results, rather
than preceding their scope. Partial-membership warnings remain visible.
Sibling measures use Speed's 16px / hairline / 16px separation. Shared,
content-sized grid rows align dividers across side-by-side categories; stacked
categories keep their natural height, without fixed heights or filler rows.
Labels and quality results use the shared 14/20 role; quality coverage and timing
values use 22/29.7, with timing coverage at 12px. Unavailable results stay neutral.
All content reflows with enlarged text. This applies to Home, scoped Activity
and the individual interaction through `renderAssessmentSummary`; report
documents and frozen comparison renderers retain their separate presentation.

Local reply saving is a row in Collection preferences, not a separate Settings
category. It uses the existing row divider, spacing and heading role, a plain
current state and **Save Copilot replies locally** beside its checkbox, without
a separate introduction. These are recorded assistant replies, not guaranteed final answers.
Legacy evidence-category links and the named assessment-evidence target resolve
to this row. Collection/source controls keep explicit action handlers; the outer
collection container does not nest the response-saving form inside another form.
**What gets saved** holds source, partial-text, privacy and technical limits.
Only an edited choice reveals **Turn on response saving** or the destructive
**Turn off and delete responses**, plus **Discard change**. The checkbox alone
does not write permission; discard restores the current choice and focus.
Revocation/renewal consequences stay visible before confirmation. Errors,
pending work and receipt recovery remain explicit. Local retention is not
permission for remote model assessment and promises no accuracy/trust result.

Benign source/preference notices belong to their originating Settings category
and clear on departure; closing an unedited form has no cancellation banner.
Discard messages name source or preference edits instead of saying only
"Changes cancelled". Unresolved errors and uncertain operations remain visible
with their existing recovery action rather than being dismissed as success.

Insight panels keep a visible header exit while their contents scroll. Close
and Escape release the native modal and return focus to the current originating
control, including after a same-context refresh. Dismissing a feedback panel
does not cancel a submitted update or its receipt lookup; recovery retains the
original operation identity and never repeats the mutation.

If the approved source or capture scope changes, earlier capture permission is
shown as inactive. Enabling capture for the new scope is an explicit choice
that clears prior optional evidence and linked unsaved insights; ordinary
activity and saved reports remain. View filters, display time zone, polling
and new activity within the approved scope do not require renewed permission.

Saved-report comparison has explicit Baseline and Later choices. Inspecting
their frozen facts is independent of creating a separately reviewed comparison
copy. Format changes invalidate that copy's approval. Saved comparisons are
self-contained; an original report's deletion does not rewrite them. Quiet
contextual **Delete report** and **Delete saved comparison** actions name one
managed object, preview its scope and require separate red-outline confirmation.
Source activity, other saved objects and external downloads are not a hidden
cascade. Discarding a draft and withdrawing feedback remain different actions.

## Collected activity deletion

One shared flow is available from Settings > Data management and a quiet Activity
shortcut. Neither entry deletes anything. It begins with blank custom dates;
All requires an explicit radio choice. Preview is read-only and independent of
the activity filters. A separate confirmation stage hides the editor, names
All or the inclusive dates/zone, and shows canonical affected records, partial
groups, retained-only copies and saved-report preservation.

Data management entries each have one short purpose/effect paragraph. Exact
scope, prompt restoration, source limits and preservation belong in the existing
preview/confirmation, not in repeated entry paragraphs. Deletion details retain
the explicit statement that source approval and collection preferences stay
unchanged. Collection preferences use short field help; file limits, discovery
cadence and continued collection after closing the panel live in Collection
details. The selected values already show the interval and history window.

The shared UI font, 24px dialog corners, Fluent warning glyph and light/navy
tokens are reused. Destructive entries and confirmations share neutral surfaces
with red text/outlines, alongside the warning rail and irreversible wording.
The same restrained accent marks saved-object deletion, capture revocation and
source renewal that purges prior optional evidence; ordinary first-time capture,
preview, cancellation and recollection stay neutral. Its paired foreground passes 4.5:1 in both
themes. **Cancel** receives initial focus; **Change scope** invalidates the preview.
The native modal prevents click-through, traps Tab/Shift+Tab, supports Escape
before commit and restores focus to the entry. Controls remain 44px targets and
wrap at 375px/200% text; long details scroll without hiding focus. No animation
is needed, including in reduced motion. The local design-search interpreter was
unavailable; the skill's built-in accessibility guidance and this existing
product system were used, rather than claiming a catalog match.

Pending work disables duplicate confirmation and dismissal. Uncertain transport
offers only a receipt read, never a repeated mutation. Completion refreshes the
accepted view without changing filter intent; other panels clear removed report
copies, selections and approvals. Saved report bytes are preserved. The exact
storage, date-grain, recovery and recollection boundary is in README.md.

## Explicit recollection

Data management pairs deletion with **Recollect activity**. Its
**Recollect from approved sources** action opens the existing native dialog
visual system, not a reset control. Labeled chat checkboxes reuse the existing
local search matcher and paged-list renderer, rather than mounting the entire
roster. Selection survives search/paging; a visible count and **Show selected**
make hidden selections reviewable. Blank dates require a deliberate scope;
a separate prompt-restoration checkbox is initially off. Preview distinguishes
previously deleted, newly available and prompt-only records, names the selected
chats/dates/zone, and exposes bounded-source gaps.
Technical source counts are available under **Source availability and limits**;
partial availability is also announced in the main confirmation.
Existing display-time formatting replaces raw ISO timestamps, with same-day
ranges shown once. The main confirmation keeps counts, scope, prompt choice and
preservation consequences; technical bounds, expiry and unsupported-history
explanations stay in the existing disclosure. A clipped approval window and
incomplete availability remain visible before confirmation.

Cancel receives safe initial/confirmation focus. Change scope revokes the
preview, Escape/Close before commit change nothing, and keyboard focus stays
inside the modal. The existing sticky dialog header keeps Cancel/Close visible
while long source lists or expanded details scroll. A pending receipt read can
be closed without cancelling/replaying the committed operation; a late result
does not reopen the panel. During confirmation duplicate action and dismissal are
disabled. Lost responses offer a receipt read, never retry. Completion names
what was recollected and refreshes derived views; immutable saved reports remain
unchanged. Light/navy tokens, 44px actions, 375px layout and 200% text are shared
with deletion; this flow uses neutral outlined confirmation because it is not
another destructive purge. This small addition uses the existing product system
and built-in accessibility guidance; no external design catalog match is claimed.

WIRE (Work IQ Request Explorer) is a personal activity and learning app, not an operations
console. Its job is to help someone recognize a request, understand the recorded
actions behind it, and choose what to include in a short technical report.

The installed Taste redesign guidance informed hierarchy, spacing, navigation,
interaction states and restraint. Its marketing-page prescriptions do not fit
this product. The app uses bundled Asta Sans with system fallbacks and its own coherent
light/blue-dark palette, without external imagery, decorative animation or
invented metrics. The shapes are Fluent-inspired, not an official Fluent UI
component implementation. This targeted navigation change uses predictable
hierarchy (variance 3), no decorative motion (motion 2), and ordinary app density
(density 4), rather than importing marketing-page patterns or a new framework.

## Theme and shape

### Fluent typography and controls

The user-selected IQ-OS reference establishes the visual roles, not dashboard
content or a new information architecture. Source inspection verified **Asta Sans**:
IQ-OS `kit/theme.css:11-26` registers the local variable face,
`kit/typeface.mjs:12` supplies its fallback stack, and `kit/theme.css:87-125`
defines 14/20 body, 12/16 caption, 13/20 compact controls, 18/36 widget titles
and weights 400/500/600. `kit/icons.mjs:25-45` uses official Fluent regular/filled
variants. `kit/theme.css:211-249` distinguishes outlined buttons from filled
primary actions; `web/index.html:2251-2276` distinguishes outlined metadata pills.
These are declared CSS facts. Screenshot scale and device-pixel ratio are
unknown; screenshot pixels do not establish exact CSS dimensions or font identity.

WIRE adapts these roles to its existing reading tasks and 44px targets. The
single source is `typographyTokens` in `web/tokens.mjs`, with no page-local font
stacks or external font downloads:

| Role | Token | Size / line at 16px root | Weight |
| --- | --- | --- | --- |
| Page heading | `--type-title` / `--leading-heading` | 24 / 32 | 600 |
| Section heading | `--type-section` / `--leading-section` | 18 / 24 | 600 |
| Body, navigation, controls | `--type-body`, `--type-control` / `--leading-ui`, `--leading-control` | 14 / 20 | 400; controls 500 |
| Caption and metadata | `--type-caption` / `--leading-caption` | 12 / 16 | 400 |
| Labels and help | `--type-small` / `--leading-ui` | 14 / 20 | 400 or 500 |
| Longer reading text | `--type-reading` / `--leading-reading` | 16 / 26 | 400 |
| Dialog title and assessment value | `--type-dialog`, `--type-data-value` / corresponding leading tokens | 22 / 29.7 | 600 |
| API paths and code | `--mono`, `--type-small` | 14 / 22.4 | 400 |

All sizes use rem and line heights are unitless. General headings have zero
tracking; the explicitly selected Settings reference has its own heading role
below. Chart numeric sizes remain their
established quantitative roles; tabular figures are retained. Filesystem paths
in Settings remain selectable regular UI text, while literal API paths retain
Cascadia Mono, no ligatures, original case and full wrapping text.

`lib/typeface.mjs` embeds the unchanged Latin variable WOFF2 and its complete
OFL-1.1 copyright/license from `assets/fonts/`. The font SHA-256 is
`ad3079a2c2cef53a0ba3598f7c5a4ae9289982c8b8a426872395846e9fa08e25`.
The Latin unicode range deliberately leaves other scripts to the verified
system fallback chain. The application permits only data fonts, not a CDN.
New reviewed reports freeze the font, license and role declarations into their
own HTML; print sizing remains independent. Existing saved report bytes are
never re-styled or rewritten. Actual loaded-face checks must await
`document.fonts.ready`; a computed family name alone does not prove font loading.

Primary actions use the existing solid accent/foreground pair and 8px corners.
Secondary actions are content-sized outlined controls with 8px corners, neutral paper at rest,
12px inline padding, 8px icon/group gaps and 44px minimum targets. Their
neutral outline retains at least 3:1 contrast against resting, hover and pressed
surfaces in both themes. Native and enhanced fields use 4px corners. Activity
result badges use 12/16 caption text, 16px glyphs and 6px corners rather than the
reading-text role; actionable results retain a 44px target around their smaller
painted face. The outer target stays transparent on hover and press; only the
inset face changes color. Keyboard focus keeps its distinct native outline.
Noninteractive results have a neutral inset keyline without changing their
compact geometry or acquiring button behavior, hover paint or a tab stop.
Native form fields, sidebar rows, popups, cards and dialogs retain distinct
shapes rather than becoming identical capsules. Text-only controls no longer
reserve invisible leading and trailing spinner gutters: a small pending marker
fits within the existing inset without moving or widening the label. Controls
with existing Fluent glyphs replace that glyph with the spinner. Deletion
dialogs keep their red-outline treatment and a 16px helper-to-preview gap.
Scope captions sit below insights with their own 12px separation, retain
all-pages/full-interaction meaning, and do not compete with measured values.

Connection recovery distinguishes an unreachable local runtime from a collector
source failure. A runtime must be started normally; a browser retry does not
start a service or run collection. Expired capabilities are renewed once and
read-only requests can retry. Renewal also requires a fresh accepted snapshot,
even when the evidence revision is unchanged. Mutations are never replayed.
Only a previously accepted view can be described as retained, and offline
messaging labels it as the last accepted view rather than current collection.

Fluent System Icons remain local official 20px assets (16px help/chevrons).
The five main navigation items use regular at rest and filled only on the
current page, retaining `aria-current`, a visible boundary and stable row
geometry. Decorative glyphs are hidden from assistive technology; native
control names and keyboard behavior remain unchanged. No tooltip timing,
consent, deletion, data, report membership or outcome/performance semantics
change with this styling. Focus remains immediate, reduced motion is respected,
and full labels wrap instead of being hidden by global overflow clipping.

The approved integrated wordmark uses the cable as W, passes behind I and through
R, and completes the tilted E's middle bar with exposed copper tips. It has no
face. Its light/dark geometry and colors live in `assets/wire-wordmark.svg` and
`assets/wire-wordmark-dark.svg`; the compact tab icon is `assets/wire-icon.svg`.
The header shows the 165px by 52px wordmark above the visible
**Work IQ Request Explorer** subtitle, using the shared Asta Sans font at
.8125rem (13px), weight 600, foreground ink and a unitless 1.25 line height.
The subtitle stays on one line without truncation or ellipsis. Its viewport fit
caps the size at `(100vw - 40px) / 12`; for example, at 320px with 200% root
text it uses approximately 23.33px rather than overflowing at 26px. The logo
keeps its approved size, and the intrinsic-width brand group can take its own row,
moving surrounding controls instead of wrapping the expansion. There is no added
gap between the SVG box and caption. The complete graphical wordmark is one native
Home link, named **WIRE - Work IQ Request Explorer - Home** for assistive technology.
The subtitle is plain text outside that anchor, with no click action or tab stop.
The logo does not change appearance on hover or press; only keyboard focus adds
a visible outline. Clicking any part of the wordmark still returns Home.
Inline artwork is decorative, and only the appropriate
theme variant is visible; each variant has separate local paint/clip IDs.
Standalone assets retain accessible titles. This branding does not replace
Fluent action icons or recolor the application's themes. New reports can embed
the light artwork inline, retaining their offline/no-external-resource boundary;
previously frozen report bytes are not changed by an asset update.
Technical names, storage keys, paths and historical source attribution keep their
legacy identifiers; this is not a data or protocol migration.

Authored navigation links have no underlines at rest, hover, press, focus or after
visiting. Accent text, existing icons and contextual labels retain their navigation
affordance; ordinary text links use foreground emphasis on hover/press, never
a rectangular background across their expanded hit target. Structured navigation
rows and painted controls retain their own bounded surfaces. Keyboard focus retains a distinct outline.
Native anchors keep their hrefs, modifier-key behavior and existing route context.
This applies to chart counts/categories, details, Settings, reports and dialogs,
and to newly generated HTML reports. Saved immutable reports and raw captured
content are not rewritten.

The header has one compact, horizontal appearance switch, not a menu or two
separate buttons. Both official Fluent glyphs stay visible: sun on the left,
moon on the right. A contrasting circular thumb sits under the active glyph
and slides between them in 160ms (no motion with reduced motion enabled).
The 76px by 36px track sits within a fixed 80px by 44px touch target; neither the
icons nor neighboring header controls move when the appearance changes.
The stable accessible name is **Dark theme**, with `role="switch"` and
`aria-checked` reporting whether dark is active. The shared hover/focus tooltip
says **Switch to light theme** or **Switch to dark theme**.
Clicking anywhere on the single switch, Enter or Space toggles once and keeps
focus; the icons are not separate selection targets. No visible label or dropdown
chevron consumes header space. Only this
non-sensitive preference is saved in browser local storage (`workiq-evidence.theme`)
for the local app origin; it survives navigation/reload and synchronizes other
open panels in the same browser profile. A storage failure is shown explicitly.
Saved `light`/`dark` always wins. A legacy `system`, unset or invalid preference
is migrated once to the currently available appearance: Copilot's documented
`data-color-mode` on the root (then body) when valid, otherwise
`prefers-color-scheme`, or Light when that browser API is unavailable. The
concrete `light`/`dark` value is saved immediately; invalid values also produce
a diagnostic warning. No later host/OS changes are followed. Cross-panel
notifications accept only `light`/`dark`; legacy/invalid values and removed or
cleared storage are ignored with a warning, keeping the current appearance.
When storage is blocked, the concrete choice lasts for the panel and can be
saved on a later toggle if storage recovers. Switching never refreshes data,
changes routes or clears report choices/drafts. App-owned `data-evidence-theme`
attributes and palette tokens are separate from host-injected defaults.
The nonce-authorized head script applies the saved choice before body rendering.

`web/tokens.mjs` owns interface colors and radii.
`createDimensionalCharts().servicePalette` in `lib/dimensional-charts.mjs` owns
all 12 service identities and the separate grouped Other presentation;
`web/dimensional-charts-styles.mjs` consumes it for material and readable ink in
both themes. Service tokens never reuse outcome tokens.
Light uses cool airy page/surface
layers; Dark uses a deep navy page (`#142236`), blue-gray paper (`#1b2e46`) and
brighter inset surfaces (`#233a55`), never a black background. Blue is the
interaction accent; outcome colors have separate accessible chart tokens.
Counts, labels and exact tables retain the meaning independently of color.
Chart tooltips, accessible exact-data tables and form controls follow the resolved color scheme.

Stacked filter fields keep the title/help row and dropdown in one wrapping field.
The title's text edge and selected-value text edge share `--select-value-inset`
(12px from the painted pill edge, 16px at 200% root text). Settings uses the
separate label/help/action row described below. Help remains a separate sibling button, not part of the associated
label; its 40px/44px target centers on the final label line without changing the
value inset. Wrapped peers align their final label baselines and controls, with
a shared 4px field gap. Labels use a readable, unitless line height; controls
grow for enlarged text while retaining 36px paint inside 44px targets at normal
size. The rem-based minimum field width also applies on mobile, so enlarged
text wraps complete fields onto their own rows instead of squeezing labels.
`tests/select-control.browser.test.mjs` measures text, painted edges,
help targets and popup anchors at 375/820/1200/1466px in both themes and 200% text.

Secondary navigation actions, secondary buttons, format choices and filter chips
use the shared 8px control corners; fields use 4px corners and result badges 6px.
Ordinary text-action buttons (including primary, secondary, quiet and destructive
actions) paint a 36px face inside a 44px native target at normal text size. The
face is inset 4px vertically in every pointer/disabled state; its balanced padding
grows with wrapped or enlarged text. Hover/press changes only that face, not the
outer target. Text stays at the established control size with 12px horizontal
insets. Components with purpose-built surfaces (filters, result badges, icon
controls, disclosure rows, report steps and chart marks) keep those surfaces
rather than gaining a second background. Destructive entry points use the same
compact action proportions and explicit row gaps as other actions.
Filter triggers paint 36px inside 44px targets; format choices paint 36px, applied
filter chips 32px, and non-interactive recorded-result badges 22px at normal text
size. Actionable chat result links retain the 24px painted face inside a
44px hit target; both Worked and Needs attention are non-underlined native links
with contextual accessible labels, explanatory tooltips, hover/pressed feedback
and visible keyboard focus. An inset rounded surface grows with the text, rather
than cropping a fixed-height rectangular background. Ordinary document links
keep their own styling. Icon/text counts, not color alone, identify each outcome. Dropdown popups
retain 12px corners and multi-line option rows, not capsule-shaped containers.
Cards/charts use 20px corners, dialogs 24px, and inputs, rows,
documents and inset disclosures 12px. Whitespace and tonal surfaces replace
nested outlines on filters, charts, activity and report choices. Report columns
share a width but size to their content; prompt choices have matching rows and
format pills use an equal-width responsive grid. Data remains rectangular and aligned,
not capsule-shaped. Focus, pressed, hover and disabled states share these
tokens; numbers use tabular figures and reduced motion disables transitions.
Primary actions keep `--accent-fill` and `--on-accent` paired at rest, hover and
press. Foreground and surface switch atomically between themes instead of
interpolating only the background through an unreadable intermediate color.
Border and shadow feedback remain. Browser coverage measures composed
pseudo-element surfaces, nested text and icons across pointer, keyboard,
selected and disabled states, including enlarged text and actual animation frames.
Pill-style button, navigation and result links remain native anchors: the anchor
owns the painted surface, padding, icon and label, so the whole pill is a link.
These anchor families suppress text decoration in every state while keeping
visible keyboard focus. Ordinary prose/evidence/Back/Open-analysis links retain
their document-link styling; real action buttons remain buttons.

Secondary action/navigation pills share the `--pill-*` contract: a neutral paper
resting fill, readable paired ink, a visible 1px neutral boundary, 12px horizontal
inset, 8px icon/group gaps and medium-weight text. Hover and press use stronger
theme-specific neutral fills, never background-only interpolation. Primary actions
retain the solid accent pair and distinct 8px corners. Chart and percentage switches use 44px targets;
the selected choice adds strong weight and an inset border alongside
`aria-pressed`, not just a color change. Existing dense select, format, filter
and result paint sizes remain deliberate variants, growing with enlarged text.
Result links retain semantic outcome ink and a neutral visible boundary;
non-interactive badges and static legends are not promoted to action controls.
Main-sidebar navigation uses compact rows, not action-pill silhouettes, with its
established current-page fill and border. Settings categories use quiet
icon-led rows, 6px corners and transparent resting surfaces. The current category
has a quiet paper surface, strong text and a persistent accent rail, paired with
`aria-current=page`. Hover uses the neutral hover fill; keyboard focus uses the
outer focus ring. Neither transient state replaces the location marker.
Quiet reload/disclosure/help controls and the chart
time-scale picker remain intentional non-pill exceptions.

### Settings reference composition

The user's second Settings reference supersedes the earlier boxed category/card
composition. Read-only IQ-OS `web/index.html:2472-2517` verifies 32/40 page and
pane headings, a 240px category column with a 48px gap, search inside that column,
quiet 6px navigation rows and a thin vertical divider. Its setting rows pair
label/help with a right-side action (`2520-2557`). `kit/theme.css:212-223` uses
8px button corners; `287-294` uses 4px field corners. These are source facts,
not dimensions inferred from screenshots with unknown zoom.

WIRE retains its outer navigation and four Settings categories. The Settings
rail contains search, the native category disclosure and the Collection status
link. Search stays available when categories collapse. The right pane is flat,
with 24px row insets and single hairline boundaries; wide rows place label/help
left and a bounded control right, while narrow or enlarged-text layouts stack
them. Header and pane titles use the scoped 32/40 role and -.025em tracking;
compact titles reuse 24/32. Body/help and controls keep the shared Asta 14/20
roles, with readable 16px row labels. Source paths retain their separate
regular reading role. No palette, outer navigation, form state or controller
contract changes with this presentation.

Settings fields, navigation and ordinary actions use distinct 4/6/8px corners,
not universal capsules. Their native targets remain at least 44px. The search
input itself is 44px high; its containing border is not counted as hit area.
Its wrapper supplies the input's visible focus ring, and the rail reserves
space for outward keyboard outlines. Existing help/icon exceptions and
red-outline confirmation dialogs keep their existing geometry. Steady deletion
and recollection entry labels have no authored continuation dots; the adjacent
help explains scope preview and separate confirmation. Tests measure real text,
row/control centers, divider spacing, long option disclosure, private search,
Back/focus, grants and source-edit behavior in light/navy and enlarged layouts.

Painted text controls retain at least the shared 12px horizontal inset, including
both Read/Hide request-text labels and chat disclosures. Quiet controls remain
transparent at rest; their hover border and keyboard outline do not remove that
inset. Filter/format targets include their inset painted surface in vertical
padding, so wrapping never places glyphs outside the paint. Format-grid rows share
the tallest content-sized height, and their labels stretch within the help-button
wrappers; adjacent help targets retain their own size and vertical centering.
Wrapping text-action
corners are capped at the greater of 22px or half a line height (result links use
22px), preserving normal 36/44px capsules without letting tall capsule corners
cut into the first and last lines. This is a multiline-text exception, not a new
shape for sidebar rows, icon controls, static badges or inline links. Existing
dropdown truncation still exposes the full value in its described option panel.
`tests/pill-padding.browser.test.mjs` measures rendered text/icon rectangles
against both painted edges and curved corners, not just computed padding.

Contextual return and Clear selection share an adjacent wrapping group aligned with the
view heading or report-selection summary, rather than disconnected header and
selection rows. Request/chat return links retain their native destinations;
primary report and collection actions stay separate. The group moves only when
its view changes, preserving node identity during reads. Reset to Home is separate,
beside analytical filters/scope; Clear selection keeps its draft/preview-only scope.
Neither changes retained evidence or saved reports. Full labels wrap naturally
with 44px targets and the shared 8px pill gap.

Home's Source and Collection settings are native secondary links within
the closed **Source and collection** disclosure beside the primary check.
Its row allocation does not depend on whether it is open: the same summary
stays beside the action on wide layouts and consistently below it on narrow
or enlarged layouts. Opening reveals native details below that stable trigger;
only downstream content moves. Focus, the 44px target and both Settings links
remain intact, and toggling does not run collection or change capture permission.
Their group uses intrinsic width with an 8px gap beside or immediately below
the source/window summary when expanded.
The primary stays first and content-sized; a container query stacks the result
beneath it in narrow panels or with enlarged text. These
presentation changes add no collection action, permission or freshness claim.
`tests/pill-consistency.browser.test.mjs` checks actual composed control paint,
native edge/touch/keyboard navigation, disabled state and 375/820/1200/2560px
layouts in both themes at 100/200% text, including a narrow panel in a wide host.

The chart period picker is a quiet text-and-chevron control, not a pill.
Its transparent 44px hit area keeps keyboard/touch behavior; the title and
period control share a baseline without redundant Calendar dates or info controls. At narrow
chart-container widths the intact title precedes one control line; Time scale remains the
accessible label while the selected period stays visible. The styling lives in
`web/toolbar-styles.mjs`, with browser checks in `tests/toolbar.browser.test.mjs`.
The visible Time scale label has an 8px external gap (`--space-sm`) before the
dropdown, without increasing the control's padding or size. The time chart
heading names the successfully applied scale, for example **Activity over time
(Monthly)**, and labels its focusable chart region. Pending or failed reads do
not relabel old data; selecting a scale retains focus on the picker.
Weekly, Daily and Monthly remain fully visible both selected and in the menu.
Compact chart selects use the widest actual option's intrinsic width in the
trigger's own font, not a fixed em width inherited from the smaller caption.
An aria-hidden, noninteractive grid sizer keeps width stable across selections
and follows font/text-size changes. Ordinary dropdown sizing remains unchanged;
the existing chart-header reflow moves the whole time-scale control at narrow
widths rather than ellipsizing, abbreviating or shrinking the selected label.

## Quantitative chart contract

Every chart separates canonical quantities, visual geometry, decoration and
interaction. Counts, denominators, calculated percentages, filters and saved
evidence never change for presentation. The user's later explicit instruction
permits enlarging small columns, result sections and donut slices; it supersedes
the earlier exact-linear-height/exact-angle restriction. Visual minimums are
disclosed, not presented as measured quantities. Zero has no data-bearing paint;
missing evidence stays distinct.

The approved art direction is dimensional glass: faceted columns and open,
front-facing, restrained-tilt donuts in light and navy. The user's correction
concerned small-value readability and label alignment, not rejection of 3D.
Do not substitute flat columns or outcome/service bars. The self-contained
factory keeps exact arithmetic separate from a shared readability allocation.
Front and side faces agree on each allocated visual span. Neutral lids must never inherit
the final outcome's color. Paint lids and inward-clipped rims before data faces.
An integer SVG viewport contains the complete visual geometry. Small bands use
solid high-contrast material and no glints or horizontal
outlines. Larger bands retain face-bounded glass accents. The user's additional service
chart reference applies to service, API and timeline columns alike: broad
translucent facets, a narrow front sheen and a restrained bright corner spine,
not matte blocks. Spines stop inside each sufficiently tall band and are absent
from thin bands; no reflection or colored lid may impersonate a small count.

Positive donut slices have a 3% minimum visual share. Remaining angular space is
allocated proportionally among the larger categories, with all visual spans
summing to one circle. Canonical partitions and displayed percentages still use
the actual counts and denominator. The existing unit line says **small slices
enlarged** only when needed, so a donut remains understandable without the column
panel. One concise shared Home note explains adjusted visual sizes; existing
exact-data help carries the detail. No mode toggle or repeated warning blocks.

The donut uses a bounded 360px normal-size reading surface, clamped
to its real narrow container. Below the space needed for both chart and legend,
the legend moves underneath; text never overlaps or shrinks to preserve a side
layout. Hover and keyboard inspection visibly brighten and outline exactly one
category's real faces, including previously opaque tiny slices, mixed services
and grouped Other. Informational labels can receive inspection focus without
inventing a filter action. Neighboring outlines remain clipped to their own
faces. Do not restore full-row hover blocks, dotted leaders, detached tiny-outcome
annotations or per-column info controls.
Donut face links suppress only the browser's non-keyboard SVG focus outline:
that native rectangle follows a face's bounding box, not its painted geometry.
Pointer inspection keeps the existing face-bounded highlight; keyboard inspection
keeps the visible focus ring on the semantic legend label and highlights the same
category. Native link destinations/modifiers and `:focus-visible` remain intact.
The rule is scoped to donut SVG links, not column/count links or tool-name bars.
Paired cards keep the same shared row alignment with exact-data disclosures open
or closed. Disclosure content expands below its summary; opening it must not
switch the parent layout or move the trigger.

New chart types must pass this admission gate before shipping: exact zero,
1/2/20/200 common-readability-scale comparisons, extreme ratios, adjacent small categories,
balanced/full/empty data, changing denominators, and preserved unknown/grouped
members; actual rendered-path or pixel proof of unobscured data; readable labels
and keyboard/touch association in both themes and narrow/enlarged layouts.
Reusing policy is not sufficient without testing the new encoding. Node,
browser serialization and newly generated reports must agree; existing report
bytes are never rewritten. `chart-geometry-policy.browser.test.mjs` exercises
the shared policy and current renderer families alongside their specific suites.

## Count charts

`lib/dimensional-charts.mjs` renders actual glass front/side/lid geometry.
Interactive time footprints are 84px; comparison/report footprints are 116px.
Heights use one square-root scale per scene, with a minimum positive body of
36px; zero stays empty. Interactive maximum height is 320px and print remains
compact at 280px. Positive recorded-result sections have a 6px visual minimum;
the remaining body is allocated proportionally, never overflowing its total.
For unusually small custom extents those minimums are bounded by the extent.
The original two-call body is about 41px instead of a thin plate. Equal totals
retain equal body heights, with a common baseline and maximum; unchanged
polling cannot change the geometry. Native labels and exact tables retain the
real counts and shares.
The neutral lid has no quantitative meaning;
the subtle common glass floor belongs only to columns. Zero has no data paint
and no action. Reflections and decorative connectors are omitted.

Column ends are closed, softly shaded neutral planes, not the panel background
inside a faint outline. The finish is opaque and shared across every service and
outcome; it has no extra vertical wall or thickness and never inherits the final
result's color. Only a restrained front seam is highlighted inside that plane,
not a perimeter rim. This lets the end read clearly in light and navy while the
sides retain their glossy glass treatment. Data bands paint afterward, so the
finish cannot cover or impersonate a small result.

Time and API columns stack the unchanged canonical outcomes. Missing-result
bands have a stable base position so gray data cannot masquerade as the finish
of a mixed-result column. Service columns
use the existing stable service identity palette and explicit category names; service
color is not success. Missing/partial/other results remain separate.

Under-column labels are text-only: no standalone service glyph or reserved icon
row. Service and path/operation labels use the same Asta Sans 14/20, medium
weight (500) role from the existing typography tokens. They begin 24px below the
common column baseline, centered on their projected column axis. Single- and
multiline labels align on their first visible text line, not the final line;
additional lines flow downward without a reserved two-line block. Font
enlargement retains those roles and complete wrapping. Counts remain the
separate prominent numeric-link role above each column. Donut legends, category
definitions and other semantic glyphs are unaffected by this label-only change.

Non-underlined count links provide 44px visible-label targets, including
**2 calls**, without changing the data or making the plot a hidden hit region.
Chart text links use a subtle text-color change, not filled rectangular hover
blocks. Percentage labels fit their text within the allocated track; deliberate
keyboard focus remains visible and softly rounded, without painting the whole
legend row or putting text outside its target.
Narrow legends retain icon, label and right-aligned value tracks wherever they
fit. Do not force every value onto an indented second line at a viewport
breakpoint; only genuinely long or enlarged text wraps within its own track.
Painted faces and count links lead to the same filtered requests. Native
link modifier behavior, keyboard focus, scroll position and Back remain intact.
Count width and root text size determine category pitch and headroom, never the
count scale. Horizontal scrolling preserves complete labels in dense views.

The existing exact count table starts collapsed and retains the user's explicit
expansion/collapse choice across navigation and snapshot updates.
It associates every date/category with its counts and recorded outcomes,
including **No result recorded**. It contains numbers and its concise caption,
not another explanation block. Geometry/calendar help lives in the existing
closed **What these results mean** disclosure; service definitions remain in
their existing disclosure. Counter/whole-column duplicate hover popups,
per-column info buttons and detached tiny-band captions stay removed.
The user's later clarification restores inspection of individual recorded-result
sections: hovering either actual glass facet reveals that section's exact count
and share of its own column immediately, without the ordinary control delay.
Front and side belong to one inspection target, so crossing their seam does not
flicker. Escape, departure and navigation use the shared tooltip lifecycle.
Native count focus remains quiet and exposes the full breakdown in its accessible
name; touch/click still drill down normally. Do not enlarge a section invisibly
over a differently colored result or assign decorative cap area to its count.
Decorative cap edges are subdued; thin slate results use their lighter solid
material instead of dark label ink so a missing-result band does not read as a
heavy lid border.

`lib/dimensional-report.mjs` shares the same dimensional geometry in new script-free
HTML/PDF reports, with their own concise visible explanation of the adjusted
geometry. Print groups of at most three columns retain one maximum; exact tables
retain all outcomes. Previously saved reports are immutable.

### Responsive content widths

The shell allocates its full available width to Home's chart card and associated
chart controls, after the real sidebar and main gutters. It does not impose the
old 1440px main cap on a data visualization. Other workspace blocks and supporting
disclosures keep their 1384px content budget; prose retains its 72ch reading
measure and exact-data tables retain content-sized columns.

The shared browser chart reads its own scrollport's usable content width, not
screen or viewport width. Category pitch adapts between a readable minimum and
a bounded comfortable maximum; physical column widths, count heights, icons and
text never scale to fill the scene. Minimum pitch accounts for actual label
typography and unwrapped exact 44px numeric-link targets. A single
ResizeObserver per view handles container-only resizing, hidden-to-visible views
and typography changes. Geometry updates keep the existing buttons and labels,
so focus and category identity survive resizing. The caller disconnects the
observer before replacing a view and preserves keyed chart focus and scroll
through snapshot updates and browser history.

True excess categories remain in a named, keyboard-focusable horizontal
scrollport. Visible overflow guidance follows the measured layout. There is no
page overflow, text downscaling, category wrapping into multiple rows, automatic
regrouping or hidden-scrollbar workaround. One- and two-column scenes stay bounded
even in an ultra-wide card. Report preview/HTML/PDF remain document views: their
script-free three-column scenes and common numeric scale are intentional, not
an instruction to stretch a print document.

## User journey

### Percentage charts

The single **Recorded result** dropdown precedes Home's count header,
time/service/API columns and percentage panels. The existing rounded custom
select provides a native button with combobox semantics and a portaled listbox:
arrows/typeahead explore, Enter/Space commits, and Escape cancels. Options carry
canonical icons/colors, labels, counts and ordinary readable descriptions.
Selection never relies on hue. All six canonical outcomes stay available,
including zero counts; the short list does not need another search box.
The same DOM field stays in the shared Home/Activity filter region beside the
period controls, retaining one route/query model, not a second selector in More filters. The menu's
All results description and the field's accessible description explain faceted
counts without adding a redundant full-width scope row above the chat list.

A separate native **Clear recorded result filter** button with the shared Fluent
close glyph sits immediately after the trigger, outside it, in a reserved 44px
slot. It clears only the result and returns focus to the dropdown (or its label
when result filtering is unavailable). The unused slot stays empty, not a fake
disabled X. There is no detached Result chip on Home/Activity and no duplicate
empty-chart clear; the empty state points to this same local action. Selected
text wraps within a content-proportioned trigger, the chevron stays distinct
from Clear, and the option panel exposes every full label. The group and menu
remain bounded at 375/820/1200/2560px, 200% root text and a narrow host.

`analytics.resultFacet` counts canonical rows with every current filter except
outcome, using the same selection predicate and snapshot; the concise scope line
distinguishes these available counts from selected chart totals.
Missing/partial/other/transport outcomes remain separate. HTTP and returned-result
layers keep their own labels and units; code references disable outcome selection
with an execution-not-observed explanation and allow clearing an inherited filter.
Accepted result context labels 100% slices as filtered. Pending reads keep the
accepted selected value and counts beside the accepted charts, with the existing
pending indicator; a newer choice, including reselecting the accepted value or
Clear, supersedes older intent. Unchanged polling keeps an open menu intact;
replaced options close it rather than committing stale values. Late, malformed
or failed responses cannot replace the accepted chart with mismatched counts.

**Related-surface audit:** Activity's previously loose Clear search now belongs
to the same input row as the query. Settings, affected-chat, report-request and
saved-report searches already use that local row and now all have explicit
field-specific clear names. These searches filter only their documented lists,
not report membership, source permission or display preferences. Collapsed
More filters refinements (service/project/layer/collection) keep their existing
selectors and useful applied-scope indicators; date range remains a coordinated
When/From/To/Apply group, not two independent date resets. Request details keep
their scope chips because the local filter field is not present there.
Chart/composition switches remain segmented view choices; format choices,
disclosures, category navigation and actionable result links are not converted
into dropdown filters. Reset to Home keeps its established broader view reset;
Clear selection still affects report membership only.

Home keeps its count columns and adds directly labeled **Recorded outcomes**
and **Service share** dimensional donuts. **Tool names** retains the existing composition
switch, using recorded names rather than an inferred taxonomy. Every panel uses
the same accepted canonical snapshot, filters, evidence unit and denominator.
Malformed or failed reads cannot replace accepted figures with mismatched data.
The full applied scope remains the percentage region's accessible description;
Home's shared applied-period summary carries the visible date/count context, not
a second paragraph of ISO dates above the donuts.

Each donut has its category, exact count and percentage in an adjacent aligned
legend. Restrained glass gradients, face-clipped rims and glints reuse the column
materials; small slices keep opaque identity color and no decorative overlay.
There is no floor behind donuts, no dotted leader and no extra help control.
Tool-name rows continue to use unrounded bars.
Positive outcome/service labels are native links to the relevant filtered
activity; zero labels are noninteractive. Tiny categories are readable through
their visible row, not a precision hit on a wedge or required hover. Percentages
use honest `<0.1%` / `>99.9%` boundaries, never false zero or 100%.

At most six positive service/tool categories are shown: up to five named rows
plus Other. Unknown and multi-service attribution retain slots. **All categories
and definitions** lists all members and exact counts, including zero outcomes,
in the existing closed disclosure. No evidence or denominator is dropped.

Cards span the workspace and use two equal columns at a 64rem container width,
otherwise stacking. Inner content stays at its readable measure. Shared rows
align headings, units, counters and disclosures without fixed-height filler.
Labels/counts wrap at enlarged root text; symbols and words preserve meaning
without color. The total counter is baseline-aligned with **in this view**.
Container reflow, polling and Back retain the selected breakdown, disclosure
and logical focus. These percentage views do not rewrite saved report bytes.

Home starts with **Work IQ in your Copilot chats** and one seven-word purpose sentence:
"Explore recorded activity and prepare feedback reports."
**Check for new activity** is Home's first action, followed by
the existing period selector, Choose a Copilot chat action and evidence
in main-content document and keyboard order. No routine collector card
precedes the task, even during loading. This is a dashboard correction, not a
hero, new wizard or competing call to action.

The fresh-data control pairs the primary action with a concise result after a check,
not an always-on health card or a repeated idle instruction. **Source and collection**
contains local Copilot history, the intake window and direct
**Source** and **Collection settings** links to the existing Settings categories.
It keeps the background-paused state explicit and never enables it as a side
effect. Unapproved sources route to review. **Refresh stored data** is a quiet
secondary action inside this disclosure on Home/Activity, beside saved history
in Reports, and within the relevant evidence/settings section elsewhere. It reads
the retained snapshot without scanning source history or reloading app code.
The global header has no duplicate refresh action.
On unapproved Home, the fresh control is the sole source-review action.
The generic connection notice adds only retained-evidence availability when
applicable, not another setup link. Other views keep their connection action;
blocking errors, paused collection and initial-import guidance remain visible.

An explicit check has owned checking, applying, complete/no-change, partial and
error states. Its live status changes at those transitions, not every five-second
poll. Novelty and coverage are separate facts: **No new recorded activity** can
appear with **Some history unavailable or incomplete**, linked to Collection
status. Both facts are announced; the manual completion time stays outside the
live region and is never replaced by an unrelated background timestamp.
**Source and collection** also holds source counts, elapsed milliseconds and limits,
plus the local-history boundary: use Work IQ in Copilot, then check its recorded
calls and results here. Checking does not create remote traffic. A file-stamp
check may finish immediately; the app adds no minimum delay or invented stages.
Counts/charts remain
on the prior good snapshot until the check's committed revision is available.
The runtime coalesces simultaneous manual callers behind any active interval
cycle, then reconciles metadata before the bounded read. Check receipts are not
job queues and do not promise a complete backfill. Late responses cannot complete
a newer intent, an older snapshot cannot satisfy a check, and apply failures offer
the existing read-only Refresh stored data recovery without replaying the mutation.
Reviews stay frozen if opened during collection; applying waits until review or
editing finishes. New evidence excluded by a filter or evidence layer is described,
not silently included. Missing or bounded histories are partial, never empty success.

Home has one applied summary: the selected activity count and unit, followed by
the accepted period and source-chat count. Request-group counts, complete-interaction
scope and counting boundaries remain in **Scope and result definitions**, not
another default-visible summary. Activity retains its more detailed matching
chat/request-group/count summary beside its private search. The Home
summary and native chooser form one left-aligned, content-sized group: the action
sits 20px beside the copy or wraps 12px beneath it, after the combined date/result
filter region. Neither item grows to push the chooser across unused chart width. The
summary remains two lines where space allows, without smaller fonts, ellipsis,
fixed heights or forced no-wrap. Narrow panels and enlarged text wrap naturally.
Activity keeps its summary without reserving an empty action row; hidden
pending/error/empty-state actions keep their existing state guards. Charts retain
their independent full-width layout. Detailed group provenance remains in existing evidence help; source
inventory and matching-evidence denominators remain distinct.
Home's count summary and percentage denominators use the same applied rows as
its count chart. A private Activity search stays available when returning to
Activity but does not narrow Home's charts or summary invisibly.

The existing **About this evidence** disclosure starts closed and explains
recorded results and request grouping. **Collection status → Technical details**
distinguishes Work IQ calls, returned API metadata and separately recorded Graph
requests. Tool names and service categories do not prove requests or HTTP status.
The adjacent **Scope and result definitions**, activity/service category meanings
and **About this evidence** summaries are peers: all use the same 16px reading
role, 600 weight, 1.5 line height, 8px vertical padding and 44px minimum target.
They scale together with root text size; the scope summary does not inherit the
larger section-heading treatment used by the chart's exact-data disclosure.
The three current measure groups follow the activity charts. Missing reasons,
measured coverage and dimension help remain visible/discoverable; the glossary
stays in Measure definitions. Moving these sections does not change pooled metrics.
Details remain keyboard-accessible and retain their open state through polling.
At enlarged text sizes, the existing navigation/export controls wrap instead of
clipping. The existing header controls and keyboard order stay unchanged;
mobile actions wrap onto additional lines only when needed.

Exact chart tables use content-sized columns rather than the page-wide table
default. Date/category labels stay left-aligned; numeric headers, values and
totals share centered column axes and tabular numerals. Body cell padding does
not duplicate the 44px action's padding. Single-page position labels have no
reserved button height; paginated controls retain their 44px targets and the
24-row limit. Long labels wrap, numeric columns can grow, and only the table
region scrolls when necessary. No fixed row heights or smaller fonts are used.
The caption explains the selected unit, Monday-starting weeks or
month-start dates and the current filters. **Total (all rows)** includes every
page, excludes explicitly labeled records without dates, and never implies the
total covers uncollected activity. A visible scope note distinguishes unavailable
history from hosted Work IQ's internal Graph traffic; collecting more local logs
cannot reveal that traffic. Recorded outcomes and chart geometry are unchanged.

Source conversations are **GitHub Copilot chats**. Introduce the full phrase in
each coherent area, and use **Copilot chat/Copilot chats** on standalone controls,
labels, counters and breadcrumbs. This applies equally to standalone and project-associated
chats; identify the project separately. A missing recorded name says **Copilot chat name
not recorded**. Unattributed request groups explicitly lack source-chat identity;
do not invent a name, project or chat analysis link. Their request counts remain
visible, separately from identified-chat counts.

The unrefined chooser can also list eligible metadata-only sources. Matching
chats, request groups and activity stay in the existing view summary above
Insights; the outer Activity list does not repeat them in an Insights footer or
another paragraph above the pager. The list note adds only the distinct inventory
fact, for example **Also listed: 884 Copilot chats without matching evidence**.
When every listed chat matches, that extra note is hidden. A metadata-only list
says its chats have no matching evidence **in this view**, not that they have no
recorded history. The paginator says **Listed Copilot chats** when it includes
additional metadata rows and keeps the total listed inventory separate from the
matching denominator. Its navigation label identifies the chat list.
Counts use the actual applied snapshot, not these illustrative values. The
existing **About this evidence** disclosure explains current filters/private
search and the wider full-retained-interaction scope used by Insights. The
focused chat-analysis context keeps its existing explanation. Do not hide
eligible empty/unreadable chats to force agreement with matching counts;
zero-match rows keep their analysis link and explicit zero evidence counts.

Terminology changes affect authored copy only. Keep technical `sessionId`,
`sourceSessionId`, schema keys, route/query `session`, API/tool names, database
tables, `session-state` paths and deep links unchanged. Recorded source names,
prompts, raw diagnostics, payloads and historical scan notes stay verbatim.
Panel/runtime authentication sessions are connections, not source chats. New
reports use the new language; previously saved bytes and privacy gates stay fixed.

Collapsed rows connect the distinct units on one line: **1 request group with
3 Work IQ tool calls** or **6 request groups with 14 Work IQ tool calls**.
The adjacent **12 Worked / 2 Needs attention** counts apply to those 14 calls,
not task completion. The list's visible scope sentence covers active filters
and private search, including off-page matches. The group count is distinct
primary `scenarioId`s represented by the selected canonical rows, not prompts,
MCP round trips, HTTP executions or response-array elements. Current extraction
uses nearest preceding recorded-message identity; missing origins fall back
to call-start identity. Follow-ups that trigger calls form separate groups;
retaining a nearby follow-up as context does not add it to the count.

Use the selected evidence layer's exact unit: Work IQ tool calls, tool-returned
API results, recorded Graph request sites, sites with visible status, owned HTTP
records or Graph code references. A multi-target fetch remains one call.
Visible Graph statuses are a subset of request sites, never extra traffic.
Recorder-only identities use recorder-source/record-group wording.
Full request counts and full eligible report selection stay separate from
matching counts; analysis explicitly labels its pre-result-filter total.
No backend counting or source evidence is changed to make labels reconcile.

Original Copilot chat titles share `--copilot-chat-title`, restrained violet
in light and light violet in navy. This token is distinct from interaction,
outcome and service colors, and keeps at least 4.5:1 composed text contrast
through rest, hover, focus and selected states. Labels, original text and weight
remain readable without color; long names wrap rather than being renamed or
truncated. Plain-text/JSON reports do not carry visual title styling.

### Progressive disclosure and bounded lists

| Surface | Keep visible | Disclosure / list decision | User job |
| --- | --- | --- | --- |
| Home | Filters, viewing context, totals, chart, result legend, coverage warning | Retain collapsed explanations and glossary. Exact data renders on opening, 24 rows per page with complete plotted/category totals. | Understand the slice, then inspect exact values without a hidden large table. |
| Activity | Exact chat name, distinct project/unscoped context, compact reference for same-name or unnamed sources, one request-group-to-call count line, actionable recorded successes/failures, report-inclusion count | The repeated name-field label is screen-reader-only. Group the complete filtered set **before** paging eight chats. Overview groups start closed; each opened group renders six request groups per page. Eligible chats with no captured calls can still open analysis. | Choose a recognizable Copilot chat, then inspect its collected evidence independently. |
| Chat analysis | Exact chat name as the primary heading, a recorded project when present, compact reference only for ambiguous/unnamed sources, canonical results, date/service/collection summary, coverage and report action | The existing Technical source record disclosure pattern holds exact source ID, recorded name, source host and project facts without a new card. Worked and Needs attention links render six matching canonical actions per page. | Inspect results without losing chat/filter context; create a report for this chat only. |
| Request | Recorded outcomes and known failure details first, source context once, one exact prompt reader, chronological actions | Long prompt text opens without an excerpt or internal height limit. Technical details, provenance and inferred follow-ups stay secondary; action and follow-up lists remain paged by six. | Understand what is known, read the retained prompt and inspect its actions without duplicate summaries or navigation. |
| Collection status | Collector state and next step, readable/eligible coverage, Chat history gap summary and compact search | Closed short reason groups, six chats per page; closed Technical details for inventory, exclusions, limits and stored refresh. Home check results and Activity link here. | Know whether collection is working, inspect missing activity when relevant and avoid treating every gap as a repair task. |
| Settings | Display, Connection & permission, Collection preferences | Already-approved sources have one plain source summary, not a duplicate approval form. Review/Change source opens exact requested paths and a deliberate approval button. Operational results link to Collection status. | Understand and authorize scope once, edit deliberately, and keep evidence browsing independent. |
| Reports | Current-stage work, one-report inclusion summary, Clear selection and four-step navigation | Requests shows scope and a disclosure with four requests per page. Contents holds the three prompt modes, four formats and Scan and preview. Saved history stays separate, six reports per page. | Choose membership, then contents, without confronting every control at once. |
| Review and Save | Review shows the frozen formatted preview, scope, incomplete-source/removal totals, limitations and unchecked attestation. Save shows the separate final confirmation, then actual file downloads. | Review opens six original/copy comparisons per page, retaining edits when paging; exact-file disclosures remain available. Save is reached only after explicit disclosure review. | Compare and approve the copies, then deliberately save; paging or changing stages never grants consent. |

Chat buttons expose `aria-expanded` and `aria-controls`; **Open analysis** is a
separate link, never a nested control. Summary outcomes cover all matching actions
in the filtered chat, not just the visible six requests. Individual request
outcomes retain the matching-versus-full denominator. Report-inclusion counts
cover the whole chat (including requests outside the current filters), count
canonical request owners once, and remain visible when its cards are unmounted.
Missing source IDs have separate unattributed request groups and no invented
chat drilldown. Same-name chats include their source IDs. Project kind is
shown when the mapping records it; a folder project is not relabeled a repository.

**Choose a Copilot chat** is the prominent Home next step after the period results and
opens the matching list, retaining the applied period and refinements.
Choosing **Open analysis** retains the indicated dates, service, layer and
collection; incompatible project, result, endpoint and private-request filters
are cleared. A result link instead retains its exact originating slice,
including private search, and narrows to that one source-chat ID. Both are
native links with independent disclosure and information controls. Back to
chats restores the list route/search/page in browser history state; private
search never enters copied URLs. A success or failure deep link opens the matching
actions without manual hunting. Unknown and nonexecuted evidence has no
success/failure action. Neither does a zero or unavailable count.

Activity search uses the precise **Find a Copilot chat or request group** label and a short
**Search** placeholder. Help explains the searchable chat names,
projects and requests without stuffing a sentence into the input. Its native
single-line editing, horizontal caret scrolling and exact query value are
preserved. Control and label height grow with enlarged text; result labels wrap
only when needed, with no text shrinking or clipped capsule edges.

The focused chat header leads with the exact recorded name, without a repeated
**Copilot chat name** label, generic review instruction, default no-project sentence
or prominently displayed UUID. A recorded project remains useful context.
**Technical source record** uses the existing native disclosure style, not another
box, for the complete ID, source host, recorded name and project facts. Request
details retain their existing source/provenance disclosure and exact chat navigation.
Same-name and unnamed sources have a compact ID suffix in the chooser and analysis
header; the suffix lengthens when needed to distinguish the current sources.
It describes the native analysis link for assistive technology; it never replaces
the complete on-demand ID or changes source identity. The breadcrumb retains
the full name in its accessible label without visually repeating the heading.
Renames preserve the source-keyed disclosure state and native route.
One scope summary covers dates,
service and collection; result-filtered actions below are distinguished from the
chat's pre-result-filter totals. The snapshot uses the existing canonical
analytics for both, never independent success flags or per-chat fetches.
Source history failures remain coverage notices, not API outcomes. Empty,
unreadable, partial and archived states offer existing collection checks or
preserved/layer-specific evidence, without pretending a check repairs history.

The report membership list retains its existing 360px reading area, now limited
to four requests instead of the entire catalog. Its pager remains outside that
area, always reachable; the region is named and keyboard-focusable. Other new
list pages flow with the document rather than introducing nested scroll areas.

A chosen chat opens on arrival; a request deep link renders the request
directly. A unique one-request search result opens its chat; broader searches
show complete matching counts without expanding every group. Existing user-open
groups remain open. Within a filter/search scope, newly collected chats and
requests append after already listed IDs, keeping pages stable; a fresh panel or
new scope begins in newest-request order. Filter/search changes begin on chat
page one. Paging never changes the analytical slice or report membership.

Recorded results distinguish **Tool completion** from **API metadata from tool**.
Worked records completion, not task correctness; returned HTTP status
families do not imply a directly observed Graph response or a specific status
code. Tool, service and API path have separate labels. Literal paths such as
`/me/messages?$top=5` use selectable, wrapping code text, never a link or a
slash-joined breadcrumb. Missing paths say **Not recorded**; absent API metadata
is not a failed response. Requests with no tool calls do not acquire an API
metadata row. Batched targets remain distinct, and returned-result details are
associated by canonical parent call and result identity, not by tool name,
source-array index or the first path. Unattributed batch results say so; only
single-target calls can supply an explicitly labeled fallback path. Technical
details retain the original arguments and provenance.

Action-level support disclosures align with their owning action inside its
timeline rail. Any inter-action divider follows the complete disclosure, open
or closed, never separating Technical details from the action above it.
Independent request, Source and Settings support sections retain their boundaries.

Open state and inner page positions are panel-memory presentation state, keyed by
source chat/request/action/bundle identity, not row positions or changing
summary text. They survive ordinary navigation, Back/Forward and snapshots.
Reading anchors and identifiable focus are restored across refresh, and returning
to a previously visited route restores its reading position. Reset to Home resets
the analytical route and outer chat page, **not** source disclosure choices or
inner pages; Back restores the earlier route. Reload/new panel restores closed
overview defaults and first inner pages, along with the existing empty report
draft policy. No disclosure state is written to the evidence store or a URL.

Next and Previous are section-pagination intents, not new-page navigation.
The outer chat pager and shared request/action/table/report-history pagers keep
their pager anchor at the current reading position, subject to the document or
scroll container's natural end when a page becomes shorter. Focus stays on the
requested direction while enabled, otherwise the available reverse action or
range label; the current range describes the focused button. No spacer or
fixed content height is added.

Context and browser returns use reading positions belonging to the actually
displayed route, never an in-flight destination that has not appeared. A failed
read does not run success positioning. New pointer, keyboard, wheel or touch
reading intent takes precedence over a late navigation finalizer without
preventing the user's input. First visits and initial deep links retain their
normal destination positioning. Report-flow Back restores a still-valid prior
stage action and its local scrollers; a new or invalidated review uses the
stage heading instead. Returning from a saved comparison restores focus within
its retained draft section without scrolling to the page heading.

Collapsed chat cards, report lists, prompt-comparison pages and exact-table
rows are not rendered in full behind CSS. Source text remains exact in its
original disclosure; excerpt and copy semantics are unchanged. These are screen
navigation changes only: generated HTML/PDF/JSON/Markdown membership and complete
content are unchanged, and previously saved bytes are never rewritten.

**Collection status** is a dedicated `#collection-status` main-navigation view,
not a configuration category or a second status card on Home. It separates
active/paused/checking/disconnected/error state from history coverage, with a
short state-specific next step. Routine active collection explicitly requires no
action. Importing history continues through existing automatic checks; a running
collector with all histories unavailable states that no history is readable,
not that coverage is healthy. Relative last check and last new evidence stay
separate; no new evidence is not a failed check or proof of complete history. Eligibility
is metadata, not a successful-read count; the inventory and exclusions live there
too. Routine status and timestamps are not live announcements. Check for new
activity is also available on Home; Pause/Resume stays in Settings. All have
ordinary labeled 44px targets. Source and preference links are subordinate
navigation, not duplicate collection buttons. Pause and source-review guidance
locate the existing Settings controls without invoking them. The existing
Retry connection button appears in the health heading when the status read
fails, rather than disappearing inside the hidden entry notice.

**Chat history** shows one affected total and unavailable/limited counts.
Previously collected evidence is kept. The search control is capped at 32rem
within a 64rem page, with 4px field-help spacing and unchanged reading type.
Desktop headings and short reason labels fit naturally; narrow/enlarged text
reflows without clipping or shrinking. The healthy state shows one no-gap
message, not a search over an empty list. Unchecked, importing and current
failure states retain their own wording. A nonempty query remains available
even if its last matching issue disappears, so Clear/Escape still work.
Only a nonempty query shows matching-versus-total counts. Distill guidance
removed duplicate counts/actions without removing the existing metadata search,
reason definitions, six-row pager or privacy boundaries.

The closed **Optional network diagnostic** section on Collection status is
separate from local collection health. **Test HTTP recorder** explains the
outbound credential-free public Graph metadata GET and local diagnostic write
before **Send public request** confirms it. It cannot establish Work IQ,
workplace access, task correctness or healthy collection. A durable attempt
identity is accepted before the bounded request; adjacent live feedback names
pending, HTTP failure, no response, timeout, storage failure or a recorded
response. Recorded outcomes link to the separate HTTP recorder evidence.
Intent/result files and the recorder file preserve identity across reloads;
read-only result checks never resend uncertain or interrupted attempts. The
browser no longer waits on the 30-second outbound call inside its 10-second
transport limit. No page load, navigation, reconnect or Home activity check
starts this optional request. Synthetic injected transports retain their
synthetic provenance and never enter ordinary evidence counts.

Settings action pills explain their consequence on hover and keyboard focus
through the shared dismissible, hoverable tooltip. Change source opens an editor;
Pause preserves retained evidence; Resume uses the prior approval; Check for new activity
performs one local-history check even while paused. Review, approval, preference,
progress and unavailable states have distinct one-sentence guidance.
Native-disabled actions remain disabled and expose one focusable explanation
group without extra info icons or duplicate action tabstops. Polling preserves
the current control and description; Escape dismisses help. The collection row's
borders and text baselines already align, so content-sized 44px controls and
intentional wrapping are preserved rather than applying a cosmetic offset.
First use shows a short **Review source in Settings** Home entry after the title, not
a mandatory configuration wall. The dedicated route is reachable in the sidebar
and the same mobile drawer, with an official Fluent settings glyph, active state,
deep links and focus/Back/Forward behavior. Settings has three categories:
Display, Connection & permission and Collection preferences. Its short
Collection status link separates configuration from reading results.
Inside the existing main sidebar, a compact left category navigation presents
exactly one dedicated content pane. Native links use `aria-current="page"`, not
incomplete tab roles. On a Settings container at or below 52rem (also reached
through text enlargement), the same links live in a native Category disclosure,
closed after choosing a category. No second fixed sidebar or nested pane scroller
is introduced. The pane has a 58rem maximum; field labels and explanations wrap.
Native form nodes stay mounted to preserve drafts, but inactive categories use
`hidden` and expose neither controls nor prose to keyboard/screen-reader users.

`section=display|connection|collection` is the canonical category
route; `setting` contains only a fixed destination ID. Legacy `section=history`
locates the history-window control. Legacy `#settings?issues=1` and `setting=issues`
canonicalize to `#collection-status?setting=issues`, focusing Chat history.
`section=diagnostics` opens Collection status; `setting=advanced` and
`setting=collection-details` open/focus its Technical details.
Unknown categories show an explicit notice and canonical Connection fallback.
The existing timezone header link still opens Display. Category links focus
the new heading; search links focus/highlight the relevant visible control,
disabled explanation, source-review entry or disclosed heading, never invoke it.
Back/Forward restores category and safe reading focus; reload restores the route.
The source editor links to Collection preferences and back, keeping both drafts.

**Search settings** is a local fixed-metadata lookup, not a search of hidden DOM
text or source paths. It covers setting titles, category names, brief contexts and
purpose aliases (time zone/city, pause/resume, permission, history/window/cadence,
missing history/issues). Results include title, category and useful context;
disabled/unapproved actions show the same current blocking reason as their
existing controls. Literal DOM text/`mark` nodes escape every result; query input
never becomes a regex or HTML. Clear and Escape are explicit, empty queries show
no catalog dump, and no-result/one-result/multiple-result counts are honest.
Polling does not replace unchanged results, queries, focused editors or help.

The search-surface audit keeps one search per meaningful finding task:
Settings metadata; existing Activity phrase search over the complete retained
filtered collection; all saved-report metadata; all currently reported issue
chat metadata/reasons; and the current report membership list. Saved reports
were already six-per-page and grow over time; Issues can contain many pages
within each reason; report membership is four-per-page. These three new list
filters operate before pagination/grouping, preserve source order and state
matching-versus-total counts. Query-specific pages preserve the unsearched
position on clear. The report-list filter never changes membership or preview
approval; its excluded-looking rows remain explicitly included.

Home already has canonical filters and chart drilldowns, request details already
scope one group with bounded exact disclosures, and selects already provide
keyboard typeahead. No redundant boxes are added there and no app-wide command
palette, raw-transcript index or semantic search is introduced. Metadata matches
remain distinct from evidence matching. Activity preserves phrase semantics
(including numbered request specificity) while tolerating case/accents/punctuation;
the new scoped filters require all query words across their declared fields.
The Settings result count is separate from diagnostic affected-chat counts.
Issue search includes each chat's displayed availability status: unavailable
history or limited history. An unavailable chat with additional limits matches
unavailable, not the limited-status subset; its individual reason titles and
common aliases remain searchable. Explanatory negations such as "does not make
the whole file unavailable" are not used as availability search terms.
This reuses the canonical per-chat classification
and deduplication, never the aggregate status paragraph.
Search is limited to retained in-memory data: it never fetches Work IQ/Graph,
opens saved report bodies, scans unrelated files or changes source approval.
Queries use the existing browser `history.state` convention and are excluded
from URLs, requests, telemetry and exports. They can remain in local browser
history; there is no local-storage search index. Native input editing and
short placeholders remain readable at 200% text, with scope in labels/help.

An approved connection shows one pair of plain source values, not bordered
textbox lookalikes or an extra disclosure. **Change source** replaces that
presentation with the two editable paths; read values and draft fields are never
shown together. Metadata identifies Copilot chats; the history folder holds
recorded events. Long read values wrap completely and remain selectable; they
need no hidden horizontal scroll or extra keyboard stop. Both inputs share the same field radius, padding, width
and minimum height through normal, focused, error and disabled states; focus
outlines remain visible rather than being mistaken for extra containers.
Source values use the existing system reading font at regular weight and preserve
exact whitespace, wrapping spaces inside the field rather than hanging them beyond
its edge; medium-weight role labels and the stronger heading establish
hierarchy without oversized monospace. Named Settings and affected-chat headings
keep programmatic destination focus, with a keyboard-only start rail rather than
an enclosing control outline. Search-target outlines apply only while focused;
polling cannot revive a stale highlight. Real controls retain their focus rings.
**Review source & connect** is the separate initial permission entry. Editing an
approved source does not remove its approval. Cancel restores the current values
and focuses the original entry without writing. Source/path search and deep
links locate the visible read presentation or current draft without approving.
The clearly named approval action validates before switching; existing
paused/enabled state is preserved on replacement and preference saves.
Cancel performs no write. Full writes retain backend approval validation and use
a last-read configuration version to reject stale replacement. An uncertain
response blocks another write until a safe status read; no automatic replay.
Dirty fields stay in panel memory and survive polling/navigation, with explicit
save/cancel and a return notice outside Settings. No local storage contains paths
or consent. Reload warns about unsaved work. Collection approval is separate from
the report disclosure gate; configuration changes invalidate old previews.
No source is silently collected or replaced with sample data. Failures keep the last good
chart and provide visible diagnostics. Partial unavailable/limited historical
logs use the counted reason list in Collection status, not an opening caution banner.
A blocked source/all unreadable histories still gets a concise visible notice
and an actionable Collection status link after the task heading. Paused collection
stays explicit without offering an unapproved resume action. Initial import with
no evidence shows progress; later routine polling/importing does not insert a
notice or shift task content. A lost status connection says unavailable and points
to contextual Retry connection; it never claims the collector is healthy.
Issues shows recognizable chat and
Copilot project/unscoped identity; the known reason, last attempt, prior-evidence
availability and stable source ID are disclosed on demand. Raw errors and paths
do not enter issue rows. Missing files, denied reads, other known read errors,
unsupported history and unknown causes are distinct; archived and intentionally
excluded sources are never counted as failures. Size, malformed-entry and context
limits are separate from unreadable files. One primary group per chat keeps
all counts reconciled; secondary reasons remain in that chat's detail.
Reason groups and their six-per-page chat rows start closed. Their short page
titles and full explanatory titles share the same reason contract and remain
searchable. Open chat activity uses the existing session journey and preserves
the gap-list route, search, pager and reading focus on Back. Removing the outer
Issues disclosure reduces one level of nesting; neither a search nor the current
failure is hidden behind it. Search opens matching reason groups, across the whole
current issue list before paging.

Every authored reason names its affected object: absent history file, denied file
access, filesystem read error, unverified opening record/identity/format, unknown
read failure, older file portion beyond 64 MiB, invalid JSON entries, entries over
1 MiB, or incomplete request-to-action links from limited working context.
ENOENT establishes only that a file was not found, not deletion or its cause.
Opening-record validation failures affect the file; malformed-entry warnings
affect individual skipped records. Pending reads and unfinished entries are
explained separately from failures. A single history-versus-request-result
distinction avoids repeated disclaimers. Per-chat details state whether prior
evidence exists; a closed support disclosure labels **Copilot chat identifier**
and **Technical code**, never presenting a raw enum as the explanation.

The closed page-level Technical details contains the existing stored-snapshot
refresh (not a history check), readable inventory/exclusion
counts, units and limit explanations. "Check frequency" replaces "cadence" in
authored controls. Inventory is not readable-chat count; importing chats can
already have readable entries. Counts and issue rows use one detailed status
response while visible. Current connection failures remain visible immediately.
This presentation does not change read limits, collection permissions, analytical
denominators or any original logs, errors, evidence or report bytes.

Issue names are fetched on visiting Collection status. Ordinary five-second polling changes text
only when needed, keeps focused nodes/scroll and disclosure pages, and never
announces a whole timestamp paragraph. Full timestamps use the current IANA
timezone in settings and issue details. No new recovery control is introduced:
Check for new activity performs the existing bounded local read; it cannot recreate missing
history, change permissions or replay API requests. No new source identity or
diagnostic text enters exports; the manifest explains history gaps in generic
report-facing language. The form reuses existing typography,
semantic tokens, keyboard focus and wrapping controls rather than a new visual language.

The main journey is **period -> chat -> analysis -> report** without enforcing
a wizard on browsing. When/custom date inputs and Recorded result share one
compact filter region. From/To labels align with the peer label/help row;
Apply and Clear belong to the date group. Container-based wrapping keeps that
group intact at narrow widths and enlarged text. Date boundary guidance remains
in the When help and the inputs' accessible description, with inline errors.
**All retained dates** (the compatible `capture` route value) describes the
default scope, not the initial experiment or last collection window. Its visible
date bounds come from the accepted canonical rows. A custom single day uses the
same From/To; both boundary days are included in the display time zone using a
half-open UTC interval. Date fields grow with text so native date segments and
the calendar affordance remain readable. Inline errors identify missing,
reversed or invalid bounds without replacing the accepted view. Daily, Weekly
and Monthly are independent chart aggregation choices.
One **More filters** disclosure retains service/project/evidence/collection
choices, described dropdowns, active-count summary and removable chips.
After **Apply dates**, the accepted Home or Activity count remains visible with a real pending
indicator and busy state, then updates only from the accepted snapshot and
the applied IANA dates. Apply keeps focus and scroll. The single Home next action
sits beside those results; the redundant chart-to-Activity link is not displayed,
and empty report-selection controls stay out of the initial view.
Inside analysis, Apply updates that chat's scope and keeps the report action.
Failed reads label prior results; generation guards reject late snapshots.
Changed date submissions supersede pending reads; identical pending submissions
are not repeated. A draft edited while a response arrives stays in the inputs
until submitted or deliberately abandoned by changing the date scope.

Same-view filter changes are refinements, not page navigation. They use the
existing local pending indicators and busy state rather than inserting a
temporary full-width notification above the workspace. Accepted content stays
visible until a validated replacement arrives. The navigation finalizer does
not focus the page title or scroll to the top, nor reclaim focus if the user
has moved to another control during the read. Clearing a filter returns focus
to its surviving field, or the closed More filters summary without opening it.
Opening custom-date inputs alone does not remount unchanged plots or cancel an
unchanged scoped-insight read. Actual data changes may still change content
height; no fixed-height mask or animation conceals that reflow. Cross-view
navigation, Back/Forward reading restoration and explicit Reset keep their
separate behavior.

Filtering never collects additional history. If the requested local calendar
period extends the known checked window, the warning names that window and links
to Settings history preferences. It says activity may be absent, not that the
entire selected period is complete, including partial boundary days. The
collector projects its most recent checked window separately from the immutable
evidence snapshot's collection window, so a no-change check does not leave
misleading stale bounds or rewrite old evidence. Unknown coverage stays unknown. Empty
results are not proof that no activity occurred, and source/partial-history
warnings remain outside More filters. Without date refinements the chat list
can still expose eligible empty/unreadable chats; a period-filtered list does
not pad matched counts with unrelated source-inventory rows.

One small, decorative `aria-hidden` pending indicator accompanies real async
status text: initial/view reads, manual source checks, applying snapshots,
initial scoped issue reads, Settings operations and report scan/review/save.
Controls expose busy state and block only conflicting actions; the primary
check label and icon slot remain stable. Reduced motion uses a static dotted
indicator. No fake percentages, minimum delay or idle polling animation is
used. Error, partial and no-change results remain readable after the indicator
stops. A confirmed check waiting for a frozen report review is explicitly
waiting, not spinning. Prompt expansion is synchronous within the accepted
snapshot, so it has no artificial wait state.

The runtime owns collection independently of this panel. Its chosen event cadence,
30-second source reconciliation and five-second page check are described as polling,
not guaranteed "live" delivery. Unchanged revisions do not repaint charts. New
snapshots retain analytical filters, empty/cleared report membership and scroll;
editing controls and open report reviews defer them. A visible new-data notice
does not apply old consent to new records: the report membership and bytes remain
frozen, and selected-content/options changes require a new review. Original and
masked prompts still use the existing privacy gate. No report files are written
by collection, connection, pause, selection or preview.

**Home** offers a period and one Choose a Copilot chat action before its aggregate chart.
Over-time, service and API-path views use the same canonical data. Date, project,
service, result and activity-source filters retain their semantics; secondary
refinements are in More filters. Exact chart data is
available as a table; color is never the only source of meaning.

**Activity** groups recognizable private request excerpts by source chat.
The full GitHub Copilot chats introduction precedes standalone Copilot chat labels and
separately labelled Copilot projects beside the requests.
The filter spells out **GitHub Copilot project**, with concise hover/focus help
distinguishing that context from a repository. Project names alone never imply
repository links. Unscoped records
say **Copilot chat without a project**. The same context appears in request details and
the project filter.
Selecting a chart row or time bucket carries the slice into this list. Each
request has an ordinary deep-linked page, not a modal-only detail view.

Each request row has one inline recorded-results unit beneath its existing
metadata. Counts are tabular, 16px and paired with official Fluent icons and
plain text in compact pills, never color-only labels. A mixed request has counts for each recorded
outcome; there is no fabricated overall success/failure. Long excerpts retain
ellipsis and the full accessible link label. Canonical row ownership prevents
legacy aliases from duplicating cards or totals.

The persistent viewing strip names the current source unit, count, result,
service, project, dates and collection, reusing the inline metadata and
applied-filter controls. Request pages label the expansion explicitly: their
full results cover all retained layers, dates and collections, while the matching
summary covers only the originating slice. Opening a request never silently
adds a chat filter. Returning preserves pagination and private search;
history entries retain search locally without putting it into URLs.

`buildRequestActivity` supplies canonical attribution for all request details in
the same snapshot as the filtered chart. No per-card reads or raw success-flag
fallbacks are used. `createRecordedResults` owns the shared display vocabulary
and validates complete counts. Tool results, returned API units, request sites,
visible-status subsets, owned HTTP and code references remain separate.
Missing data displays an unavailable state; code references never claim execution.
Report selection rows show full eligible request outcomes separately from the
matching view, while the scope header names the revision that will be frozen at
preview. Existing report scope, privacy, prompt modes and format choices are unchanged.

**Request details** starts with compact source/chat context and the actual prompt
and response reading sections. Insights follow the source content. A named
**Recorded actions** section groups the existing results, exact tool/path and
retained failure detail with their chronological action history. A missing reason says
**Failure details were not recorded.** Returned API errors retain their own
attribution; they are not invented root causes for a parent tool failure.
Matching/full counts appear separately only when the selected layer's scopes
differ; tool/API/Graph/HTTP units are never summed. A single action does not
repeat its result badge in three adjacent blocks. Mixed actions retain their
own outcomes and matching-context labels.

The chat name, project and request time appear once in the body. The breadcrumb
keeps its native chat destination and exact accessible name without repeating
the long name visually. **Originating view and filters** holds return-scope
metadata and the Collection status link. The existing contextual Back/Reset/
Clear strip remains authoritative; no second Back or Review action is added.
Real blocking notices and unsaved Settings drafts remain visible and protected.
The focused matching-action list does not add another chat title/project,
source toggle or one-chat pager under the existing analysis header. A distinct
matching summary remains when it differs from the source's pre-result totals.

There is one **Your prompt**, **Agent prompt**, or neutral source-appropriate reader beside the recorded source context, before
interaction insights and chronological actions, never another excerpt on the detail
page. Its single header aligns explicit **Read prompt**/**Hide prompt** and
**Copy prompt** controls; response readers use the equivalent response labels.
Text up to 1,200 UTF-16 code units opens initially; longer
text starts closed. Explicit per-request choices override this initial default.
The complete recorded message uses the reading-text role at a maximum 72ch measure,
natural wrapping and document scrolling, without a nested frame or height cap.
It is source evidence, not an editable report copy. Supported explicit sources,
host-added input/sender envelopes and qualified creator kickoffs determine the author label.
One quiet **Author unverified** state is reserved for missing, unsupported or conflicting evidence.
Its adjacent keyboard/touch help explains the retained basis and that this is not
an account sign-in failure. Explicit `source: system` stays in the neutral author
cohort and is explained as system-supplied context, not guessed to be an Agent prompt.
Source role, writing style, raw typed tags and old `human-authored` strings alone do not determine authorship.
The shared authorship helper owns labels, origin kinds and actor identity; the
separate author-cue stylesheet owns their restrained color cues.
**About this prompt & copying** contains human-readable author and
clipboard explanations. **Technical source record** has a different purpose:
exact timestamps, source identifiers, normalized basis codes and association facts.
A concise **Copies original text, unmasked** notice is associated with Copy
before activation. Copy writes only the complete exact retained body, not the
excerpt, metadata, notices, response or page. Short/multiline,
partial and source-truncated values remain exact; unavailable/blank originals
have no copy button. Missing bytes are never reconstructed. Technical arguments
keep their separate preformatted, keyboard-scrollable viewer.

Reading and reporting are separate contexts: after the action history,
**Report selection** shows this request's explicit selected state and one outlined
**Add to report**/**Remove from report** action. **Review selection** appears with
the overall selection count in the page header, only when membership is nonempty;
Reports remains available in navigation when empty. Neither reading nor opening
Reports adds a request, scans text or exports. Adding/removing restores focus to
the same action without resetting reader intent.

Activity, matching actions and report lists show **Prompt** as an ordinary
body-size paragraph, bounded to 68ch and at most 170 graphemes. Excerpts end at a
word boundary when available; unbroken URLs and Unicode retain whole graphemes.
There is no second CSS ellipsis or paragraph-sized link. The adjacent native
**View interaction** link navigates; **Read full prompt** expands in place.
A shortened preview explicitly says **Preview / full retained prompt available**;
this is presentation shortening, not missing source text. A partial source instead
uses **Read retained prompt**, identifies a retained fragment, and keeps its missing-text
notice visible in both compact and complete readers. Both actions use
the shared compact outlined action face, including a visible resting keyline
in light and navy, while keeping native 44px targets and keyboard focus. Their
matching control line-height keeps the two actions aligned; neither paints
the outer target or regains an underline.
Unavailable sources say **Prompt not available**; partial sources remain explicit. Recorded messages can come
from a coordinator or an unverified origin, not necessarily a human question.
No reading requires clipboard/export. Copy uses exact source text,
preserving whitespace, Unicode and line breaks. Reader open state, focus,
scroll and same-text selection survive snapshots and Back; selection offsets
never transfer to a different or changed retained value. Disclosure state is
panel memory only, not another private-text persistence surface.

Actions are ordered by recorded start time, with missing times last and no
invented timing. Lists remain six records per page. Arguments, responses,
provenance and inferred follow-ups remain discoverable after the actions.
Nearby follow-ups and Work IQ/Graph sequences are associations, not causal
explanations or evidence of task correctness.

Text-access audit boundaries:

| Display family | Full-value contract |
| --- | --- |
| Home summaries, chart labels | Wrapping labels and expandable exact data; chart geometry/scroll lanes stay owned by chart components. |
| Activity/chat/request/report membership | Labeled bounded previews, exact in-place reader and native detail navigation; chat/project names wrap. |
| Request details, result paths/errors | One unabridged source reader, wrapping paths/errors and explicit unavailable fields; no string-sliced primary context. |
| Raw arguments and report comparison text | Exact copy source; preformatted technical code may scroll, prose wraps. Report membership stays paged and its named reading region remains scrollable. |
| Settings source read/edit | Exact selectable read values wrap fully; native single-line editors preserve horizontal caret access. |
| Display/custom selects | Compact selected labels may ellipsize only with full-value keyboard/focus/hover help and complete popup options; no truncated option data. |
| Collection status/help | Long names/reasons wrap; raw diagnostics and supporting facts expand. Tool failures remain distinct from source-history gaps. |

`request-investigation.browser.test.mjs` verifies the actual Needs attention ->
matching action -> request journey, exact retained string equality separately
from every non-whitespace grapheme's rendered bounds, both themes, 375/820/
1200/2560 widths and a 420px detail inside a wide host at 100/200% root text.
It covers hidden-before-enlargement, source gaps, mixed/empty/paged records,
missing reasons, polling/stale reads and selection identity. Existing
text-access, result, navigation, report/privacy and Settings/chart-owner tests
retain their independent contracts.

**Reports** starts with an empty Selected requests scope, unless this panel
already has a deliberate selection or scope choice. All collected activity,
Current view and Selected requests each show their canonical request count.
From chat analysis, **Create report for this chat** atomically replaces
draft IDs with only that source chat's canonical eligible request owners,
across every page and alias. It explicitly includes full retained dates/services,
not the current failure/date slice. Those IDs remain fixed as new requests arrive.
The source chat/project context stays visible before review.

Four numbered stages make the remaining task explicit: **Requests**, **Contents**,
**Review**, **Save**. Requests shows membership and keeps broader All/Current scopes
under a disclosure. Contents holds all three prompt modes and four formats, with
one **Scan and preview** action. Review presents the formatted document inline,
then optional exact-copy comparisons; no modal hides the sidebar. Explicit
unchecked attestation and disclosure review lead to Save, where the separate
final confirmation writes files and successful completion shows download links.
The adjacent **One report · N requests included** summary distinguishes membership
from saved report history. Zero says **No requests selected** and explains the
next collection/selection action. All is a deliberate opt-in, usable without
progressing dozens of cards through review states. It means available eligible
collected evidence, including identifiable preserved records, not a new chat
scan or inferred hidden calls. Current includes all matching pages and private
search. The report carries complete eligible evidence for matching requests, not
only the individual chart actions. Work IQ/API/Graph/code-reference counts remain
separate, known aliases count once, and scope exclusions are explicit.

Clear selection is beside the Reports membership summary throughout the stages,
including while preparing, and in the shared Home/Activity/request
selection strip. It clears every page's explicit IDs, switches All/Current to
empty Selected, invalidates pending async previews and attestation, and discards
per-copy edits and chat-entry context. It does not delete evidence, reclassify requests, delete saved
reports, reset filters/theme, scan or export. Prompt mode, formats and additional
masking terms survive clearing. Clearing cannot interrupt a confirmed write.
Draft state is memory-only: navigation and Back/Forward retain it; reload or a
new panel starts empty with default report options. A late snapshot cannot
restore cleared IDs. Reset to Home remains an independent analytical intention.

Activity keeps compact report-selection feedback in the same layout for zero
and nonzero membership. Its existing context/actions show an `N in report`
count and scope; Clear selection is disabled, rather than removed, when empty.
The full inclusion sentence remains the accessible live status. Each chat has
a persistent compact count whose description explains retained-chat scope and
complete eligible request groups, not just visible matching calls. Only the
count changes during checkbox selection. Tabular numeric space follows the
maximum possible count; there are no fixed row heights or scroll corrections.
Selecting or unselecting a request therefore leaves its row, surrounding chat
context and window scroll unchanged, including an already-expanded prompt.

Review labels are independent user classifications. Optional changes remain in
an expandable request list; no selection, preview, cancellation, download or
completed export changes those labels. Scope, review and source revisions are
checked again at the privacy boundary. Export history is appended separately;
older reports are never overwritten. The preview is a readable
document with a prominent **No prompts / Masked prompts / Original prompts**
choice before preview. Masked is the default and means a redacted copy of
retained wording, never a generated summary. Original inclusion is a deliberate
local-file disclosure, not permission to share elsewhere. Credentials recognized
by the local scanner are removed even in Original mode and clearly labeled.

The review shows exact local originals beside highlighted report copies, with
category counts, incomplete-source labels and per-prompt editing/omission.
No-prompts originals sit behind a separate local disclosure. Additional names or
phrases can be masked across copies; personal settings and consent are not
persisted. Unlabelled names and confidential meaning still require human review.

HTML, PDF, JSON and Markdown can be selected together. The formatted print-style
preview represents their common frozen snapshot; exact text files remain
inspectable separately. PDF is rendered locally before review and never
substituted with HTML on error. Checking the disclosure box alone cannot export.
Recording disclosure review and confirming the named mode/formats are separate
actions. Editing a copy or changing any export choice requires rebuilding and
reviewing again. The final commit writes every selected format before appending
an export-history entry; source records and their classifications remain unchanged.

Saved-report reading starts with a short **At a glance**, not the disclosure
manifest. Separate-unit counts, recorded outcomes, services and missing-status
coverage lead; bounded request-to-action examples precede exact operation tables.
HTML links to full prompt copies in native disclosures, while PDF expands those
same copies and numbers pages. Full wording is never silently clipped. Markdown
uses linked sections and inert prompt blocks, and JSON puts the shared summary
before complete record detail. Scope/privacy explanations remain accessible in
the coverage appendix. Known empty retained strings are labeled unavailable with
their source-status discrepancy, never reconstructed or repaired in source.

## Typography and text actions

Typography uses local Segoe UI Variable Text/Segoe UI/system UI for prose and
Cascadia Mono/Consolas/platform monospace for technical values. Sizes, weights and
leading live in tokens; numbers use tabular figures and code ligatures are
disabled. The **WIRE** Home link uses the approved vector wordmark above its
visible acronym expansion. The subtitle uses semibold foreground ink and the
shared Asta Sans family across both themes and every view, with a measured
single-line viewport fit rather than a multi-line fallback.

Literal API paths share `code.api-path` in `web/ux-styles.mjs`: the existing
monospace stack, small type, regular weight, 1.6 leading, and a quiet canvas
surface with 4px/8px inset. Recorded results, matching actions, action timelines
and structured returned-path fields use this same role. Full strings remain
selectable, escaped as text and wrapping without normalization or truncation.
The API-path filter context uses the same type role for its existing analytical
path label; this does not turn a normalized category into literal source evidence.
Tool titles, prose and captions retain their own hierarchy; Settings filesystem
paths stay regular system text. Raw code/log blocks remain verbatim. Portable
report templates retain their print-specific type scale; frozen reports are
not restyled by live interface changes.

Action headers center the exact tool title and service identity in one wrapping
flex row with a 16px group gap. Service glyph and label share one centered cue;
its adjacent help is a separate 44px target with a 16px Fluent info glyph, not a
nested metadata line box or an offset icon. Header groups wrap naturally while
timestamps and Technical details remain owned by the same timeline record.

Technical Copy controls retain their bundled MIT Fluent icon, contextual
accessible label and keyboard/hover tooltip. Prompt/response readers opt into
visible **Copy prompt**/**Copy response** labels and visible pending/success
feedback. Success is shown only after the write resolves; permission denial,
unavailable APIs and other write failures remain explicit errors. A late result
cannot reopen hidden text. Copy reads only the
explicit authorized-text getter, never the clipboard or hidden source backing
data. Exact code retains whitespace/Unicode and scrolls within its block; prompt
prose wraps in the UI font. Checkmark feedback and visible live errors distinguish
success from denied or unavailable clipboard access.

One dismissible, hoverable tooltip uses the popover top layer, including dialogs,
preserving focus and existing descriptions. Activating an ordinary enabled action
or navigation link dismisses its tooltip before the action runs and cancels pending
hover help. Escape does the same without activating anything. Retained focus,
stationary pointers, polling, replaced controls and restored views do not reopen it:
a new pointer visit or deliberate keyboard-focus visit is required. Browser reload
starts without an open tooltip; no tooltip preference or open state is saved.
Rendering uses `ux.restoreFocus` for restored focus, distinct from a new focus visit.
Pointer departure removes the portal and its description association after one
120ms transit grace outside both trigger and tooltip. This lets a pointer cross
the 8px gap into readable help; movement outside, polling and description updates
do not restart that deadline. Trigger descendants and reentry during transit do
not flicker. Pointer-induced or restored focus does not keep hover help open;
a genuine keyboard focus visit can, until Escape, blur or activation. Focus itself,
its outline and tab order are never removed to dismiss help.
Dismissal removes the tooltip description reference and portal text, not focus or
the control's other descriptions. Disabled action wrappers expose
actionable guidance on keyboard focus. Essential privacy instructions and
limitations remain visible without hovering.

Explanatory help uses a small locally bundled Fluent info button. Hover, keyboard
focus or a tap reveals its text; Escape or an outside tap dismisses it. Category
help is a sibling of the chart action, never a nested button, and does not change
the selected slice. Dynamic chart-value tooltips remain separate from definitions.
Info buttons and non-action chart legends intentionally reveal help when activated;
they are not action buttons that immediately dismiss their own only explanation.
Legend/slice activation explicitly owns that help (including touch), rather than
depending on incidental mouse focus. Ordinary legend hover uses the same departure
deadline as other controls. Native-disabled explanations remain focusable.
Select option descriptions, status/error messages and expanded disclosures remain
ordinary content and are not closed or erased by tooltip dismissal.
Select synchronization preserves a visible tooltip's description alongside the
field's own descriptions; closing help removes only the tooltip reference.
Filters, result labels, report choices and ambiguous technical fields use the same
helper. Copy and appearance icons remain their own affordances, without extra
info icons.

All app-authored icons use the locally bundled MIT `@fluentui/svg-icons` Regular
family. `web/ux-icons.mjs` owns asset loading and semantic action keys;
`web/dimensional-icons.mjs` reuses it. Action/service glyphs are 20px; Info and
select chevrons use their native 16px assets. Official paths, viewBox and
currentColor are preserved; selected states use tokens, ARIA and a checkmark,
not a switch to Filled icons. Decorative SVGs are aria-hidden and not focusable;
icon-only actions retain contextual names and shared tooltips. Help/copy targets
are 40px on desktop and 44px on narrow/coarse-pointer screens. Inline metadata
alone uses bounded 24px fine-pointer or 32px coarse-pointer help targets around
the same 16px Fluent glyph. Labels and symbols align on the same text line;
separators belong to the following item, and a wrapping label keeps its final
grapheme with its help control. Copy and chart help targets are unchanged.
Summary, checkbox and radio affordances and quantitative chart geometry remain
native, not replaced by decorative icons.

`lib/service-categories.mjs` owns the classifier-bound service labels and concise
definitions. Home also offers an expandable service glossary for the current
slice. Unknown service attribution is explicitly not a failure; search may span
sources, and multiple services still represent one call. Report HTML, PDF and
Markdown include a readable glossary of only the categories present in their
selected evidence, while JSON carries the same structured static descriptions.
These are safe reading metadata, not source prose or extra metric counts; the
frozen snapshot, privacy review and hashes cover them with the rest of the report.

Result explanations and service terms pair a compact official Fluent glyph with
an accented label; descriptions remain neutral reading text. These are definition
terms, not pill-shaped controls. Icons align with the first text line and labels
wrap without losing their glyph. Intrinsic term/definition wrapping also handles
text enlarged before a native disclosure opens, without depending on a cached
container query. The existing two-column glossary, native
disclosures, readable type and independent info buttons remain unchanged.

`web/semantic-cue-styles.mjs` derives outcome accents from the chart factory's
single outcome mapping: teal/check for Worked, pink/warning for Needs attention,
slate/question for No result recorded, orange/warning for partial results,
slate/info for other results and pink/warning for connection failures. Request
result chips, actionable result links and chart legends use the same readable
label tokens, not the translucent chart-face fills. Missing results are neutral,
never a success or failure and never evidence of task correctness or Graph HTTP.

Service cues use `createDimensionalCharts().tone` and `dimensionalIcons`: Mail and
Tasks orange; Calendar, People and Search cyan; Files and Directory teal; Teams
and Notes pink. Multiple workloads (grid), Platform metadata (code), Unknown
(question) and grouped Other (apps list) deliberately use slate. These stable
category colors identify services, not outcomes; icon shapes and exact labels
disambiguate repeated colors and grayscale. Newly generated HTML/PDF glossaries
reuse the same label tokens and icons; print uses dark ink and retains all glyphs
and wording without depending on background color. Forced colors uses system
text/link colors. JSON descriptions, Markdown, classifier assignments, counts,
original source prose and immutable saved report bytes are unchanged.

## Interaction contract

All seven single-select controls use one local combobox/listbox implementation.
The original select values remain authoritative, and one committed choice emits
one change. A 44px hit area surrounds the 36px painted control; the actual
top-layer popup has 12px corners and scrolls within 320px. Arrow keys, typeahead,
Home/End, Enter/Space, Escape and Tab preserve ordinary choice semantics. Outside
click dismisses without activating the covered page. Associated labels stay
outside buttons, options cannot commit after replacement, and viewport changes
reposition or dismiss the popup. Long selected labels expose their full text.

`lib/control-help.mjs` owns decision guidance and reuses service definitions
rather than duplicating them. Option descriptions are visible before selection,
including all six evidence layers; there is no hidden second-tap requirement.
Report scopes explain complete-request inclusion before selection. Existing
prompt-mode and format descriptions remain visible, while action help explains
snapshot reload versus source collection, diagnostic recording, independent review labels and
downloads of already frozen reports. Clipboard and follow-up limitations remain
visible beside the relevant private text; they are not disclosure approvals.

Home, Activity and Reports are stable top-level destinations. Hash routes encode
the current filters and selected request/chat. Breadcrumbs and browser
Back/Forward preserve the route; navigating away closes an open modal and
invalidates its preview.

The persistent left sidebar uses one native navigation landmark with two static
groups: **Explore** (Home, Activity, Reports) and **Manage** (Collection status,
Settings). Quiet 14/20 regular rows have 44px minimum targets, 8px/10px padding,
a 24px icon track, 10px label gap and 6px corners. Group captions and a hairline separate tasks
from management. There is no resting row border or outlined selected button;
tonal selection, the filled Fluent glyph and `aria-current` identify the page.
Visible keyboard focus rings remain distinct and do not move neighboring rows.

All five full labels and group captions stay on one line, including at 200% root
text. The rail sizes intrinsically above its 208px desktop/176px intermediate
minimum; the existing resize observer matches the main offset to its measured
width. No font shrinking, clipping or ellipsis. Below 700px the same navigation
nodes move into a drawer with 12px inline insets and up to 304px usable width;
Menu, Escape, Close and outside-click focus return retain their semantics.
The wordmark remains a Home link, separate from the collapse control. No new
destinations or Settings layout changes.

A native 44px panel control at the top of the desktop rail exposes **Collapse
navigation** / **Expand navigation** and `aria-expanded`. Collapse retains all five
native anchors, their accessible names, tonal selection and filled current glyph;
only labels and group captions become visually hidden. The desktop rail becomes
69px (65px at the intermediate breakpoint) through its intrinsic content and
padding, not a second main-offset system. The same resize observer publishes
`--app-sidebar-width`; main, filters and existing chart observers consume the real
released area. A deliberate desktop toggle glides for 320ms with a decelerating
cubic-bezier curve. The rail animates between its measured intrinsic widths;
the same observer publishes each fractional width so content and charts move
with it, without an independent offset animation or a final pixel snap.
Labels fade out promptly and fade back in after expansion starts, while group
caption space closes smoothly. Icons stay on one fixed track; text is neither
scaled nor wrapped. Rapid toggles start from the current rendered width and
opacity rather than jumping back to an endpoint. Resizing, entering the drawer,
backgrounding the page or enabling reduced motion cancels transient geometry
and settles to the current choice. Initial loads, cross-panel preference updates
and reduced-motion toggles apply the final layout immediately.

The control and compact icons use the shared tooltip portal, contrast surface
and right-side placement where it fits. Pointer departure, Escape, activation,
restored focus and no-resurrection rules remain shared. Keyboard focus stays
outlined. Touch activates the same native controls, and Expand makes all labels
visible without requiring hover. No extra icon-only mobile rail is introduced.
The original nodes still move into the native drawer below 700px. Crossing that
breakpoint preserves the desktop choice and moves focus off a newly hidden rail
to Menu; closing the drawer restores Menu without reopening help.

`workiq-evidence.navigation` stores only `expanded` / `collapsed` in browser
local storage, applied before paint like the theme preference. A known storage
failure warns explicitly and shows a panel-only notice; the next explicit choice
can retry. Collapse does not navigate, fetch evidence, rerender the workspace,
alter selection, rebuild a report preview or reset a Settings draft. Other
same-origin panels can synchronize this non-sensitive display choice without
taking focus from a form. The isolated tests in
`navigation-collapse.browser.test.mjs` cover real shell width, keyboard/pointer/
touch, history/drafts, comparison layout, reading dialogs, mobile focus, themes,
200% text, empty/populated views and storage recovery. Frame-by-frame browser
measurements additionally prove intermediate widths, synchronized main/chart
reflow, label opacity, reversal continuity and no completion jump.

There is no global **Export report** action in the rail/header/mobile shell.
Open **Reports** (mobile: **Menu > Reports**) for its existing Requests, Contents,
Review and Save flow. Contextual **Add to report**, **Review selection** and
chat-specific report creation remain. Navigation preserves deliberate empty
selection, current draft, filters, privacy gates and saved/downloaded artifacts.

**Reset to Home** sits beside the analytical filters on Home/Activity, or the
current scope on request/report pages, whenever the route differs from Home
defaults. It returns to all retained dates and the weekly Work IQ chart,
clearing primary/secondary filters, chart choice, time scale, chat/request/path
scope, outer pagination and private search. It creates a
history entry, so Back restores the prior slice and Forward returns to Home.
Private search travels in browser history state, never a copied route URL.
Theme, report prompt/format choices, report selection, review state, consent
and recorded/exported data are not reset. The resulting view conveys a successful
reset without a routine success banner; pending work, errors and uncertain
recovery remain explicit. Inner disclosure and pager memory stays intact.
Refresh stored data still reads the existing intent, and
browser reload retains its existing URL/preference and unsaved-draft contract.
Empty views point to this same control rather than adding competing resets.

Manual stored-data refresh is disabled while a report scan/review or prepared
snapshot remains open, during a write, or while Settings edits are pending.
Back to Contents alone keeps the prepared snapshot; changing report choices uses
existing invalidation, and completing the report releases the guard. A small
state notification from report presentation synchronizes only the native control
and its concise explanation. It never loads data, cancels a preview, navigates or
changes approval. Background collection/polling keeps its existing review and
editing deferral; contextual Retry/Try again use the same manual-read guard.

Time-chart grid cells are layout only. One native button owns the visible
stacked column and all its segments; empty plot space cannot filter or light up
as a selection slab. Hover accent and keyboard focus stay column-bounded,
with the shared anchored, dismissible tooltip. Zero buckets have a focusable
baseline marker, not a hidden full-cell button. The exact-data table provides
ordinary-sized date actions for short or densely spaced nonzero columns;
zero counts remain readable without suggesting requests exist.
Scrolling a column into view does not cancel its pending hover tooltip; only an
already open tooltip is repositioned or dismissed when its anchor disappears.

Time defaults to the viewer's detected IANA zone, formatted with their locale.
One quiet, top-right header link names the applied display zone in human-readable
form, with the exact IANA identity and per-instant offset explanation available
on focus/hover. It opens the Time zone category using normal link semantics.
Home, Activity, chart tooltips and exact tables inherit this single global context;
offset-bearing exact timestamps and independently portable reports keep their own.
The header wraps rather than truncates at narrow widths and enlarged text; its
measured height keeps the sidebar and scroll targets below it.

Settings offers a browser-local Time zone override using the existing
typeahead select. Device default removes it. Named choices are canonicalized by
the shared time helper, never inferred from an abbreviation or today's offset.
The category and single **Time zone** heading use the same plain name; a Fluent
globe-and-clock icon represents time zones rather than general display settings.
The heading also names the select accessibly. Existing `section=display` links
remain compatible. Time zone and Collection selects size to their value, bounded by the pane and
36rem; long values retain the shared full-value focus/hover tooltip and readable
popup choices. Font size and 44px minimum targets are unchanged; the pill grows
vertically with enlarged text. One short impact sentence
and one effective-zone statement replace repeated instructions and zone values.
**About this time zone** sits inside the setting row without a separate section
divider. It holds typeahead/reset guidance, browser scope and the exact device
zone when an override is selected; warnings and unapplied-state
messages remain visible. Collection fields form one vertical sequence, with
each label, control and helper before the next setting. Category navigation
remains beside one active pane; path inputs retain their separate full-width layout.
Only explicit changes write `workiq-evidence.time-zone` in local storage; open
panels at this origin synchronize, but other profiles/devices do not. Invalid
saved choices visibly fall back to Device default without rewriting storage.
Unavailable listing/storage capabilities have explicit notices and a constrained
valid list or panel-only lifetime. Display changes never configure collection.

Home period labels, bucket axes/tooltips, Activity and request times, and report
preparation all agree. Named-zone historical rules control daily, Monday-weekly
and monthly buckets. Date inputs represent civil dates; an inclusive ending day
ends at the next local midnight exclusively. Last 7/30 days include today and
the preceding local days. Drilldown clips to the existing slice, never expanding
a partially visible week/month. Entered From/To values remain calendar dates
in the selected zone. Applied snapshot and header update atomically; a pending
or failed read cannot relabel old buckets. Focus/load/live-tick revalidation detects
device-zone or locale changes and invalidates an outstanding report review. A saved
report freezes its zone, locale and date selection in every format; later viewers
cannot reinterpret it. Source timestamps/raw text and prior bundles stay intact,
and report privacy exclusions still withhold source-event timestamps.

Losing visibility must not leave the page permanently inert. Returning,
reconnecting or restoring a cached page revalidates a consistent snapshot.
Late reads cannot overwrite a newer slice. Read-only exploration remains
available while mutations require a current snapshot. An uncertain write is
never automatically replayed.

## Evidence language

The Work IQ result label "Worked" describes a recorded tool completion, not
verified task correctness; its explanation sits beside the chart. Unknown
service attribution and missing results remain explicit.

Expanded Home headings use 18px semibold type, prose and definitions use
16px/1.6, and facts, captions and exact table cells use 14px. Primary explanation
text uses the foreground token in both themes; secondary labels retain AA
contrast. Long prose is bounded to 65ch. Result definitions share columns when
space allows. The service glossary uses aligned term/definition pairs in two
columns on wider screens and one readable column on phones, without nested
cards or repetitive attribution on every row.

Exact chart tables separate Total, Worked, Needs attention and No result for
tools, adding other outcomes only when present. API/HTTP layers name their actual
status categories; code references show a total only because execution results
are not meaningful for that unit. Headers and values are right-aligned with
tabular figures. Dates identify bucket starts in the effective display time zone;
the footer sums plotted rows and undated records remain explicit. Native row
buttons retain the original slice-clipped drilldown. Only the table's
keyboard-focusable region can scroll horizontally.

About this evidence uses short explanations of recorded tool results and request
groups, followed by counts of matching records. All paragraphs share an adaptive
80ch measure and 16px reading type, without fixed line counts or clipping.
Incomplete coverage remains visible outside the disclosure. Collection status
is the explicit destination for history gaps, scope and scan details; its
existing Technical details holds the original paged scan notes, not another
nested disclosure. Selected dates, dated-record bounds, approved collection
window, snapshot window and last coverage check have separate meanings and
labels. Times use the applied display context, including while a new zone is
pending. Collection-wide source scans and currently eligible sources are
separate counts, never a completion fraction: retained scans can include sources
that are no longer eligible. Metadata-only chats do not enter evidence counts.
Shared shortened service definitions also flow into newly prepared reports;
frozen earlier exports never change.

Work IQ calls, returned API results, recorded Graph request sites, output-visible
statuses, owned HTTP captures and code references have distinct units. Code is
not execution evidence. Public Graph metadata is diagnostic, not ordinary
Office work. An empty direct-Graph view does not imply no Office activity
occurred through Work IQ.

## Chart label alignment

Each painted front face, numeric value, 24px Fluent service icon box and centered
label shares one centerline. Decorative side facets do not move the measured
center, and capless buttons exclude invisible facet space. Service captions are
bounded to 184px, with symmetric help slots and a shared final label baseline.
Value tooltips anchor above the count; category definitions remain beside their
separate info controls. Scrolling an anchor outside the chart dismisses its
tooltip instead of leaving a disconnected popup at the screen edge. Zero buckets
retain an explicit count and non-actionable baseline. Counts, front-face scale
and timezone bucketing are unchanged.

## Finish criteria

Check the real Home -> chart -> Activity -> chat/request -> Reports journey,
Back/Forward, exact original-text disclosure, chart/table parity and the
unchecked report gate. Check 375, 820 and 1200 CSS-pixel widths, keyboard focus,
light/dark readability, reduced motion, loading, empty/error states and delayed
responses. Browser regression tests cover the recovery handler and actual
runtime restart; they do not claim to reproduce every native Copilot hide/show
transition.
