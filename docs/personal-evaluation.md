# Personal interaction evaluation

WIRE derives supported insights from retained, approved Work IQ and API activity.
Default collection does not replay requests or call an evaluator. Optional
personal feedback and separately approved model assessment are not a required
grading workflow.

## What the dimensions mean

- **Accuracy:** unsupported semantic correctness is unassessed. Optional personal
  verdicts and scoped model assessments have distinct origins; neither is
  labeled as an automatic local measurement.
- **Speed:** recorded tool start-to-completion durations and owned HTTP
  response/error durations have separate definitions. Concurrent calls are not
  added into task latency. A verified whole-interaction latency is unavailable
  when the source does not establish its start and final answer.
  New supported event streams also retain metadata-only final-response timing:
  recorded request timestamp to a root `final_answer` message with no tool
  requests and a matching completed turn, before the next recorded request.
  This is labeled **Time to recorded final response**, not task success or
  network latency. Response text and reasoning are not captured by this path.
  Older checkpoints without those markers remain unavailable; they are not
  silently rescanned or backfilled.
  An explicitly requested metadata qualification may target at most six exact
  retained request IDs at a current source revision. It uses already-enabled
  normal collection cycles, the current source/date window and byte limits.
  It never enables collection, rewinds primary cursors, retains response bodies
  or changes capture consent. The runtime-local request has an operation ID;
  status is read through collection status. After a restart or uncertain reply,
  inspect current timing facts rather than automatically repeating the request.
- **Trust:** answer trust and action trust are separate. A successful tool,
  HTTP 2xx, authorization header, or captured answer does not establish correctness,
  citation validity, or human authorization. Separately approved model action
  assessments check recorded intent alignment, not proof of authorization.

Current views and newly prepared reports use Accuracy, Speed and Trust; the original
Cost metric is retired, not zero. Historical validators still read its original
four-dimension facts. Saved artifacts are never rewritten. Evaluator allowance,
observed spending and unknown billing remain in score-processing controls.

Recorded execution outcomes and evidence-availability checks are diagnostics,
not substitutes for these quality dimensions. Every fact includes its definition,
version, origin, units, measurement basis, exact membership, coverage, and an
unavailable reason where applicable. Negative verdicts, insufficient evidence,
and evaluator errors remain distinguishable.
An unavailable check's specific reason survives interaction, overview, and
report aggregation when all included items share it. Mixed missing reasons use
the aggregate "no assessed items" state rather than claiming one common cause.
The three measure headings have keyboard/touch-accessible help. The same short
definitions appear in **Glossary** inside the existing insight-details dialog;
exact units, boundaries, and coverage remain under **Recorded measures and definitions**.
The Speed card separates **Tool calls** from **Request to final response**.
Each value keeps its median label and its own timed-call or timed-request
coverage; longer timing boundaries live in the existing Speed help and details.

An interaction can contain multiple calls, returned API entries, owned HTTP
records, recorded Graph sites, and code references. These are different units.
Recorded `user.message` origin is not assumed human; nearest-message association
is not proof of causality. Conflicting call/start aliases are excluded rather
than treated as verified membership.

## Optional response evidence

Additional assessment evidence starts **off**. An explicit, category-scoped
setup action can permit bounded, credential-screened, already-recorded answer
text from the same approved local source. Existing collection approval and
development approval do not grant this permission.

The initial supported extra category is answer text. Usage and explicit
authorization remain unavailable until a supported source schema exists.
There are no citation fetches, API replays, new source discovery, external judges,
or network destinations introduced by assessment capture.

Answer capture is limited to 64 KiB per item, 20 items per interaction, and
256 KiB per interaction. Truncation is explicit; a complete recorded message
is not necessarily a final answer. Credential-bearing text is excluded.
Newly captured full answers are not copied into collector checkpoints.
Private response reads serve retained payloads only and recheck current consent
and revision before returning text.

## Feedback and immutable reports

Personal feedback is optional and revisioned. It never edits original source
outcomes. Withdrawal restores the applicable automatic result. Unchanged personal
verdicts survive unrelated feedback writes; changed member/evidence dependencies
make them inapplicable until the user supplies a new verdict.

