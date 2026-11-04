# Chat and Cowork source adapters

These are bounded source decoders, not authentication, acquisition, scheduling
or writer authority. The caller supplies qualified account/capture/source
coordinates. Pure projection and invented-record integration do not establish
real provider completeness. Current released WIRE does not activate either
Microsoft source.

Use the [read model](native-read-model.md) for common validation/units and
[host](microsoft-native-host.md) for actual acquisition/provenance boundaries.

## Version selection

| Producer | Contract |
| --- | --- |
| Chat `m365-chat-source-v0-inactive` | Original bounded message/invocation and separate source-fact projection |
| Chat v0.1 | Whole-input capacity aligned with the shared native bound; per-fact/output limits remain |
| Chat v0.2 | Singleton qualified card-text fallback only when original plain text is absent |
| Chat v0.3 | Adds typed provider Progress context, not a reply/call/outcome |
| Cowork v3 review-only | Singleton observations with conservative author/description qualifications |
| Cowork v4 message parts | Explicit multipart entrypoint with original part pointers |
| Cowork v5 `748365` authors | Matched producer's qualified user/assistant role mapping |
| Cowork v6 result facts | Legacy cohort's diagnostics/result facts, keeping its author/description limits |
| Cowork v7 `748365` result facts | Matched cohort's author and literal description qualification |

Select the exact supported producer deliberately. New facts can create a new
immutable capture variant; old captures and frozen reports are not re-decoded
or relabelled. Source/schema/build labels remain provenance, not current
authority or a proof that this client was actually observed.

## Chat

`decodeNativeChatObservation` takes the original scope, capture, ordering,
source document/pointer and message record. An optional response request ID
requires its response pointer and never replaces the message's request ID.
Output separates compatible envelopes, source observations and explicit
limitations. Missing original message identity cannot manufacture a carrier.

Original pointers address source fields; `decodedPointer` addresses fields
inside a decoded string/array. They are different namespaces. Keep absent,
null, empty, unsupported, excluded, unqualified and conflicting facts distinct.
Unavailable facts have no hidden value.

| Source observation | Admitted meaning |
| --- | --- |
| Ordinary Chat text | Screened original representation and source role/provenance, not a fabricated call |
| Strict invocation array | Exact `id`, function name and independently qualified input per entry |
| Task body | Indexed task/step/reasoning source facts and safe status literal, not a qualified task-success enum |
| Supported clarification | Original question/options and exact request/call/widget associations, not an executed action |
| Confirmation/card metadata | Original action IDs, consequential flag and prospective submit coordinates, not permission or success |
| Provider Progress | Screened intermediate source text under recorded updates, not authored reply/finality |
| Unknown completion/trigger shape | Explicit limitation; no generic inferred enterprise result |

Before projecting a call, require:

- An exact, unambiguous native invocation `id`. Do not alias `callId` or bind
  input by array position, tool name or proximity.
- A supported input shape without unknown fields, duplicate IDs or credentials.
  Refuse the affected projection on failure; missing input never becomes `{}`.

Task arrays preserve every supported indexed element. The historical UI's
first-element behavior is recorded as qualification, not used to drop later
source facts or synthesize IDs/default status. Task status literals remain
unqualified in meaning; annotations do not expose opaque tool bodies.
Raw reasoning, task results and arbitrary card/confirmation payloads remain
excluded.

Supported clarification names are `clarification_ask_user_question` and
`clarification_request_browser_take_control`. Their original fallback and
first-element eligibility rules remain distinct. `sourceRequestId`, native
task IDs, invocation IDs and widget IDs are not renamed to each other.
CompletePlugin/CompleteExtension/ExecuteAction/InvokeAction labels alone
do not supply a result schema.

| Text path | Admission condition |
| --- | --- |
| Card-text fallback | Plain text is absent and exactly one supported bounded TextBlock leaf exists |
| Present/null/empty/excluded plain text | Cannot be bypassed by fallback |
| Progress | Original `messageType: "Progress"` and exact `/text` pointer; no structured-control text as prose |

| Chat decoder bound | Maximum |
| --- | --- |
| Outer input | Shared native byte bound |
| Text / decoded fact layer | 64 KiB |
| Output | 1 MiB |
| Depth / expanded input values | 24 / 10,000 |
| List / pointer | 100 entries / 1,800 bytes |

Check bounds before whole serialization and after each supported decode.
Never execute accessors, custom serializers, cycles, sparse or non-JSON objects.
Fixed errors contain no source payload.

`retainNativeChatSourceObservations` attaches the separately validated source
bundle to exactly one matching carrier. It preserves parser/source/ordering
identity and cannot turn an orphan Task fact into a conversation. Its strict
version/kind validator lives in `lib/native-chat-observation-contract.mjs`.

Historical parser provenance pins retained first-party configuration module
714560 and its reviewed source hashes in `lib/native-chat-source.mjs`.
Those historical labels do not establish current-build applicability.
Enterprise execution/failure/return semantics still need their own qualified
source anchor; image/citation representation is not a substitute.

