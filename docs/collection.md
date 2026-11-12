# Collection and private data

WIRE reads approved local GitHub Copilot app metadata and history. This
reference explains collection permissions, read limits and saved-data operations.
For setup, see [Connect local history](user-guide.md#connect-local-history).

Collection does not rerun Work IQ requests or read remote-only chats through a
provider. Microsoft 365 Chat and Cowork are not supported sources.

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
| Sign out of this instance | Stops collection and hides private retained content across this instance's tabs, without deleting it or signing out of GitHub, Copilot or other independent WIRE instances. |

View dates, Search, opening an interaction, report selection and report
disclosure do not grant collection or reply-saving permission.

## Store ownership

The default data folder follows the environment running Node.js:

| Environment | Default data folder |
| --- | --- |
| Windows with `LOCALAPPDATA` set | `%LOCALAPPDATA%\WorkIQEvidence\data` |
| Linux, macOS or Linux Node in WSL, with `LOCALAPPDATA` unset | `~/.local/share/WorkIQEvidence/data` |

WIRE uses `LOCALAPPDATA` when set; otherwise it uses `.local/share` under the
current user's home directory. In WSL, that is the Linux user's home, not the
Windows profile. These are storage defaults, not a guarantee that Copilot
history is available in that environment; source paths still need review and approval.

Set `WORKIQ_EVIDENCE_DATA_DIR` to an absolute path outside the source directory
to choose another folder. A store has one writer, regardless of its port or
checkout. On the same host, a replacement checkout can use that store after
its current runtime has stopped.

Concurrent instances need distinct data directories and reachable ports.
They may each approve the same Copilot input, but cached activity, cursors,
settings, source approval, reply consent and saved reports are instance-owned.
An independent instance reads history using its own window and progress; it
does not borrow another instance's cursor or consent, or synchronize reports.
Windows and WSL can run together without moving the Windows store. For a
concrete launch example, see [platform setup](development.md#windows-wsl-and-linux).

Content-addressed evidence snapshots are separate from atomic state
metadata. A process lock rejects a live writer; an unverified owner is not
permission to remove a lock. Preserve approvals, unresolved receipts, pseudonym
keys and saved output when changing storage code. Incompatible stores must
fail explicitly, not be stripped, reset or bypassed with empty data.

## Source mapping and bounded reads

### Approved paths

The suggested source comes from `COPILOT_HOME`, otherwise `.copilot` in the
home directory of the user running WIRE: `data.db` and `session-state`.
In WSL, these defaults do not automatically locate a Windows user's source.
Choose the actual paths in source review; WSL can qualify Windows drive paths
or their mounted equivalents. WIRE checks those named paths, not arbitrary
home-directory contents. Approval and schema validation precede history reads.

### Account profile

Account presentation uses a separate, bounded profile-only read of that approved
database. For the supported account mapping (schema 207 or later), it follows
`app_state.activeWorkspaceId` to the workspace's linked GitHub account, then the
app's GitHub default or first GitHub account in creation order. A missing link
requiring repair or an ambiguous selection stays unavailable. Only bounded
selection and profile metadata, including `settings_json.avatarUrl`, leave the reader;
tokens and history are not read by this projection. WIRE fetches supported
GitHub-hosted images through its local image route, with an account-bound cache
and short-lived tickets. It rechecks the profile within 15 seconds while visible.
Successful same-profile reads renew the image ticket without replacing the image;
image requests alone do not renew it.
If unrelated metadata changes during a profile read, WIRE makes one fresh
read-only check of the selected profile. It accepts matching profile facts from
the same database, not an old cached identity; changed or unreadable results
remain unavailable. History collection keeps its whole-metadata change checks.
The display association neither grants access nor assigns ownership of history.

### Native metadata reads

Native metadata access uses the local read-only SQLite projection. For
Windows-owned live metadata, WSL runs that same projection through an existing
Windows Node 24+ executable (`node.exe`) using WSL interop. This bounded,
short-lived helper avoids opening Windows WAL shared memory from Linux. It
accepts only the approved database path, returns metadata and exits; it is
not a second WIRE server, daemon or database copy.

The source reader preserves these checks:

- The helper's version covers the actual SQL read. WSL checks database identity,
  database/WAL sizes and exact modification times before accepting it.
- History files use qualified filesystem paths. Unavailable readers or
  unsupported mappings refuse without bypassing locks or replacing saved evidence.
- Metadata changes during publication require a fresh bounded projection and
  unchanged selected-source eligibility, membership and provenance. Source-file,
  authority or store conflicts still refuse.
- Final pre-write validation allows one fresh membership check before the
  same rename. A second freshness change refuses; no write is repeated or
  interrupted write relabeled as success.

### Schema and read bounds

The current adapter checks the consumed ordinary `sessions`, `workspaces` and
`projects` mapping, required text/null values and sole `id` primary keys.
Schema generation 156 is the minimum; a later number alone neither grants nor denies
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
completion only with its exact original start in the same verified read.
For a newly observed completion split from its start by a chunk boundary or
restart, WIRE can make one fresh lookbehind ending at that exact completion.
The lookbehind, including source guards, is at most 4 MiB and consumes the same
32 MiB cycle budget. A saved start is not authority. If the cycle lacks room,
the cursor stops before that completion and retries later; an original start
outside the bounded span remains unavailable.

Current optional tool labels and completion telemetry do not establish identity,
authorship or an outcome. WIRE qualifies the observed `preToolUse`,
`preMcpToolCall` and `postToolUse` hook pairs only when the complete parent chain,
unique invocation IDs, source, tool, call, arguments and chronology agree.
Missing hook turn fields are not a general scope exception. Hook payloads are
not retained, hook success flags do not establish tool success, and tool
completion does not establish application or task success.

Compact projection validates the entire UTF-8/JSON entry before admitting any
metadata. Long scalar tails that cannot be selected are validated without
allocating their discarded string tokens. Structural tokens still count toward
the unchanged 100,000-token limit, with bounded batches and a depth limit of 64.
Excessively complex results remain unavailable; neither omitted bodies nor a
parser limit establishes a failure, timeout or returned API outcome. Installing
this reader does not rewrite already-consumed historical completions.

### Event reading and committed progress

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
retained evidence. The bounded-history index barrier preserves committed
progress. Source-reader instances use schema 3 to bind the store to its host
and make older readers refuse rather than ignore that ownership.
Use a compatible reader when restarting an existing store; do not remove its
owner binding or writer lock to make an older or different-host reader accept it.
Within the same approved WSL store/source, a Windows-drive remount may change
only the virtual device number. The reader preserves the saved identity when
the qualified Windows path, inode, birth time, startup event and saved anchors
still agree. It does not reset cursors or adopt another host's store.

## Evidence fidelity

| Fact | Preserve |
| --- | --- |
| Original prompt and timestamp | Never replace them with a conflicting later delivery or host-transformed instructions. New associations need unique explicit message/tool-request links and compatible ownership. |
| Automatic continuation | No new message is distinct from a missing/excluded prompt. Event kind does not establish author; unknown records do not default to User. |
| Tool diagnostic | Screened message/code/status/details stay with their original call or returned entry, separately from optional assistant replies. |
| Model and final-response timing | Require qualified source/message/response/turn links. Tool hints, deployment names and the current account cannot fill missing provenance. |

Diagnostics exclude credentials, sensitive/payload-shaped text, stacks, headers
and inner identifiers. Text is bounded to 8 KiB. Envelope inspection may retain
complete entries before malformed syntax, marked partial with an unknown
supplied total. Missing diagnostics remain unavailable; the reader does not
reconstruct them from other calls.

A Work IQ error envelope may supply only an HTTP status, with no error text.
WIRE retains and displays that status without treating the envelope as unreadable
or inventing a cause. An older record's saved status remains readable without
rewriting its evidence. A reported 503 means Service unavailable; it does not
establish which downstream service failed or whether an operation took effect.

The decoder also recognizes the `ask` failure envelope with a null response
and separate `error`/`errorCode`, and an empty `fetch_blob` response carrying
a nested error and status. It keeps the screened diagnostic, not conversation
IDs, request IDs, recovery instructions or encoded file contents.
An empty retrieval envelope with `stoppedReason: "error"` establishes that
retrieval stopped, but supplies no cause. WIRE says so instead of treating
that supported envelope as unreadable. Unknown shapes stay unsupported;
the decoder does not search arbitrary response bodies for error-like prose.

These rules apply when original events are collected. Reading an older cache
cannot recover text already discarded by an earlier collector. A separately
approved, source-bound repair must update the canonical record and any retained
checkpoint together; installing new code is not that approval. Saved reports
keep their original facts and files.

### Guarded retained-error restoration

The retained-error maintenance policy is separate from ordinary collection and
requires its own reviewed, sealed user decision. It binds exact original start
and completion regions, canonical calls, every retained alias, and both record
and checkpoint preimages. A named older-retained-target exception does not change
the collector's history window or authorize new calls. Restored returned entries
are disclosed separately from unchanged tool-call counts and outcomes.

Where an inline diagnostic would exceed the existing 512 KiB context bound,
checkpoint schema 2 can reference the exact completed failed call in the current
canonical evidence snapshot. It stores no second diagnostic blob. Resolution
checks the store, source namespace, completion identity/time, failed outcome and
alias agreement; missing or conflicting dependencies refuse. At most 32
references and 64 KiB of referenced error carriers can be projected from one
checkpoint. Compact stored events remain separate from hydrated reading events,
so hydration cannot force unrelated context out of the saved cache.

Only the explicitly applied maintenance operation installs collector-index
schema 4 and its compatible-reader fence. Ordinary startup and collection never
upgrade a schema-3 store to this format. Keep a compatible reader afterward:
older readers refuse schema 4 rather than discard its references. Source
switching preserves that fence; references cannot cross store or source
namespaces. Deletion removes the corresponding cached event and canonical
dependency together, while saved reports remain independent.

Prepare does not publish evidence or install the fence. Apply first blocks
ordinary collection with the operation's pending fence, then writes the sealed
checkpoint and evidence postimages. An interruption resumes the same journal;
it does not create another operation or restore an old whole board. Once all
sealed postimages are committed, finalization needs no new original-history
read. The pending fence is released only after the completion journal is durable.
If release is interrupted, the same operation must finish it before collection
can restart. There is no generic rollback command.

`scripts/maintain-retained-errors.mjs` uses this policy through the existing
maintenance protocol. `inspectRetainedErrorRepair` is a read-only projection
check, not Prepare, approval or permission to apply it.

Prompt authorship comes from supported host provenance, not the `user.message`
role or the wording. Host-added image references must match the event's attachment
metadata; they do not supply an author themselves. Reading saved activity never
rereads original author envelopes. Correcting an already-qualified unverified
author requires a separately reviewed, bounded original-event lookup and repair;
the image-envelope classifier does not trigger that repair automatically.
Literal image-reference examples in the original prompt or a supported canvas
attachment remain content, not host provenance.

New author qualification can retain a closed `issue` code with the existing
actor/basis pair: `body-boundary-v1` means the original prompt did not match a
supported transformed-message boundary; `host-wrapper-v1` means the host-added
prefix was not recognized. Neither code proves malformed source data or supplies
an author. Raw host context stays excluded. A qualified creator kickoff cannot
erase that format gap or turn it into a claim of contradictory sender records.
Already-qualified historical records are not reread or given these details on
upgrade. Canonical evidence owners resolve origin disagreements before author
filtering; duplicate-only legacy copies do not override the current owner.

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

Response-saving recovery keeps its original operation, token and storage owner.
Malformed, unreadable or multiple unresolved receipts block new changes rather
than choosing a convenient default.

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
is not cleared broadly. Deleted optional replies do not return.
Saved reports, source files, cursors and settings stay unchanged.

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