Report facts are frozen over exact selected membership. Counts are pooled, not
displayed percentages. Duration distributions use compatible raw samples, not
medians of medians. Model quality metrics count interactions: pass divided by pass
plus fail. Missing or insufficient results increase eligible/unassessed coverage,
not the pass denominator. Recorded execution diagnostics are not model assessments.
New report facts carry `metricProjectionVersion: 2` and omit Cost metrics; this does
not change the independent category, pattern, or measurement definitions. Legacy
facts without that marker remain valid and retain their original metric values.

Report facts omit raw answers, raw source identifiers, per-record source timestamps, prompts,
and deletion markers. Existing report prompt modes and disclosure review are
separate. Technical comparison keys use normalized operation structure, not
prompt similarity. Namespace compatibility must be established from trusted
saved-artifact provenance; equal arbitrary imported strings are insufficient.

Changing feedback or collection state does not rewrite saved report bytes.
Unavailable legacy facts are not reconstructed from today's histories.

## Deletion and recovery

Activity All/range deletion uses the source record's established date grain,
not assessment creation time. Partial groups retain unrelated source records.
Dependent captures, feedback histories, unsaved comparisons, and caches are
removed or invalidated. Separately saved reports and comparisons remain under
the activity-deletion policy.

Capture revocation removes optional payloads through the sealed cleanup
lifecycle. Capture-owned event suppression is separate from base activity
tombstones; removing an answer must not suppress a surviving call or existing
base fallback prose. Pending cleanup blocks dependent reads and writes.
Restart resumes only the sealed operation.

Explicit **Recollect from approved sources** is separate from polling and
deletion recovery. It can reread selected canonical base request records inside
the existing source/window approval. Deleted original prompts require a separate
unchecked-by-default choice, bound to the same preview and confirmation.
Hash-only prompt grants pair the original event with selected record identities;
shared event/context tombstones remain, and subsequent deletion revokes grants
for removed units. Optional response captures, suppressed capture events and
feedback are never reauthorized by recollection. Recomputed insights use the
resulting base evidence, not recovered verdicts or fabricated response evidence.
Saved report/comparison bytes remain immutable.

Individual saved-artifact deletion is a different operation: it removes the
selected managed bundle, its recognized copies, and index entry. It does not
delete source activity, other reports, or external downloads. Existing frozen
comparisons survive deletion of an input report; their historical source link
becomes unavailable. Unsaved dependent comparison previews become invalid.
Surviving artifact bytes are not rewritten.

Mutation identities are owner- and payload-bound. Uncertain responses use status
lookup, never automatic mutation replay. When personal receipt content is purged,
a non-content idempotency reservation remains so the old operation cannot recreate
its deleted verdict.

## Implementation seams

`assessment-contract.mjs` is the browser-safe shared validator module.
`assessment-read-model.mjs` owns cached canonical views and frozen report facts;
it does not parse original histories on detail clicks. `assessment.mjs` owns
validated reads, consent, feedback, and mutation receipts.
`assessment-capture.mjs` owns the already-recorded answer adapter.
`personal-evaluation.mjs` validates stored metadata and supplies the pure cleanup
selector. The deletion engine owns physical inventory, sealed cleanup, and recovery.
`recollection.mjs` coordinates the existing collector/board writer for explicit
source-backed previews and atomic evidence/authorization/receipt publication.
It reuses the collector's sanitizer, canonical merge and coverage calculation;
it does not reset cursors or create another polling/capture pipeline.

Authenticated assessment routes live under `/api/assessment/`. The shared
contract is served only at `/assets/assessment-contract.mjs`. The existing
same-origin/capability transport applies; only read operations may reconnect
automatically. New capture does not run as a startup migration.

## Scoped model evaluation backend (off by default)

`evaluation-controller.mjs` is connected to normal startup, shutdown and the
same-origin capability routes under `/api/evaluation/`: `setup`, `start`,
`status` and `revoke`. No provider client, SDK session, original-body read or
model call starts without an explicit source-bound grant for at most six
retained interactions and a positive call/credit budget. Local response saving
is a separate permission: its checkbox never authorizes submission or spending.
The normal product exposes **Automatic scores** as a separate compact row in
Collection preferences, with a contextual entry from Insights. There is no
mandatory per-interaction Evaluate action. A single approval names the chats,
source/window, evidence categories, model/rubric and cumulative allowance.
Nothing is preselected or pre-funded on first approval.

