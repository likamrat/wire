# Screened retention and storage compatibility

`lib/native-persistence.mjs` owns account-qualified retained roots,
configuration/privacy revisions and operation readback. It does not acquire
Microsoft data or admit the raw review-only v0 writer. The release remains
Copilot-only; these interfaces require the deliberately composed incubation
runtime and genuine backend authority.

## Screening, identity and custody

`m365-native-screened-observations-v1` stores closed normalized facts,
availability, relationships and interpretation, not raw provider carriers or
UI projections. Source normalization and pre-stage/disk/readback validation
independently apply shared JSON bounds and mandatory credential screening.
Decoded keys/strings are checked as well as serialized structure. A URL in one
JSON string cannot combine with a different value to manufacture userinfo.

Qualified account association retains actual issuer, tenant, subject and
transport partition. It does not infer JWT/Entra equivalence, realm or current
authority from historical tuples. The current native-account namespace is v2.
An existing v1 partition can match only through the fresh original principal,
routing and Cowork header witness under the same verification owner/generation.
The verifier does not receive a requested stored partition as proof.
No migration/rekey/alias ledger is inferred from equal-looking IDs.

Intrinsic observation identity is account/source/conversation/native scoped.
Unchanged content reuses an immutable variant with added capture provenance;
changed content remains a separate variant. Latest accepted variant is not
inferred source chronology. Source disappearance does not delete retained data.

The existing collector owns the single process lock. Native persistence checks
its actual PID/token custody and enters lifecycle admission before the board
writer. It never acquires another writer or reenters the collector queue.
Content-addressed files are verified byte-for-byte before reuse.

## Configuration and acquisition

A branded persistence instance belongs to one context/lifecycle. Its exact
`readAuthorized` function is not replaceable with a shape-compatible callback.
Explicit metadata-only pre-account mode can report that no Microsoft account
is configured without reading retained source content. It still requires
current WIRE retained access and validated metadata. Known-account failures
never become empty/not-configured success.

Explicit configuration intents use the original offer's generation,
authorization/configuration revision and source choices. First Enable needs
fresh verified identity and grants that account; Save preserves committed
Pause. Native-only schema 1 and source-aware schema 2 with `globalRevision`
remain distinct. Stale offers/drafts are not rebased by polling.

Only the dedicated global setter changes the absent-or-explicit global policy.
Enrollment and ordinary saves cannot create running state, remove Pause or
resume another source. Committed settings are adopted inside the same
lifecycle turn; uncertain post-write failures close stale authority.

The acquisition lifecycle is:

1. `begin` durably registers original owner, account, intent and
   configuration/privacy/write-generation basis before acquisition.
   Only its genuine new ticket may call the source.
2. `commit` screens, rebases, stages/fsyncs, publishes the pointer and receipt,
   then validates actual disk readback.
3. `retire` permanently fences unused/queued work.

Registered pending/unknown operations cannot become fresh acquisition under
the same ID.

Native schema-1 public receipts keep observations, variants, provenance, reuse
and suppressed-observation changes separate. Registration/HTTP 202 is not
commitment. Loss after dispatch remains unknown until original-owner readback;
there is no fabricated legacy GitHub last-check receipt.

## Operation receipts

| Receipt storage | Rule |
| --- | --- |
| Live acquisition entries | Limit 1,024; not a lifetime successful-cycle quota |
| Archive trigger | Near 128 live entries, old committed receipts may move to metadata-only indexed SQLite |
| Always inline | Latest 64, current-pointer, live-ticket and unresolved receipts; these can still exhaust capacity |
| Archive identity | One existing collector-owned file and schema, bound by the private marker |
| Row | At most 16 KiB |

Archive creation commits and reopens its identity before anchoring it, with
original receipts still inline. FULL-synchronize and reread copies before
compaction. Exact owner/account/ID lookup checks both locations; a missing
or corrupt archive never permits replay.

Rollback-journal recovery, if needed, requires the existing writer custody and
an existing canonical archive opened read-write without creation. SQLite
performs recovery; application code does not delete the journal or invent a new
archive. Final retained authority is rechecked.

