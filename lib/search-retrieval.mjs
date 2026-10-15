import { setImmediate } from "node:timers/promises";
import { createSearchCorpus } from "./search-corpus.mjs";
import { corpusHash, freezeCorpus } from "./search-corpus-content.mjs";
import { SEARCH_MATCH_POLICY_ID, SEARCH_TYPES, indexSearchText, rankTextSearch, textSearchHit } from "./search-text.mjs";

export function createSearchRetrieval(session, { source, onInvalidate } = {}) {
    if (typeof source !== "function" || typeof onInvalidate !== "function") throw new TypeError("Current source and synchronous invalidation callbacks are required.");
    let index = null, state = "uninitialized", closed = false, building = false;
    let buildToken = 0, latestRequest = -1, queryController, delivering = false, metrics = {};
    const operations = new Set();
    const corpus = createSearchCorpus(session, {
        source,
        onInvalidate(receipt) {
            index = null;
            queryController?.abort();
            state = closed ? "closed" : building ? "building" : "stale";
            return onInvalidate(receipt);
        },
    });
    const status = override => freezeCorpus({
        state: override ?? state, mode: index ? "text" : "unavailable", corpus: corpus.status(),
        indexId: index?.identity ?? null, items: index?.items.length ?? 0, metrics: { ...metrics },
    });
    function track(operation) {
        operations.add(operation);
        operation.then(() => operations.delete(operation), () => operations.delete(operation));
        return operation;
    }
    const current = (snapshot, requestId, signal) => !closed && !signal.aborted && requestId === latestRequest && snapshot === index;
    async function queryIndex({ query, requestId, types = [] }, disclose, discovery) {
        if (typeof query !== "string" || !Number.isSafeInteger(requestId) || requestId < 0
            || !Array.isArray(types) || types.some(type => !SEARCH_TYPES.includes(type))
            || new Set(types).size !== types.length || typeof disclose !== "function") {
            throw new TypeError("Search requires text, a monotonic request ID, valid unique types and a synchronous disclosure callback.");
        }
        types = [...types];
        if (closed) return status();
        if (requestId <= latestRequest) return status("superseded");
        latestRequest = requestId;
        queryController?.abort();
        // Delivery may own a PDF parser. Invalidate its generation before replacing it.
        if (delivering) { corpus.invalidate(); return status("stale"); }
        if (building || !index) return status(building ? "building" : state);
        const controller = new AbortController(), signal = controller.signal;
        queryController = controller;
        const snapshot = index, began = performance.now();
        state = "searching";
        let hits = [];
        try {
            hits = await rankTextSearch(snapshot.items, query, types, signal);
            if (!current(snapshot, requestId, signal)) return status(closed ? "closed" : "superseded");
            const selections = new Map(hits.map(hit => [hit.id, hit]));
            const ticket = { generation: snapshot.generation, hits: hits.map(({ id, revision }) => ({ id, revision })) };
            hits = [];
            delivering = true;
            let disclosed = false, count = 0;
            const deliveryStarted = performance.now();
            const result = await corpus.deliver(ticket, entries => {
                if (!current(snapshot, requestId, signal)) return;
                const values = entries.map(entry => textSearchHit(entry, selections.get(entry.id)));
                const receipt = { requestId, generation: ticket.generation, indexId: snapshot.identity, mode: "text" };
                const returned = discovery ? disclose(freezeCorpus({ matches: { hits: values, receipt: {
                    ...receipt, purpose: "strict-match-population", matchPolicyId: SEARCH_MATCH_POLICY_ID,
                    types: SEARCH_TYPES.filter(type => !types.length || types.includes(type)),
                } } })) : disclose(freezeCorpus(values), freezeCorpus(receipt));
                if (returned && typeof returned.then === "function") throw new TypeError("Search disclosure must be synchronous.");
                disclosed = true; count = values.length;
            });
            if (requestId !== latestRequest || closed) return status(closed ? "closed" : "superseded");
            if (!disclosed) return status(result.state === "ready" || result.state === "partial" ? "stale" : result.state);
            metrics = { ...metrics, searchMs: performance.now() - began, deliveryMs: performance.now() - deliveryStarted };
            state = result.state;
            return freezeCorpus({ ...status(!query.trim() ? "empty" : !count && state === "ready" ? "no-match" : state), count, requestId });
        } catch (error) {
            if (!current(snapshot, requestId, signal)) return status(closed ? "closed" : "superseded");
            throw error;
        } finally {
            hits = [];
            if (queryController === controller) { delivering = false; queryController = null; }
        }
    }
    async function build() {
        if (closed) return status();
        const token = ++buildToken, began = performance.now();
        building = true;
        queryController?.abort();
        state = "building";
        const result = await corpus.index(async (entries, { signal }) => {
            const items = [];
            for (const [i, entry] of entries.entries()) {
                if (i % 32 === 0) { await setImmediate(); signal.throwIfAborted(); }
                if (token !== buildToken) throw new DOMException("Search build replaced.", "AbortError");
                items.push(indexSearchText(entry));
            }
            return items;
        }, (items, { generation }) => {
            if (closed || token !== buildToken) return;
            index = { items, generation,
                identity: corpusHash([SEARCH_MATCH_POLICY_ID, "text", generation, items.map(item => [item.id, item.revision])]) };
        });
        if (token !== buildToken || closed) return status(closed ? "closed" : "superseded");
        building = false;
        state = index ? result.state : result.state === "ready" || result.state === "partial" ? "unavailable" : result.state;
        metrics = { buildMs: performance.now() - began };
        return status();
    }
    return {
        status,
        build: () => track(build()),
        search: (input, disclose) => track(queryIndex(input, disclose, false)),
        discover: (input, disclose) => track(queryIndex(input, disclose, true)),
        invalidate() { buildToken++; building = false; corpus.invalidate(); return status(); },
        close() {
            closed = true; buildToken++; building = false;
            corpus.close();
            return Promise.all([...operations]).then(() => undefined);
        },
    };
}