The observed Copilot runtime requires a **30 AI-credit minimum session limit**.
This is a runtime ceiling for a session's accounting window, not a minimum
charge and not WIRE's cumulative allowance. WIRE keeps the existing ceiling
`min(request allowance, cumulative remaining)` and never rounds it up.
New approvals need at least 30 unspent credits; a batch or automatic approval
pauses before another source read, reservation or SDK client when less remains.
For example, a 30-credit allowance with 0.1 observed evaluator credits spent
leaves 29.9 and cannot fund a second session. Only a separately confirmed
cumulative allowance change can permit later unattempted work; there is no
automatic top-up. Setup and the approval form disclose this minimum and do not
choose a budget for the user.

Older positive allowances, including 10-credit grants, remain readable without
rewriting their receipts or balances. Existing unknown billing, unresolved
attempts and cleanup retain their precedence over a low remaining balance.
The runtime floor was identified from a user-shared no-send setup failure; it
does not recover any earlier Calendar failure stage or prove zero charges.
The installed public SDK send contract provides no lower per-request AI-credit
ceiling. WIRE's one-assessment call allowance and timeout do not replace a
spending ceiling or guarantee that in-flight/post-paid charges stop at it.

The backend reserves each call durably before invoking the installed GitHub
Copilot SDK. The credit limit is soft and post-paid, not a guaranteed monetary
ceiling. Identified provider usage is accounted even if JSON parsing, result
validation or SDK cleanup fails. Partial billing preserves the known subtotal
and an unknown remainder; duplicate call IDs are not charged twice, and
conflicting amounts are not silently chosen. Unknown overhead is not zero and
stops further calls. An uncertain accounting write is not automatically repeated.
Evaluator overhead remains score-processing accounting, separate from quality metrics.
Receipts bind the owner, inputs and recovery token;
an uncertain or interrupted operation is read, not resubmitted.

Future failed-attempt receipts also retain a strict content-free diagnostic:
the observed adapter stage, a whitelisted error code, send-invocation/response
flags, failed cleanup stages, and an exact size kind/count/limit where available.
Calling `sendAndWait` establishes only invocation, not transport delivery;
without a response the effect remains unknown. Diagnostic facts never override
billing uncertainty. Provider prose, source text, paths, credentials and raw
packets are not copied into diagnostics. Existing receipts without these fields
remain unchanged; missing historical stages cannot be inferred retroactively.

The isolated SDK session has no tools, inherited instructions, skills, memory,
session-store integration or remote export. Temporary work uses private,
link-checked paths. Shutdown and revocation abort and drain affected owned work;
revocation is durable first, and success waits for cleanup outside the board
writer. Cleanup failure remains an error, and another evaluation cannot start
while owned work or cleanup is pending. Sealed activity
deletion waits for affected work cleanup before reporting success, and preserves
unrelated assessments during range deletion. Empty, source-purged grants do not
invent a revocation timestamp during preview; the sealed deletion journal dates
that action. Restart cleans known temporary work and marks interrupted
reservations uncertain without calling the provider. Cleanup failures are errors,
not successful stops. Saved report and comparison bytes remain unchanged.

Model-assessed results use evidence-anchored request requirements,
complete answer-segment coverage, and selected action-to-intent alignment.
Intent alignment is not proof of authorization. Provider request usage, when
explicitly linked, stays separate from evaluator overhead. Historical session
checkpoint totals are never divided among prompts. Available historical identifiers do not establish ownership of the locked cohort's
charged calls. Current views do not emit an original-interaction Cost slot.

The supported prospective integration point is the `CopilotSession` returned
by the existing extension's `joinSession()` call. Its typed `on()` handlers can
observe that original foreground session without creating another session or
sending a prompt. This is not an arbitrary-session or historical attachment API.
User-message logical IDs, response `originatingMessageId` and response/usage
`apiCallId` anchors are optional; actual delivery and complete attribution still
need a separately authorized, single-session metadata-only pilot. The observer
is not connected or enabled by score approval.

The source declares per-request original Copilot model usage in nano-AI units.
It is not total hosted Work IQ/Graph cost, currency or evaluator overhead.
Missing anchors, unjoined call classes and collection-lag losses must remain
explicit rather than turning a matched subtotal into full coverage.

`automatic-score-controller.mjs` owns this score-specific approval and its
durable, owner/input/token-bound receipts. Stop advances the approval generation
even when no grant is visible yet, so a delayed older approval cannot enable
scoring after Stop. An unresolved positive-approval receipt never blocks the
separate Stop path. Browser reload recovers receipts by status reads only.

