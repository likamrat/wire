# Optional role-bound lexical search

This adjunct is **disabled by default and unqualified for activation**. Its
dictionary-backed matching code remains available for corrective safety testing,
not as a validated recall improvement. The existing MiniLM, exact and prefix
matcher remains unchanged.

This activation hold is not a choice between local and provider-backed Search.
Search must remain independent and on-device; an optional Copilot assessment
or its spending approval cannot supply Search relevance.

The original two-query qualification is **withdrawn** following corrections for
negative-scope generalization and source-modifier loss. In particular, the
retained **broken automobile** no longer supports an adjunct match to the
unmodified car query: the available adjective tags do not establish that dropping
a modifier preserves the noun's meaning. No special case for that fixture is
used to retain the headline gains. **All original F09 requirements and the
ordinary-work misses remain open.** The original positive assertions remain
unchanged and expose this lost qualification; the extension must stay off.

## Activation hold and resource handling

**Keep the adjunct off.** The command and host option below document the resource
mechanism, not an instruction to provision or enable it. Any future use requires
separate qualification and explicit approval; resource approval or successful
provisioning alone does not lift the activation hold.

The provisioner interface is:

```powershell
npm run search:linguistics:provision
```

The command obtains exactly ten immutable files, **23,789,691 bytes** before
filesystem/staging overhead, under ignored
`assets\search-linguistics\<resource-id>\`. Every byte length and SHA-256 is pinned
in `lib\search-linguistics-assets.mjs`. There is no npm dependency installation,
neural model, training, provider call or private-content transfer.

Provisioning **does not activate the extension**. The host must explicitly supply
`search: { linguisticsDirectory }` to its existing `startServer` options (or
`linguisticsDirectory` to `createLiveSearch` / `createSearchRetrieval`). The exported
`defaultSearchLinguisticsDirectory` identifies the standard provisioned directory.
Omitting the option leaves the baseline algorithm and its core index identity
and receipt policy values unchanged. No first search, retry or startup silently downloads resources.

A configured missing/corrupt resource produces an explicit `linguistics-*`
failure and lexical-only degraded search, not a false enhanced-semantic result.
The existing model error/status channel carries that reason; the content-free
`status.linguistics` additionally reports helper state, policy ID, timings and
RSS. Missing resources are not replaced by a network service.

## Resource provenance and licenses

- Compromise **14.17.0**, Git revision
  `263fab53e01f18c8ba2ed5c69fb128c7116a3185`: its reviewed standalone ESM bundle,
  package metadata and unmodified **MIT** license. The bundle has no external
  imports; runtime imports the verified bytes rather than reopening a mutable
  module path. No plugins or source-package dependencies are loaded.
- `wordnet-db` **3.1.14**, Git revision
  `9e5cbc56523450c50d6655c8ba47bcb9fabf7935`: noun/verb data and indexes, package
  metadata, README and the unmodified **Princeton WordNet notice/disclaimer**.
  The package describes data version 3.1, while its supplied license is headed
  *WordNet Release 3.0*. Preserve and disclose that discrepancy; the database is
  not simply MIT, and its provenance is the distributor's declaration rather
  than an independently reproduced Princeton archive.

Licenses remain alongside every provisioned copy and are verified with the data.
Do not commit the database or strip its notices when packaging the application.

## Matching and deliberate limits

The rule-based parser provides original term spans, verb roots, grammatical form
and local negation. The adapter preserves every required clause in its supported
grammar; it does not use the parser's main-clause convenience function to drop a
`where` clause. Supported nominal-event/location references bind to the same
recorded event using a dictionary-backed occurrence predicate.

Operation, actor/patient and location must have a consistent dictionary-sense
witness in that event. Candidate senses are constrained by noun/verb form and
documented verb frames. Synset identity or directed hypernym/verb-entailment
edges provide support; shared ancestry, best score, rank one and fitted
thresholds do not. Negative scope, modifiers, specific ownership and differing
location relations cannot be silently discarded.
The adjunct now accepts **positive assertions only**: not performing a narrow
operation, or not performing it at one place, does not entail absence of a
broader operation. Parsed intents do not preserve enough quantifier/event-domain
scope to implement a general negative proof, so negative pairs abstain from the
adjunct even if both polarities agree. The existing baseline matcher is unchanged.

Source noun modifiers may not be dropped. A modified argument/location must be
consumed by a query requirement with the identical modifier sequence and head
lemma; unrequested modified participants also prevent an adjunct proof.
This applies to every modifier, not a blacklist of words such as `fake`.
Unmodified nominals retain their directed dictionary relationships. The
restriction deliberately sacrifices unqualified recall rather than treating
all adjectives as intersective or subsective.
Only simple noun phrases are admitted: unhandled quantifiers, pronouns, noun
compounds and internal determiners fail closed rather than being dropped as
optional adjectives. Spatial prepositions are recognized even when the parser
mistags them as adjectives, so a nearby building cannot become the patient of
an unrelated repair.

The current graph has no directed repair-to-service relationship among any of
their verb senses. Joining both under broad `change` would weaken the rule, so
this implementation does not do it.

Complex/ambiguous grammar, multi-sentence inputs and unsupported lexical entries
are explicitly unsupported **by this additional path**. They retain the complete
unchanged baseline retrieval path; they are not clipped to a convenient phrase,
rewritten or assigned guessed roles. There is no new whole-cohort uncertainty
state and no universal semantic-completeness claim.
Lexical support concerns the retained text only. It does not establish actual
execution, successful completion, correctness, ownership or permission.

## Ownership, cancellation and identities

An enabled panel owns one additional Node helper alongside its existing MiniLM
helper. The deterministic helper loads only verified local resources, denies
network entry points, uses a minimal environment and accepts one active job.
Cancellation, invalidation, supersession and close terminate owned work and await
exit. The existing two-panel limit still bounds ownership; resource usage must
include both helpers, not only the model.

Parsed records stay in the in-memory, source-generation-bound retrieval index.
No new persistent derived cache, query log or original-data capture is added.
Only complete, validated helper responses are used. The parent revalidates IDs,
revisions, representation policy and source ranges; new hits pass through the
same `corpus.deliver` permission/integrity/current-source gate as baseline hits.

The opt-in `SEARCH_LEXICAL_POLICIES` pair binds the optional linguistic rule and
resource identities. Enabled index identities additionally bind that rule.
Disabled search keeps the original baseline policy pair. The shared wire
validator recognizes only the two explicit pairs, rejects mixed pairs, and
never upgrades one stored receipt into another policy's authority.
Baseline MiniLM vectors, chunking and cosine thresholds are unchanged.

Related retains its original vector floor/band and navigation-only purpose.
New strictly supported records are removed from Related to keep the sets
disjoint; Related itself never supplies admission. Its revised policy identity
binds that composition. Live receipts remain purpose/owner/generation/revision
bound, and old policies cannot be relabeled into current analytical authority.

The same complete accepted set, not a page slice, feeds Analyze membership,
both comparison periods and report preparation. Frozen saved output is not
rewritten. Existing report review/save boundaries remain unchanged.

## Focused qualification

Set `WIRE_SEARCH_LINGUISTICS_TEST_DIRECTORY` to the approved resource directory
and, if needed, `WIRE_SEARCH_MODEL_TEST_DIRECTORY` to existing verified MiniLM
assets. Then run:

```powershell
node --test --test-concurrency=1 tests\search-linguistics.test.mjs tests\search-linguistics-protocol.test.mjs tests\search-linguistics-scale.test.mjs tests\search-linguistics-wire.test.mjs
```

Resource-backed tests are explicitly skipped without that directory; the opt-in
contract test still runs. The suite retains the original gain and
remaining-miss assertions, preserved contrasts/exact controls, full 63-ID/four-page
membership, the existing 352-item long fixture, both periods/frozen report
scope, actual HTTP purpose/preview guards, corruption/deletion/current-source
fences, query/build cancellation, and measured resource cost. Synthetic
qualification is not proof of universal recall or an application SLA.
The original gain assertions now fail because they require dropping `broken`;
do not treat the earlier scale/consumer qualification as still valid for the
corrected adjunct. The correction-specific raw-helper and actual-corpus
regressions are in `tests\search-linguistics-scope.test.mjs`. Those passing
safety checks do not requalify the feature or waive its original positive cases.
Provisioning tests use controlled in-process responses and already approved
bytes, never a network acquisition. Long core inputs remain complete; the live
HTTP query limit remains 65,536 bytes.
`tests/search-linguistics-fixture.mjs` is the canonical expected-set ledger.
Qualification requires `MUST ⊆ actual ⊆ ALLOWED`: the three original car queries
require the automobile repair and permit, but do not require, the ambulance
engine repair. Default and optional results are checked independently, including
all original negatives and ordinary-work requirements. Their known missing
positives remain failing qualification assertions, not TODOs or assertions that
an empty result is correct. Resource-dependent qualification still requires the
existing explicitly supplied local assets; no test acquires them.

The three required raw positive pairs are no longer also forbidden by blanket
modifier guards. This corrects the test contract, not the matcher: the modifier
limitation and activation hold remain. Scope cases label genuine negative
contrasts separately from implementation observations. Both-negated forms,
unrequested `red`/`miniature` modifiers and `fake automobile` versus `fake vehicle`
retain their current fail-closed mechanism checks, but have unspecified semantic
acceptance (`must: null, allowed: null`), not permanent no-match requirements or
invented positive targets. The separate 18 comparison/prospective
probes preserve their allowed sets; nine have no primary required-set
specification and are explicitly marked as unspecified recall. Passing an
allowed-only or baseline-parity check cannot establish positive qualification.

`node --test tests\search-expectations.test.mjs` checks ledger consistency and
consumer assertions without inference. Invented admitted sets exercise strict
Matches, analytical membership, both periods and frozen report scope; neither
Related union nor dropping the required item passes. This proves the contract
and consumer projection only, not semantic recall or default search quality.
