# On-device hybrid retrieval

`lib/search-retrieval.mjs` is a private, in-memory retrieval facade over the [authorized corpus](search-corpus.md). `lib/search-retrieval.d.mts` is its consumer contract. It implements actual pretrained embeddings plus independent lexical precision. It does **not** attach itself to the running collector, expose HTTP routes, change the browser's existing analytical search, render results, or open targets.

Its additive `discover()` method can also produce separately stamped **Related results** for navigation. The producer contract below is implemented; runtime/UI consumers must separately wire purpose-checked receipts before exposing it. Existing `search()` remains strict-only and unchanged.

The separate [live-search integration](live-search.md) now owns those runtime/UI
responsibilities, using this facade unchanged. It coalesces normal typing behind
verified delivery instead of repeatedly aborting a PDF generation.

## Model and provisioning

| Component | Fixed identity | License |
|---|---|---|
| Encoder | `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`, `onnx/model_quantized.onnx` | Apache-2.0, declared by the preserved model card |
| CPU runtime | `onnxruntime-web@1.22.0`, Node ESM WebAssembly build | MIT |
| Tokenizer | `@huggingface/tokenizers@0.2.0`, pure JS | Apache-2.0 |

`lib/search-model-assets.mjs` contains exact filenames, byte lengths and SHA-256 values for all five model/provenance files and the selected runtime/tokenizer modules. The acquired weight is 22,972,370 bytes, SHA-256 `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`. The model's four inference files total 23,685,047 bytes; its original README adds 1,767 bytes.

Install packages using the repository lockfile, then explicitly provision the public assets:

```powershell
npm ci --omit=dev --ignore-scripts
npm run search:model:provision
```