The existing collector notifies the controller after a successful normal cycle,
outside its running marker and board writer. Observer errors do not turn an
already committed collection into a failed collection. No new worker, process,
timer service or source-wide enrollment is introduced. Paused collection is
never resumed by scoring; already admitted work uses the explicit Stop policy.

The metadata policy chooses one eligible interaction at a time. Its durable
attempt key binds the approval, exact interaction, material evidence and
final-answer/turn-end identities, and the scoring method. Global revisions,
allowance edits and restarts do not create another charge for completed work.
Author-only provenance and browse-filter metadata do not invalidate scores or
request another assessment.
An earlier uncertain interaction is not retried automatically under a fresh
approval either. New final evidence must agree with the original source before
submission and also invalidates stale stored scores.

All child attempts share one cumulative call/soft-credit allowance; the budget
is not reset per batch. Exhaustion, unknown billing or unresolved effects pause
new work. Off, Waiting, Assessing, Ready and Paused are shown in context. A
fixed historical approval can additionally bind at most six exact retained
interaction references. Out-of-window members remain explicit exclusions, not
replacement opportunities; this supports the locked real acceptance cohort.

Model dependencies exclude optional reply-saving observations because model
evidence has its own grant. Turning off local reply saving therefore cannot
authorize evaluation or erase independently approved model scores. Deleted or
pruned source evidence remains excluded; base recollection does not silently
reauthorize optional model processing.

`evaluation-fingerprint.mjs` and `model-evaluation-rubric.mjs` contain the shared
source identity and static rubric without pulling execution or persistence into
their import graph. Automatic setup/summary/status routes are read-only;
approval and Stop routes are never automatically replayed.

`copilot-installation.mjs` resolves the installed SDK and executable for both
the production adapter and metadata preflight. Defaults are the existing
`%LOCALAPPDATA%\Programs\GitHub Copilot\copilot-sdk\index.js` and
`%LOCALAPPDATA%\Microsoft\WinGet\Links\copilot.exe`. Explicit
`WORKIQ_EVIDENCE_COPILOT_SDK` / `WORKIQ_EVIDENCE_COPILOT_CLI` overrides must name
existing absolute files; empty, relative, missing or directory paths fail.
There is no PATH search, download, installation fallback or account/model switch.
The SDK requires a filesystem path, not a bare shell command. Resolution alone
does not start a client or establish that a real connection/session will work.

The structured-response schema declares the primitive type of every `const` and
`enum` leaf. The selected provider has reported a missing `type` at
`properties.schemaVersion` after accepting the SDK send RPC. Explicit integer
types for schema/rubric versions and string types for the rubric ID, segment kind,
verdict and reason preserve all finite values and local validation rules.
Reference-only nodes and property maps are not primitive schema leaves.
`node --test tests\evaluation-schema-types.test.mjs` reproduces that rejection at
the nonstarting SDK/provider fixture boundary and exercises the corrected schema
through the default installed evaluator. This proves the local correction, not
real provider acceptance or a newly measured real interaction.

Controlled-provider fixtures prove connected automatic processing, guards, explicit report
origin and cleanup only. They do not close the real numeric acceptance gate:
authorized real multi-scenario interactions must still reconcile through the
application and frozen reports/comparisons.

The default-adapter regression witness is
`node --test tests\copilot-installation.test.mjs`. It materializes only synthetic
SQLite/source events, runs normal collection and authenticated automatic-score
routes, and exercises the default installed-evaluator resolver, session options,
structured-response parser, usage accounting and rubric validation. Only the SDK
module/executable locations point to a nonstarting fixture; the source reader,
discovery and evaluator factory are not replaced. All three dimensions are
checked after persistence in overview, interaction detail and frozen new report
facts. It also proves that invalid answer coverage cannot publish a score, and
that a 90,217-byte structured reference remains excluded by the unchanged
65,536-byte item limit before reservation or SDK construction.

These are source-only controlled tests, not real Copilot session or model-output
evidence. A successful connection check does not prove session creation,
structured-output compatibility, or a real assessment. An unknown-billing
reservation cannot be retried to obtain a more convenient result. No test,
projection change or report version grants fresh source scope, model calls or
spending authority.
