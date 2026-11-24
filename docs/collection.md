# Collection and private data

WIRE reads approved local GitHub Copilot app metadata and history. This
reference explains collection permissions, read limits and saved-data operations.
For setup, see [Connect local history](user-guide.md#connect-local-history).

Collection does not rerun Work IQ requests or read remote-only chats through a
provider. Normal startup supports the GitHub Copilot app only. The separate
development-only Microsoft 365 Chat and Cowork adapters are not additional
sources you can enable in a normal installation.

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
| Read history again | Preview missing, nondeleted activity in selected approved chats and dates. Confirm separately to save it. |
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

Managed connectors may record an opaque `cc-*` server name. WIRE recognizes
their Work IQ calls only when the approved app metadata labels that exact
session and event as **Work IQ** or **WorkIQ**. A tool named `fetch` alone is
not enough. This bounded read admits at most 100,000 managed Work IQ event
identities; incompatible mappings fail explicitly without replacing evidence.
If a recognized operation needs an app mapping, even when the start carries
only the logical tool name, WIRE rechecks that decision if metadata changes before it saves
progress. A changed mapping stops the stale read; the next check can collect
the call from the unchanged cursor. A mapping first supplied **after** progress
was saved is different: updating WIRE or refreshing does not rewind the cursor
or authorize a historical reread. Use **Read history again** to review eligible
missing calls; only a separately confirmed preview can save them.

A failed managed call can return a JSON error labeled with its opaque connector
name. WIRE reads supported diagnostics and returned entries only when the name
matches the unique earlier call start in the source or its bounded checkpoint,
and the app still identifies that event as Work IQ. A connector name alone
does not qualify an error. Response bodies and inner identifiers remain excluded.

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
remain unavailable. Ordinary roster discovery keeps its whole-metadata change checks.
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
- During an authorized selected-chat read, a concurrent metadata commit can
  trigger one fresh read-only transaction. WIRE requires the same database,
  selected mappings and managed event identities. Only the fresh transaction's
  fully checked stamp can advance the read. If metadata changes again during
  that check, or access is withdrawn, WIRE refuses rather than using the first result.
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
retained evidence. A saved start may omit empty completion ID, time or duration
fields. To fill them, the reprojected call must match the same saved prompt and
start facts, have a recorded outcome, and have consistent completion timing.
A call ID and order alone do not qualify. This does not widen historical reads.
The bounded-history index barrier preserves committed
progress. Source-reader instances use schema 3 to bind the store to its host
and make older readers refuse rather than ignore that ownership.
Use a compatible reader when restarting an existing store; do not remove its
owner binding or writer lock to make an older or different-host reader accept it.
Within the same approved WSL store/source, a Windows-drive remount may change
only the virtual device number. The reader preserves the saved identity when
the qualified Windows path, inode, birth time, startup event and saved anchors
still agree. It does not reset cursors or adopt another host's store.

## Evidence fidelity

For token usage, WIRE reads numeric `session.usage_record` receipts during
ordinary approved collection. A call needs an exact model/API-call match to a
response linked to the originating message or a directly linked interaction
receipt, with a complete root response boundary. WIRE subtracts recorded cache
reads and writes from inclusive input. A root completion receipt can establish
the exchange boundary even without saved reply text, latency, a logical
message ID, or a model name on the reply: the usage receipt identifies the
model. WIRE still requires a prompt-to-run or prompt-to-message link, at least
one matching Work IQ tool request, and receipts for every linked response
call. Opaque model request and accounting IDs can contain `/`, `+` and `=`.
WIRE compares bounded, privacy-screened values by an internal digest without
putting the raw opaque ID in new retained model metadata or in reports.
The [SDK's `initiator`](https://github.com/github/copilot-sdk/blob/03056de9b9f21203c14037536097c0e1a8774822/nodejs/src/generated/session-events.ts)
may be `user` for a model request carrying a prompt or `agent` for the next
request after a tool result. Neither proves prompt authorship or request
ownership. Nested activity, a competing owner, or an incomplete window cannot
establish a whole-interaction total. Missing cache counts still allow an
exact input/output total. WIRE does not sum `session.usage_checkpoint`, reason from chat
order alone, subscribe to live SDK events, or start a backfill. Conflicting,
partial, or unsupported receipts do not establish a whole-interaction count.
These optional fields use the existing evidence snapshot; no store conversion
is necessary. A matched Work IQ completion may retain its returned text byte
count (roughly four UTF-8 bytes per token), not its body.
When there is no message-level prompt link, an explicitly owned model request
in the verified run can link its tool ID to one exact start. WIRE can then
include that call's returned text size without changing prompt authorship.
Older receipts without that link are not rewritten.

For a separately metered tool, the [Copilot completion contract](https://github.com/github/copilot-sdk/blob/03056de9b9f21203c14037536097c0e1a8774822/nodejs/src/generated/session-events.ts#L10775-L10781)
can supply `tool.execution_complete.data.toolUsage` even on failure. Ordinary
collection keeps token counts only for a uniquely matched Work IQ invocation.
The tool's operation ID is digested for conflict detection; no quota, charge,
provider detail or additional result text is retained. Input or output can be
missing independently. These counts do not enter conversation model totals.

The journal mapping follows the
[public Copilot reader](https://github.com/markrussinovich/agent-session-insights/blob/d65c0119b31cea27743e4f4ec21be158977e06aa/sources.py)
and the [SDK per-call/aggregate distinction](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing).
The reference project's [redacted journal](https://github.com/markrussinovich/agent-session-insights/blob/d65c0119b31cea27743e4f4ec21be158977e06aa/examples/creation-session.jsonl)
has 120 distinct call receipts but only 21 assistant message call IDs. An
explicit interaction reference can bind additional receipts; message count
alone is not model-call count. A redacted example does not prove a particular
installed source has all the required fields.

| Fact | Preserve |
| --- | --- |
| Original prompt and timestamp | Never replace them with a conflicting later delivery or host-transformed instructions. New associations need unique explicit message/tool-request links and compatible ownership. |
| Automatic continuation | No new message is distinct from a missing/excluded prompt. Event kind does not establish author; unknown records do not default to User. |
| Tool diagnostic | Screened message/code/status/details stay with their original call or returned entry, separately from optional assistant replies. |
| Model and final-response timing | Require qualified source/message/response/turn links. Tool hints, deployment names and the current account cannot fill missing provenance. |

Service classification uses recorded target paths, not the connector's display
name or prompt wording. User-profile relationships such as `/me/manager` and
`/me/directReports` are People operations; a more specific downstream path can
identify another service. Correcting path recognition updates live views of
retained calls without rereading history or changing outcomes. Previously saved
report facts and files remain frozen.

An exact `/me/translateExchangeIds` or `/users/{id}/translateExchangeIds`
target identifies an Exchange ID conversion request, not whether the item is
mail, an event or a contact. The public operation name survives normalization;
user IDs, item IDs and query values do not become part of its path template.
An older record that retains only `/me/{id}` cannot establish the operation.
The generic `/businessapps/me` route also identifies no particular business
app. WIRE distinguishes that recorded limit from a path it does not recognize.

Ask returns an answer and a conversation ID, not an app-by-app execution log.
Requested sources, attached files and citations do not establish which apps
Copilot used. Separately, a structured Work IQ batch can report a path on an
individual result. When its completion matches one recorded Work IQ start,
WIRE keeps the normalized path beside that result's status, without query
values, bodies or literal identifiers. A sibling's path is never substituted.
An older result saved without that path does not gain one on reopen.
A lone requested target can supply explicitly labeled request context, but
not if another result reports a different path. A pathless sibling then
keeps its status and no service assignment.

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

The sender of a saved message is separate from the link between a call and
its initiating request. Within existing checkpoint limits, WIRE keeps the
assistant's outstanding tool-request identifiers beyond the recent-event
window so a later start can still match the original message and turn.
This does not keep extra reply text. A uniquely linked Work IQ call keeps
its prompt and assistant-request event references. A group-level link from
an older record is not evidence for each call in it. Reading old records
does not reopen history or assign a requester from a skill or system message.
Two distinct retained starts for the same invocation cannot prove a direct link.
New collection marks that conflict before trimming the checkpoint, so retaining
only one start does not erase the conflict after restart.
If copies of a single message name conflicting senders, the sender stays
unclear even when the timestamp and original text agree.

The host can append a direct-message source reference after the original text.
WIRE recognizes the supported UUID/revision envelope and fixed footer only at
that exact outer boundary. The reference is neutral framing: source, timestamp,
sender and agent-created kickoff checks still determine authorship. Typed
imitations, altered or duplicate references and unsupported layouts do not
establish a human author. Classifier version 9 covers newly consumed originals;
it does not reopen or relabel already-qualified records or compact checkpoints.
Those retained copies still require separately approved, source-qualified repair.

New author qualification can retain a closed `issue` code with the existing
actor/basis pair: `body-boundary-v1` means the original prompt did not match a
supported transformed-message boundary; `host-wrapper-v1` means the host-added
prefix was not recognized. Neither code proves malformed source data or supplies
an author. Raw host context stays excluded. A layout rejection cannot be turned
into a claim of contradictory sender records. Separate qualified origin evidence
can establish an author without making the model-text layout supported.
Already-qualified historical records are not reread or given these details on
upgrade. Canonical evidence owners resolve origin disagreements before author
filtering; duplicate-only legacy copies do not override the current owner.

The host's `[[PLAN]] ` prefix is neutral runtime mode framing, not sender
evidence. WIRE recognizes it only after the qualified timestamp and outside the
exact displayed message; the existing sender and attachment checks still apply.
The historical plan-mode notice and app branch context are also neutral; their
prose cannot establish a sender.
Classifier version 10 also recognizes an autopilot-mode transition notice when
the recorded mode is autopilot, without a plan marker or mixed mode blocks.
This keeps a supported sender envelope visible to the same author checks;
autopilot mode alone never means an agent authored the prompt or that an
automatic continuation occurred.
The supported steering path can omit the timestamp wrapper around a
cross-session sender envelope. WIRE accepts only that complete, isolated sender
frame with a valid logical message ID and recorded steering delivery. It still
validates the sender fields and source contradictions. Timestamp-free direct
input, extra context and other delivery paths do not gain a guessed human author.
The supported runtime can remove trailing spaces and line endings from model
input while keeping them in the timeline. WIRE recognizes that exact trailing
transform without changing retained text or normalizing leading/internal text.
The app's display and model projections can also differ for an attachment.
For one explicit file with a unique displayed label, WIRE checks the entire
path-bearing model descriptor against that recorded label and path. Missing or
ambiguous metadata and any other body difference remain unqualified. This is not
fuzzy matching or general Markdown removal. Original timeline text stays intact;
file contents are never opened and attachment paths are not added to retention.

Classifier version 11 checks the direct-message reference and a following image
notice separately. Version 12 also recognizes a canvas attachment immediately
before that reference. The canvas contents stay opaque, including quoted sender
or attachment markers. With a matching timestamp, message ID, delivery and original
text, the reference can accompany the app's ordered workspace sections outside
plan mode. A cross-chat sender, automatic continuation or agent-created first
message still goes through its own origin checks. Workspace text alone does not
establish a sender. New unverified records distinguish an unsupported source
value (`source-value-v1`) from workspace details without verified origin
(`workspace-origin-v1`). WIRE saves neither the source value nor the host text.
Already-qualified prompts are not reopened or updated on startup.
For example, a prompt already marked unverified by version 10 keeps that
label after an upgrade, even when every call links directly to it. The links
identify the request, not its author. To correct its retained author, review
that original through the procedure below rather than refreshing the chat.

Version 13 reads the Copilot journal's `user.message.data.agentAuthored: true`
as an explicit Agent origin, including a kickoff with no separate sender
envelope. A false or absent flag does not identify a Human. An explicit user
or system source that contradicts the flag remains unverified. `shell` is a
supported execution mode, not a sender: the same direct-input, cross-chat
sender and kickoff checks apply. Both fields are defined in the
[Copilot session event schema](https://github.com/microsoft/copilot-sdk/blob/2dfe56f7a205e0a4f13b6c02fc36afeb035650eb/nodejs/src/generated/session-events.ts#L7281).
Older versioned `missing-source` entries are eligible for the bounded review
below. A review that still finds no supported sender proposes no change.

Version 14 handles an older idle original with no logical send ID. It requires
a valid journal event ID, the matching timestamp and exact original display
boundary, plus either the validated app direct-input reference or an explicit
host-added cross-chat sender. An ID, plain timestamped text, or a marker typed
in the prompt is insufficient. The creator/kickoff and competing-source
checks still apply. This does not invent a logical message ID or attach a
tool call to a message by order.

### Prompt origin reader compatibility

The [SDK's per-message continuation flag](https://github.com/microsoft/copilot-sdk/blob/2dfe56f7a205e0a4f13b6c02fc36afeb035650eb/nodejs/src/generated/session-events.ts#L7321-L7323)
records injection by the autopilot loop, not merely the mode that was open.
Classifier version 15 recognizes such a system-delivered message as **Agent
prompt (automatic continuation)** when there is no competing sender evidence
or unresolved kickoff guard. A system message by itself, an idle delivery,
or wording that sounds automatic is not enough. This is sender evidence for
the message, not proof it initiated a particular call. Installing the
classifier does not repair a previously qualified conflicting sender.

Once `host-agent-authored` is written, both the active
reader and the fallback must recognize it in retained prompts, interaction
validation and JSON-only saved reports (v13 origin support or a verified
reader backport). A v12 reader can open the saved JSON yet render the Agent
prompt as unverified. An unchanged file hash or a healthy server does not
prove compatible reading. Before first collection or offline repair on the
real store, verify the intended primary and fallback on an invented marked
prompt and its JSON-only saved report, as well as a previously saved report.
Do not use a v12 fallback after a marked origin is written. The existing
collector schema-4 guard is separate and does not establish this compatibility.

Historical origin correction is separate from collection. The prompt-origin
maintenance policy binds exact original regions, every retained origin/follow-up
copy and its checkpoint preimage. Its read-only inspector proposes changes but
does not authorize them. Prepare and Apply use the existing sealed maintenance
journal and offline writer guards; they change only author metadata and require
an explicit decision for the named retained targets. Prompt text, calls, source
cursors, privacy choices and existing saved reports stay unchanged. An
interruption resumes the same operation rather than creating a replacement.
Apply uses the existing persisted sealed-operation fence before any checkpoint
write. Normal collector startup refuses until that operation is complete.
An index at schema 3 advances to the store-bound schema-4 reader capability;
an existing schema-4 store keeps its registry and binding. No completion references
are created by an author correction. Keep a compatible reader after application;
do not remove the fence or restore an older index to bypass it.
Named checkpoint-only companions can correct an existing context message without
creating a retained interaction. They are counted separately, preserve all tool
and repaired error carriers, and bind honest before/after checkpoint hashes.
Already-known origins remain outside the unknown-only repair population.

### Review older unverified authors as a group

Use the existing prompt-origin maintenance command. You do not need a
screenshot, a prompt excerpt or a hand-built event pin. Keep its output private:
it contains local source identifiers and hashes, not prompt or reply text.

```text
node scripts/maintain-prompt-origins.mjs --mode list --data-dir <absolute-store>
node scripts/maintain-prompt-origins.mjs --mode list --counts-only --data-dir <absolute-store>
node scripts/maintain-prompt-origins.mjs --mode review --data-dir <absolute-store> --batch <listed-batch>
```

`list` reads only the retained store. It groups older unverified origins and
their retained copies by chat, lists batches of up to four, and counts excluded
origins by reason. A candidate is **not** a finding that the author was human.
`--counts-only` returns no member or batch IDs. It counts canonical Work IQ
tool calls and their originating interactions across **all retained dates**,
including earlier/inactive Copilot records and excluding platform metadata.
Follow-ups do not add interactions. All unverified interactions count, even
if they have no reviewable event. The reason/version groups describe retained
evidence, not what a new original lookup would find. The time/archive choices
below affect review eligibility, not this all-retained denominator.
Use `--mode list --originating-only` for a private case list on **one** verified
retained revision. Each unverified canonical interaction has a store-bound
case reference and either its batch/one-based position or an exclusion. The
saved call-to-prompt association is separate from who sent the message:
message order alone cannot identify the initiating request. A
listed source's `consumedBytes` is its retained fully consumed cursor (or
null), not a live file check. Follow-up copies of selected originals are
counted, but follow-up-only originals do not enter these batches. Use the
same `--originating-only` and time/archive choices with `--mode review`;
a general batch cannot be substituted. The list needs no journal or
checkpoint read. It is not a proposal, permission or persistent index.

For one eligible listed case, `--mode links --link-check <linkCheck>` with
the same `--data-dir` reads only its retained store and one compact checkpoint,
not the Copilot database or original journal. It returns the case reference and
one opaque reference per selected Analyze call. `same-origin` or
`different-origin` means a unique retained start and assistant request name a
logical message. `checkpointOriginRef` identifies that message without exposing
its source ID; `retainedSender` describes only that message's saved checkpoint
metadata. A missing start or request is a limit of the checkpoint, not proof
that the journal lacks it. `fullSourceUniquenessChecked` is always false: an older
checkpoint may already have discarded a competing start before it could be marked.
A disagreement with a board link is not resolved by
preferring either copy. The check cannot prepare, apply or authorize a repair.

Between pages of that exact source, a new check time, cycle counter or
another chat's cursor alone does not invalidate already verified bytes.
The selected source and cursor, compact checkpoint preimage, original
journal, database identity and mapping, board/configuration, source
membership, host owners and global guards must still match. Each invocation
requires a stable control read; the final proposal seals the **current exact**
index bytes. Prepare and Apply do not use this page-continuation exception.
The default is the current window and active sources. To review older dates or
archived local chats, explicitly add `--include-older` or `--include-archived`
to both commands. These options do not change collection settings.

`review` checks the selected chat's approved local mapping and reads one bounded
page of its fully consumed journal. If it returns `status: "continue"`, save
that JSON as UTF-8 in a private file **outside** the checkout and store. Run
the same `review` command with `--previous <absolute-page-file>`. Keep each
new page separate from the one you're reading. Pages cannot be mixed across
batches or changed sources. No proposal is made until the full journal has
been checked for competing event identities. An unreadable, oversized or
ambiguous source region prevents a complete review; it is not an empty batch.
Every ordinary entry must establish an unambiguous outer event ID and type,
including escaped JSON keys. Noncanonical or duplicate fields inside an
unselected payload do not establish or disprove a sender. Startup and each
proposed original still need full-field verification. An ambiguous selected
payload with a unique envelope stays unresolved; an ambiguous envelope can
hide another selected ID and blocks the whole page.
For a complete oversized entry already inside the same page budget, a bounded
streaming check can establish just its unique outer ID, type and timestamp.
It does not project a sender or payload. A collision still counts, and an
oversized selected original cannot become a target. Malformed input, excessive
parser work, and entries that cannot fit a verified page still refuse.
If the metadata database changes during a named review read, the selected-chat
reader can take one fresh transaction. Only its fully fenced result is used.
The physical database, schema, complete selected mapping (including managed
events), retained controls and journal boundary must still agree. Repeated
churn or a changed selected mapping refuses the read. The same mapping proof
binds page continuations and new proposals; Prepare and Apply still perform
their own original and checkpoint checks.

The final `targets` are the corrections the original records actually support.
If an agent-created chat lacks its saved first-prompt ID, a completed review
can still prove a selected direct input was **not** its kickoff. It seals
the earlier first event's digest to this store, source mapping, complete
journal and exact selected region. An unsealed flag, a nearby timestamp or
the first event itself cannot remove that guard. Prepare and Apply verify
the same seal and original; neither edits the collector's first-event pointer.
For **new collection**, the reader also checks the startup bytes it already
reads. If a verified first event is not there, consecutive, already-approved
prefix pages can establish it across restart. Only the offset and byte anchor
of a clean prefix carry forward. A gap, malformed or duplicate fields, a
replay entry or a changed source cannot turn the first *visible* prompt into
the first prompt of the chat. No extra file scan is started and previously
retained authors are not bulk-updated.
Reviewed corrections may identify either a human or an agent. `unresolved` explains why other
candidates stay unverified. Listing, reviewing and installing a new reader
do not write these changes. For an approved correction, use the returned
targets, source and state guard in the existing offline Prepare/Apply plan.
Preserve its stopped-runtime attestation, saved-file guards, review seal and
separate confirmation. A changed source invalidates the proposal. A stale
batch must be listed again; do not weaken the guards or replay calls.

For an exact original the classifier cannot qualify, the private review receipt
includes the failed host-envelope condition, a fixed sender/delivery category,
the host flag states, and the checked original-region pin. It contains no raw
sender value, prompt or transformed input. For example, a missing logical
message ID and a timestamp disagreement are separate observations. These
observations explain a refusal; neither assigns a sender nor grants another read.

For a complete correction batch, `inspectPromptOriginRepair` also accepts
`origins`: exact source/event identities, pinned original regions and the
explicit `olderRetained` choice. It uses the same classifier as collection,
derives every retained alias and checkpoint hash, and returns bound targets
alongside explicit unresolved or already-known exclusions. It does not infer
missing identities from matching text. One operation can include up to 32
origins. Each inspection, preparation or apply invocation stays within the
existing 32 MiB original-read budget. Both input paths reserve up to three complete
original-verification passes, including their repeated event and startup reads;
a larger batch refuses before reading.

Legacy copies with genuinely absent author metadata can be corrected without
treating missing versions on known authors as permission to overwrite them.
`includeArchived: true` permits review of exact retained originals from a
currently verified local archived source, not source restoration or collection.
The resulting target seals that source mapping and the legacy exception.
Current metadata must establish local provenance independently of the archive
flag; nonlocal, ambiguous and unavailable mappings refuse. A compatible metadata
reader is required for that proof. Explicit-source and legacy targets cannot
omit the fresh source mapping guard through the lower-level target interface.
The older nonlegacy host-target format remains readable only when fresh metadata
still matches its retained source identity; cached eligibility alone never
authorizes the correction.
Source mappings and pinned originals are checked again before first effects and
before board publication. Drift leaves the same journal and any pending fence
in place; completing an already committed postimage does not replay old source
reads. None of this changes the automatic legacy
qualification threshold, collection window, source eligibility or saved reports.

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

In the normal Copilot runtime this is a **missing, nondeleted activity** review.
Both local source approval and active acquisition must still be valid. This
operation does not use manual Refresh's Pause exception. A panel can preview
its selected scope without writing evidence; only a separate confirmation of
that still-current preview can publish it. It cannot restore suppressed calls
or deleted prompts. Reading an existing receipt does not require another
source read.

**Also review source-verified corrections to saved calls** is off by default.
The preview names each proposed change (up to 32). An unknown can become a
completed call only through the bounded original start/completion qualification;
omitted bodies or HTTP statuses are not recovered from success alone. For an
already completed call, WIRE can fill an absent result or failure carrier when
the start, completion, outcome and retained entries agree. It never replaces
conflicting facts. Duplicate targets, an unread prefix or incomplete tail, and
missing or contradictory checkpoint evidence prevent correction. Checkpoints
and saved reports are not rewritten. If an existing checkpoint needs a different
postimage, the separately reviewed maintenance path is required.

1. Open **Read history again > Choose chats** and select eligible approved local
   chats. Selection survives paging. Inclusive dates intersect the approved
   window; they do not grant wider history or a new source.
2. Read the preview's deleted, newly available, already-present and unavailable
   counts. Bounds are 128 chats, 32 MiB per read, the last 64 MiB per file
   and 20,000 candidate records.
3. Confirm only the changes you reviewed. If the result is uncertain, use
   **Check recollection result**, including after reload/restart, rather than
   confirming again.

An edit in a different Copilot chat does not invalidate your preview by
itself. WIRE rechecks the physical source database and the selected chats,
their histories and the proposed changes before saving. A changed selection
or expired preview requires a fresh review. The panel distinguishes a known
refusal before saving from a lost response: only the latter needs a receipt
check. Neither is automatically retried.

For **one chat, one day, missing records only**, a large log can take more
than one read. **Read next part** continues from the verified byte boundary;
it does not start another scan or show partial counts as the final selection.
After confirmation, **Continue verification and save if complete** checks the
same original selection before any write. Each phase allows at most three
32 MiB reads (including repeated partial lines and source checks). The file
must fit the 64 MiB source window. A continued read with an unfinished,
malformed or oversized entry, or an unqualified prompt or credential-bearing
entry excluded by retention, cannot certify that day and offers no save.

Only one large-chat read is held in memory at once, with bounded screened
event context and no raw partial-line buffer on disk. Cancellation, access
withdrawal, restart or the original two-minute deadline retires it. Continued
steps do not extend the deadline. The collector's normal source cursor and
other stored receipts are not used to resume a review. On the oldest partly
approved day, only records inside the original window can be proposed. If
any proposed record leaves the rolling window before saving, the whole
selection is refused rather than silently shortened.

**Verified records only (day incomplete; runtime opt-in).**
Strict recovery stays selected by default. A Copilot-only runtime started
with `--verified-record-recovery` also offers this operation. Opening the
chooser on that runtime does not read the chat list. **Load eligible chats**
reads the list; previewing and confirming the selected calls remain separate.
This is a separate choice for one chat and one day, not a fallback from a
failed full-day preview. It lists up to 32 missing calls whose original
identities, explicit message and tool links, and recorded completions can be
checked independently. A completion with no reported outcome stays **unknown**.
No completion is inferred from a neighboring event. An unidentified region
that could hide another matching identity prevents the preview, even if it is
outside the proposed calls.

In this mode only, each bounded read step can spend up to four extra parser
pages on structurally dense entries. Each page keeps the ordinary 100,000-token
limit, yields between pages and rechecks access and the selected file. Only
the completed, validated entry is available to the identity checks. An
unread tail, an unsupported field or an exhausted budget still prevents
recovery; ordinary collection and strict recovery keep their existing limits.

A supported SDK startup header can contain typed workspace, model and tool
settings. WIRE still requires the source's mapped session identity and
supported version. The header grants no access and its values are not copied
into the recovered call or its receipt.

A separate assistant turn or a text-free Copilot mode or permission notice
need not rule out an otherwise verified call. WIRE checks the notice's
declared fields and identifiers against the whole source and its checkpoint.
Notice content never supplies attribution or grants access. Unknown
fields, ambiguous identifiers, and unclassified oversized entries still
prevent a verified-record preview.
If another saved prompt's text happens to equal the call ID, WIRE can
distinguish that text from a second request. The complete checkpoint row
and saved prompt must match a unique original, and the ID must appear there
only as text. An actual competing request still rules out the call.
For a permissions notice recorded as `on`/`off`, both the previous and new
modes must agree with their corresponding Boolean flags.
A remote-session notice may name a canonical GitHub Copilot task URL. WIRE
checks the task identifier for conflicting claims, but does not visit the URL,
import the task, or use it to connect a prompt to a call.

The assistant's `originatingMessageId` identifies the initiating user
message; `parentId` identifies the preceding journal event. They need not
point to the same event. A review can verify the user's message across up
to 32 typed, consecutively linked timeline notices and a matching turn
start. It requires the explicit origin, request, turn and call to agree;
chronological order alone is never enough. Intervening system or developer
text is not a user prompt and is not copied into the call. A linked turn
end is checked against the completion and changes neither its outcome nor
the receipt's incomplete-day coverage.

A prompt can also follow an independently verified session notice in the
selected interval if the prompt names that immediately preceding event. This
checks journal order only; the assistant must still name the prompt explicitly.

For a first message, WIRE can verify the recorded session-start, prompt-submission
and prompt-transformation hook pairs in order. All must belong to this source,
finish successfully without output, and agree with the original message and
its transformed copy. Hook text is not saved and does not establish authorship.

A task-linked prompt may also record a parent-task ID, an interaction ID, an
empty native-document list and reasoning settings. WIRE checks those IDs
separately from the source, prompt, request and call. A parent-task reference
may recur in the same role; neither ID can stand in for the initiating message.
A conflicting identity or checkpoint claim still prevents recovery.

The historical SDK also records which interaction received a system or
developer instruction. When that instruction immediately follows its original
prompt, WIRE can verify their shared interaction ID and bounded template
metadata (`promptVersion` and JSON `variables`). It screens the complete
instruction but does not keep it or use it to choose a call's owner. A
second request claiming the same call still excludes the call.
If an instruction prevents the review, WIRE distinguishes an unverified
prompt link, an unsupported template, excess template size, incomplete
original verification and a privacy exclusion without showing the contents.

If the original prompt exactly matches a single saved parent in this chat,
WIRE can keep that parent and its recorded author, including an agent author,
without writing a new prompt. The explicit request and call must agree on
their turn; the originating prompt can be from an earlier turn. WIRE screens
the complete original prompt and assistant request before using their bounded
retained fields. It neither truncates the prompt to fit nor retains the
assistant's discarded text. This does not make an unresolved reference safe.
If multiple saved parents claim the original prompt, or its saved parent is
ineligible, WIRE does not treat that prompt as missing to recover the call.
For a newly verified human prompt, the assistant request may exceed the
individual-record limit because of reply text alone. WIRE screens the full
original, keeps only the bounded request, and requires an app-mapped start.
The prompt, call and completion still have to qualify independently.
A start that records only its logical tool name (such as `fetch`) can qualify
when the app identifies that exact start as Work IQ. The name alone cannot
qualify a call or override a conflicting recorded server.

An unrelated external-tool request or canvas record can be classified when
its matching close is the next original event. The supported forms carry no
tool arguments or canvas input; an empty arguments object is also allowed.
Their IDs must be disjoint across the whole journal, including original
fields that JSON parsing could hide. Even separate canvas lifecycles reusing
an extension or canvas ID are currently refused. Neither an external
completion nor a canvas close can supply a missing call outcome.

A compact, text-free post-tool hook may close directly after its matching
unrelated hook start. Its success flag describes the hook, not the tool call.
An unmatched close, an intervening record, or an unverified hook body cannot
supply that link.

For an app-mapped Work IQ start already linked to the user's prompt and the
assistant's request, the completion's parent can instead lead back through
three adjacent hook pairs: `preToolUse`, `preMcpToolCall`, then `postToolUse`.
For an app-mapped managed start, the MCP hook can name the exact same
managed server as the original start instead of the literal `workiq`.
An unrelated server name or an unmapped identifier does not establish this link.
The start, all six original hook records and the original completion must fit
in one read part. WIRE checks every parent link and event time, the distinct
event and invocation IDs across the source and checkpoint, the hook session,
tool, `workiq` server on the MCP hook and arguments, and the completion's own call and turn.
Only the completion reports the outcome; missing success stays unknown.
Projected hooks, ambiguous original fields, credentials and deleted
dependencies cannot qualify the chain. WIRE binds the original bytes. For
entries up to 16 KiB it can also verify harmless JSON spelling differences,
such as `17.0` instead of `17`, without accepting duplicate keys or rounded
values. Explicit `checkpoint: false` and `ephemeral: false` flags are
compatible with an ordinary original; replay copies and transient records
are not. Even a directly linked call cannot be proposed if another original
in the journal could hide a conflicting identifier. WIRE refuses a split
hook chain rather than carrying private arguments or result bodies into the
next part.

Confirmation rereads the same bounded originals, using the same two-minute
deadline and explicit reading steps. A changed mapping, file, checkpoint,
approval, selection or review basis refuses the operation. The writer preserves
other records, consent, checkpoints and saved reports. Its original receipt
identifies each added call and always says **verified records only; day
incomplete**. Proposed and added are calls, excluded counts observed candidates
not admitted, and unknown counts proposed calls without a recorded outcome.
None estimates the number of missing calls in the day. Byte-span witnesses
are not stored. If WIRE refused the original confirmation before writing,
the panel says nothing was saved and gives the reason. A lost response or a
response for a different operation is not that proof: check the original
receipt instead of confirming again.

Older compatibility-mode previews can include deleted records. Only those
previews offer **Also restore original prompts for these requests**; it starts
unchecked and requires an exact association between the selected call and
its source prompt. Neither normal recovery mode offers that choice. Host
envelopes cannot promote an agent kickoff to User. Anonymous local records
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

A missing or unreadable approved metadata file is a known source-read failure,
including the file checks before opening SQLite. Refresh identifies the source
problem and keeps Review source and Read stored activity available; it does not
replay the check or change approval or Pause. An absent optional SQLite WAL is
normal, but an unreadable companion file is not. Failures after publication
begins still require outcome recovery rather than being relabeled as no-effect
source failures.

GitHub checks do not have client-request correlation for a lost response.
A newer last-check timestamp cannot settle that operation. The tab's verified
pending sentinel survives reload; uncertain checks allow stored/status reads,
not another dispatch. Sentinel storage failure blocks checking explicitly.
This is tab-session protection, not runtime-wide cross-tab correlation.

Settings configuration uses its last-read version and rejects stale writes.
**Read current connection** reconciles saved settings without claiming a lost
write's original receipt. Unsent safe preferences can survive withdrawal;
private source-path drafts cannot. See [runtime access](runtime-access.md).
