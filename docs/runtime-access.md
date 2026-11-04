# Runtime access

Normal `npm start` reserves its loopback endpoint, then constructs
`createCopilotRuntimeAccess`. It reuses the local gate, leases and receipts in
`createMicrosoftSession` without a Microsoft transport, profile or acquisition
owner. The descriptor is enforced with `collectionMode: "copilot-only"`.

An ordinary previously unbound store starts locally signed in; a saved explicit
logout remains signed out. Protected native retention/report/account state
requires its matched runtime and is refused, not migrated, stripped or reset.
Saved Microsoft configuration alone is ignored and preserved. See
[collection](collection.md) for private storage and source permission.

## Authority and operation effects

| State/change | Retained reading | Acquisition |
| --- | --- | --- |
| Current WIRE access | Still needs the relevant source/account and response authority | Still needs the source's approval and enabled policy |
| Pause | Preserved | Automatic acquisition stops; approved explicit GitHub manual checks remain separate |
| WIRE sign-out | Withdrawn across panels | Stopped without deleting evidence or signing other apps out |
| Natural Microsoft expiry in incubation | Fresh retained leases may remain available | Old source acquisition is retired; no automatic reconnect |
| Account/generation replacement | Old publication is retired; new reads must requalify | Old leases cannot be rebound |

Presentation identity is not source permission. Browser data, a copied lease,
configuration, a successful page load or a historical capture generation cannot
grant backend authority.

## Bootstrap and capabilities

`GET /` serves the current renderer with one newly issued panel capability.
Independent clients use `POST /api/session` with exactly `{}` and
`X-Wire-Session-Protocol: 1`. Missing/duplicate/unsupported protocols return
409 `WIRE_CLIENT_UPDATE_REQUIRED` before allocating authority.

The handshake returns exactly `{capability,runtimeId,accessBootstrap}` with
matching runtime IDs. The descriptor is immutable for that runtime, with
schema 1, enforced/unbound mode and, when applicable, the exact collection
mode. Explicit unbound is a validated compatibility mode, never inferred from
a missing or failed watch. Enforced renewal cannot silently downgrade.

Protocol metadata is not authentication. Existing host/origin/JSON/fetch-site
checks, random capabilities, TTL and 128-panel limit still apply. Reuse an
API helper's own capability and release it through `/api/session/release`
after its work/recovery ends. Readiness uses `/health`; repeated `GET /`
allocates panels. Closing a tab alone does not release server authority before
its TTL.

The separately loaded canvas adapter must match this protocol and its runtime
client. Server restart does not reload extensions. Native delivery remains
[deferred](development.md#deferred-canvas-integration).

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

Ordinary hidden-tab transitions keep the same watch and accepted content while
authority stays current. Page departure suspends publication. Failure, expiry,
logout or generation loss clears private owners, including while hidden.
Readiness allows new authorized reads, not old DOM, queries or mutations.
Frozen native-renderer pixels and already-disclosed external copies cannot
be retroactively erased.

## Client publication and withdrawal

The callable transport owns `publicationToken`, `isCurrent`, `accessState`,
`subscribeAccess`, `startAccess` and `suspendAccess`. Tokens must be defined,
non-null and synchronous; only literal `true` from the current check admits.
Missing methods, promises and truthy objects are not an unbound fallback.

Capture authority before asynchronous work. Recheck after each await and
reentrant callback before private paint, errors/finalizers, navigation,
focus/scroll, image/frame completion or Search delivery. Successful private
responses carry matching `X-Wire-Runtime` and `X-Wire-Generation` stamps.
A new token cannot make an old continuation current.

Shared mount closes publication before owner teardown. Each existing owner
provides local, synchronous, idempotent withdrawal: abort owned reads/timers,
retire callbacks, scrub private text/attributes and drop models, selections,
queries, previews, object URLs and return preparations. Clear actual held
`Text.data` and `Attr.value` before detaching; removing a parent is not erasure.
Retire private select options and Copy/tooltip getters as well.

Withdrawal must not invoke ordinary Back, Cancel, Save, recollection, deletion
or remote-preview cancellation. Clearance failure keeps publication closed.
Resume merely permits fresh intent; it cannot restore cached private data.
Static navigation, headings, safe preferences and original opaque recovery
identities can remain.

Enforced reconnection never retries an old private path. Validated
unbound-to-unbound renewal keeps its limited legacy read behavior, but Search
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

Obtain a genuine acquisition lease before source discovery/reads. Source I/O
does not hold lifecycle admission. Recheck source configuration, operation
epoch and original request authority inside final admission, then commit
evidence, consented replies, checkpoints, index and manual receipt in order.
The whole admitted commit precedes acknowledgement of queued sign-out.

Admission provides ordering, not rollback or a multi-file transaction.
Evidence can commit before a later reply/checkpoint failure. Report that
uncertainty; do not claim nothing was written. Existing canonical identities
support continuation without duplicating evidence.

Settings serialize against collection, persist first, and synchronize lifecycle
from the actual committed pair. A possible post-write failure poisons stale
acquisition authority; status recovery reads committed state instead of
replaying configuration. Deferred scheduler work must not inherit lifecycle
listener reentry context; the existing collector-owned async resource separates
that scheduling from admission. No second queue, timer or writer is added.

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
| Profile | Minimal unrelated gate recovery | Names, handles, initials, image tickets, image callbacks and lease timers |
| Search | Only intent allowed by its current explicit lifecycle contract | Results, receipts, private history/preparations, open documents and obsolete callbacks |

Collection configuration has no owner-local opaque receipt; preserve its
explicit read-current recovery rather than invent one. Fresh status and late
old success do not settle an unknown write. Report Save recovery fingerprints
the original identity without keeping raw private titles/bodies; shared
history reads must be fenced too.

## Incubation and fixture bindings

`createFixtureRuntimeAccess` is explicitly temporary, with matched source/store
paths and disabled timers. A top-level read binding alone does not qualify
fixture writers; the joined collector must use the same access object.
Legacy withheld routes remain withheld in that fixture. This restriction is
not the current normal Copilot-only startup policy.

Source-aware Microsoft controls, native retained leases, configuration offers,
report publication and whole-local versus account-specific deletion have
separate [incubation contracts](incubation/microsoft-session.md).
Their descriptors are not frontend switches to activate them in the release.
No unavailable native dependency becomes an empty or GitHub-only all-source
cohort.

## Focused proof

Use the existing runtime-access/watch, collector-access, client-access,
account-gate and owner-withdrawal suites for affected seams. Real backend
publication, client clearance, cross-panel behavior, provider qualification
and live deployment are different proof boundaries. Do not substitute a
fabricated unbound descriptor for an enforced fixture or treat a green
owner-local test as full application acceptance.
