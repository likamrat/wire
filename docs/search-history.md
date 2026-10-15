# Search scope reset and historical tests

The current product is [deterministic local text search](live-search.md).
Earlier semantic, embedding, linguistic, Related and intent-denial experiments
are not active Search options or current qualification gates.

The original research fixture `tests/search-linguistics-fixture.mjs` is unchanged.
Its MUST/ALLOWED sets were not rewritten to make literal results pass. In
particular, literal text search intentionally finds `did not repair the car`
when asked for `repair the car`; the earlier opposite expectation is historical.

The following backend test files were moved byte-for-byte from `.test.mjs` to
`.historical.mjs` in the same directory, preserving their source and relative
import statements rather than silently skipping or relabeling them:

- `search-model`, `search-model-guard`, `search-model-owner`, `search-provision`
- `search-linguistics`, `search-linguistics-protocol`, `search-linguistics-scope`,
  `search-linguistics-scale`, `search-linguistics-wire`
- `search-denial`, `search-expectations`, `search-retrieval`, `search-discovery`
- `live-search`, `related-wire`

They are evidence snapshots, not a runnable current-contract suite. Historical
reproduction belongs to source baseline
`8dab98f4e847186c2606efb3fe2ada87c609db98` and its separately authorized resources,
not to the current text implementation. Their former grants do not authorize
new model/helper/provisioning runs. The normal `tests/*.test.mjs` glob does not
select the archived names.

## Still-current invariants remain active

| Historical mixed cases | Current active proof |
| --- | --- |
| `search-retrieval`: authorized types, long tails, Unicode, complete query inputs, current source, cancellation | `search-text.test.mjs`: actual corpus, original Unicode ranges/sigma, long record and long literal query, same-index search/discover, replacement/invalidation/empty/error cases; `search-corpus*.test.mjs` retains readers and authority |
| `search-discovery`: complete deterministic population, cross-entry-point replacement, async-disclosure rejection, no persistent query/index files | `search-text.test.mjs` and `live-search-text.test.mjs`: first-class text path, deterministic fields/order, cross-method supersession, no stored query files, 63 unique IDs/four page slices |
| `live-search`: actual PDF typing/cancel/closure, two-owner ceiling, idle/TTL/reconnect | `live-search-text-lifecycle.test.mjs`: actual PDF parsing/verified PDF Open, newest-only queue, cancellation, owned parser exit, two-panel limit and expired/new owner receipts |
| `live-search`: reused state revision after changed retained bytes; foreign origin/anonymous/caller-path refusal | `live-search-text-lifecycle.test.mjs`: real changed retained-content write and real HTTP refusal cases |
| `live-search` / `related-wire`: one owned Open slot, Close waits, no late comparison bytes, stream backpressure | `live-search-text-lifecycle.test.mjs`: actual board/file read gates, cross-owner comparison refusal, closure waiting and slow-consumer closure without truncated disclosure |
| `related-wire`: permission revocation, frozen-file tamper/deletion, independent saved content, current-source loss | `live-search-text-lifecycle.test.mjs`, `live-search-text.test.mjs` and unchanged `search-corpus.test.mjs`: normal consent/deletion actions on owned fixtures, before/after authority checks and independent approved files |
| `related-wire`: closed policy/purpose/type receipts; navigation cannot acquire analysis/report authority | `live-search-text.test.mjs`: v3-only receipt/range validation, old enum/schema/policy rejection, real navigation-purpose relabeling refusal and actual analysis membership |
| Whole population, both periods and frozen report scope | `live-search-text.test.mjs`: actual emitted text receipts, all 63 interaction IDs, both period sets and in-memory frozen scope; frozen readers retain their independent schemas |
| Report-format/privacy/read-only lifecycle | Existing `search-corpus-readonly.test.mjs`, `search-corpus-native.test.mjs`, and non-installing `search-corpus-report-formats.test.mjs` cases remain active; new text cases use generated HTML/JSON/Markdown/PDF and real extractors |

Model scoring, model-provision failures, semantic recall, and Related-specific
ranking are intentionally not current text behavior. Removing those expectations
does not remove the lifecycle/permission requirements above.

Browser/client-transport migration is a separate coordinated UI change. These
backend changes do not retire `related-browser.test.mjs` or claim that old browser
fixtures already exercise v3. Active Open/Back/focus, paging, clearing, live typing
and visible source/match marking must be proved on the integrated text UI.

## Dependency cleanup

Only historical Search workers/guard import `@huggingface/tokenizers` and
`onnxruntime-web`; active text retrieval/corpus/wire/runtime does not. Those two
direct dependencies and `search:model:provision` /
`search:linguistics:provision` scripts can be removed by the coordinated manifest
owner after usage/test integration. Keep `pdfjs-dist` for non-AI PDF extraction,
Playwright for browser proof, and optional assessment/SDK features unchanged.
Do not delete private historical weights, resource directories or borrowed
dependency closures as part of this cleanup.
