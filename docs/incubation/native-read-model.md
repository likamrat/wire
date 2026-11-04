# Native evidence read model

`lib/native-read-model.mjs` validates and projects already-authorized
Microsoft-native observations. It does not acquire sources, resolve identity,
create a writer or activate a connection. Current released WIRE is Copilot-only.
See [source adapters](source-adapters.md), [retention](native-retention.md) and
[bounded views](native-retained-views.md) for the adjacent boundaries.

## Raw-v0 admission and bounds

`projectNativeReadModel(envelopes)` is pure and synchronous.
The `m365-native-v0-review-only` raw writer remains withheld on three distinct
source gaps: missing qualified Cowork input/no-input provenance, the original
batch's unobserved member outcomes, and qualified Chat enterprise execution/
result coverage. A successful projection or fixture cannot clear those gates.
The separate screened retention contract does not relabel raw-v0 as admitted.

The shared native bound is 10,000 envelopes/16 MiB, 1 MiB per recorded fact,
depth 64 and one million expanded values. Preflight measures escaped UTF-8
JSON before full serialization; every aliased occurrence charges the expanded
budget. Cycles, accessors, custom serializers/prototypes, sparse/nonfinite or
non-JSON values reject without execution.

Each supported decoding layer is independently bounded, including invocation
arrays, serialized entries and argument strings. Invalid input throws a fixed
`NativeReadModelError` code and structural path, not private payload prose or
a success-shaped empty result.

## Envelope and evidence vocabulary

| Field | Required meaning |
| --- | --- |
| `scope` | Exact harness, Chat/Cowork surface, tenant/subject/historical verification and conversation identity |
| `capture` | Original capture identity/time/generation, parser/source schema and operation; optional qualified origin/digest |
| `record` | Minimal original identity/type carrier for validation, not arbitrary reader payload |
| `ordering` | Original page/record and optional frame/sequence coordinates and completeness |
| `qualifiedFields` | Explicit value or unavailable reason for each supported fact |
| `evidenceReferences` | Exact source document/pointer and optional original event identity |
| `outcomes` | Separate task, tool and observed returned-result facts |
| `callFacts` | Per-native-call associations on a multi-invocation Chat carrier |
| `chatSource` | Closed, independently validated source-observation bundle |
| `messageParts` | Qualified pointer-keyed Cowork representations, not additional events |
| `coverage` | Bounded source/interpretation/extent limitations |
| `checkpoint` | Private continuation descriptor; not projected into consumers |

Unknown fields reject. Recorded/recorded-empty/null/absent/excluded/unsupported/
unqualified/conflicting are different states. Unavailable facts have a reason
and no hidden value. Original pointers and pointers inside decoded string
content remain separate.

Historical account verification and capture generation are provenance, not
current authorization. The correlation tuple is not a lifecycle partition or
JWT/Entra identifier equivalence. Do not normalize identifier case, trim values,
invent a hash recipe or fill missing source with GitHub.

## Identity, observations and outcomes

Conversation/call keys use source-qualified literal tuples including harness,
surface, tenant, subject, conversation and native namespace/ID.
Observation keys additionally bind capture, source coordinates and representation.
Reordering input does not create identity; exact modeled duplicates deduplicate;
conflicting content at one observation identity rejects.

Separate captures/variants retain their original facts without multiplying
canonical calls. A task completed state is not aggregate tool success.
Cowork tool outcome requires the supported explicit `tx.data.ok`; conflicting
known completions stay unknown with both observations. Chat message/image
completion and invocation presence alone do not prove call success.

Observed returned results have their own bounded array positions, supported
status/code/pagination facts and intermediary provenance. At most 100 are
retained; declared request count and reference cardinality are not returned
result denominators. No raw entity body, pagination URL or inferred target
correlation is added.

## Multi-call and multipart records

One Chat message can carry several native invocations without becoming several
source observations. `callFacts` binds an original native call ID occurring
exactly once in that carrier. Input/name facts cannot come from a sibling,
array position or unscoped shared field. Unknown/duplicate associations reject.
Multi-call completion/result/timing schemas remain unqualified unless the
specific source contract supplies them.

Cowork `messageParts` is explicitly supported for qualified `rc/aq/aa` events,
not every card/event. Each part keeps the original event, exact source pointer
and representation. Nonempty parts and singleton message text cannot coexist.
Parts are capped at 256 per event, while aggregate flattened views share the
10,000-view and 16 MiB budgets.

