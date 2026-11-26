# Collection and private data

WIRE reads approved local GitHub Copilot app metadata and history. This
reference explains collection permissions, read limits and saved-data operations.
For setup, see [Connect local history](user-guide.md#connect-local-history).

**Contents**

- [Operations and permissions](#operations-and-permissions)
- [Store ownership](#store-ownership)
- [Source mapping and bounded reads](#source-mapping-and-bounded-reads): [approved paths](#approved-paths),
  [account profile](#account-profile), [native metadata reads](#native-metadata-reads),
  [read bounds](#schema-and-read-bounds), [committed progress](#event-reading-and-committed-progress)
- [Evidence fidelity](#evidence-fidelity): [token usage](#token-usage),
  [services and diagnostics](#services-paths-and-diagnostics),
  [retained-error restoration](#guarded-retained-error-restoration),
  [prompt authorship](#prompt-authorship), [reader compatibility](#prompt-origin-reader-compatibility),
  [review older authors](#review-older-unverified-authors-as-a-group)
- [Optional replies](#optional-replies)
- [Deletion](#deletion)
- [Explicit recollection](#explicit-recollection): [steps](#steps),
  [corrections to saved calls](#corrections-to-saved-calls), [large chats](#large-chats),
  [verified records only](#verified-records-only)
- [Refresh and uncertain outcomes](#refresh-and-uncertain-outcomes)

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
current user's home directory. In WSL, that's the Linux user's home, not the
Windows profile. These are storage defaults, not a guarantee that Copilot
history is available in that environment; source paths still need review and
approval.

To choose another folder, set `WORKIQ_EVIDENCE_DATA_DIR` to an absolute path
outside the source directory.

- A store has one writer, regardless of its port or checkout.
- On the same host, a replacement checkout can use that store after its current
  runtime has stopped.

Concurrent instances need distinct data directories and reachable ports. They
may each approve the same Copilot input, but each instance owns its cached
activity, cursors, settings, source approval, reply consent and saved reports.

- An independent instance reads history using its own window and progress.
- It doesn't borrow another instance's cursor or consent, or synchronize
  reports.
- Windows and WSL can run together without moving the Windows store. For a
  launch example, see [platform setup](development.md#windows-wsl-and-linux).

Rules for storage code:

- Content-addressed evidence snapshots are separate from atomic state metadata.
- A process lock rejects a live writer. An unverified owner isn't permission to
  remove a lock.
- Preserve approvals, unresolved receipts, pseudonym keys and saved output when
  changing storage code.
- Incompatible stores must fail explicitly, not be stripped, reset or bypassed
  with empty data.

## Source mapping and bounded reads

### Approved paths

The suggested source comes from `COPILOT_HOME`, otherwise `.copilot` in the
home directory of the user running WIRE: `data.db` and `session-state`.

- In WSL, these defaults don't automatically locate a Windows user's source.
  Choose the actual paths in source review; WSL can qualify Windows drive paths
  or their mounted equivalents.
- WIRE checks those named paths, not arbitrary home-directory contents.
- Approval and schema validation come before any history read.

#### Managed connectors

Managed connectors may record an opaque `cc-*` server name. WIRE recognizes
their Work IQ calls only when the approved app metadata labels that exact
session and event as **Work IQ** or **WorkIQ**. A tool named `fetch` alone isn't
enough.

- One bounded read admits at most 100,000 managed Work IQ event identities.
  Incompatible mappings fail explicitly without replacing evidence.
- If a recognized operation needs an app mapping, even when the start carries
  only the logical tool name, WIRE rechecks that decision if metadata changes
  before it saves progress. A changed mapping stops the stale read; the next
  check can collect the call from the unchanged cursor.
- A mapping first supplied **after** progress was saved is different. Updating
  WIRE or refreshing doesn't rewind the cursor or authorize a historical
  reread. Use **Read history again** to review eligible missing calls; only a
  separately confirmed preview can save them.

A failed managed call can return a JSON error labeled with its opaque connector
name. WIRE reads supported diagnostics and returned entries only when:

- the name matches the unique earlier call start in the source or its bounded
  checkpoint; and
- the app still identifies that event as Work IQ.

A connector name alone doesn't qualify an error. Response bodies and inner
identifiers stay excluded.

### Account profile

Account presentation uses a separate, bounded, profile-only read of the approved
database. For the supported account mapping (schema 207 or later), it chooses
the profile in this order:

1. `app_state.activeWorkspaceId` to the workspace's linked GitHub account.
2. Otherwise, the app's GitHub default.
3. Otherwise, the first GitHub account in creation order.

A missing link that needs repair, or an ambiguous selection, stays unavailable.

What the read exposes:

- Only bounded selection and profile metadata, including
  `settings_json.avatarUrl`, leave the reader. Tokens and history aren't read by
  this projection.
- WIRE fetches supported GitHub-hosted images through its local image route,
  with an account-bound cache and short-lived tickets.
- It rechecks the profile within 15 seconds while visible. Successful
  same-profile reads renew the image ticket without replacing the image; image
  requests alone don't renew it.

If unrelated metadata changes during a profile read, WIRE makes one fresh
read-only check of the selected profile. It accepts matching profile facts from
the same database, not an old cached identity; changed or unreadable results
stay unavailable. Ordinary roster discovery keeps its whole-metadata change
checks.

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
- During an authorized stamped selected-chat read, a concurrent metadata commit can
  trigger one fresh read-only transaction. WIRE requires the same database,
  selected mappings and managed event identities. Only the fresh transaction's
  fully checked stamp can advance the read. If metadata changes again during
  that check, or access is withdrawn, WIRE refuses rather than using the first result.
- Final pre-write validation allows one fresh membership check before the
  same rename. A second freshness change refuses; no write is repeated or
  interrupted write relabeled as success.

### Schema and read bounds

The adapter checks the consumed ordinary `sessions`, `workspaces` and
`projects` mapping, required text and null values, and sole `id` primary keys.

- Schema generation 156 is the minimum. A later number alone neither grants nor
  denies compatibility. Additive fields and indexes can stay compatible.
- Optional creator fields qualify authorship only as a compatible pair with
  valid recorded evidence.
- Unknown host, location or workspace values don't establish local scope.

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

#### Split completions

A complete tool-result line up to 4 MiB can supply a supported successful
completion only with its exact original start in the same verified read.

- For a newly observed completion split from its start by a chunk boundary or
  restart, WIRE can make one fresh lookbehind ending at that exact completion.
- The lookbehind, including source guards, is at most 4 MiB and uses the same
  32 MiB cycle budget.
- A saved start isn't authority. If the cycle lacks room, the cursor stops
  before that completion and retries later.
- An original start outside the bounded span stays unavailable.

#### Hooks and telemetry

Optional tool labels and completion telemetry don't establish identity,
authorship or an outcome. WIRE qualifies the observed `preToolUse`,
`preMcpToolCall` and `postToolUse` hook pairs only when all of these agree: the
complete parent chain, unique invocation IDs, source, tool, call, arguments and
chronology.

- Missing hook turn fields aren't a general scope exception.
- Hook payloads aren't retained.
- Hook success flags don't establish tool success, and tool completion doesn't
  establish application or task success.

#### Large results

Compact projection validates the entire UTF-8/JSON entry before admitting any
metadata.

- Long scalar tails that can't be selected are validated without allocating
  their discarded string tokens.
- Structural tokens still count toward the 100,000-token limit, with bounded
  batches and a depth limit of 64.
- Excessively complex results stay unavailable. Neither omitted bodies nor a
  parser limit establishes a failure, timeout or returned API outcome.
- Installing this reader doesn't rewrite already-consumed historical
  completions.

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
unknown result without adding a call; rotation or truncation can't erase
retained evidence.

A saved start may omit empty completion ID, time or duration fields. To fill
them, the reprojected call must:

- match the same saved prompt and start facts;
- have a recorded outcome; and
- have consistent completion timing.

A call ID and order alone don't qualify, and this doesn't widen historical
reads.

#### Store binding

The bounded-history index barrier preserves committed progress.
Source-reader instances use schema 3 to bind the store to its host, and older
readers refuse rather than ignore that ownership.

- Use a compatible reader when restarting an existing store.
- Don't remove its owner binding or writer lock to make an older or
  different-host reader accept it.
- Within the same approved WSL store and source, a Windows-drive remount may
  change only the virtual device number. The reader keeps the saved identity
  when the qualified Windows path, inode, birth time, startup event and saved
  anchors still agree. It doesn't reset cursors or adopt another host's store.

## Evidence fidelity

### Token usage

WIRE reads numeric `session.usage_record` receipts during ordinary approved
collection.

#### What qualifies a token count

A call needs all of these:

- an exact model/API-call match to a response linked to the originating
  message, or a directly linked interaction receipt;
- a complete root response boundary;
- a prompt-to-run or prompt-to-message link;
- at least one matching Work IQ tool request; and
- receipts for every linked response call.

How the count is formed:

- WIRE subtracts recorded cache reads and writes from inclusive input.
- A root completion receipt can establish the exchange boundary even without
  saved reply text, latency, a logical message ID or a model name on the reply.
  The usage receipt identifies the model.
- Missing cache counts still allow an exact input and output total.
- When a telemetry run ID is reused, WIRE can use each prompt's unique message
  and request identities instead, but only if every competing claim and run
  receipt has an exclusive request owner. The complete-root, tool-link, privacy
  and receipt-conflict checks still apply, and the shared run doesn't contribute
  extra receipts to either prompt.

Opaque model request and accounting IDs can contain `/`, `+` and `=`.
IDs longer than 512 characters, up to 4,096, must use one base64 alphabet
with padding only at the end; the producer documents no length bound.
WIRE compares bounded, privacy-screened values by an internal digest, without
putting the raw opaque ID in new retained model metadata or in reports.

#### What doesn't establish a total

- The [SDK's `initiator`](https://github.com/github/copilot-sdk/blob/03056de9b9f21203c14037536097c0e1a8774822/nodejs/src/generated/session-events.ts)
  may be `user` for a model request carrying a prompt, or `agent` for the next
  request after a tool result. Neither proves prompt authorship or request
  ownership.
- Nested activity, a competing owner or an incomplete window can't establish a
  whole-interaction total.
- Conflicting, partial or unsupported receipts don't establish a
  whole-interaction count.
- WIRE doesn't sum `session.usage_checkpoint`, reason from chat order alone,
  subscribe to live SDK events or start a backfill.

#### Where an exchange starts and ends

- A message the producer delivers as `steering` carries the same run ID into
  the running interaction. Its model calls count with that root prompt; it isn't
  a rival prompt.
- When both the prompt and a reply record a run ID, the run decides ownership.
  Copilot can repeat the first prompt's `originatingMessageId` on replies to
  later prompts.
- An exchange that stopped before a final answer still spent every model call
  it recorded. Once the next independent prompt begins or Copilot ends the
  session, those calls are its total and the reader says it stopped early.
  A reply to it after that point conflicts.
- The assistant message Copilot writes after a background notification has no
  turn, model request, run or originating message. It isn't a rival reply.
- Only a skipped, oversized or withheld entry between the prompt and the next
  prompt blocks a total. An unread prefix, pasted image or withheld entry
  elsewhere in the chat doesn't. Withheld prompt text keeps its run and message
  identity, so it can still contest ownership.
- A gap is missing evidence. It never clears a total that was already verified.

#### The Copilot app's usage index

Older Copilot journals have no per-call receipts. The Copilot app also keeps
its own per-call accounting in `session-store.db` beside the approved chat
database (`turns` and `assistant_usage_events`). Source approval doesn't
cover it. **Read Copilot's token records** in the source review shows that exact
path and records a separate approval (`usageRecords`), off by default and for
existing approvals. With it on, when the journal can't establish a total, WIRE
reads that index read-only for the same approved chat.

- WIRE reads only the turn's prompt text (to match it, never retained) and each
  call's model, token counts, sub-agent marker and time.
- A missing file means no records. A file WIRE can't open or whose tables don't
  match is a failed read: the reader says so and an existing total stays.
- Approval applies when collection next reads a chat. Chats WIRE already read
  in full aren't recounted until they change.
- Turning it off stops every read of the file. Totals already counted stay
  until the journal extends that exchange.
- A stored indexed total is retired when the app changes that turn's calls,
  including a corrected amount, model or time on the same row.

- A prompt's indexed turn counts only when the exact prompt text and occurrence
  match.
- Each of the journal's main-agent model rounds for that exchange must hold at
  least one indexed call, and every indexed call must fall inside one of those
  rounds.
- The exchange ends at the journal prompt that owns the next indexed turn, so
  steering stays with its root. Indexed sub-agent calls are included and
  disclosed in the reader.
- Journal receipts always take precedence. The index isn't copied, and no
  prompt text is retained from it. WSL collection of a Windows-owned index isn't
  yet supported.

These optional fields use the existing evidence snapshot; no store conversion
is needed.

When a response explicitly identifies a retained Work IQ run, its request-only
receipt can survive a collection restart before the final boundary arrives.
WIRE still shows no total until it verifies the complete exchange.

#### Returned text size

A matched Work IQ completion may keep its returned text byte count (roughly four
UTF-8 bytes per token), not its body.

When there's no message-level prompt link, an explicitly owned model request in
the verified run can link its tool ID to one exact start. WIRE can then include
that call's returned text size without changing prompt authorship. Older
receipts without that link aren't rewritten.

#### Tool operation tokens

For a separately metered tool, the [Copilot completion contract](https://github.com/github/copilot-sdk/blob/03056de9b9f21203c14037536097c0e1a8774822/nodejs/src/generated/session-events.ts#L10775-L10781)
can supply `tool.execution_complete.data.toolUsage`, even on failure.

- Ordinary collection keeps token counts only for a uniquely matched Work IQ
  invocation.
- The tool's operation ID is digested for conflict detection. No quota, charge,
  provider detail or extra result text is retained.
- Input or output can be missing independently.
- These counts don't enter conversation model totals.

#### Sources for the mapping

The journal mapping follows the
[public Copilot reader](https://github.com/markrussinovich/agent-session-insights/blob/d65c0119b31cea27743e4f4ec21be158977e06aa/sources.py)
and the [SDK per-call/aggregate distinction](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing).

The reference project's [redacted journal](https://github.com/markrussinovich/agent-session-insights/blob/d65c0119b31cea27743e4f4ec21be158977e06aa/examples/creation-session.jsonl)
has 120 distinct call receipts but only 21 assistant message call IDs. An
explicit interaction reference can bind more receipts; message count alone
isn't model-call count. A redacted example doesn't prove a particular installed
source has all the required fields.

| Fact | Preserve |
| --- | --- |
| Original prompt and timestamp | Never replace them with a conflicting later delivery or host-transformed instructions. New associations need unique explicit message/tool-request links and compatible ownership. |
| Automatic continuation | No new message is distinct from a missing/excluded prompt. Event kind does not establish author; unknown records do not default to User. |
| Tool diagnostic | Screened message/code/status/details stay with their original call or returned entry, separately from optional assistant replies. |
| Model and final-response timing | Require qualified source/message/response/turn links. Tool hints, deployment names and the current account cannot fill missing provenance. |

### Services, paths and diagnostics

Service classification uses recorded target paths, not the connector's display
name or prompt wording.

- User-profile relationships such as `/me/manager` and `/me/directReports` are
  People operations. A more specific downstream path can identify another
  service.
- Correcting path recognition updates live views of retained calls without
  rereading history or changing outcomes. Saved report facts and files stay
  frozen.

#### Paths that name less than they seem

- An exact `/me/translateExchangeIds` or `/users/{id}/translateExchangeIds`
  target identifies an Exchange ID conversion request. It doesn't say whether
  the item is mail, an event or a contact.
- The public operation name survives normalization; user IDs, item IDs and
  query values don't become part of its path template.
- An older record that keeps only `/me/{id}` can't establish the operation.
- The generic `/businessapps/me` route identifies no particular business app.
  WIRE tells that recorded limit apart from a path it doesn't recognize.

Ask returns an answer and a conversation ID, not an app-by-app execution log.
Requested sources, attached files and citations don't establish which apps
Copilot used.

#### Paths on returned entries

A structured Work IQ batch can report a path on an individual result. When its
completion matches one recorded Work IQ start, WIRE keeps the normalized path
beside that result's status, without query values, bodies or literal
identifiers.

- A sibling's path is never substituted.
- An older result saved without that path doesn't gain one on reopen.
- A lone requested target can supply explicitly labeled request context, but
  not if another result reports a different path. A pathless sibling then keeps
  its status and no service assignment.

#### Diagnostics

Diagnostics exclude credentials, sensitive or payload-shaped text, stacks,
headers and inner identifiers.

- Text is bounded to 8 KiB.
- Envelope inspection may keep complete entries before malformed syntax, marked
  partial with an unknown supplied total.
- Missing diagnostics stay unavailable. The reader doesn't reconstruct them
  from other calls.

If a Work IQ error message is unreadable, a separately recorded status, code or
error detail on the same error can still explain the failure. WIRE screens
those fields separately and does not assign them to individual requested paths.

A Work IQ error envelope may supply only an HTTP status, with no error text.
WIRE keeps and shows that status without treating the envelope as unreadable or
inventing a cause. An older record's saved status stays readable without
rewriting its evidence. A reported 503 means Service unavailable; it doesn't
establish which downstream service failed or whether an operation took effect.

The decoder also recognizes:

- the `ask` failure envelope with a null response and separate
  `error`/`errorCode`;
- an empty `fetch_blob` response carrying a nested error and status;
- an empty retrieval envelope with `stoppedReason: "error"`, which establishes
  that retrieval stopped but supplies no cause. WIRE says so instead of
  treating it as unreadable.

It keeps the screened diagnostic, not conversation IDs, request IDs, recovery
instructions or encoded file contents. Unknown shapes stay unsupported; the
decoder doesn't search arbitrary response bodies for error-like prose.

These rules apply when original events are collected. Reading an older cache
can't recover text an earlier collector already discarded. A separately
approved, source-bound repair must update the canonical record and any retained
checkpoint together; installing new code isn't that approval. Saved reports keep
their original facts and files.

### Guarded retained-error restoration

The retained-error maintenance policy is separate from ordinary collection and
needs its own reviewed, sealed user decision.

- It binds exact original start and completion regions, canonical calls, every
  retained alias, and both record and checkpoint preimages.
- A named older-retained-target exception doesn't change the collector's
  history window or authorize new calls.
- Restored returned entries are disclosed separately from unchanged tool-call
  counts and outcomes.

#### Checkpoint references

Where an inline diagnostic would exceed the existing 512 KiB context bound,
checkpoint schema 2 can reference the exact completed failed call in the
current canonical evidence snapshot. It stores no second diagnostic blob.

- Resolution checks the store, source namespace, completion identity and time,
  failed outcome and alias agreement. Missing or conflicting dependencies
  refuse.
- At most 32 references and 64 KiB of referenced error carriers can be
  projected from one checkpoint.
- Compact stored events stay separate from hydrated reading events, so
  hydration can't force unrelated context out of the saved cache.

#### Schema 4 fence

Only the explicitly applied maintenance operation installs collector-index
schema 4 and its compatible-reader fence. Ordinary startup and collection never
upgrade a schema-3 store to this format.

- Keep a compatible reader afterward. Older readers refuse schema 4 rather than
  discard its references.
- Source switching preserves the fence; references can't cross store or source
  namespaces.
- Deletion removes the cached event and its canonical dependency together.
  Saved reports stay independent.

#### Prepare and Apply

Prepare doesn't publish evidence or install the fence. Apply:

1. blocks ordinary collection with the operation's pending fence;
2. writes the sealed checkpoint and evidence postimages;
3. releases the pending fence only after the completion journal is durable.

An interruption resumes the same journal; it doesn't create another operation or
restore an old whole board. Once all sealed postimages are committed,
finalization needs no new original-history read. If release is interrupted, the
same operation must finish it before collection can restart. There's no generic
rollback command.

`scripts/maintain-retained-errors.mjs` uses this policy through the existing
maintenance protocol. `inspectRetainedErrorRepair` is a read-only projection
check, not Prepare, approval or permission to apply it.

### Prompt authorship

Prompt authorship comes from supported host provenance, not the `user.message`
role or the wording.

- Host-added image references must match the event's attachment metadata. They
  don't supply an author themselves.
- Reading saved activity never rereads original author envelopes.
- Correcting an already-qualified unverified author needs a separately reviewed,
  bounded original-event lookup and repair. The image-envelope classifier
  doesn't trigger that repair automatically.
- Literal image-reference examples in the original prompt, or a supported canvas
  attachment, stay content, not host provenance.

#### Sender versus requester

The sender of a saved message is separate from the link between a call and its
initiating request.

- Within existing checkpoint limits, WIRE keeps the assistant's outstanding
  tool-request identifiers beyond the recent-event window, so a later start can
  still match the original message and turn. This keeps no extra reply text.
- A uniquely linked Work IQ call keeps its prompt and assistant-request event
  references. A group-level link from an older record isn't evidence for each
  call in it.
- Reading old records doesn't reopen history or assign a requester from a skill
  or system message.
- Two distinct retained starts for the same invocation can't prove a direct
  link. New collection marks that conflict before trimming the checkpoint, so
  keeping only one start doesn't erase the conflict after restart.

If an original assistant request arrives after its tool call was saved as
complete, WIRE can add a missing direct link to the same prompt without changing
the sender, call or result. The prompt identity, text and time and all existing
call facts must match. A request replayed from a checkpoint doesn't repair
history.

If copies of a single message name conflicting senders, the sender stays unclear
even when the timestamp and original text agree.

#### Host framing that isn't sender evidence

Several host additions are neutral framing. WIRE recognizes each only at its
supported position, and the usual source, timestamp, sender, attachment and
agent-created kickoff checks still decide the author:

- The direct-message source reference: the supported UUID/revision envelope and
  fixed footer, only at the exact outer boundary after the original text. Typed
  imitations, altered or duplicate references and unsupported layouts don't
  establish a human author.
- The `[[PLAN]] ` prefix: runtime mode framing, recognized only after the
  qualified timestamp and outside the exact displayed message. The historical
  plan-mode notice and app branch context are also neutral; their prose can't
  establish a sender.
- Steering delivery without a timestamp: the supported steering path can omit
  the timestamp wrapper around a cross-session sender envelope. WIRE accepts only
  that complete, isolated sender frame with a valid logical message ID and
  recorded steering delivery, and still validates the sender fields and source
  contradictions. Timestamp-free direct input, extra context and other delivery
  paths don't gain a guessed human author.
- Trailing whitespace: the runtime can remove trailing spaces and line
  endings from model input while keeping them in the timeline. WIRE recognizes
  that exact trailing transform without changing retained text or normalizing
  leading or internal text.
- Attachment descriptors: the app's display and model projections can
  differ for an attachment. For one explicit file with a unique displayed label,
  WIRE checks the whole path-bearing model descriptor against that recorded
  label and path. Missing or ambiguous metadata and any other body difference
  stay unqualified. This isn't fuzzy matching or general Markdown removal;
  original timeline text stays intact, file contents are never opened and
  attachment paths aren't added to retention.

#### Unverified reason codes

New author qualification can keep a closed `issue` code with the existing
actor/basis pair. None of these codes proves malformed source data or supplies
an author, and raw host context stays excluded.

| Code | Meaning |
| --- | --- |
| `body-boundary-v1` | The original prompt did not match a supported transformed-message boundary. |
| `host-wrapper-v1` | The host-added prefix was not recognized. |
| `source-value-v1` | An unsupported source value. WIRE saves neither the value nor the host text. |
| `workspace-origin-v1` | Workspace details without verified origin. |

A layout rejection can't be turned into a claim of contradictory sender records.
Separate qualified origin evidence can establish an author without making the
model-text layout supported. Canonical evidence owners resolve origin
disagreements before author filtering; duplicate-only legacy copies don't
override the current owner.

#### Classifier versions

Each version covers newly consumed originals only. Installing a version doesn't
reopen or relabel already-qualified records or compact checkpoints; those copies
need a separately approved, source-qualified repair.

| Version | Adds |
| --- | --- |
| 9 | The direct-message source reference as neutral framing. |
| 10 | An autopilot-mode transition notice when the recorded mode is autopilot, without a plan marker or mixed mode blocks. This keeps a supported sender envelope visible to the same author checks. Autopilot mode alone never means an agent authored the prompt or that an automatic continuation occurred. |
| 11 | Checks the direct-message reference and a following image notice separately. |
| 12 | A canvas attachment immediately before that reference. The canvas contents stay opaque, including quoted sender or attachment markers. With a matching timestamp, message ID, delivery and original text, the reference can accompany the app's ordered workspace sections outside plan mode. Workspace text alone doesn't establish a sender, and a cross-chat sender, automatic continuation or agent-created first message still goes through its own origin checks. |
| 13 | Reads the Copilot journal's `user.message.data.agentAuthored: true` as an explicit Agent origin, including a kickoff with no separate sender envelope. A false or absent flag doesn't identify a Human. An explicit user or system source that contradicts the flag stays unverified. `shell` is a supported execution mode, not a sender. |
| 14 | An older idle original with no logical send ID. It needs a valid journal event ID, the matching timestamp and exact original display boundary, plus either the validated app direct-input reference or an explicit host-added cross-chat sender. An ID, plain timestamped text or a marker typed in the prompt isn't enough, and WIRE doesn't invent a logical message ID or attach a tool call to a message by order. |
| 15 | A system-delivered message carrying the [SDK's per-message continuation flag](https://github.com/microsoft/copilot-sdk/blob/2dfe56f7a205e0a4f13b6c02fc36afeb035650eb/nodejs/src/generated/session-events.ts#L7321-L7323) becomes **Agent prompt (automatic continuation)** when there's no competing sender evidence or unresolved kickoff guard. See [reader compatibility](#prompt-origin-reader-compatibility). |

Both version 13 fields are defined in the
[Copilot session event schema](https://github.com/microsoft/copilot-sdk/blob/2dfe56f7a205e0a4f13b6c02fc36afeb035650eb/nodejs/src/generated/session-events.ts#L7281).
Older versioned `missing-source` entries are eligible for the bounded review
below. A review that still finds no supported sender proposes no change. The
creator/kickoff and competing-source checks apply to version 14 too.

For example, a prompt already marked unverified by version 10 keeps that label
after an upgrade, even when every call links directly to it: the links identify
the request, not its author. Already-qualified prompts aren't reopened or updated
on startup. To correct a retained author, review that original through the
procedure below rather than refreshing the chat.

### Prompt origin reader compatibility

The continuation flag records injection by the autopilot loop, not merely the
mode that was open.

- A system message by itself, an idle delivery or wording that sounds automatic
  isn't enough for version 15.
- This is sender evidence for the message, not proof it started a particular
  call.
- Installing the classifier doesn't repair a previously qualified conflicting
  sender.

#### Readers must recognize `host-agent-authored`

Once `host-agent-authored` is written, both the active reader and the fallback
must recognize it in retained prompts, interaction validation and JSON-only
saved reports (v13 origin support or a verified reader backport).

- A v12 reader can open the saved JSON yet render the Agent prompt as
  unverified.
- An unchanged file hash or a healthy server doesn't prove compatible reading.
- Before first collection or offline repair on the real store, verify the
  intended primary and fallback on an invented marked prompt and its JSON-only
  saved report, as well as a previously saved report.
- Don't use a v12 fallback after a marked origin is written.

The collector schema-4 guard is separate and doesn't establish this
compatibility.

#### Historical origin correction

Historical origin correction is separate from collection. The prompt-origin
maintenance policy binds exact original regions, every retained origin and
follow-up copy, and its checkpoint preimage.

- Its read-only inspector proposes changes but doesn't authorize them.
- Prepare and Apply use the existing sealed maintenance journal and offline
  writer guards. They change only author metadata and need an explicit decision
  for the named retained targets.
- Prompt text, calls, source cursors, privacy choices and existing saved reports
  stay unchanged.
- An interruption resumes the same operation rather than creating a
  replacement.

Apply uses the existing persisted sealed-operation fence before any checkpoint
write, and normal collector startup refuses until that operation is complete.

- An index at schema 3 advances to the store-bound schema-4 reader capability.
  An existing schema-4 store keeps its registry and binding.
- No completion references are created by an author correction.
- Keep a compatible reader after application. Don't remove the fence or restore
  an older index to bypass it.

Named checkpoint-only companions can correct an existing context message without
creating a retained interaction. They're counted separately, preserve all tool
and repaired error carriers, and bind honest before and after checkpoint hashes.
Already-known origins stay outside the unknown-only repair population.

### Review older unverified authors as a group

Use the existing prompt-origin maintenance command. You don't need a screenshot,
a prompt excerpt or a hand-built event pin. Keep its output private: it contains
local source identifiers and hashes, not prompt or reply text.

```text
node scripts/maintain-prompt-origins.mjs --mode list --data-dir <absolute-store>
node scripts/maintain-prompt-origins.mjs --mode list --counts-only --data-dir <absolute-store>
node scripts/maintain-prompt-origins.mjs --mode review --data-dir <absolute-store> --batch <listed-batch>
```

The default is the current window and active sources. To review older dates or
archived local chats, add `--include-older` or `--include-archived` to both the
list and review commands. These options don't change collection settings.

#### List

`list` reads only the retained store. It groups older unverified origins and
their retained copies by chat, lists batches of up to four, and counts excluded
origins by reason. A candidate is **not** a finding that the author was human.

`--counts-only` returns no member or batch IDs. It counts canonical Work IQ tool
calls and their originating interactions across **all retained dates**,
including earlier and inactive Copilot records and excluding platform metadata.

- Follow-ups don't add interactions.
- All unverified interactions count, even if they have no reviewable event.
- The reason and version groups describe retained evidence, not what a new
  original lookup would find.
- The time and archive choices affect review eligibility, not this
  all-retained denominator.

`--mode list --originating-only` gives a private case list on **one** verified
retained revision. Each unverified canonical interaction has a store-bound case
reference and either its batch and one-based position or an exclusion.

- The saved call-to-prompt association is separate from who sent the message.
  Message order alone can't identify the initiating request.
- A listed source's `consumedBytes` is its retained fully consumed cursor (or
  null), not a live file check.
- Follow-up copies of selected originals are counted, but follow-up-only
  originals don't enter these batches.
- Use the same `--originating-only` and time and archive choices with
  `--mode review`. A general batch can't be substituted.
- The list needs no journal or checkpoint read. It isn't a proposal, permission
  or persistent index.

#### Check one case's call links

For one eligible listed case, `--mode links --link-check <linkCheck>` with the
same `--data-dir` reads only its retained store and one compact checkpoint, not
the Copilot database or original journal. It returns the case reference and one
opaque reference per selected Analyze call.

| Field | Meaning |
| --- | --- |
| `same-origin` / `different-origin` | A unique retained start and assistant request name a logical message. |
| `checkpointOriginRef` | Identifies that message without exposing its source ID. |
| `retainedSender` | Describes only that message's saved checkpoint metadata. |
| `fullSourceUniquenessChecked` | Always false. An older checkpoint may already have discarded a competing start before it could be marked. |

A missing start or request is a limit of the checkpoint, not proof that the
journal lacks it. A disagreement with a board link isn't resolved by preferring
either copy. The check can't prepare, apply or authorize a repair.

#### Review

`review` checks the selected chat's approved local mapping and reads one bounded
page of its fully consumed journal.

1. Run `review` for the listed batch.
2. If it returns `status: "continue"`, save that JSON as UTF-8 in a private file
   **outside** the checkout and store.
3. Run the same `review` command with `--previous <absolute-page-file>`. Keep
   each new page separate from the one you're reading.
4. Repeat until the full journal has been checked for competing event
   identities. No proposal is made before then.

Pages can't be mixed across batches or changed sources. An unreadable, oversized
or ambiguous source region prevents a complete review; it isn't an empty batch.

What a page must establish:

- Every ordinary entry must establish an unambiguous outer event ID and type,
  including escaped JSON keys.
- Noncanonical or duplicate fields inside an unselected payload don't establish
  or disprove a sender. Startup and each proposed original still need
  full-field verification.
- An ambiguous selected payload with a unique envelope stays unresolved. An
  ambiguous envelope can hide another selected ID and blocks the whole page.
- For a complete oversized entry already inside the same page budget, a bounded
  streaming check can establish just its unique outer ID, type and timestamp. It
  doesn't project a sender or payload; a collision still counts, and an
  oversized selected original can't become a target.
- Malformed input, excessive parser work and entries that can't fit a verified
  page still refuse.

Between pages of that exact source, a new check time, cycle counter or another
chat's cursor alone doesn't invalidate already verified bytes. These must still
match: the selected source and cursor, compact checkpoint preimage, original
journal, database identity and mapping, board and configuration, source
membership, host owners and global guards. Each invocation needs a stable
control read, and the final proposal seals the **current exact** index bytes.
Prepare and Apply don't use this page-continuation exception.

Named read-only author reviews use two independent metadata observations at each
page boundary.

- Both must identify the same physical database, schema and complete selected
  mapping, including managed events.
- Access, retained controls and the journal boundary are checked around each
  observation.
- Unrelated app commits don't require the whole Copilot database to become idle.
  Changed selected mappings, withdrawn access and changed history still refuse.
- These observations carry **no whole-database publication stamp** and can't
  replace the strict stamped reader used by collection or Prepare/Apply.
- The retained board, configuration and index must still stay unchanged during
  each page. A long review needs a stable WIRE store cut; the separate Copilot
  producer can remain active.

The selected mapping proof binds continuations and proposals. The revised
continuation seal rejects pages from the earlier stamped-review reader: start a
newly bound review rather than joining an old partial scan. Prepare and Apply
still perform their own strict metadata, original and checkpoint checks.

#### Read the result

The final `targets` are the corrections the original records actually support.
Reviewed corrections may identify either a human or an agent. `unresolved`
explains why other candidates stay unverified.

If an agent-created chat lacks its saved first-prompt ID, a completed review can
still prove a selected direct input was **not** its kickoff. It seals the
earlier first event's digest to this store, source mapping, complete journal and
exact selected region. An unsealed flag, a nearby timestamp or the first event
itself can't remove that guard. Prepare and Apply verify the same seal and
original; neither edits the collector's first-event pointer.

For **new collection**, the reader also checks the startup bytes it already
reads. If a verified first event isn't there, consecutive, already-approved
prefix pages can establish it across restart. Only the offset and byte anchor of
a clean prefix carry forward. A gap, malformed or duplicate fields, a replay
entry or a changed source can't turn the first *visible* prompt into the first
prompt of the chat. No extra file scan is started and previously retained
authors aren't bulk-updated.

For an exact original the classifier can't qualify, the private review receipt
includes the failed host-envelope condition, a fixed sender and delivery
category, the host flag states, and the checked original-region pin. It contains
no raw sender value, prompt or transformed input. For example, a missing logical
message ID and a timestamp disagreement are separate observations. These
observations explain a refusal; neither assigns a sender nor grants another
read.

#### Apply an approved correction

Listing, reviewing and installing a new reader don't write these changes. For an
approved correction:

1. Use the returned targets, source and state guard in the existing offline
   Prepare/Apply plan.
2. Preserve its stopped-runtime attestation, saved-file guards, review seal and
   separate confirmation.

A changed source invalidates the proposal. A stale batch must be listed again;
don't weaken the guards or replay calls.

#### Inspect a batch directly

For a complete correction batch, `inspectPromptOriginRepair` also accepts
`origins`: exact source and event identities, pinned original regions and the
explicit `olderRetained` choice. It uses the same classifier as collection,
derives every retained alias and checkpoint hash, and returns bound targets
alongside explicit unresolved or already-known exclusions. It doesn't infer
missing identities from matching text.

- One operation can include up to 32 origins.
- Each inspection, preparation or apply invocation stays within the existing
  32 MiB original-read budget.
- Both input paths reserve up to three complete original-verification passes,
  including their repeated event and startup reads. A larger batch refuses
  before reading.

#### Legacy and archived originals

Legacy copies with genuinely absent author metadata can be corrected without
treating missing versions on known authors as permission to overwrite them.

`includeArchived: true` permits review of exact retained originals from a
currently verified local archived source. It isn't source restoration or
collection.

- The resulting target seals that source mapping and the legacy exception.
- Current metadata must establish local provenance independently of the archive
  flag. Nonlocal, ambiguous and unavailable mappings refuse, and a compatible
  metadata reader is required for that proof.
- Explicit-source and legacy targets can't omit the fresh source mapping guard
  through the lower-level target interface.
- The older nonlegacy host-target format stays readable only when fresh
  metadata still matches its retained source identity. Cached eligibility alone
  never authorizes the correction.

Source mappings and pinned originals are checked again before first effects and
before board publication. Drift leaves the same journal and any pending fence in
place; completing an already committed postimage doesn't replay old source
reads. None of this changes the automatic legacy qualification threshold,
collection window, source eligibility or saved reports.

## Optional replies

**Settings > Privacy & saved data > Recorded replies** has a draft switch and a
separate confirmation. The supported category is already-recorded assistant
text.

| Bound | Maximum |
| --- | --- |
| One item | 64 KiB |
| Items per interaction | 20 |
| Text per interaction | 256 KiB |

- Partial capture and unverified finality stay explicit.
- Credentials are excluded. Entity response bodies, citation fetches and new
  source discovery aren't added.
- Reader and Search payload reads recheck current source, consent, membership,
  basis and integrity. Opening a reader doesn't turn on saving.
- Turning saving off removes optional text and its dependent retained
  annotations through sealed cleanup, not base activity or independently saved
  reports.
- Source or scope changes need a new deliberate approval. Browsing filters and
  ordinary collection within that approved scope don't.

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

How dates apply:

- Ranges include both civil dates in the applied IANA zone, including 23- and
  25-hour DST days.
- Calls use their start time or their established group-capture fallback.
  Other layers don't borrow that clock.
- Unknown or invalid times stay out of ranges; All includes them.
- Spanning groups keep surviving records and shared prompts without changing
  their metadata.

| Scope | Treatment |
| --- | --- |
| Active evidence, checkpoints/context, dependent replies/annotations, unsaved caches, known managed recovery/migration copies | Included in the sealed plan |
| Source configuration, approval, cursors, roster and reading receipts | Preserved |
| Saved reports/comparisons and their managed copies, external downloads and original sources | Preserved; artifact deletion is separate |

This is logical and filesystem deletion, not forensic erasure or an undoable
backup.

Only hash-based suppression of the confirmed identities and events remains.
Polling, rotation, restart and later results can't automatically reimport them.
Genuinely new calls stay collectible; previously unread history wasn't part of
the confirmed set.

A durable journal comes before cleanup. An interruption blocks affected reads.
Changed, linked, unrecognized or ambiguous files and records refuse rather than
guess.

| Cleanup bound | Maximum |
| --- | --- |
| Files / total bytes | 20,000 / 2 GiB |
| One file | 16 MiB |
| Unique records / compact metadata | 64 MiB / 32 MiB |

Exceeding a bound refuses before anything changes.

Saved-artifact deletion has its own [scope and recovery contract](report-contract.md#saved-artifact-deletion);
activity permission isn't artifact mutation permission.

## Explicit recollection

In the normal Copilot runtime, this is a review of **missing, nondeleted
activity**.

- Both local source approval and active acquisition must still be valid. This
  operation doesn't use manual Refresh's Pause exception.
- A panel can preview its selected scope without writing evidence. Only a
  separate confirmation of that still-current preview can publish it.
- It can't restore suppressed calls or deleted prompts.
- Reading an existing receipt doesn't need another source read.

### Steps

1. Open **Read history again > Choose chats** and select eligible approved local
   chats. Selection survives paging. Inclusive dates intersect the approved
   window; they do not grant wider history or a new source.
2. Read the preview's deleted, newly available, already-present and unavailable
   counts. Bounds are 128 chats, 32 MiB per read, the last 64 MiB per file
   and 20,000 candidate records.
3. Confirm only the changes you reviewed. If the result is uncertain, use
   **Check recollection result**, including after reload/restart, rather than
   confirming again.

An edit in a different Copilot chat doesn't invalidate your preview by itself.
WIRE rechecks the physical source database and the selected chats, their
histories and the proposed changes before saving.

- A changed selection or expired preview needs a fresh review.
- The panel tells a known refusal before saving apart from a lost response. Only
  a lost response needs a receipt check.
- Neither is retried automatically.

### Corrections to saved calls

**Also review source-verified corrections to saved calls** is off by default.
The preview names each proposed change (up to 32).

- An unknown can become a completed call only through the bounded original
  start and completion qualification. Omitted bodies or HTTP statuses aren't
  recovered from success alone.
- For an already completed call, WIRE can fill an absent result or failure
  carrier when the start, completion, outcome and retained entries agree. It
  never replaces conflicting facts.
- Duplicate targets, an unread prefix or incomplete tail, and missing or
  contradictory checkpoint evidence prevent correction.
- Checkpoints and saved reports aren't rewritten. If an existing checkpoint needs
  a different postimage, the separately reviewed maintenance path is required.

### Large chats

For **one chat, one day, missing records only**, a large log can take more than
one read.

- **Read next part** continues from the verified byte boundary. It doesn't start
  another scan or show partial counts as the final selection.
- After confirmation, **Continue verification and save if complete** checks the
  same original selection before any write.
- Each phase allows at most three 32 MiB reads (including repeated partial lines
  and source checks). The file must fit the 64 MiB source window.
- A continued read with an unfinished, malformed or oversized entry, or an
  unqualified prompt or credential-bearing entry excluded by retention, can't
  certify that day and offers no save.

Only one large-chat read is held in memory at once, with bounded screened event
context and no raw partial-line buffer on disk.

- Cancellation, access withdrawal, restart or the original two-minute deadline
  retires it. Continued steps don't extend the deadline.
- The collector's normal source cursor and other stored receipts aren't used to
  resume a review.
- On the oldest partly approved day, only records inside the original window can
  be proposed. If any proposed record leaves the rolling window before saving,
  the whole selection is refused rather than silently shortened.

### Verified records only

**Verified records only (day incomplete)** is a runtime opt-in. Strict recovery
stays selected by default.

- A Copilot-only runtime started with `--verified-record-recovery` also offers
  this operation.
- Opening the chooser on that runtime doesn't read the chat list. **Load
  eligible chats** reads the list; previewing and confirming the selected calls
  stay separate.

This is a separate choice for one chat and one day, not a fallback from a failed
full-day preview. It lists up to 32 missing calls whose original identities,
explicit message and tool links, and recorded completions can be checked
independently.

- A completion with no reported outcome stays **unknown**.
- No completion is inferred from a neighboring event.
- An unidentified region that could hide another matching identity prevents the
  preview, even if it's outside the proposed calls.

#### Parser budget

In this mode only, each bounded read step can spend up to four extra parser
pages on structurally dense entries.

- Each page keeps the ordinary 100,000-token limit, yields between pages and
  rechecks access and the selected file.
- Only the completed, validated entry is available to the identity checks.
- An unread tail, an unsupported field or an exhausted budget still prevents
  recovery.
- Ordinary collection and strict recovery keep their existing limits.

#### Records that need not block a call

None of these grants access, supplies attribution or connects a prompt to a call
on its own:

- A supported SDK startup header can contain typed workspace, model and tool
  settings. WIRE still requires the source's mapped session identity and
  supported version. Its values aren't copied into the recovered call or its
  receipt.
- A separate assistant turn, or a text-free Copilot mode or permission notice.
  WIRE checks the notice's declared fields and identifiers against the whole
  source and its checkpoint. Unknown fields, ambiguous identifiers and
  unclassified oversized entries still prevent a verified-record preview.
- For a permissions notice recorded as `on`/`off`, both the previous and new
  modes must agree with their corresponding Boolean flags.
- A remote-session notice may name a canonical GitHub Copilot task URL. WIRE
  checks the task identifier for conflicting claims, but doesn't visit the URL,
  import the task or use it to connect a prompt to a call.
- If another saved prompt's text happens to equal the call ID, WIRE can tell that
  text apart from a second request. The complete checkpoint row and saved prompt
  must match a unique original, and the ID must appear there only as text. An
  actual competing request still rules out the call.

#### Linking a call to its prompt

The assistant's `originatingMessageId` identifies the initiating user message;
`parentId` identifies the preceding journal event. They need not point to the
same event.

- A review can verify the user's message across up to 32 typed, consecutively
  linked timeline notices and a matching turn start. The explicit origin,
  request, turn and call must agree; chronological order alone is never enough.
- Intervening system or developer text isn't a user prompt and isn't copied into
  the call.
- A linked turn end is checked against the completion. It changes neither its
  outcome nor the receipt's incomplete-day coverage.
- A prompt can also follow an independently verified session notice in the
  selected interval if the prompt names that immediately preceding event. This
  checks journal order only; the assistant must still name the prompt
  explicitly.

For a first message, WIRE can verify the recorded session-start,
prompt-submission and prompt-transformation hook pairs in order. All must belong
to this source, finish successfully without output, and agree with the original
message and its transformed copy. Hook text isn't saved and doesn't establish
authorship.

A task-linked prompt may also record a parent-task ID, an interaction ID, an
empty native-document list and reasoning settings. WIRE checks those IDs
separately from the source, prompt, request and call. A parent-task reference
may recur in the same role; neither ID can stand in for the initiating message.
A conflicting identity or checkpoint claim still prevents recovery.

#### System and developer instructions

The historical SDK also records which interaction received a system or developer
instruction. When that instruction immediately follows its original prompt, WIRE
can verify their shared interaction ID and bounded template metadata
(`promptVersion` and JSON `variables`).

- It screens the complete instruction but doesn't keep it or use it to choose a
  call's owner.
- A second request claiming the same call still excludes the call.
- If an instruction prevents the review, WIRE distinguishes an unverified prompt
  link, an unsupported template, excess template size, incomplete original
  verification and a privacy exclusion, without showing the contents.

#### Saved parents

If the original prompt exactly matches a single saved parent in this chat, WIRE
can keep that parent and its recorded author, including an agent author, without
writing a new prompt.

- The explicit request and call must agree on their turn. The originating prompt
  can be from an earlier turn.
- WIRE screens the complete original prompt and assistant request before using
  their bounded retained fields. It neither truncates the prompt to fit nor keeps
  the assistant's discarded text. This doesn't make an unresolved reference
  safe.
- If multiple saved parents claim the original prompt, or its saved parent is
  ineligible, WIRE doesn't treat that prompt as missing to recover the call.

For a newly verified human prompt, the assistant request may exceed the
individual-record limit because of reply text alone. WIRE screens the full
original, keeps only the bounded request, and requires an app-mapped start. The
prompt, call and completion still have to qualify independently.

A start that records only its logical tool name (such as `fetch`) can qualify
when the app identifies that exact start as Work IQ. The name alone can't qualify
a call or override a conflicting recorded server.

#### Unrelated tools, canvases and hooks

An unrelated external-tool request or canvas record can be classified when its
matching close is the next original event.

- The supported forms carry no tool arguments or canvas input; an empty
  arguments object is also allowed.
- Their IDs must be disjoint across the whole journal, including original fields
  that JSON parsing could hide. Even separate canvas lifecycles reusing an
  extension or canvas ID are refused.
- Neither an external completion nor a canvas close can supply a missing call
  outcome.

A compact, text-free post-tool hook may close directly after its matching
unrelated hook start. Its success flag describes the hook, not the tool call. An
unmatched close, an intervening record or an unverified hook body can't supply
that link.

#### Work IQ hook chains

For an app-mapped Work IQ start already linked to the user's prompt and the
assistant's request, the completion's parent can instead lead back through three
adjacent hook pairs: `preToolUse`, `preMcpToolCall`, then `postToolUse`. For an
app-mapped managed start, the MCP hook can name the exact same managed server as
the original start instead of the literal `workiq`. An unrelated server name or
an unmapped identifier doesn't establish this link.

The start, all six original hook records and the original completion must fit in
one read part. WIRE checks:

- every parent link and event time;
- the distinct event and invocation IDs across the source and checkpoint;
- the hook session, tool, `workiq` server on the MCP hook and arguments;
- the completion's own call and turn.

Only the completion reports the outcome; missing success stays unknown.

- Projected hooks, ambiguous original fields, credentials and deleted
  dependencies can't qualify the chain.
- WIRE binds the original bytes. For entries up to 16 KiB it can also verify
  harmless JSON spelling differences, such as `17.0` instead of `17`, without
  accepting duplicate keys or rounded values.
- Explicit `checkpoint: false` and `ephemeral: false` flags are compatible with
  an ordinary original; replay copies and transient records aren't.
- Even a directly linked call can't be proposed if another original in the
  journal could hide a conflicting identifier.
- WIRE refuses a split hook chain rather than carrying private arguments or
  result bodies into the next part.

#### Confirmation and receipt

Confirmation rereads the same bounded originals, using the same two-minute
deadline and explicit reading steps. A changed mapping, file, checkpoint,
approval, selection or review basis refuses the operation. The writer preserves
other records, consent, checkpoints and saved reports.

Its original receipt identifies each added call and always says **verified
records only; day incomplete**.

| Count | Meaning |
| --- | --- |
| Proposed, added | Calls. |
| Excluded | Observed candidates that weren't admitted. |
| Unknown | Proposed calls without a recorded outcome. |

None of these estimates the number of missing calls in the day. Byte-span
witnesses aren't stored.

If WIRE refused the original confirmation before writing, the panel says nothing
was saved and gives the reason. A lost response, or a response for a different
operation, isn't that proof: check the original receipt instead of confirming
again.

### Compatibility-mode previews

Older compatibility-mode previews can include deleted records. Only those
previews offer **Also restore original prompts for these requests**. It starts
unchecked and needs an exact association between the selected call and its
source prompt. Neither normal recovery mode offers that choice.

- Host envelopes can't promote an agent kickoff to User.
- Anonymous local records and owned HTTP diagnostics can't be recovered through
  this source reread.

### What confirmation publishes

Confirmation rechecks source stamps, mapping, approval, revision, expiry and
canonical membership. It then atomically publishes evidence, narrowly scoped
hash-only restoration grants and its receipt.

- Shared event and context suppression isn't cleared broadly.
- Deleted optional replies don't return.
- Saved reports, source files, cursors and settings stay unchanged.

The result check neither rescans nor repeats confirmation. Missing remembered
scope is stated, not reconstructed from receipt counts. Malformed or unreadable
recovery storage stays untouched and blocks new recollection. If the stored view
fails after commitment, read stored activity instead of recollecting again.

## Refresh and uncertain outcomes

A manual check's receipt and its applied stored revision are distinct.

- No-change, late results, outside-view updates and incomplete history stay
  separate.
- Previous accepted results survive an ordinary failed read. Access withdrawal
  instead clears private content.

A missing or unreadable approved metadata file is a known source-read failure,
including the file checks before opening SQLite.

- Refresh names the source problem and keeps Review source and Read stored
  activity available.
- It doesn't replay the check or change approval or Pause.
- An absent optional SQLite WAL is normal; an unreadable companion file isn't.
- Failures after publication begins still need outcome recovery rather than
  being relabeled as no-effect source failures.

GitHub checks don't have client-request correlation for a lost response, and a
newer last-check timestamp can't settle that operation.

- The tab's verified pending sentinel survives reload.
- Uncertain checks allow stored and status reads, not another dispatch.
- Sentinel storage failure blocks checking explicitly.
- This is tab-session protection, not runtime-wide cross-tab correlation.

Settings configuration uses its last-read version and rejects stale writes.
**Read current connection** reconciles saved settings without claiming a lost
write's original receipt. Unsent safe preferences can survive withdrawal;
private source-path drafts can't. See [runtime access](runtime-access.md).
