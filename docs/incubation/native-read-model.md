# Native evidence read model

`lib/native-read-model.mjs` validates and projects already-authorized
Microsoft-native observations. It does not acquire sources, resolve identity,
create a writer or activate a connection. Current released WIRE is Copilot-only.
See [source adapters](source-adapters.md), [retention](native-retention.md) and
[bounded views](native-retained-views.md) for the adjacent boundaries.

## Raw-v0 admission and bounds

`projectNativeReadModel(envelopes)` is pure and synchronous. The
`m365-native-v0-review-only` raw writer remains withheld:

| Unresolved source fact | Why raw-v0 remains blocked |
| --- | --- |
| Cowork input/no-input | Missing qualified provenance |
| Original batch members | Outcomes were not observed |
| Chat enterprise execution/results | Coverage is not qualified |

A successful projection/fixture cannot clear those gates. Separate screened
retention does not relabel raw-v0 as admitted.

| Shared bound | Maximum |
| --- | --- |
| Envelopes / expanded bytes | 10,000 / 16 MiB |
| Recorded fact | 1 MiB |
| Depth / expanded values | 64 / one million |

Preflight measures escaped UTF-8 JSON before full serialization, charging every
alias occurrence. Cycles, accessors, custom serializers/prototypes,
sparse/nonfinite or non-JSON values reject without execution.

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

| Observation | Outcome meaning |
| --- | --- |
| Separate capture or variant | Preserve original facts without multiplying canonical calls |
| Completed task | Not aggregate tool success |
| Cowork tool completion | Requires supported explicit `tx.data.ok`; conflicting known completions stay unknown with both observations |
| Chat message/image completion or invocation presence | Does not prove call success |

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

| Fact | Qualified use |
| --- | --- |
| Chat creation/update time | Message-scoped; not a call clock |
| Ordinary message creation | Can admit dated conversation context when no call-specific restriction excludes it; adds no call, timeline point, outcome denominator or latency sample |
| Cowork `observationTime` | Requires original `data.ts`, exact event reference, qualified unit/basis and matching carrier |
| Call start | Current unambiguous `ts` only; completion, capture, update and reconnect cannot fill it |
| Returned-result time | Its own observation clock |
| Native elapsed time | Its recorded boundary; do not pool with GitHub prompt/tool/HTTP latency |
| Snapshot model / tool name | Not per-call model attribution / proof of service targets or business outcomes |

The shared timestamp predicate requires calendar-valid explicit-offset ISO
values with bounded fractional precision. Comparison may truncate beyond
milliseconds, but retains the original string. Stored derived values must
recompute exactly; unavailable facts have no derived time.

Missing or unsupported metadata stays unavailable.

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

To use the optional projection cache:

1. Supply a synchronous immutable revision binding captured bytes and
   decoder/projection identity, not object identity alone.
2. Cache at most one deeply frozen projection per account/content.
3. Obtain current authority for every read; check revision around awaits and
   again at publication.

Missing revision support uses the uncached path. Malformed or asynchronous
revisions fail.

Sign-out, replacement, generation loss and closure retire caches and late work.
Pause or natural provider expiry can permit fresh retained reads without
source acquisition. Search and report consumers retain their own additional
membership/disclosure gates. Synthetic composition is not real-record or
production-source acceptance.
