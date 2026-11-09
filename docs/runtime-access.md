# Runtime access

`createCopilotRuntimeAccess` owns the local WIRE access gate. Normal startup
reserves the loopback endpoint before initializing it, with enforced
`collectionMode: "copilot-only"`.

A new store starts locally signed in; an explicit sign-out remains saved.
This gate does not approve a source. Incompatible stored state is refused
without resetting it. See [collection](collection.md) for storage and source permission.

## Authority and operation effects

| State/change | Retained reading | Acquisition |
| --- | --- | --- |
| Current WIRE access | Still needs the relevant source/account and response authority | Still needs the source's approval and enabled policy |
| Pause | Preserved | Automatic acquisition stops; approved explicit GitHub manual checks remain separate |
| WIRE sign-out | Withdrawn across panels | Stopped without deleting evidence or signing other apps out |
| Account/generation replacement | Old publication is retired; new reads must requalify | Old leases cannot be rebound |

Presentation identity is not source permission. Browser data, a copied lease,
configuration, a successful page load or a recorded capture generation cannot
grant backend authority.

## Bootstrap and capabilities

| Entry | Contract |
| --- | --- |
| `GET /` at the canonical `127.0.0.1` origin | Current renderer with one newly issued panel capability |
| `GET /` with the exact `localhost` host and actual port, no Origin header | Once ready, empty redirect to the canonical root; no capability or private content |
| `POST /api/session` | Independent-client handshake; exactly `{}` and `X-Wire-Session-Protocol: 1` |
| Invalid/missing/duplicate protocol | 409 `WIRE_CLIENT_UPDATE_REQUIRED`, before allocating authority |
| `/health` | Readiness check without allocating a panel |
| `/api/session/release` | Release the API helper's own capability after its work/recovery ends |

The handshake returns exactly `{capability,runtimeId,accessBootstrap}` with
matching runtime IDs. The descriptor is immutable for that runtime, with
schema 1, enforced/unbound mode and, when applicable, the exact collection
mode. Explicit unbound is a validated compatibility mode, never inferred from
a missing or failed watch. Enforced renewal cannot silently downgrade.

Protocol metadata is not authentication. Host/origin/JSON/fetch-site checks,
random capabilities, TTL and the 128-panel limit still apply. Repeated `GET /`
allocates panels; closing a tab does not release authority before its TTL.
The localhost spelling is only an entry redirect for root navigation; fragments
stay with the browser. It is not an alternate API/write origin. Requests with
an Origin header, a non-root path or non-navigation fetch metadata retain the
existing rejection, and the destination never comes from forwarded headers.

Every client must match this protocol and its runtime client. A successful
server start does not make an incompatible adapter safe to use.

## One latest-state watch

`POST /api/access/watch` accepts exactly schema 1 and
`after: null | {runtimeId,authorizationRevision}`. It supplies current runtime,
generation, WIRE/retained/collection state, fixed timing metadata and admitted
collection-mode/control extensions. Cursor fields control waiting, not access.

There is one pending watch per capability. A valid replacement retires the
prior request; invalid input does not displace it. Null, older or foreign-runtime
cursors return current state; future revisions within the same runtime reject.
The server holds a current cursor for at most 1,000 ms. Watches do not renew
capability `lastUsed` or its TTL.

The client's freshness expires **5,000 ms from watch request start**, not
response receipt. Check monotonic freshness on dispatch, decode, publication
and resume; late timers/responses cannot extend it. Status/watch are safe
control observations, not independent private-read grants.

On delivery, validate the incoming watch against its own request-start deadline,
not the preceding observation's deadline. A still-fresh, same-generation watch
can preserve an unretired view after a renderer pause. It cannot revive a token
already withdrawn by an expiry check, logout, generation change or page departure.
If delivery leaves at most two maximum server waits of freshness, the existing
next watch uses a null cursor for an immediate current-state response. This
reserves room for the wait and its delivery; ordinary long polling resumes once
freshness is replenished. It adds no overlapping watch, timer or capability
renewal and changes neither the five-second bound nor capability TTL.

| Transition | Client effect |
| --- | --- |
| Hidden tab with current authority | Keep the watch and accepted content |
| Page departure | Suspend publication |
| Failure, expiry, logout or generation loss | Clear private owners, including hidden ones |
| Readiness returns | Allow new authorized reads; do not restore old DOM, queries or mutations |

A hidden tab is not necessarily a suspended renderer. If the browser stops
delivering responses or running the client long enough that no current watch
can establish fresh authority, return must clear the old view and confirm access
before reading again. Keeping the watch active avoids needless blanking; it
cannot guarantee uninterrupted reading across server unavailability or expired
authority.

Withdrawal cannot erase copies already made outside WIRE.

## Client publication and withdrawal

The callable transport owns `publicationToken`, `isCurrent`, `accessState`,
`subscribeAccess`, `startAccess` and `suspendAccess`. Tokens must be defined,
non-null and synchronous; only literal `true` from the current check admits.
Missing methods, promises and truthy objects are not an unbound fallback.

For each asynchronous read:

1. Capture the original authority before starting work.
2. Recheck after every await and reentrant callback, before paint, error/finalizer
   effects, navigation, focus/scroll, image/frame completion or Search delivery.
3. Require matching `X-Wire-Runtime` and `X-Wire-Generation` response stamps.
   A new token cannot make an old continuation current.

