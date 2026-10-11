import { createSearchCorpus } from "./search-corpus.mjs";
import { freezeCorpus } from "./search-corpus-content.mjs";
import { createSearchModel } from "./search-model.mjs";
import { SearchError, SEARCH_MODEL_ID, searchHash } from "./search-model-assets.mjs";
import { SEARCH_CHUNKER, permittedSearchText } from "./search-chunks.mjs";
import { SEARCH_RANKING, SEARCH_TYPES, rankSearch } from "./search-ranking.mjs";

export function createSearchRetrieval(session, { source, modelDirectory, onInvalidate, onModelActivity } = {}) {
    if (typeof source !== "function" || typeof onInvalidate !== "function") throw new TypeError("Current source and synchronous invalidation callbacks are required.");
    const model = createSearchModel({ directory: modelDirectory, onActivity: onModelActivity });
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
            state = closed ? "closed" : "stale";
            const result = onInvalidate(receipt);
            if (result && typeof result.then === "function") throw new TypeError("Search invalidation must be synchronous.");
        },
    });
    function status(override) {
        return freezeCorpus({
            state: override ?? state, mode, corpus: corpus.status(), modelId: SEARCH_MODEL_ID,
            model: { ...model.status(), ...(modelCode ? { code: modelCode } : {}) },
            indexId: index?.identity ?? null, items: index?.items.length ?? 0,
            chunks: index?.items.reduce((sum, item) => sum + item.chunks.length, 0) ?? 0, metrics: { ...metrics },
        });
    }
    const current = (snapshot, requestId, signal) => !closed && !signal.aborted && requestId === latestRequest && snapshot === index;
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
            return model.close();
        },
        async build() {
            if (closed) return status();
            const token = ++buildToken, started = performance.now();
            building = true;
            queryController?.abort();
            state = "building";
            let candidateMode = "hybrid", candidateCode = null, buildMs = 0;
            const result = await corpus.index(async (entries, { signal }) => {
                const encodingStarted = performance.now();
                const items = entries.map(entry => ({ id: entry.id, revision: entry.revision, type: entry.type,
                    title: entry.title, text: permittedSearchText(entry), chunks: [] }));
                try {
                    for (const item of items) {
                        if (signal.aborted || token !== buildToken) throw new SearchError("model-cancelled");
                        item.chunks = await model.embed(item.text, { signal });
                    }
                } catch (error) {
                    if (!(error instanceof SearchError) || signal.aborted || token !== buildToken || /cancelled|closed/.test(error.code)) throw error;
                    candidateMode = "lexical-only"; candidateCode = error.code;
                    for (const item of items) item.chunks = [];
                }
                buildMs = performance.now() - encodingStarted;
                return items;
            }, (items, { generation }) => {
                if (closed || token !== buildToken) return;
                const identity = searchHash(JSON.stringify([SEARCH_MODEL_ID, SEARCH_CHUNKER, SEARCH_RANKING,
                    candidateMode, generation, items.map(item => [item.id, item.revision])]));
                index = { items, generation, identity };
                mode = candidateMode; modelCode = candidateCode;
            });
            if (token !== buildToken || closed) return status(closed ? "closed" : "superseded");
            building = false;
            state = index ? result.state : result.state === "ready" || result.state === "partial" ? "unavailable" : result.state;
            metrics = { buildMs: performance.now() - started, encodeBuildMs: buildMs };
            return status();
        },
        async search({ query, requestId, types = [] }, disclose) {
            if (typeof query !== "string" || !Number.isSafeInteger(requestId) || requestId < 0
                || !Array.isArray(types) || types.some(type => !SEARCH_TYPES.includes(type)) || typeof disclose !== "function") {
                throw new TypeError("Search requires text, a monotonic request ID, valid types and a synchronous disclosure callback.");
            }
            if (closed) return status();
            if (requestId <= latestRequest) return status("superseded");
            latestRequest = requestId;
            queryController?.abort();
            // The corpus has no independent delivery-cancel method. Cancel parsing without weakening its gate.
            if (delivering) { corpus.invalidate(); return status("stale"); }
            if (building || !index) return status(building ? "building" : state);
            const controller = new AbortController(), signal = controller.signal;
            queryController = controller;
            const snapshot = index, started = performance.now();
            state = "searching";
            let queryChunks = [], hits = [], inferMs = 0, deliveryMs = 0;
            try {
                if (query.trim()) {
                    if (mode === "hybrid") {
                        const inferenceStarted = performance.now();
                        queryChunks = await model.embed(query, { signal });
                        inferMs = performance.now() - inferenceStarted;
                    }
                    hits = await rankSearch(snapshot.items, query, queryChunks, types, signal);
                }
                if (!current(snapshot, requestId, signal)) return status(closed ? "closed" : "superseded");
                const ticket = { generation: snapshot.generation, hits: hits.map(({ id, revision }) => ({ id, revision })) };
                const selection = new Map(hits.map(({ id, start, end, match }) => [id, { start, end, match }]));
                hits = []; queryChunks = [];
                delivering = true;
                const deliveryStarted = performance.now();
                let disclosed = false, count = 0;
                const result = await corpus.deliver(ticket, entries => {
                    if (!current(snapshot, requestId, signal)) return;
                    const values = entries.map(entry => {
                        const selected = selection.get(entry.id), text = permittedSearchText(entry);
                        return { ...entry, excerpt: text.slice(selected.start, selected.end), match: selected.match };
                    });
                    const returned = disclose(freezeCorpus(values), freezeCorpus({ requestId, generation: ticket.generation,
                        indexId: snapshot.identity, modelId: SEARCH_MODEL_ID, mode }));
                    if (returned && typeof returned.then === "function") throw new TypeError("Search disclosure must be synchronous.");
                    disclosed = true; count = values.length;
                });
                deliveryMs = performance.now() - deliveryStarted;
                if (requestId !== latestRequest || closed) return status(closed ? "closed" : "superseded");
                if (!disclosed) return status(result.state === "ready" || result.state === "partial" ? "stale" : result.state);
                metrics = { ...metrics, searchMs: performance.now() - started, queryInferenceMs: inferMs, deliveryMs };
                state = result.state;
                return freezeCorpus({ ...status(count ? state : "no-match"), count, requestId });
            } catch (error) {
                if (!current(snapshot, requestId, signal)) return status(closed ? "closed" : "superseded");
                if (!(error instanceof SearchError)) throw error;
                modelCode = error.code;
                corpus.invalidate();
                mode = "unavailable";
                return status("unavailable");
            } finally {
                hits = []; queryChunks = [];
                if (queryController === controller) { delivering = false; queryController = null; }
            }
        },
    };
}