First-failure/predicate/admission/protocol metadata is closed and content-free,
attached to the original issued ticket. It can preserve the original failure
after lease withdrawal without authorizing content reads or late commit.
Cleanup cannot replace that cause; committed receipts remain committed even if
later completion handling fails. Optional fields require matched strict readers
across live/archive/restart, not stripping or normalization to an older binary.

## Segmented roots

`m365-native-screened-segments-v2` reuses the SCREENED data contract and policy.
Its canonical content-addressed blocks are:

| Block | Shape |
| --- | --- |
| Root | Null tree or one bounded descriptor |
| Page | Level and 1-128 child descriptors |
| Segment | 1-128 strictly ordered typed rows |

Descriptors bind hash, kind, level, first/last key and count. Disjoint ordered
ranges, verified totals and depth at most 64 are checked by traversing the actual
graph. Every block keeps the 16 MiB expanded JSON/privacy/node/per-fact limits;
this is not a whole-history retention cap.

Capture, observation, variant, variant-index, record, provenance, unit and
membership rows form verified relationships. Variants retain original seed
capture/facts; additional provenance does not duplicate content. Observation
ordinal ranges, current variant, call/conversation membership and capture-use
witnesses must agree. Missing/dangling/foreign/duplicate rows fail before use.

Staging must:

1. Keep bounded segment/page buffers.
2. For v1 adoption, read one validated bounded v1 document and a new bounded
   capture. For v2 append, stream old rows with bounded indexes/lookahead.
3. Reopen the completed graph and check its ordered length-prefixed row digest
   before returning a candidate.

It does not rebuild a whole-history array.

Inserting variants can shift current root ordinals while preserving each older
immutable root's original mapping. Unchanged variant segments reuse addresses.
Every old row must be conserved unless explicitly removed by a separately
authorized deletion. Tombstoned observations cannot silently reappear.

Only a **new Collect** may use `beginSegmented/commitSegmented` to adopt v1 or
append v2. First registration establishes schema/version compatibility before
publication; a failure can leave old v1 data authoritative alongside a new
pending operation. No startup/read/adoption-only success is invented.

## Compatibility matrix

| Board version | Native retention | Native report policy | Global policy |
| --- | --- | --- | --- |
| 2/3 | Absent | Absent | Absent |
| 4 | Schema 1 | Absent | Absent |
| 5 | Schema 1 | Required | Absent |
| 6 | Absent or schema 1 | Independently optional; needs retention when present | Required |
| 7 | Schema 2; pointers may still be v1 | Independently optional | Absent or valid explicit pair |

Ordinary saves preserve the highest established version, sticky report policy
and exact global pair/absence, even when a callback replaces the whole state
or removes the last native artifact. Registration, source configuration and
deletion do not silently downgrade.

Old strict readers reject newer fields/formats. Keep matched retention,
archive/checkpoint, lifecycle, source, saved-report and board validators
together after writing new state. Do not strip private bindings, restore old
snapshots or use an empty store to bypass incompatibility.

## Backfill and committed readback

Backfill stores a bounded checkpoint per account with a fixed unfinished
window and source/privacy/deletion basis. Member/cursor/page witnesses are
hashes; raw provider cursors, URLs, titles and credentials are absent.
Original data commits before confirmed progress.

Only actual committed-source comparison can mark handling/suppression.
Failed or unconfirmed work remains pending/unreadable; a late failure cannot
restore old membership after deletion or rewind a newer committed checkpoint.
All-activity deletion clears those membership witnesses without granting or
revoking source consent.

`compareCommittedSource(actualTicket,acquiredEnvelopes)` is a one-attempt,
read-only completion check outside writer admission and before retirement.
It requires the original ticket plus fresh current retained authority, exact
operation/account/root and original captured fingerprint. It validates the
document and idempotent merge, including variants/provenance/tombstones.
Matched, suppressed and unverified are distinct; empty input is unverified.

Current read generation can differ from historical write/capture generation
after restart. Status/readback keep those tuples separate. Pause restart reads
committed data without provider verification or a transient capture array.
The original committed storage timestamp is not an activity date.

## Callback-owned readers and report frames