Derived part identity binds the original parent observation plus source
document/pointer/representation. Native page/frame/event coordinates are not
fabricated to avoid collisions. Recorded literal text can remain qualified as
unknown-author or unknown-rendering-context without being asserted visible or
complete in the provider. Parts do not add turns, calls or outcomes.

## Chat source observations

`retainNativeChatSourceObservations` accepts one matching inactive decoder
result and attaches its closed version-1 source bundle. No original carrier
means no invented conversation. Parser versions v0 through v0.3 have explicit
kind admission; historical hash labels are not current-build verification.

The collection preserves Task/step/reasoning, clarification, confirmation,
invocation and supported Progress facts with exact original/decoded coordinates.
Safe literals are not interpreted success enums. Task/sourceRequest/call/widget
IDs stay in their own namespaces. Consequential/prospective actions are not
permission or execution receipts. Opaque annotations, raw task results and
excluded reasoning/control text remain unprojected.

The bundle is bounded to 1 MiB and 200 top-level source observations, with
independent child-list/fact limits. Its facts remain outside call, task-outcome,
message and timing denominators. Search admits only explicitly allowed literal
text as context, preserving the exact fact focus target and incomplete coverage.

## Time, model and service qualification

Original Chat creation/update values stay message-scoped. The shared predicate
accepts calendar-valid explicit-offset ISO timestamps with bounded fractional
precision. A derived calendar instant may truncate beyond milliseconds for
comparison, but the original value remains exact. Stored derived values must
recompute exactly; unavailable facts have no derived time.

Ordinary qualified message creation can admit conversation context to a dated
tool view when no call-specific restriction excludes it. It adds no call row,
timeline point, outcome denominator or latency sample. Updates, captures and
reconnect times never substitute for call starts.

Cowork `observationTime` needs its original `data.ts`, exact event reference,
qualified unit/basis and matching carrier value. Only a current unambiguous
`ts` observation supplies a call start; returned results use their own
observation clock. A completion cannot fill a missing start.

Native provider elapsed time keeps its recorded boundary and is not pooled
with GitHub prompt/tool/HTTP latency by convenience. Snapshot model names are
not per-call attribution. Tool names do not establish service targets or
business outcomes. Missing/unsupported metadata remains unavailable.

## Consumer population

The older bounded in-memory compatibility projection retains a full
`nativeConversation`, not fake GitHub `userPrompt` or `toolCalls` records.
Source-qualified scenario/call keys, observations, messages, parts, task states,
returned results, measurements and coverage keep their original units.
No-tool conversations can remain context without adding measured calls.

`analytics.population.scenarioIds` and measured `rowIds` are separate.
Aligned `rowScenarioIds`/`rowUnits` bind each row's real parent/unit.
`narrowPopulation` can only intersect accepted backend membership; it cannot
qualify a new clock, source, orphan or context-only conversation.
Same IDs cannot be relabelled to bypass their original parent.

Sources, Dates, tool/service/outcome/author and other selectors preserve their
own meaning. Native context-only and message-date coverage are explicit subsets;
action-only Search cannot restore a parent excluded by scope. Mixed source/unit
rates are withheld rather than pooled into Work IQ percentages.

The current source-aware scalable route uses bounded query/detail DTOs instead
of materializing this full-history array. Its complete aggregates and report
receipts are documented in [retained views](native-retained-views.md).

## Current authority and revisions

Retained reads obtain a genuine current `microsoft-retained` lease and publish
inside lifecycle admission. A process-owned frame binds account, content,
original owner and generation; copied frames or frontend booleans fail.
Source callbacks receive authorized leases, not historical capture approval.

An optional synchronous immutable source revision can cache one deeply frozen
projection per account/content. It binds captured bytes and decoder/projection
identity, not object identity alone. Every read still obtains current authority,
and revision is checked around awaits and at publication. Missing support
uses the uncached path; malformed or asynchronous revisions fail.

Sign-out, replacement, generation loss and closure retire caches and late work.
Pause or natural provider expiry can permit fresh retained reads without
source acquisition. Search and report consumers retain their own additional
membership/disclosure gates. Synthetic composition is not real-record or
production-source acceptance.
