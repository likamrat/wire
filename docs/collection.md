# Collection and private data

The released runtime reads approved local GitHub Copilot app metadata and
history. It does not rerun Work IQ/Graph requests, enumerate remote-only chats
through a provider API or initialize an evaluator. Microsoft source work is
[parked incubation](incubation/microsoft-native-host.md).

## Operations and permissions

| Operation | Effect |
| --- | --- |
| Review and approve a source | Validates the local metadata/history mapping and deliberately starts or switches the approved collector. |
| Save preferences | Changes the approved history window and check frequency; preserves Pause. |
| Pause collection | Stops automatic acquisition; retained activity stays readable. |
| Refresh | One bounded read of already-approved local history, including the deliberate GitHub manual exception under Pause. |
| Read stored activity | Reads WIRE's saved view/status, without checking original history. |
| Save Copilot replies locally | Separate permission for bounded, screened assistant text from the same approved source. |
| Review deletion | Previews an exact retained-activity scope; a separate confirmation deletes it. |
| Read history again | Separately previews and confirms rereading selected approved chats/dates, including an independent original-prompt restoration choice. |
| Sign out of WIRE | Stops collection and hides private retained content without deleting it or signing other apps out. |

View dates, Search, opening an interaction, report selection and report
disclosure do not grant collection or reply-saving permission. Model evaluation,
automatic scoring and personal ratings are retired; old approvals cannot
reactivate them.

## Store ownership

On Windows, private state defaults to `%LOCALAPPDATA%\WorkIQEvidence\data`.
`WORKIQ_EVIDENCE_DATA_DIR` can select another absolute location outside the
maintained source directory. The store is independent of a conversation or
checkout; a second checkout can select the same store. Only one runtime may
write it, even on a different port.

Content-addressed evidence snapshots are separate from atomic review/state
metadata. A process lock rejects a live writer; an unverified owner is not
permission to remove a lock. Existing private state, approvals, unresolved
receipts, pseudonym keys and frozen output must survive ordinary upgrades.
Copilot-only startup explicitly refuses incompatible protected Microsoft state
rather than stripping it, downgrading it or bypassing it with an empty store.

## Source mapping and bounded reads

The suggested source comes from `COPILOT_HOME`, otherwise the documented
`.copilot` home: `data.db` and `session-state`. WIRE checks those named paths,
not repositories, credentials or arbitrary home-directory contents. Approval
and schema validation precede history reads.

The current adapter checks the consumed ordinary `sessions`, `workspaces` and
`projects` mapping, required text/null values and sole `id` primary keys.
Inspected schema generations 156, 166 and 174 share that mapping. Generation
156 is the minimum; a later number alone neither grants nor denies
compatibility. Additive fields/indexes can remain compatible. Optional creator
fields qualify authorship only as a compatible pair with valid recorded
evidence. Unknown host/location/workspace values do not establish local scope.

Discovery pages contain 250 mappings, bounded to 10,000 chats and 20,000
workspaces. Reconciliation occurs every 30 seconds and on an approved manual
check. Only verified local mappings qualify. Ambiguous, archived, missing,
unmapped and nonlocal sources retain distinct dispositions; directory presence
alone is insufficient.

The initial reader starts within the last 64 MiB of each log, uses 4 MiB chunks
and accounts for at most 32 MiB of event bytes per cycle. The approved window
is 7, 30 or 90 days; older retained evidence is not pruned by changing it.
Live tails have priority, with bounded earlier-prefix continuation when
capacity remains. Every read/reread charges the same cycle budget.

Ordinary entries are bounded to 1 MiB. Complete tool-result lines fitting
4 MiB can supply a supported successful completion only with the exact original
start in that same read; omitted result bodies cannot supply inferred failures
or API outcomes. Partial UTF-8/JSONL tails wait for completion without storing
raw fragments. Unchanged tails need only file-stamp checks; changed sources
verify startup and cursor-boundary identity.

Correlation context has a 2,000-event/512 KiB general bound. One newly observed
pending original has a separate 1 MiB plus 2 KiB allowance within the event cap.
Gaps, malformed/oversize events and evictions remain explicit. Association
cannot cross a gap merely by choosing the nearest earlier text.

