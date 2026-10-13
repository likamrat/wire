import { createSearchCorpus } from "./search-corpus.mjs";
import { freezeCorpus } from "./search-corpus-content.mjs";
import { createSearchModel } from "./search-model.mjs";
import { SearchError, SEARCH_MODEL_ID, searchHash } from "./search-model-assets.mjs";
import { SEARCH_CHUNKER, permittedSearchText } from "./search-chunks.mjs";
import { SEARCH_RANKING, SEARCH_MATCH_POLICY_ID, SEARCH_RELATED, SEARCH_LEXICAL_POLICIES, SEARCH_TYPES, lexicalMatch, rankSearch, rankDiscovery } from "./search-ranking.mjs";
import { createSearchLinguistics } from "./search-linguistics.mjs";
import { SEARCH_INTENT_POLICY_ID } from "./search-linguistics-assets.mjs";

export function createSearchRetrieval(session, { source, modelDirectory, linguisticsDirectory, onInvalidate, onModelActivity, onLinguisticsActivity } = {}) {
    if (typeof source !== "function" || typeof onInvalidate !== "function") throw new TypeError("Current source and synchronous invalidation callbacks are required.");
    const model = createSearchModel({ directory: modelDirectory, onActivity: onModelActivity });
    const linguistics = createSearchLinguistics({ directory: linguisticsDirectory, onActivity: onLinguisticsActivity });
    const policies = linguistics.enabled ? SEARCH_LEXICAL_POLICIES
        : { matchPolicyId: SEARCH_MATCH_POLICY_ID, relatedPolicyId: SEARCH_RELATED.id };
    let index = null, state = "uninitialized", mode = "unavailable", closed = false, building = false;
    let buildToken = 0, latestRequest = -1, queryController, delivering = false;
    let metrics = {}, modelCode = null;
    const corpus = createSearchCorpus(session, {
        source,
        onInvalidate(receipt) {
            index = null;
            mode = "unavailable";
            queryController?.abort();
            model.cancel();
            linguistics.cancel();
            state = closed ? "closed" : "stale";
            const result = onInvalidate(receipt);
            if (result && typeof result.then === "function") throw new TypeError("Search invalidation must be synchronous.");
        },
    });
    function status(override) {
        return freezeCorpus({
            state: override ?? state, mode, corpus: corpus.status(), modelId: SEARCH_MODEL_ID,
            model: { ...model.status(), ...(modelCode ? { code: modelCode } : {}) },
            linguistics: linguistics.status(),
            indexId: index?.identity ?? null, items: index?.items.length ?? 0,
            chunks: index?.items.reduce((sum, item) => sum + item.chunks.length, 0) ?? 0, metrics: { ...metrics },
        });
    }
    const current = (snapshot, requestId, signal) => !closed && !signal.aborted && requestId === latestRequest && snapshot === index;
    async function queryIndex({ query, requestId, types = [] }, disclose, discovery) {
        if (typeof query !== "string" || !Number.isSafeInteger(requestId) || requestId < 0
            || !Array.isArray(types) || types.some(type => !SEARCH_TYPES.includes(type)) || typeof disclose !== "function") {
            throw new TypeError("Search requires text, a monotonic request ID, valid types and a synchronous disclosure callback.");
        }
        types = [...types];
        const outcome = (override, extra = {}, related = { state: "unavailable", reason: "not-current" }) => freezeCorpus({
            ...status(override), ...extra,
            ...(discovery ? { related: { policyId: policies.relatedPolicyId, count: 0, populationComplete: false, ...related } } : {}),
        });
        if (closed) return outcome();
        if (requestId <= latestRequest) return outcome("superseded");
        latestRequest = requestId;
        queryController?.abort();
        // The corpus has no independent delivery-cancel method. Cancel parsing without weakening its gate.
        if (delivering) { corpus.invalidate(); return outcome("stale"); }
        if (building || !index) return outcome(building ? "building" : state);
        const controller = new AbortController(), signal = controller.signal;
        queryController = controller;
        const snapshot = index, started = performance.now();
        state = "searching";
        let queryChunks = [], hits = [], related = [], evaluatedItems = 0, inferMs = 0, deliveryMs = 0, linguisticMs = 0;
        try {
            if (query.trim()) {
                if (mode === "hybrid") {
                    const inferenceStarted = performance.now();
                    queryChunks = await model.embed(query, { signal });
                    inferMs = performance.now() - inferenceStarted;
                }
                if (discovery) {
                    const ranked = await rankDiscovery(snapshot.items, query, queryChunks, types, signal);
                    hits = ranked.matches; related = ranked.related; evaluatedItems = ranked.evaluatedItems;
                } else hits = await rankSearch(snapshot.items, query, queryChunks, types, signal);
                if (mode === "hybrid" && linguistics.enabled) {
                    const began = performance.now(), byId = new Map(snapshot.items.map(item => [item.id, item]));
                    const prefixes = [...new Set(snapshot.items.filter(item => item.type === "tool")
                        .flatMap(item => item.title.normalize("NFKC").toLowerCase().match(/^[\p{L}\p{N}]+[-_]/u) ?? []))];
                    const candidates = snapshot.linguisticItems.filter(item => {
                        const indexed = byId.get(item.id);
                        return item.intent.state === "supported" && (!types.length || types.includes(indexed.type))
                            && !lexicalMatch(query, indexed, prefixes).blocked;
                    });
                    const added = await linguistics.match(query, candidates, { signal });
                    const present = new Set(hits.map(hit => hit.id)), sourceById = new Map(candidates.map(item => [item.id, item]));
                    for (const hit of added) if (!present.has(hit.id)) {
                        const item = sourceById.get(hit.id);
                        hits.push({ ...hit, start: item.start, end: item.end, tier: 0, similarity: -1, match: "semantic" });
                        present.add(hit.id);
                    }
                    hits.sort((a, b) => b.tier - a.tier || b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.start - b.start));
                    related = related.filter(hit => !present.has(hit.id));
                    linguisticMs = performance.now() - began;
                }
            }
            if (!current(snapshot, requestId, signal)) return outcome(closed ? "closed" : "superseded");
            const strictCount = hits.length, relatedCount = related.length;
            const union = [...hits, ...related];
            const ticket = { generation: snapshot.generation, hits: union.map(({ id, revision }) => ({ id, revision })) };
            const selection = new Map(union.map(({ id, start, end, match }) => [id, { start, end, match }]));
            hits = []; related = []; queryChunks = [];
            delivering = true;
            const deliveryStarted = performance.now();
            let disclosed = false, count = 0;
            const result = await corpus.deliver(ticket, entries => {
                if (!current(snapshot, requestId, signal)) return;
                const values = entries.map(entry => {
                    const selected = selection.get(entry.id), text = permittedSearchText(entry);
                    return { ...entry, excerpt: text.slice(selected.start, selected.end), match: selected.match,
                        ...(selected.match === "related" ? { purpose: "navigate-only" } : {}) };
                });
                const receipt = { requestId, generation: ticket.generation, indexId: snapshot.identity, modelId: SEARCH_MODEL_ID, mode };
                let returned;
                if (discovery) {
                    const corpusState = corpus.status().state;
                    if (!["ready", "partial"].includes(corpusState)) throw new SearchError("discovery-not-current");
                    const effectiveTypes = SEARCH_TYPES.filter(type => !types.length || types.includes(type));
                    const coverage = { evaluatedItems, corpusState, populationComplete: false };
                    returned = disclose(freezeCorpus({
                        matches: { hits: values.slice(0, strictCount), receipt: {
                            ...receipt, purpose: "strict-match-population", matchPolicyId: policies.matchPolicyId, types: effectiveTypes,
                        } },
                        related: mode === "hybrid"
                            ? { state: "available", hits: values.slice(strictCount), receipt: {
                                ...receipt, purpose: "related-navigation", relatedPolicyId: policies.relatedPolicyId, types: effectiveTypes,
                            }, coverage }
                            : { state: "unavailable", reason: "model-unavailable", hits: [], receipt: null, coverage },
                    }));
                } else returned = disclose(freezeCorpus(values), freezeCorpus(receipt));
                if (returned && typeof returned.then === "function") throw new TypeError("Search disclosure must be synchronous.");
                disclosed = true; count = strictCount;
            });
            deliveryMs = performance.now() - deliveryStarted;
            if (requestId !== latestRequest || closed) return outcome(closed ? "closed" : "superseded");
            if (!disclosed) return outcome(result.state === "ready" || result.state === "partial" ? "stale" : result.state);
            metrics = { ...metrics, searchMs: performance.now() - started, queryInferenceMs: inferMs, linguisticMs, deliveryMs };
            state = result.state;
            return outcome(count || relatedCount ? state : "no-match", { count, requestId },
                mode === "hybrid" ? { state: "available", count: relatedCount } : { state: "unavailable", reason: "model-unavailable" });
        } catch (error) {
            if (!current(snapshot, requestId, signal)) return outcome(closed ? "closed" : "superseded");
            if (!(error instanceof SearchError)) throw error;
            modelCode = error.code;
            corpus.invalidate();
            mode = "unavailable";
            return outcome("unavailable");
        } finally {
            hits = []; related = []; queryChunks = [];
            if (queryController === controller) { delivering = false; queryController = null; }
        }
    }
    return {
        status,
        invalidate() {
            buildToken++;
            building = false;
            corpus.invalidate();
            mode = "unavailable";
            return status();
        },
        close() {
            closed = true; buildToken++; building = false;
            corpus.close();
            return Promise.all([model.close(), linguistics.close()]).then(() => undefined);
        },
        async build() {
            if (closed) return status();
            const token = ++buildToken, started = performance.now();
            building = true;
            queryController?.abort();
            state = "building";
            let candidateMode = "hybrid", candidateCode = null, buildMs = 0, linguisticBuildMs = 0;
            const result = await corpus.index(async (entries, { signal }) => {
                const encodingStarted = performance.now();
                const items = entries.map(entry => ({ id: entry.id, revision: entry.revision, type: entry.type,
                    title: entry.title, text: permittedSearchText(entry), chunks: [] }));
                let linguisticItems = [];
                try {
                    for (const item of items) {
                        if (signal.aborted || token !== buildToken) throw new SearchError("model-cancelled");
                        item.chunks = await model.embed(item.text, { signal });
                    }
                    buildMs = performance.now() - encodingStarted;
                    if (linguistics.enabled) {
                        const began = performance.now();
                        const sources = entries.filter(entry => ["interaction", "context", "reply"].includes(entry.type)).map(entry => {
                            const start = entry.title ? entry.title.length + 1 : 0;
                            return { id: entry.id, revision: entry.revision, text: entry.content, start, end: start + entry.content.length };
                        });
                        const prepared = await linguistics.prepare(sources, { signal });
                        linguisticItems = prepared.map((item, i) => ({ ...sources[i], intent: item.intent }));
                        linguisticBuildMs = performance.now() - began;
                    }
                } catch (error) {
                    if (!(error instanceof SearchError) || signal.aborted || token !== buildToken || /cancelled|closed/.test(error.code)) throw error;
                    candidateMode = "lexical-only"; candidateCode = error.code;
                    for (const item of items) item.chunks = [];
                    linguisticItems = [];
                    model.cancel();
                }
                if (!buildMs) buildMs = performance.now() - encodingStarted;
                return { items, linguisticItems };
            }, ({ items, linguisticItems }, { generation }) => {
                if (closed || token !== buildToken) return;
                const identity = searchHash(JSON.stringify([SEARCH_MODEL_ID, SEARCH_CHUNKER, SEARCH_RANKING,
                    ...(linguistics.enabled ? [SEARCH_INTENT_POLICY_ID] : []),
                    candidateMode, generation, items.map(item => [item.id, item.revision])]));
                index = { items, linguisticItems, generation, identity };
                mode = candidateMode; modelCode = candidateCode;
            });
            if (token !== buildToken || closed) return status(closed ? "closed" : "superseded");
            building = false;
            state = index ? result.state : result.state === "ready" || result.state === "partial" ? "unavailable" : result.state;
            metrics = { buildMs: performance.now() - started, encodeBuildMs: buildMs, linguisticBuildMs };
            return status();
        },
        search: (input, disclose) => queryIndex(input, disclose, false),
        discover: (input, disclose) => queryIndex(input, disclose, true),
    };
}