Withdrawal closes publication **before** owner teardown. Each owner must
synchronously and idempotently:

- Abort owned reads/timers and retire callbacks.
- Clear held `Text.data` and `Attr.value` before detaching nodes; removing a
  parent alone is not erasure. Retire private select options and Copy/tooltip getters.
- Drop models, selections, queries, previews, object URLs and return preparations.

Withdrawal invokes no ordinary Back, Cancel, Save, recollection, deletion or
remote-preview cancellation. Clearance failure keeps publication closed.
Static navigation, headings, safe preferences and original opaque recovery
identities can remain; resume permits fresh intent, not cached private data.

Enforced reconnection never retries an old private path. Validated
unbound-to-unbound renewal keeps that mode's limited reading intent, but Search
still retires its old stream/receipt and uses a fresh read. Neither mode
automatically retries a mutation. Canonical routes are navigation intent, not
permission; lost private narrowing requires explicit recovery or an explicit
open-without-selection choice, never silent broadening.

## Local WIRE account commands

The existing account presenter uses backend-projected actions and the shared
control owner. `/api/access/command` takes schema, action, original operation
ID and generation. `/api/access/receipt` reads only the original owner's exact
operation. Status and these safe control reads remain usable while signed out;
private domain recovery still requires retained access.

`controlToken` and `isControlCurrent` are separate from private publication.
They preserve original command recovery across sign-out but retire on
capability/runtime replacement. Tokens are local call options, never request
JSON, headers or URLs. A replacement capability cannot adopt a receipt.

Capture the intended action before preflight. A delayed Sign out gesture must
not become Sign in after another panel changes state; repeated key/pointer
events cannot issue the opposite action. No mutation runs on readiness, focus,
status or receipt completion.

After dispatch, missing, pending or mismatched receipts remain unknown.
Read the original receipt rather than submit another command. Current state
may justify reading it but does not establish that operation's result. The
backend remains the only durable gate; a presenter flag is not sign-out.

## Collector and writer admission

The common lock order is:

```text
recorder coordination, where required
  -> collector settings/quiescence
    -> lifecycle admission
      -> board writer
```

1. Obtain a genuine acquisition lease before discovery or source reads.
   Source I/O stays outside lifecycle admission.
2. Inside final admission, recheck source configuration, operation epoch and
   original request authority.
3. Commit evidence, consented replies, checkpoints, index and manual receipt
   in that order. Finish the whole admitted commit before acknowledging queued sign-out.

| Failure boundary | Required response |
| --- | --- |
| Evidence commits but reply/checkpoint work fails | Report uncertainty. Admission orders work; it is not rollback or a multi-file transaction. Canonical identities support deduplicated continuation. |
| Settings may have persisted before failure | Close stale acquisition authority and read committed status; do not replay configuration. Settings persist before lifecycle adopts the committed pair. |
| Deferred scheduler work | Use the existing collector-owned async resource, outside listener reentry context. Add no second queue, timer or writer. |

Callbacks inside lifecycle admission must not reenter it or acquire an inverse
lock. HTTP request checks run after body parsing and again at actual queued
admission; expired/released panels cannot gain authority while waiting.
Releasing a panel after dispatch does not cancel an already-admitted effect.

Backend response revocation after dispatch suppresses private payload and
reports `wire_access_outcome_unknown`; transport keeps it unknown even when
an authentication status is involved. Only proved pre-dispatch refusal is
not-started. Backend response fencing cannot clear already-sent client bytes;
client withdrawal is independently required.

## Existing owner responsibilities

| Owner | Keep on withdrawal | Clear or retire |
| --- | --- | --- |
| Collection Settings | Unsent safe window/frequency draft; original write uncertainty | Source paths/baselines, private status/errors and old read/write callbacks |
| Reply saving | Original response-capture operation/token and unresolved outcome | Consent/source snapshots, payloads, private drafts and old detail callbacks |
| Reports and comparisons | Minimal original Save identity/fingerprint and uncertainty | Titles, masking terms, copy overrides, prepared bytes and private frames |
| Deletion/recollection | Original opaque operation/token and unknown result | Targets, counts, source lists, previews and return-focus references |
| Recorder | Original attempt recovery | Confirmation body, timers and detached Send callbacks |
| Search | Only intent allowed by its current explicit lifecycle contract | Results, receipts, private history/preparations, open documents and obsolete callbacks |

Collection configuration has no owner-local opaque receipt; preserve its
explicit read-current recovery rather than invent one. Fresh status and late
old success do not settle an unknown write. Report Save recovery fingerprints
the original identity without keeping raw private titles/bodies; shared
history reads must be fenced too.

## Fixture bindings

`createFixtureRuntimeAccess` is explicitly temporary, with matched source/store
paths and disabled timers. A top-level read binding alone does not qualify
fixture writers; the joined collector must use the same access object.
Routes withheld by the fixture policy remain withheld.

Fixture descriptors cannot activate unsupported sources.
An unavailable source dependency is not an empty or GitHub-only all-source cohort.

## Check an access change

Use runtime-access/watch, collector-access, client-access, account-gate and
owner-withdrawal suites for the affected boundary. Check backend admission and
client clearance together, including late responses and a second open panel.
Use the enforced fixture when testing enforced access, not a substitute
unbound descriptor.