Evidence and consented replies commit before checkpoints/index/manual-check
receipts advance. Restart deduplicates canonical identities; late completions
can update unknown results without adding calls. Rotation or truncation does
not erase captured evidence. The index's schema-2 compatibility barrier
preserves the last committed progress and never silently downgrades.

## Evidence fidelity

Original text and timestamps are not silently replaced by later conflicting
deliveries. A new association needs unique explicit message/tool-request
linkage and compatible ownership, not adjacent prose or similar wording.
Host-transformed instructions are not retained as the original prompt.

An automatic continuation can have no new message. Keep that state separate
from a missing or excluded prompt, and keep author evidence independent from
event kind. Older unknown records do not become User by default.

Recorded tool errors are distinct from optional assistant replies. Supported
diagnostics preserve screened message/code/status/details with their original
call or returned-entry association. Credentials, sensitive/payload-shaped
text, stacks, headers and inner identifiers remain excluded. Diagnostic text
has an 8 KiB bound. The Work IQ envelope parser has separate bounded inspection
and may preserve only complete entries before malformed syntax, explicitly
partial with unknown supplied total. Installing an update does not restore
historically omitted errors.

Original response-model and final-response timing metadata require their
qualified source/message/response/turn links. Model names are not guessed
from tool hints, deployment names or the current account. Optional exact-target
metadata qualification is a separate bounded operation, not a click-triggered
backfill or permission to save response bodies.

## Optional replies

**Settings > Privacy & saved data > Recorded replies** has a draft switch and
separate confirmation. The supported category is already-recorded assistant
text: at most 64 KiB per item, 20 items and 256 KiB per interaction. Partial
capture and unverified finality remain explicit. Credentials are excluded;
entity response bodies, citation fetches and new source discovery are not added.

Reader and Search payload reads recheck current source, consent, membership,
basis and integrity. Opening a reader does not enable saving. Turning saving
off removes optional text and its dependent retained annotations through sealed
cleanup, not base activity or independently saved reports. Source/scope changes
require a new deliberate approval; browsing filters and ordinary collection
within that approved scope do not.

Response-saving recovery keeps its original operation and token. Recognized
legacy consent receipts retain their original storage owner; historical
personal-rating receipts are not cleared or replayed. Malformed, unreadable or
multiple unresolved receipt state blocks new changes rather than choosing a
convenient default.

## Deletion

**Review deletion** begins with blank custom dates or an explicit All choice.
Preview counts canonical calls, Graph records and HTTP diagnostics once,
disclosing retained-only copies separately. Filters, Reset and Clear selection
never delete. Confirmation is panel-bound, expires after two minutes and
revalidates revision, exact membership and supporting-file hashes.

Ranges include both civil dates in the applied IANA zone, including 23/25-hour
DST days. Calls use start time or their established group-capture fallback;
other layers do not borrow that clock. Unknown/invalid times stay for ranges;
All includes them. Spanning groups preserve surviving records and shared
prompts without changing their metadata.

The sealed plan covers active evidence, checkpoints/context, dependent reply
payloads/annotations, unsaved caches and known managed recovery/migration
copies. Source configuration, approval, cursors, roster and reading receipts
remain. Saved reports/comparisons and their managed copies, external downloads
and unmanaged original sources remain. This is logical/filesystem deletion,
not forensic erasure or an undoable backup operation.

Only hash-based suppression of the confirmed identities/events remains.
Polling, rotation, restart and later results cannot automatically reimport
them. Genuinely new calls remain collectible; previously unread history was
not part of the confirmed set.

A durable journal precedes cleanup. Interrupted cleanup blocks affected reads
and finishes only that exact hash-guarded plan after restart. Changed, linked,
unrecognized or ambiguously identified files/records refuse rather than guess.
**Check deletion result** reads the original receipt, not another confirmation.
Limits are 20,000 files, 2 GiB total, 16 MiB per file, 64 MiB unique records and
32 MiB compact metadata. Exceeding them refuses before mutation.

