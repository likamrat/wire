# Microsoft host and acquisition

**Parked development incubation, not released integration.** Normal `npm start`
does not import this host, read/adopt saved Microsoft configuration or expose
Microsoft connection/collection controls. A development flag is not an account,
profile, source-read or publication grant.

The host, transport, decoders, protected state and fixtures remain preserved.
Invented-provider success establishes only the exercised implementation.
Real source initialization, complete membership, continuation, original-field
fidelity and restart/reconnect remain independently qualified requirements.

## Development launch

Every Microsoft launcher option requires explicit `--development-microsoft`.
Examples below describe the parser for separately authorized development work,
not commands to run against an existing private store during source review:

```powershell
npm start -- --development-microsoft --microsoft-config "C:\Private\wire-source.json" --port 0
npm start -- --development-microsoft --microsoft-retained --port 0
```

Normal release startup remains Copilot-only. Development startup never
auto-discovers saved configuration or schedules acquisition: both Microsoft
scheduling and development GitHub timers are disabled. The compatible
`--microsoft-manual-collection` spelling does not grant another operation.
An explicit configured backend can separately exercise scheduling in fixtures;
that is not the launcher default.

The server reserves its endpoint before access/storage initialization.
Port zero selects only a listener, not an isolated store. Retained-only mode
uses current protected retained authority without loading a profile, verifying
a provider or acquiring history. Unsupported combinations/duplicate flags fail
before browser ownership.

Configuration versions have distinct meanings:

| Version | Meaning |
| --- | --- |
| 1 | Legacy selected-source metadata, its exact digest and existing profile custody |
| 2 | Native-history configuration with an optional expected-account mismatch guard and owned profile custody |
| 3 | Explicit narrow enrollment policy, not an existing profile or source grant |
| 4 | Fresh normal enrollment custody without a supplied account label or history IDs |

`readMicrosoftNativeConfiguration` owns the closed schemas and branded result.
Paths must be private and outside source; an expectation is not identity.
Fresh enrollment creates exclusive custody/configuration rather than adopting
another profile. Interrupted preparation remains unknown and cannot reset or
delete an existing profile to continue.

## Connect, Enable and collection

Ordinary incubation Connect lets Microsoft/Edge own sign-in in a separate,
sandboxed owned window. The user operates account selection, password, PIN,
MFA, consent and browser warnings. There is no enterprise registration,
credential copying or corporate-VPN requirement.

The ordinary Connect interval does not install the general collection
request/capture gate. It installs the narrow execution refusal described below
and passively observes only the original nonsecret account projection.
Microsoft's own page may make requests and cache data during sign-in;
Connected is not a promise of an empty browser cache.

Principal acceptance needs the current owned main realm, completed original
noncached successful app document, matching frame/loader/origin before and
after projection, and a qualified AAD production account. Display text, a
callback or a loaded page is insufficient. The active native bootstrap branch
chooses TanStack loader data or background-loader data; do not probe unrelated
stores when the selected branch is absent.

Account staging survives native bootstrap cleanup only as the minimal
projection, never as new authority. Owner/navigation/deadline/conflict changes
retire it. Late assignment/protocol replies cannot extend the original
90-second authentication deadline. Retirement and browser closure run without
waiting indefinitely on each other; failed closure retains custody/recovery.

Connect does not Enable, Resume or Collect. After verification and durable
lifecycle admission, the same owned window is minimized without claiming
OS foreground visibility or changing its truthful owner mode. Later collection
requires explicit source/history permission and a genuine `microsoft-read`
lease. A fresh collection document independently verifies the same principal;
pending sign-in requests do not become collection requests.

Source history/window settings record permission and retention intent, not
proof that native responses contain only those dates. Inventory/MRU/messages
may expose older data before filtering. The current native client can have
independent initialization effects; logical read-invocation counts are not all
network requests. A real grant must describe actual ingress/profile scope.

## Current session-backed acquisition

Chat, Cowork or both use the same existing `acquireNative`/`completeNative`,
segmented writer and committed-source comparison. A failed native read does
not fall back to driving the original UI. Changing source path/selection
requires fresh qualified ownership rather than reusing an old client.

