# Authorized search corpus

`lib/search-corpus.mjs` supplies process-private admitted text to
[literal retrieval](live-search.md); `lib/search-corpus.d.mts` defines its
consumer interface. The corpus does not install models, collect original
history, grant permission, render UI or persist an index.

## Admitted sources

| Type | Authoritative input and reader | Destination and limit |
| --- | --- | --- |
| Interaction/context | Complete accepted `mergeEvidenceWithState` roster and `createRequestContext.select`, not a date/page slice | Exact interaction/message context; no task clustering or reconstructed chat |
| Retained reply | Assessment read model plus the existing authorized retained-response action | Original interaction; source/consent/membership/integrity checked before and after read |
| Recorded action | Canonical activity analytics and exact call investigation across supported layers | Exact request/layer/call; returned entries also bind snapshot revision |
| Tool/service | Names actually present in qualified retained actions | Existing all-scope filter destination, not automatic analytical membership |
| Saved report | Registered saved-file reader, disclosure manifest and exact bytes/hash | Exact bundle/format/manifest/file identity, without source regeneration |
| Saved comparison | Verified frozen manifest and compatibility reader | Exact independent saved comparison, not its source reports' current contents |
| View/setting | Fixed current navigation/settings registry | Reveal/navigate only; never click a control or open approval |

Retired review/feedback operations are absent from navigation, while their
wording in an independently authorized historical saved document can remain
searchable. No source-path or live permission DOM values become setting text.

IDs use the typed canonical identity hash; revisions bind content, source,
coverage and target. IDs can survive content changes, revisions cannot.
Only admitted title, content and readable source label are matched. Operational
IDs, hashes, private paths, target descriptors and raw source fields are not
searchable text.

Titles for interactions/context/replies are original slices up to 120 graphemes.
Empty/unavailable text stays qualified. An observed automatic continuation can
have an Automatic continuation title and empty body without becoming a
missing-prompt error or retaining host instructions.

The derived-text screen removes recognized credentials, private URLs, local
paths and opaque identifiers. It is not complete DLP or permission to include
another field. Validated canonical report titles use their verified
manifest-declared provenance, not a title-shaped string as a bypass.

Recorded actions may include their already-retained screened diagnostics.
A tool call and its exact returned entry keep their own scopes/revision;
Search does not read the original error envelope or response body to enrich them.

## Saved-file extraction

Choose HTML -> JSON -> Markdown -> PDF only when the earlier format was
genuinely not saved. A declared missing/corrupt file, inconsistent inventory,
unsupported schema/encoding or failed extraction is an error, not permission
to try a lower format.

- HTML extracts inert visible body text and the verified document title,
  excluding scripts, styles, hidden content and attributes.
- JSON validates the complete frozen snapshot/manifest identity and extracts
  allowlisted projected facts and copies, not arbitrary fields.
- Markdown remains inert source text, including literal code/prompt lines;
  no links or resources are followed.
- PDF reads the verified saved text layer locally. Images have no OCR;
  encrypted, unsupported, textless and failed parses remain unavailable.

Optional recorded context requires the matching closed schema, identical
snapshot/manifest copies and context hash as well as ordinary hashes/privacy
checks. Result-text copies and historical facts retain their original
representation, coverage, membership and interpretation. Absence does not
invent current facts. No extraction rewrites saved bytes.

The selected file's size limit remains 32 MiB. PDF.js runs in a short-lived
owned Node child using `--disallow-code-generation-from-strings` and a minimal
system/temp environment. Preloads, debugger/NODE_OPTIONS/provider/data-dir
variables and inherited stdout/stderr are excluded. Only verified bytes cross
local IPC.

The byte/text-only parser disables external resources, font loading, Wasm,
XFA, GPU/image/rendering and other active paths. It checks the code-generation
restriction before loading PDF.js. Any decoder diagnostic rejects extraction
rather than presenting repaired success; diagnostic text is not retained.
Cancellation terminates the owned parser and waits for closure. This is a
constrained parsing path, not an OS sandbox or secure-erasure guarantee.

## Index, delivery and invalidation

Construct `createSearchCorpus(session,{source,onInvalidate})` for the existing
store. `source(state)` is required, synchronous and read-only, supplying the
current collector source. Persisted authorization cannot replace an unavailable
current source. Missing/malformed callback results fail; unavailable reply
authority does not block independently authorized saved artifacts.

The corpus starts uninitialized with no disk index. Every rebuild/index read/
delivery revalidates retained inputs. Artifact checks run inside the existing
board serialization boundary; reply payload reads remain outside it so their
own guards can operate. A final state/source stamp check linearizes publication
against owned changes.

| Method | Contract |
| --- | --- |
| `rebuild()` | Construct current entries and return content-free status. |
| `index(build,publish)` | Run local-only computation under cancellation; reread sources and allow synchronous publication only for the same current generation. |
| `deliver(ticket,disclose)` | Recheck every ID/revision and authority before synchronous disclosure. |
| `invalidate()` | Abort owned work, drop derived content and synchronously notify consumers. |
| `close()` | Permanently invalidate and drain owned operations. |

Store reads use the internal read-only path: absent or migration-required state
fails before initialization/directories/writes, and save callbacks reject.
That is a guarantee about owned store operations, not arbitrary supplied code.

Source/consent/deletion/evidence/artifact changes must invalidate before their
acknowledgement. Consumers synchronously clear index references, queued/displayed
excerpts and targets, and invalidate on failed status/transport. Old builder
results are not render/Open authority. JavaScript cannot erase content already
disclosed to another process or the user.

Ready/partial describes retained availability, not complete source history.
Stale, superseded, unavailable and closed are not no-match. Type-qualified issues
can distinguish an unrelated saved-file gap from incomplete analytical activity,
but cannot discard a relevant coverage gap to manufacture complete membership.
Per-file text completeness is separate from whether every admitted item was read.

## Exact Open

Targets are a closed data union, never executable actions or caller paths.
After delivery, the live owner may dispatch only the corresponding read-only
report/comparison/request/view destination. Saved non-HTML targets carry their
exact format and original file digest, not a text-extraction digest.

Open rechecks original owner, source, target revision and exact saved bytes.
Do not put capabilities, query text or private paths in URLs. A source change
can retire Search authority without revoking an independently approved library
copy; a removed saved artifact cannot be opened through either path.

## Native source-fact text

Optional incubation source facts use existing context hits, not new authored
messages, services or outcomes. Only qualified recorded literal task/step/action
names, clarification wording/options and supported provider-progress text enter.
Raw IDs, timestamps, coordinates, hashes, structured payloads and excluded
reasoning/control bodies do not become text.

Facts retain original and decoded source pointers, source-qualified keys and
their own availability. Their exact `native-source-fact-...` destination focuses
the retained fact in its conversation; no call ID or author is invented.
Missing text/unsupported facts remain incomplete context coverage. Navigation
can remain possible without a complete analysis receipt.

Native reply authority uses the actual retained account lease, not GitHub's
separate reply-saving flag. Index, delivery and Open recheck current lease/root/
revision. Boundaries for paged native Search, exact ordinal Open and analytical
membership are in [retained views](incubation/native-retained-views.md).
This does not activate the source or qualify real acquisition.

## Validation

The current corpus and format suites exercise invented stores, real readers,
ownership/privacy/deletion fences, full populations, saved formats and parser
closure. Packaging qualification is a separate
[production-only lane](development.md#check-a-change). Tests and screenshots
must not be described as real provider or private-data acceptance.