Saved-artifact deletion has its own [scope and recovery contract](report-contract.md#saved-artifact-deletion);
activity permission is not artifact mutation permission.

## Explicit recollection

**Read history again > Choose chats** searches/paginates eligible approved
local chats. Selection survives those pages. Inclusive dates intersect the
existing approved window; this is not new source or wider-history permission.
Preview distinguishes deleted, newly available, already-present and unavailable
records. It is bounded to 128 chats, 32 MiB per preview/confirmation, the last
64 MiB per file and 20,000 candidate records.

**Also restore original prompts for these requests** starts unchecked.
Without it, deleted prompt text stays unavailable. With it, only exact
source-qualified selected prompt/call associations can return. Host envelopes
alone do not promote an agent-created kickoff to User. Anonymous local records
and owned HTTP diagnostics cannot be recovered through this source reread.

Confirmation rechecks source stamps, mapping, approval, revision, expiry and
canonical membership. It atomically publishes evidence, narrowly scoped
hash-only restoration grants and its receipt. Shared event/context suppression
is not cleared broadly. Deleted optional replies and historical feedback do
not return. Saved reports, source files, cursors and settings stay unchanged.

An uncertain result uses **Check recollection result**, including after reload
or restart. It neither rescans nor repeats confirmation. Missing remembered
scope is stated, not reconstructed from receipt counts. Malformed/unreadable
recovery storage remains untouched and blocks new recollection. If the stored
view fails after commitment, read stored activity instead of recollecting again.

## Refresh and uncertain outcomes

A manual check's receipt and its applied stored revision are distinct.
No-change, late results, outside-view updates and incomplete history remain
separate. Previous accepted results survive an ordinary failed read; access
withdrawal instead clears private content.

GitHub checks do not have client-request correlation for a lost response.
A newer last-check timestamp cannot settle that operation. The tab's verified
pending sentinel survives reload; uncertain checks allow stored/status reads,
not another dispatch. Sentinel storage failure blocks checking explicitly.
This is tab-session protection, not runtime-wide cross-tab correlation.

Settings configuration uses its last-read version and rejects stale writes.
**Read current connection** reconciles saved settings without claiming a lost
write's original receipt. Unsent safe preferences can survive withdrawal;
private source-path drafts cannot. See [runtime access](runtime-access.md).

## Migration and guarded maintenance

Migration is an explicit offline operation, not normal startup:

```powershell
npm run migrate -- --source C:\Private\old-data --imports C:\Private\approved-import --session-root C:\Private\session-state --app-db C:\Private\app.db
```

These are placeholders for separately approved paths. Stop writes first.
The importer needs the approved inventory/window files, refuses an existing
destination, creates a hashed write-once backup, preserves pseudonym/export
bytes and writes no original source. Failure leaves its named staging/backup
for review, never a silent merge. Native-state stores are not admitted by the
legacy version-3 migration/maintenance path.

Historical repair is not Refresh. The scripts below share the existing
collector/activity/board custody and a reviewed, source-pinned pre/postimage
journal. They require explicit real-target authorization, a stopped/quiescent
runtime, exact current evidence/checkpoint/source guards and preserved report,
consent, cursor and unresolved-ledger state.

| Entry in `scripts` | Narrow policy |
| --- | --- |
| `maintain-historical-metadata.mjs` | Exactly two attested prompt/call metadata pairs; no source scan. |
| `maintain-failure-signal.mjs` | One unassessed eligible failure gaining only the qualified sign-in signal. |
| `maintain-failure-evidence.mjs` | One known oversized failed-fetch omission, using exact authorized original source regions. |
| `maintain-retrieve-diagnostic.mjs` | One small eligible failed-retrieve diagnostic, not a fetch or arbitrary editor. |
| `maintain-evicted-fetch-evidence.mjs` | Record-only fetch repair after real context eviction; intact checkpoint/index and prompt boundary, no inserted events. |
| `maintain-tail-retrieve-diagnostic.mjs` | Record-only retrieve inside a proved consumed tail with a visited, matching prefix fence. |
| `maintain-failure-cohort.mjs` | One to nine exact eligible failures, additive diagnostics only; existing returned identities/statuses must agree. |

Read each entry and `lib/historical-maintenance.mjs` for its closed plan and
CLI schema before preparing an operation. Preparation writes only the private
journal/review seal; apply requires that reviewed seal and identical source
manifest. Preserve all unchanged fields and checkpoint bounds. This is not an
all-files transaction: after uncertainty keep the runtime stopped, recover only
the same plan/source/journal, and accept only exact preimages or postimages.
Do not swap to an older reader, create a fresh operation to bypass drift,
invent a target or replay a consumed evaluator attempt. Restart and later
append preservation need separate real-store proof when an actual repair is
authorized. Documentation or synthetic success supplies no such authorization.