| Source | Current path | Limits and qualifications |
| --- | --- | --- |
| Chat | Existing native router/store/query client; the original history query function and primary conversation server function, without route-store updater or QueryClient retry/cache substitution | 16 inventory calls, 8 primary detail calls, 24 logical invocations; projected returns are not original HTTP captures |
| Cowork | Original independent client hook with `ownsPageHooks:false`; its genuine `ic3LiveClient.listTasks/listMessages` | 16 inventory pages, 8 histories, 16 message pages/history, 144 logical invocations; no getTaskDetail, task-open, mutation or tool methods |

Each source has 2 MiB/page and 12 MiB/cycle projected-return bounds. Both share
one five-minute acquisition deadline and the existing envelope budget, split
so one cannot consume the other's publication allowance. UI captures the
deadline before asynchronous preparation; the server caps rather than extends
it. Registration/setup/native credential waits consume that budget.

A repeated operation ID reads its original receipt, not a new invocation.
Timeout or lost UI reply is uncertainty, not confirmed cancellation. Closing
the owned context prevents future work there but cannot undo remote work
already received. Original receipt, lease, owner, configuration, privacy and
deletion fences survive cleanup.

Chat begins an unfiltered native reset, not pre-Enable cached history.
Pinned-only and ordinary rows need consistent original identities.
Primary details keep their message/call/source-time provenance; connected
conversation context remains unqualified rather than merged. Reset/null
cursor alone does not establish All-chats completeness.

Cowork history IDs must come from the same acquisition's inventory. Original
cursors advance only within that owner, with cycles refused. Native normalized
null cursors can hide absent values or filtered malformed rows, so they do not
establish complete history. Budget stops preserve pending work without
handled-through claims. Fair rotation can progress to other histories without
pretending a truncated history is complete.

The genuine provider boundary remains mounted across cycles; per-cycle
Cowork client/bridge ownership is retired after commitment/comparison.
Account/realm, provider reference, method reference, native navigation or
capability changes retire the owner even when global pointers still compare
equal. No copied React context, replaced hook or standalone auth client is used.

## Native execution refusal and reviewed source

The owned browser context keeps an HTTP refusal for
`*/v1/conversations/*/client-tool-*` from Connect until confirmed close.
It is attached at browser-target Request stage before first-script execution,
including owned popup/frame targets. Missing exclusive-browser or supported
protocol custody refuses, not a per-page timing fallback.

Module Federation's original factory hooks admit only the reviewed CoworkNav
export and exact composed reader factory. The full tool-connecting shell,
Customize/TaskCanvas and substituted factories do not execute. Loading
Customize dependencies is not executing its returned factory.
`ownsPageHooks:false` avoids page/identity registration; the reader calls no
connector connect/setIdentity/postMessage or MRU/plugin subscriptions.

False native consent/capability flags alone are not protection: pending work
could drain before asynchronous teardown. Both HTTP refusal and original
consumer exclusion are required. Denial remains through retirement until
target close; an uncertain failRequest acknowledgement is not retried or
released by detach. No source binding can undo an already-dispatched tool.

The reviewed Cowork registration selects
`https://res.cdn.office.net/s01-copilotstudio/cowork/v/20261101.72.0-6507b83d/coworker-manifest.json`
through the original synchronous federation hook, before resolution.
Runtime `coworker.8d98ec00.js` and the matching source/dependency cohort remain
the input; unavailable pinned assets cannot fall back to latest.
The current independent hook is `476712.x`, with original history client
`138360.Hs`. These are version-specific private client contracts, not stable
public API promises.

Keep exact source qualifications in the owned bootstrap/composition modules,
including `microsoft-cowork-bootstrap.mjs`, `microsoft-cowork-composition.mjs`,
`microsoft-native-tool-guard.mjs` and browser protocol. Static public bytes or
script names do not prove which bytes an earlier private document executed.

## Original-UI and legacy branches

Explicit original-UI acquisition keeps a different source/provenance contract.
It observes original native requests and bounded responses, never constructs
replay requests with copied credentials.