## Cowork

`adaptCoworkSourceRecords` takes supplied compact events/task snapshots with
mandatory account, surface, conversation, capture, parser version and original
source coordinates. It performs no file/network I/O and cannot infer missing
context from current time or a runtime lease.

| Original field/event | Meaning and limit |
| --- | --- |
| `ts/tx.data.tn` | Literal native tool name, never a Work IQ alias |
| `ts.data.inp` | Exact bounded input; absent/null/empty/serialized/plain remain distinct |
| `tx.data.ok` | Explicit boolean native completion only |
| `tx.data.dur` | Recorded milliseconds, provider-tool-duration boundary; not prompt latency |
| `tx.data.err` | Version-qualified screened failure diagnostic, not inferred HTTP/code fields |
| `taa.data.approved` | Original approval observation, not execution or a WIRE permission grant |
| Task snapshot state/model | Task outcome and snapshot model, not aggregate tool success or per-call model |
| `u/a`, `th`, `dx`, `fr` text | Version-qualified message/fragment/terminal observations; no concatenated or invented completed reply |
| `aq`, `aa`, `rc` | Original question, acknowledgement or bounded card parts |
| `tx.data.wr` | Reference-array cardinality/type facts, not entities, API requests or outcomes |
| CallGraph input requests | Declared start-observation count, not returned-member or successful-request count |

Starts and completions join by original native call identity. Twenty declared
requests plus `ok:true` cannot become twenty observed successes. No observed
members means unknown result coverage; array position does not identify a target.

| Identifier | Meaning |
| --- | --- |
| `ts/th.aid` | Agent reference |
| `ta/taa.aid` | Approval identity |
| `sa/sx.tid` | Agent announcement |
| `ta.tid` | A link, not a start/completion |

Unknown events retain qualified identity/coverage without guessed relationships.
Runtime-injected `fr` content cannot become an original reply.

V3/v4 retain unknown authors because the earlier public client did not establish
the defining enum. The matched `748365` cohort independently qualifies `u/a`
roles, without making fragments completed responses or proving human intent.
Native UI generated message IDs/defaults are not source identities.

The explicit multipart helper follows only the qualified card text tree and
question/answer fields. Parts stay separate, with exact original source pointer
and representation. It does not traverse arbitrary actions or concatenate text
to evade identity collisions. The 256-part limit covers an event, not calls;
shared aggregate byte/node/view limits still apply. Unknown ancestor/rendering
context remains a qualification, not proof the text was visible in the source UI.

## Diagnostics, results and clocks

V6/v7 use the shared screened `native-tool-error` diagnostic with exact original
`/data/err` reference. Safe text and ordinary parameter punctuation remain;
credential/sensitive/oversize/stack/payload-shaped content is excluded.
The 8 KiB diagnostic bound remains. Null/unsupported error objects do not
become parsed codes or inferred statuses.

Only the matched v7 literal `tx.data.d` qualifies the separate result-description
carrier. The reviewed public `1979.ca29e321.js` consumer has SHA-256
`edf889e1b71d7615034272715133c53cb03333becca5ce7a54d80f006ed69a3a`;
the description is at UTF-16 offsets 296036-296500 and the `tx` handler at
317831. These source locations qualify that producer, not a later live bundle.
The UI's tool-dependent `d/out` fallback is not copied.

Raw `out` never enters retention. Absent/null/empty/excluded/oversized/unsupported
content remain different. Alternative `results/responses` do not silently
become empty success. `applicationError`, singleton `statusCode` and
`resultCount` stay null where this producer has not qualified them.
Tool completion, task state and separately admitted returned API results remain
independent.

| Clock | Qualified meaning |
| --- | --- |
| Cowork `data.ts` | Exact event/source reference and producer-qualified unit; legacy/matched handlers establish epoch milliseconds, not magnitude |
| Cowork call date | Only an unambiguous current `ts`; never `tx`, list recency, capture time or a `Date.now()` default |
| Chat `createdAt` / `timestamp` | Message-scoped; creation may qualify ordinary-message Dates context, not a call clock |
| Chat update time | Provenance |

The shared model validates exact explicit-offset timestamps and recomputes
calendar instants without rewriting original strings.

## Shared privacy and integration

Input/output crosses the real native validator, including escaped JSON and
decoded string/key credential checks. Every alias occurrence counts toward
expanded bounds. Unsafe retained identities reject; excluded input values
must disappear from both fact and carrier. Arbitrary raw payload differences
are not magically an original archive.

Exact modeled replay deduplicates; changed content at the same observation
identity conflicts. Separate captures/representations preserve separate
observations and provenance without multiplying calls.

Source-to-reader fixtures use actual decoder -> shared projector -> genuine
fixture lease -> normal local HTTP/Search paths, not a substitute normalized
object. They prove those mechanics with invented data only. Raw-v0 writer
blockers, actual account/acquisition, full history, browser presentation and
report admission remain separate. No documentation example supplies a real
source grant.
