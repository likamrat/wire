# Session lifecycle and admission

This shared module owns local WIRE access, serialized leases and receipts.
The released runtime uses its Copilot-only local gate without a Microsoft
transport; see [runtime access](../runtime-access.md). Microsoft connection and
account behavior below is parked incubation, not an activation instruction.

## Durable ownership

`createMicrosoftSession` uses the private outside-source data directory,
existing atomic-write primitives and process lock. Its lifecycle metadata and
browser-owner marker are not a second evidence store.

Committed settings, not a Settings draft, initialize Pause/window state.
`initialWire:"signed-in"` preserves previously unbound continuity only when no
saved lifecycle exists; explicit logout wins. It creates no Microsoft identity,
source grant or connection.

The backend supplies an opaque owner from its validated panel capability.
Owner hashes bind durable operation fingerprints; browser JSON cannot supply
the principal, partition or provider. Original capability checks run inside
the lifecycle queue before receipt lookup or mutation, including exact replay.
Only synchronous literal true admits a command.

An admitted operation may finish before a later capability release/sign-out
is acknowledged. Release after dispatch does not cancel or roll it back;
private HTTP delivery still requires the separate current response guard.

## Commands and receipts

WIRE sign-in opens the local gate only. Sign-out persists closure before cleanup,
retires leases and stops owned work without deleting evidence or signing out
other applications. A failed durable write is an error, not successful sign-out.

Microsoft Connect/Cancel/Recover are available only in the explicitly native
binding. Connect uses the configured expected account and genuine verifier;
it does not configure, Resume or Collect. HTTP input remains the closed
schema/action/operation/generation shape, with identity/replacement choices
kept backend-owned.

The same owner and exact operation ID/input returns its original receipt.
Different owners cannot adopt it; changed input conflicts. Legacy ownerless
receipts remain validated historical data without a public adoption path.
Pending operations become ambiguous after restart and are not resumed.
Missing or mismatched receipt is not evidence of no effect.

The lifecycle's bounded command journal refuses at capacity rather than evict
unresolved ownership proof to allow replay. Acquisition receipts have a
separate [retention archive](native-retention.md#operation-receipts);
do not conflate the two journals.

Receipts preserve operation, action, generation, outcome, reason and revocation.
Original pending/completed/cancelled/failed/ambiguous meanings remain. A replaced
account retires the old namespace only after genuine verification; historical
partitions stay on disk. A failure during cleanup cannot rewrite a completed
Connect into an inferred authentication failure.

## Leases and publication

| Interface | Responsibility |
| --- | --- |
| `status`, `receipt` | Serialized safe observations; no implicit read, connection or retry |
| `lease`, `assertLease` | Genuine process-owned retained/acquisition authority; copies fail |
| `admit(lease,work)` | Check and await bounded final work under the lifecycle queue |
| `subscribeAuthorizationChange` | Synchronously seed then notify consumers before later publication |
| `collectionIntent`, `updateCollection` | Project approved source intent and synchronize committed settings, not schedule another collector |
| `expire`, `nativeOwnerLost` | Retire the exact owner/generation; natural expiry does not invent WIRE logout |
| `close` | Drain owned work and release custody only after actual cleanup |

Kinds remain distinct: WIRE retained, Microsoft retained, GitHub acquisition,
source-aware GitHub manual acquisition and Microsoft read.
A capture generation or historical verification field is not a lease.
Pause disables acquisition while retained reading remains available.

Final publication/commit must occur inside admission, not after a standalone
lease check followed by unrelated awaits. Include the whole admitted side
effect. Do not reenter any method on that lifecycle instance from its callback
or async descendants. The common lifecycle-before-board order avoids deadlock;
long provider reads stay outside admission.

Authorization notifications carry one coherent safe revision/generation/gate
projection, not profile/account/content or receipts. Listeners are synchronous,
nonthrowing and nonreentrant. Listener failure poisons authority rather than
leaving one consumer permissive. A previously readable generation cannot
regain retained authority under the same runtime key after losing it;
initially negative generations and transport-only failures are different.

Latest-state watches rely on that invariant but still enforce independent
client freshness. Control status and private publication remain separate.
Readiness allows new work, never revival of old callbacks or receipt adoption.

## Configuration and global Pause

Native configuration admission takes explicit Enable or Save intent and the
original offer's generation, authorization/configuration and optional global
revision. First Enable needs a verified connected account and grants only the
selected sources/window. Save preserves committed Pause.

The temporary configuration token is process-owned and valid only inside the
one lifecycle-to-board turn. Persistence checks the actual current state,
then returns the committed paused/window pair; lifecycle adopts it before
releasing that turn. Post-dispatch failure poisons stale authority rather than
replaying Enable/Save. Offer reads use the same authority predicate without
probing a mutator.

Source-aware global policy is absent or an explicit `{revision,paused}` pair.
Startup and enrollment do not invent running state. The dedicated global
admission/setter alone creates or changes it.

| Global policy | GitHub interval | Explicit GitHub manual | Microsoft |
| --- | --- | --- | --- |
| Absent | Existing source preference | Existing independent approval/request guards | Existing qualified source intent |
| Paused | Withheld | Still separately admitted | Withheld |
| Running | Existing source preference | Still independently admitted | Requires its own enrolled, unpaused, connected source |

The manual lease is bound to the actual original request and cannot be used
by scheduler/configure-triggered work. Saving a source preference never
resumes the global gate or another source. Native-only schemas remain distinct
from source-aware schema 2 with `globalRevision`.

## Native identity and cleanup

A qualified native transport checks current owner/epoch and the exact observed
account namespace. Equal-looking IDs, configured expectations, UI labels and
historical capture fields do not authorize a partition. Fresh evidence-bound
legacy partition compatibility is handled by the existing verifier, not by
rewriting retained identities.

The accepted identity's current generation is distinct from historical write
or capture generation. Provider expiry can retire acquisition while a new
retained lease remains valid. An unresolved Microsoft owner does not force
GitHub source authentication or erase its already-approved evidence.

A dead Node PID does not prove its browser exited. Startup retains an unresolved
owner marker and requires explicit supported recovery; it does not open or kill
a browser automatically. Stop must establish owned process exit and profile
release. Unsettled launches/failed cleanup keep the lock and recovery marker.
Late cleanup cannot grant access or settle another operation.

## Failure metadata and proof boundaries

First-failure metadata uses fixed predicate/stage/reason enums. Private native
evidence is stripped from public receipts. Optional original protocol/capacity/
document observations diagnose only what was recorded; absent old predicates
cannot be reconstructed from current fixtures or a similar error code.
Matched host/lifecycle/retention readers are required after adding strict fields.

Synthetic transport status remains explicitly synthetic and cannot establish
account-wide source completeness. Fixtures exercise lifecycle transitions,
queue ordering, no-replay, replacement, failed storage/cleanup and late reads.
Actual provider qualification, browser custody, committed retention, client
clearance and report dependency admission remain independent requirements.