`withRetainedReader` acquires current account authority and lifecycle then
read-only board admission. Reader, raw account/root/index and actual private
state stay inside that callback. Escaped/copied readers cannot authorize later
work. The source-owned HTTP layer still controls DTOs and final publication.

V1 validates its bounded original document; v2 traverses its actual graph with
a bounded decoded-block cache. `select`, `iterate`, `entryAt` and prefix lookups
preserve original ordinals and complete membership without whole-history arrays.
Selection events are start, bounded tagged conversation parts and end.
Only exact totals/digest plus final authority can emit successful end.
An abandoned or partial iterator is not a complete selection.

| Report reader operation | Required binding |
| --- | --- |
| `reportSource.captureSelection` | Exact revision/sources/IDs, including explicit empty selection, under a genuine source frame |
| Original-view expectations | HMAC and interpretation definitions from the complete authorized root, not redacted copies or returned pages |
| `iterateSelection` / `validate` | Reopen and verify the original frame/source across awaits |
| Pinned snapshot | May survive new collection, but account/configuration/privacy/deletion/owner authority must stay current |
| Entry projection | Keep global original ordinals; never renumber a selected subset |

Selected report assembly keeps existing native and tighter report/privacy/
format limits. It does not authorize whole-history UI arrays.

Native report commit needs the existing controller's private reviewed
`{bundle,validate}` publication argument. The older three-argument path remains
withheld. Hashes or browser approval fields do not manufacture that object.
Publication pins reviewed files and original facts, permits reviewed copy
edits/omissions, appends one entry, saves once and verifies actual readback.
Dispatched frames are consumed even on failure; unknown/partial writes do not
replay.

The private index binds native evidence/comparison hashes to its account.
Saved reads use `readSaved`, exposing only filtered binding-free entries.
The actual private state argument is for in-callback dependency checks, never
a DTO or a reason to reenter the board queue. Saved comparison frames have
their own original source-index/dependency binding. Read authority, current
source frame and saved-artifact mutation remain different capabilities.

## Deletion boundaries

| Deletion scope | Authority and extent |
| --- | --- |
| Whole-local activity, explicit All | WIRE retained authority; includes signed-out local partitions, historical/recovery roots and interrupted staging |
| Provider conversations and saved reports | Excluded from whole-local activity deletion |
| Segmented date range | Explicitly unavailable; never substitute All |
| Saved artifact | Separate `artifactMutationAdmission`, exact account/index/dependencies, preview and confirmation |

Public counts expose no hidden account identities or raw inventory.

The existing preview/confirmation binds owner, revision, exact scope and
inventory hashes. After collector/recorder coordination, lifecycle then board
admission saves tombstones, replacement empty roots and the pending journal
before cleanup. Recovery finishes only that sealed plan without account
adoption, new acquisition or broader confirmation.

V2 intrinsic/index aliases suppress all content variants/provenance, including
incomplete orphan staging. Saved reports, old collection receipts, consent,
source/global settings and version floors remain. Existing inventory/file/
metadata bounds are not waived.

Interrupted collector staging is recognized only by the exact canonical
source UUID/operation UUIDv4 temporary filename and qualified checkpoint
validator. It stays temporary, with original hashes/cursor/progress preserved;
cleanup cannot rename it into a committed checkpoint or downgrade the index.

Saved-artifact deletion uses the separate `artifactMutationAdmission`.
It qualifies exact current account, index and dependent reports/comparisons
before file traversal. Foreign dependencies refuse the whole scope, not skip
hidden members. Per-target eligibility is only a hint; preview and explicit
confirmation still bind exact membership/hashes.

The admitted artifact turn seals logical removal/tombstones/journal and
invalidates dependent consumers before physical cleanup. Recovery retains its
original private stamp and operation, stripped from public DTOs. It does not
use a readSaved lease or whole-local activity grant as substitute authority.

## Proof limits

Existing codec/persistence/reader/report/deletion fixtures establish exercised
mechanics with invented records. They do not prove genuine large-history
source traversal, complete approved-window acquisition or real-data
append/adoption/recovery. Source qualification and authorization remain
separate from storage-format correctness.
