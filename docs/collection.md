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

| Read boundary | Limit |
| --- | --- |
| Discovery | 250 mappings/page; at most 10,000 chats and 20,000 workspaces |
| Reconciliation | Every 30 seconds and on an approved manual check |
| Approved history window | 7, 30 or 90 days; changing it does not prune older retained evidence |
| Initial log region | Last 64 MiB, read in 4 MiB chunks |
| Per-cycle event budget | 32 MiB, shared by reads and rereads |
| Ordinary entry | 1 MiB |
| Correlation context | 2,000 events / 512 KiB; one newly observed pending original has a separate 1 MiB + 2 KiB allowance within the event cap |

Only verified local mappings qualify. Ambiguous, archived, missing, unmapped
and nonlocal sources keep distinct dispositions; a directory alone proves none.
Live tails take priority over bounded earlier-prefix continuation.

A complete tool-result line up to 4 MiB can supply a supported successful
completion only with its exact original start in the same read. Omitted
bodies cannot supply inferred failures or API outcomes.

The reader follows this order:

1. Check unchanged tails by file stamp. For changed sources, verify startup
   and cursor-boundary identity. Partial UTF-8/JSONL tails wait for completion
   without storing raw fragments.
2. Correlate only qualified events. Gaps, malformed/oversize events and
   evictions remain explicit; nearest earlier text cannot bridge a gap.
3. Commit evidence and consented replies before advancing checkpoints, index
   and manual-check receipts.

Restart deduplicates canonical identities. A late completion can update an
unknown result without adding a call; rotation/truncation cannot erase
retained evidence. The schema-2 index barrier preserves committed progress
and refuses silent downgrade.

## Evidence fidelity

| Fact | Preserve |
| --- | --- |
| Original prompt and timestamp | Never replace them with a conflicting later delivery or host-transformed instructions. New associations need unique explicit message/tool-request links and compatible ownership. |
| Automatic continuation | No new message is distinct from a missing/excluded prompt. Event kind does not establish author; old unknown records do not default to User. |
| Tool diagnostic | Screened message/code/status/details stay with their original call or returned entry, separately from optional assistant replies. |
| Model and final-response timing | Require qualified source/message/response/turn links. Tool hints, deployment names and the current account cannot fill missing provenance. |

Diagnostics exclude credentials, sensitive/payload-shaped text, stacks, headers
and inner identifiers. Text is bounded to 8 KiB. Envelope inspection may retain
complete entries before malformed syntax, marked partial with an unknown
supplied total. An update does not restore omitted historical errors.

Exact-target metadata qualification is a separate bounded operation, not
click-triggered backfill or permission to save response bodies.

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

Deletion has three stages:

1. **Review deletion** begins with blank custom dates or an explicit All choice.
   Preview counts canonical calls, Graph records and HTTP diagnostics once,
   with retained-only copies disclosed separately.
2. Confirm the exact scope. Confirmation is panel-bound, expires after two
   minutes and revalidates revision, membership and supporting-file hashes.
3. If interrupted, use **Check deletion result** for the original receipt.
   Cleanup finishes only the sealed, hash-guarded plan after restart.

Filters, Reset and Clear selection never delete.

Ranges include both civil dates in the applied IANA zone, including 23/25-hour
DST days. Calls use start time or their established group-capture fallback;
other layers do not borrow that clock. Unknown/invalid times stay for ranges;
All includes them. Spanning groups preserve surviving records and shared
prompts without changing their metadata.

| Scope | Treatment |
| --- | --- |
| Active evidence, checkpoints/context, dependent replies/annotations, unsaved caches, known managed recovery/migration copies | Included in the sealed plan |
| Source configuration, approval, cursors, roster and reading receipts | Preserved |
| Saved reports/comparisons and their managed copies, external downloads and original sources | Preserved; artifact deletion is separate |

This is logical/filesystem deletion, not forensic erasure or an undoable backup.

Only hash-based suppression of the confirmed identities/events remains.
Polling, rotation, restart and later results cannot automatically reimport
them. Genuinely new calls remain collectible; previously unread history was
not part of the confirmed set.

A durable journal precedes cleanup. An interruption blocks affected reads;
changed, linked, unrecognized or ambiguous files/records refuse rather than guess.

| Cleanup bound | Maximum |
| --- | --- |
| Files / total bytes | 20,000 / 2 GiB |
| One file | 16 MiB |
| Unique records / compact metadata | 64 MiB / 32 MiB |

Exceeding a bound refuses before mutation.

Saved-artifact deletion has its own [scope and recovery contract](report-contract.md#saved-artifact-deletion);
activity permission is not artifact mutation permission.

## Explicit recollection

1. Open **Read history again > Choose chats** and select eligible approved local
   chats. Selection survives paging. Inclusive dates intersect the approved
   window; they do not grant wider history or a new source.
2. Read the preview's deleted, newly available, already-present and unavailable
   counts. Bounds are 128 chats, 32 MiB per preview/confirmation, the last
   64 MiB per file and 20,000 candidate records.
3. Choose separately whether to **Also restore original prompts for these
   requests**. It starts unchecked; without it, deleted prompt text stays unavailable.
4. Confirm. If the result is uncertain, use **Check recollection result**,
   including after reload/restart, rather than confirming again.

Restored prompts need exact source-qualified selected prompt/call associations.
Host envelopes cannot promote an agent kickoff to User. Anonymous local records
and owned HTTP diagnostics cannot be recovered through this source reread.

Confirmation rechecks source stamps, mapping, approval, revision, expiry and
canonical membership. It atomically publishes evidence, narrowly scoped
hash-only restoration grants and its receipt. Shared event/context suppression
is not cleared broadly. Deleted optional replies and historical feedback do
not return. Saved reports, source files, cursors and settings stay unchanged.

The result check neither rescans nor repeats confirmation. Missing remembered
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

For an authorized repair:

1. Read the script and `lib/historical-maintenance.mjs` for the closed plan
   and CLI schema.
2. Prepare only the private journal/review seal.
3. Apply only with that reviewed seal and identical source manifest. Preserve
   unchanged fields and checkpoint bounds.
4. After uncertainty, keep the runtime stopped and recover only the same
   plan/source/journal, accepting exact preimages or postimages.

This is not an all-files transaction. Do not bypass drift with an older reader
or fresh operation, invent a target or replay a consumed evaluator attempt.
An authorized repair still needs separate real-store proof of restart and
later append preservation; documentation or synthetic success grants no operation.