Provisioning writes only `assets\search-models\all-MiniLM-L6-v2\751bff37182d3f1213fa05d7196b954e230abad9\`, outside private evidence storage and ignored by Git. It does not start WIRE, inspect a source, run an assessment, or accept a query. The downloader uses fixed revision URLs, a bounded public HTTPS redirect allowlist, exact byte limits and SHA-256 checks before publishing the complete staging directory. It never overwrites an existing corrupt/incomplete version as a successful repair. Such a directory needs explicit operator repair/removal before reprovisioning. A complete offline copy of these exact five files passes the same runtime checks.

The model's original README/license declaration is retained byte-for-byte. Keep it and the licenses/notices of the required npm packages with an offline distribution; the required tokenizer package includes the full Apache-2.0 license at `node_modules\@huggingface\tokenizers\LICENSE`. Do not strip runtime copyright headers or dependency notices. Source references: [model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2/blob/751bff37182d3f1213fa05d7196b954e230abad9/README.md), [base encoder guidance](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/README.md), [runtime MIT license](https://github.com/microsoft/onnxruntime/blob/f217402897f40ebba457e2421bc0a4702771968e/LICENSE), [tokenizer source/license](https://github.com/huggingface/tokenizers.js/tree/e480fc097a59cab66dbbe516ae8ad82d0e263c25).

Normal startup, search, typing and retry never acquire packages or weights. Missing, unreadable or corrupt assets are explicit model availability codes. An independently authorized lexical index can remain usable as **`lexical-only`**; it is never described as semantic success. A runtime failure during a hybrid query invalidates the index and returns unavailable, not partial semantic results.

## Local execution and privacy

The facade owns one fixed Node child using `process.execPath`, fixed arguments, ignored stdout/stderr and a minimal system/temp environment. No shell, inherited debugger/preload flags, `NODE_OPTIONS`, provider credentials or model-hub tokens are supplied. Queries travel only over private local IPC, never argv, URLs, logging, persistent storage or a cloud API. The child denies fetch/WebSocket/HTTP/TCP/DNS/UDP entry points before loading dependencies. It has no listener, browser worker or independent service lifecycle.

The helper uses the Node export of **onnxruntime-web**, not **onnxruntime-node**. The selected upstream Node build disables JSEP, WebGL and the browser proxy and runs Emscripten CPU WASM. Its non-Windows platform telemetry provider is a no-op even on a Windows host. Native ONNX Runtime Windows builds have a different, default-on platform telemetry policy; they are deliberately not installed as a substitute. [Build source](https://github.com/microsoft/onnxruntime/blob/f217402897f40ebba457e2421bc0a4702771968e/js/web/script/build.ts#L557-L583), [telemetry implementation](https://github.com/microsoft/onnxruntime/blob/f217402897f40ebba457e2421bc0a4702771968e/onnxruntime/core/platform/telemetry.cc), [native privacy disclosure](https://github.com/microsoft/onnxruntime/blob/v1.21.0/docs/Privacy.md).

Package versions and selected module hashes are checked before inference. The same verified model and WASM byte arrays are passed to the runtime; tokenizer construction uses the same verified JSON bytes. There is no model URL loader or implicit cache. The runtime is single-threaded CPU WASM with debug, trace, profiling and GPU providers disabled. Initialization asserts model configuration, exact input/output names, successful int64 input feeds, float32 output shape `[1, tokens, 384]` and finite nonzero normalization.

One request is admitted to the child at a time. Supersession, invalidation and close terminate actual active computation, not just hide a late response. Invocation ownership extends through the embed continuation, including the interval after IPC clears its pending request. A replacement waits for the prior child to exit, and the superseded promise settles without requiring the replacement to be closed. Idle helpers remain warm; restarting after cancellation has a cold-load cost. Ordinary JavaScript/process isolation is not an OS sandbox, secure memory erasure, protection against a privileged local attacker, or a change to existing evidence permissions.

**Transport seam:** global semantic queries are computed in the existing local Node runtime and this child through the separate live-search owner. Legacy analytical/private search in browser memory and `history.state` remains compatible; new global text remains memory-only and out of URLs. No transport is enabled by this facade itself.

## Corpus, index and delivery contract

Construct one facade for one panel's monotonic request sequence:

```js
const search = createSearchRetrieval(session, {
    source: state => currentCollector.assessmentSource(state),
    onInvalidate: receipt => clearOwnedQueuedAndDisplayedHits(receipt),
});
await search.build();
await search.search({ query, requestId, types: ["report", "interaction"] }, (hits, receipt) => {
    // Synchronous plain-text disclosure; opening a target is a separate read-only action.
    showAuthorizedHits(hits, receipt);
});
```

`source` must be the actual current collector assessment source, not a persisted authorization fallback. A missing current source fails closed under the existing corpus contract. `onInvalidate` is mandatory and synchronous; it must not reenter the corpus. Consumer callbacks must return `undefined`, never promises.

- `build()` uses the real `corpus.index(build, publish)` scans, current-source/integrity revalidation and synchronous publication. No result is disclosed by the builder. The index stores admitted text, vectors and stable ID/revision references, not executable targets.
- `search()` requires a nonnegative monotonically increasing safe-integer `requestId`; duplicate/older requests return superseded without disclosure. `types` is an optional allowlist of the ten corpus types. Ranking uses one coherent index. Only `corpus.deliver(ticket, disclose)` exposes freshly revalidated entries and closed target descriptors.
- Model identity binds exact model/runtime/tokenizer assets, dimensions, pooling and normalization. Index identity also binds corpus generation, sorted item revisions, chunking/ranking policy and hybrid versus lexical-only mode. Chunk hits deduplicate to typed items; ties use stable typed IDs and chunk offsets.
- `invalidate()` synchronously drops the owned index, aborts query/build work and invokes the invalidation callback. `close()` performs the same synchronous clearing permanently and returns a promise for owned-helper closure. Stale/superseded/unavailable/closed are distinct from a valid no-match.

The callback promise is **in-process only**. It does not synchronously erase a different browser panel over a transport that does not exist here. Before enabling UI, runtime integration must connect collection/source/consent/deletion/artifact changes to invalidation before mutation acknowledgment, propagate generations to every panel, clear queued/displayed hits and targets, and invalidate on state/poll/transport failure. Session expiry, disconnect and runtime shutdown must close the corresponding facade. No result from a builder or stale receipt may render or navigate.

The corpus has no separate abort-delivery method. If a newer query arrives while source/PDF delivery revalidation is active, the facade invalidates that generation to abort the real parser, returns **stale**, and requires a fresh build. It does not pretend that stale means no matches. This conservative behavior must be handled by the subsequent live-search owner.

All returned text is inert. Preserve each entry's source, coverage, original/masked/none and missing/partial/failed extraction distinctions. `open-saved-report-file` descriptors remain inert; the legacy unchecked `/api/report-file` path is not a dispatcher. This unit changes no report opening, UI, Settings, collector, HTTP, CSP or corpus/cache behavior.

## Retrieval behavior and limitations

The rules below describe the unchanged MiniLM baseline. The separately
provisioned [role-bound lexical adjunct](search-linguistics.md) is disabled by
default and **not currently qualified for activation**. Corrections for negative
scope and source-modifier loss invalidate its earlier two-query qualification.
Strict F09 and the ordinary-work misses remain open. The adjunct introduces no
new neural model or persistent search cache.

Only admitted **title, content and readable source label** enter lexical matching or embedding. IDs, hashes, targets, private paths, linked-interaction IDs and operational metadata do not. This version does not add coverage fields to embedding text.

The real WordPiece tokenizer partitions source strings into overlapping original slices, retaining all admitted coverage and the final tail. Each chunk has at most **256 tokens including CLS/SEP**, following the sentence model's intended length rather than its 512-position architecture ceiling. A 2,048-character packing window bounds tokenization work per candidate; it partitions, never truncates, a document. Overlap is at most 24 content tokens where whitespace permits. Surrogate pairs are not split. Excerpts are original admitted slices, never reconstructed with token decoding.

Every chunk uses attention-mask-aware mean pooling and L2 normalization into 384 Float32 components. Long queries use the same complete chunking. Item semantic relevance is the maximum query-chunk/document-chunk cosine; therefore a long multi-part query behaves as an OR over its chunk meanings, not an assertion that a result satisfies every clause.

Lexical tiers prioritize a complete title, exact phrase, all exact words, then all word prefixes. Structured tool-name prefixes, paths, underscores, uppercase HTTP verbs and three-digit statuses require literal anchors; a semantically similar but different status/path does not substitute. Once every required anchor is present, unmatched prose can still pass the semantic floor; anchor presence alone does not block semantic ranking. This behavior is bound to ranking policy `exact-prefix-cosine-v2` in the index identity. Unicode text is preserved; lexical normalization uses NFKC and lowercasing without an ASCII-only word filter. Ordinary lowercase "get" and prose such as "sign-in problems" are not automatically HTTP/tool identifiers.

Semantic-only hits require cosine >= **0.50**. This policy is versioned, does not pad to a result count, and emits only `match: "exact" | "prefix" | "semantic"` rather than similarity/answer-quality percentages. Three real-model positive fixtures scored **0.630, 0.544, 0.543**; twelve negative comparisons, including a neighboring hospital/payroll topic, had maximum **0.180**. The full corpus path separately asserts unrelated-query rejection. These bounded controls support this cutoff but are not a universal relevance calibration.

This encoder is **English-oriented**. Unicode lexical retrieval and complete Unicode chunk coverage do not imply multilingual semantic quality. WordPiece may map unsupported text or words longer than its 100-character word limit to unknown tokens; no hidden text or language meaning is recovered. There is no generated answer, learned usage ranking, persistent index or query log.

## Separate Related results producer

`discover(input, disclose)` accepts the same `{ query, requestId, types }` as `search()` and shares its index, monotonic request sequence, cancellation and invalidation lifetime. It uses one query embedding and one union `corpus.deliver` ticket. The synchronous authorized callback receives:

```js
{
    matches: { hits, receipt },
    related: {
        state: "available",
        hits: relatedHits,
        receipt: relatedReceipt,
        coverage: { evaluatedItems, corpusState, populationComplete: false }
    }
}
```

`matches.hits` preserves baseline strict IDs, match labels and exact excerpts. When configured, the optional linguistic path adds only separately supported records before disclosure. Its discovery-only receipt extends the existing stamp with `purpose: "strict-match-population"`, `matchPolicyId` and `types`. The **existing `search()` receipt retains its shape**. Both discovery stamps use canonical effective types: empty/omitted means all ten types in `SEARCH_TYPES` order; repeated types are deduplicated and invalid types reject.

Related hits carry only original corpus fields plus `match: "related"` and `purpose: "navigate-only"`. The Related receipt additionally binds `purpose: "related-navigation"` and `relatedPolicyId`. No scores or generated explanations are disclosed. Disabled search retains `SEARCH_MATCH_POLICY_ID` and the original `SEARCH_RELATED.id`, **`1544a5093a15a386fa06361c344aabda392a5df77ad97cb1159ec87959637148`**. Explicitly enabled search instead uses the distinct pair in `SEARCH_LEXICAL_POLICIES`, binding the optional rule/resources and Related exclusion. Related metadata does not enter the strict index identity. Enabling the linguistic rule adds its own identity; disabling it preserves the baseline core index identity and receipt policy values.

The frozen Related rule uses the same current admitted title/content/source projection and model. After type and exact-anchor gates, candidates must be absent from the strict set (including configured linguistic additions), have cosine at least **0.35**, and lie within **0.02** of the strongest eligible item score, including strict hits. All qualifying candidates are returned with stable typed-item deduplication and deterministic ties; there is no top-N/page cap or extra model run.

The discovery promise returns `SearchDiscoveryStatus`. Its inherited `count` counts **strict matches only**; `related.count` counts Related candidates. Related-only results do not return `no-match`. Empty queries disclose both empty lists without inference. Lexical-only/model-unavailable mode can still disclose strict lexical matches, but Related is explicitly `{ state: "unavailable", reason: "model-unavailable", hits: [], receipt: null, coverage }`. Early/stale/superseded/closed calls disclose nothing and return Related unavailable with reason `not-current`. Invalidation drops the shared index/queued work; consumers must clear both disclosed sets on the existing invalidation callback and on each new query.

### Navigation meaning, not analytical membership

Consumer copy should say **“Related results”**, for example: **“Similar topics, but they may describe different work. These suggestions do not change your charts or report selection.”** Show the actual source, type, original excerpt, coverage limits and destination. A printer cable record can be a Related suggestion for printer toner, but that is not evidence that toner was changed.

Related must never enter charts, comparison cohorts, report scope, selection or the strict membership map automatically. Opening an item is a read/navigation action; an independent explicit record selection is not proof of a complete query population. Runtime integration must use closed purpose-discriminated wire receipts, separate stored strict/Related hit maps, full owner/epoch/request/revision equality, and strict-only analytical admission. Editing a client purpose string cannot promote a Related ID into the server's strict map. The producer does not implement this wire authority or change the existing membership helper; the consumer owner must prove it separately.

`coverage.evaluatedItems` counts type/anchor-eligible items examined by discovery, not matching records. `populationComplete` is always false: the policy selects navigational candidates, not every semantically related item. Even with a ready corpus, a stronger new item or a different source label can move a weaker candidate outside the score band. Pages may say all N **candidates** across P pages, never a complete matching population. Partial corpus coverage remains separately visible.

The bounded qualification exposes all three original car queries through Related, but they remain absent from the strict set. Outside calibration, clear-target access improved from strict 4/15 to combined 13/15; permission removal and plant recovery remained below the discovery floor. Thirty-two unrelated-query checks and 120 retained noise records added no unrelated Related objects within the predeclared topic bounds. A separate identical-content fixture proves 63 distinct candidates survive across four display pages. This is not a universal relevance guarantee.

**Strict analytical F09 remains open.** Related does not repair the original semantic-filter recall or justify existing strict false positives. A current receipt establishes authority/revision validity, not semantic truth or completeness.

Focused producer proof:

```powershell
node --test --test-concurrency=1 tests\search-discovery.test.mjs tests\search-retrieval.test.mjs
```

The tests compare shared scoring against the frozen pre-discovery strict algorithm, exercise the real model and unchanged index identity, canonical stamps, one query inference/one delivery, held-out/topic/noise bounds, 63-ID coverage, exact-anchor precedence, shared search/discover supersession, model absence/corruption, source revocation, frozen artifact tampering/deletion and no persistent query writes. Runtime receipt-forgery, owner and UI purpose tests remain the consumer integration responsibility.

## Focused proof and measured limits

After explicit provisioning:

```powershell
node --test --test-concurrency=1 tests\search-model.test.mjs tests\search-retrieval.test.mjs tests\search-provision.test.mjs tests\search-corpus.test.mjs tests\search-corpus-readonly.test.mjs
```

Fixtures use invented ephemeral stores, real retained-content/artifact readers and the actual selected model. They cover all ten types and source kinds, original/masked/none reports, paraphrase without literal-word overlap, exact/prefix tool and method/path/status precision, Unicode, full long-tail/long-query chunks, deterministic item deduplication, current-source/revocation gates, real process cancellation/close, PDF delivery supersession, absent/corrupt assets, atomic provisioning failures and offline operation. The production fixture copies only required modules and manifests, performs `npm ci --omit=dev --ignore-scripts --offline`, and executes the real helper with the development test package and native ORT absent. npm checks lockfile SRI; selected model/runtime/tokenizer files also pass independent SHA-256 checks. The configured repository npm feed supplies SHA-1 SRI for several packages; the lock is retained rather than silently changing registries or disabling TLS.

Observed on Windows x64, Node 24.19.0, single-threaded WASM, bounded focused runs (not a hardware-independent SLA):

| Measurement | Observed |
|---|---:|
| Cold child startup + verification/loading/warm inference | about 0.35-0.50 s |
| In-helper loading portion | about 0.26-0.38 s |
| Short warm query inference + IPC | about 2.7-3.9 ms |
| Full mixed-corpus build, 65 items / 108 chunks | about 4.9-5.8 s |
| Warm non-PDF gated query | about 70-88 ms |
| Full query with one saved PDF | about 0.73-0.81 s |
| PDF query's delivery/revalidation portion | about 0.72-0.80 s |
| Child steady RSS after mixed/PDF work | about 196-202 MiB |
| Child high-water RSS during mixed/PDF work | about 315-337 MiB |

`status().metrics` retains only the latest content-free durations. Model status reports observed RSS and OS process high-water RSS (maximum across this model owner's children), not total WIRE/browser memory. Embedding storage alone is `chunks * 384 * 4` bytes; text, lexical structures, IPC copies and build buffers are additional. Model assets are ~22.59 MiB, but the whole ORT Web package is ~89.61 MiB; model plus both direct packages is ~112.5 MiB before transitives/cache.

**Concrete bottleneck:** corpus delivery reparses the saved PDF and revalidates retained inputs; it dominates the measured query, not semantic inference. Builds make two full scans and additional current-state/artifact checks. No cache, persistence or authority shortcut was added. Any future verified-extraction cache or delivery-cancellation seam requires separate clearance and must preserve current permissions, immutable-byte checks and the final delivery gate.

## ONNX Runtime license

The selected npm runtime distribution retains its source copyright headers; the upstream license is reproduced here for offline distribution.

```text
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
