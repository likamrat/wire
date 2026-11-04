# Historical semantic Search

WIRE now uses [local literal text Search](live-search.md), without embeddings,
models, Related results or an intent veto. This page records the retired
experiment and its remaining compatibility and license information.

## What changed

| Former behavior | Current behavior |
| --- | --- |
| MiniLM embeddings combined with exact/prefix matching | Deterministic literal substrings over authorized text |
| Separate navigation-only Related candidates | Actual text matches only |
| A narrow explicit-denial veto | No intent interpretation: `repair the car` can match `did not repair the car` |
| Explicit model provisioning and an optional linguistic adjunct | No Search model, dictionary or inference setup |

Retirement did not relax source permission, complete-population filtering,
Unicode highlights, exact Open, saved-file integrity or cancellation.
Those current rules live in [Search](live-search.md) and the
[authorized corpus](search-corpus.md).

## Findings and limits

| Question | Historical finding |
| --- | --- |
| Did semantic Search solve recall? | No. Required car-query matches and ordinary-work misses remained unresolved. Related improved access to some examples but did not repair strict analytical membership. |
| What did Related mean? | Similar-topic navigation candidates, never a complete matching population or automatic chart/report selection. A valid receipt established authority, not semantic truth. |
| What did the denial correction cover? | A narrow, fully consumed operation/article/object grammar with explicit complete-record qualification. Partial text and unsupported clauses could not supply a veto. |
| What did the timings show? | Bounded Windows/Node observations, not an SLA. Saved-PDF delivery and revalidation dominated one measured query path. Two-thread gains did not establish other-corpus or POSIX performance. |
| What stayed local? | Queries and admitted content remained in memory and owned local helpers. No provider session, AI-credit budget, remote fallback or persistent query index was authorized. |

The [linguistic experiment](search-linguistics.md) remained disabled and
unqualified after modifier and negative-scope corrections. Its passing safety
checks did not waive required positive cases.

## Preserved research and reproduction limit

The [complete published research text](https://github.com/likamrat/wire/blob/0585abe8b2294da12b140af5e948897b53119822/docs/semantic-retrieval.md)
preserves model hashes, helper and receipt contracts, score thresholds,
measured runs, test commands and the detailed denial/Related rules.

The document is available; its historical code is not. Source pins
`8dab98f4e847186c2606efb3fe2ada87c609db98` and
`b1ccf65e8d79534b35a347c992e947d067837858` cannot be reproduced from the
published repository. The linked setup commands describe that old code,
not the current checkout. Do not provision removed dependencies or publish
private ancestry to repair those references.

## Former resources

| Component | Fixed identity | License |
| --- | --- | --- |
| Encoder | `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`, `onnx/model_quantized.onnx` | Apache-2.0 as declared by its preserved model card |
| CPU runtime | `onnxruntime-web@1.22.0`, Node ESM WebAssembly build | MIT |
| Tokenizer | `@huggingface/tokenizers@0.2.0`, pure JavaScript | Apache-2.0 |

Existing offline copies must retain the model's original README/license
declaration, dependency notices and runtime copyright headers. Native ONNX
Runtime is not a drop-in substitute for the selected WASM build's telemetry
and execution contract.

Original references: [model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2/blob/751bff37182d3f1213fa05d7196b954e230abad9/README.md),
[encoder guidance](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/README.md),
[runtime license](https://github.com/microsoft/onnxruntime/blob/f217402897f40ebba457e2421bc0a4702771968e/LICENSE)
and [tokenizer source/license](https://github.com/huggingface/tokenizers.js/tree/e480fc097a59cab66dbbe516ae8ad82d0e263c25).

## ONNX Runtime license

The upstream notice remains here for existing offline distributions.

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