Chat's qualified starting relationship uses the actual All-chats initializer,
selected native history store, original marker and consistent pinned membership.
Continuation retains the original cursor/store. A newer reset retires older
SSR completeness; delayed SSR cannot replace a newer chain. Context GetSections
is a separately qualified leased Chat read, not Connect authority or pinned
membership proof.

Cowork's original UI can combine ordinary lists, automation parents, typed run
feeds and explicit original relationships. Parent/run IDs, log positions and
recency are not interchangeable. Deleted/unavailable parents, conditional
historical clients, native caps and missing sentinels keep membership
unqualified. UI stop conditions are not response exhaustion.

Original response/body settlement and projection acknowledgement precede
phase changes. Page/byte/record budgets are scheduling bounds, not truncation
permissions or complete-history claims. Raw cursors do not survive ownership
loss/restart; rediscovery uses new authorized original behavior and retained
identities deduplicate.

This branch's one eligible recovery from an original 503 is not a general retry:
it requires no Retry-After, exact current owner/document/lease, genuine ACK and
terminal completion, no other pending/failed work, no writer entry and enough
of the same deadline. It reinitializes once without resetting budgets.
Uncertain writes, repeated 503s, authentication errors and failed provenance
do not use that path.

Legacy selected-source/account-only/visibility and
`scripts/investigate-native-history.mjs` paths are separately scoped
engineering tools, not ordinary setup. Account-only remains unverified until
its actual principal contract qualifies. The one-shot engineering runner
creates owned temporary custody, claims one original Connect and preserves
its fixed deadlines; repeated status/reload cannot renew it.
Its close-preparation capability is private and close-only, not acquisition
authority. Do not copy capability-bearing custody into logs or documentation.

## Transport and failure invariants

The original-request observer binds request-time phase, owner, document,
frame/loader, original IDs and lease before asynchronous checks.
Continuation acknowledgement, network terminal, body completion, source
acceptance, storage commitment and visible readback remain different facts.
Selection or an ACK is not proof of provider completion.

Keep the existing finite request/correlation/byte/deadline limits. Capacity
waiting retains original custody and FIFO slot accounting; it cannot rebind
to a later document or infer missing Network IDs from matching URLs.
Redirect/preflight/helper roles need their own original associations.
Malformed, duplicate, stale and unqualified evidence refuses explicitly.

Collection-only logger/CSP denials, presentation transport and local embedded
images have distinct closed roles. Denying a request is not permitting it,
fabricating success or proving it optional to the real client. Required source
evidence still has to arrive. Completed denial accounting can retire only
after its exact ACK/failed terminal and a committed, released previous scope;
same-operation recovery cannot reset capacity.

Historical authentication gates and helper exceptions do not apply to ordinary
browser-owned Connect. Their exact policies remain in the owned transport
source for separately selected legacy/engineering paths. Do not copy an old
endpoint exception into current acquisition, relax CSP/TLS/sandboxing, inspect
credentials or automate authentication to resolve a failure.

Only closed content-free first-failure predicates/protocol classifications
enter private operation diagnostics. Missing old evidence stays unobserved.
Later cleanup/storage failures cannot replace the original first cause.
Matched-reader validation must preserve new optional fields; stripping them
to use an older binary is not recovery.

## Retention, reporting and unresolved coverage

Commit uses the original ticket and existing segmented writer. Completion
compares original accepted source content/provenance with actual retained
bytes before retiring the ticket. Matched, deletion-suppressed and unverified
are separate results; empty source is not a successful sample.

Backfill checkpoints preserve a fixed unfinished window, hashed membership/
page witnesses and handled/pending/unreadable states. Coverage requires a
qualified start, genuine exhaustion and handled membership for every selected
source. A null cursor, successful Connect or bounded fixture cannot supply
that qualification.

See [retention](native-retention.md) for storage/receipt compatibility and
[retained views](native-retained-views.md) for full-population reading and
report admission. Native source completeness, call/result fidelity and
service/clock qualification remain limited independently of writer/UI readiness.

SIGINT/SIGTERM and owned IPC disconnect use the same cleanup. Closing a tab
does not close the runtime. An unsettled launch or failed process/profile
release retains custody; no unexplained lock or unrelated process is removed.
Real source/profile operations, retained-data mutation, publishing and live
runtime replacement require their separate explicit authorization.
