import { createCorpusSources, CorpusSourceError, corpusErrorCode } from "./search-corpus-sources.mjs";
import { corpusHash, freezeCorpus } from "./search-corpus-content.mjs";

function synchronous(callback, ...args) {
    const result = callback(...args);
    if (result && typeof result.then === "function") throw new TypeError("Corpus publication and disclosure must be synchronous.");
    return result;
}

/**
 * Process-private derived cache. No query, disk index, transport or mutation API.
 * Consumers must discard their derived index and queued hits on invalidate.
 * @param {object} session Existing WIRE private-store context.
 * @param {{source: Function, onInvalidate: Function}} options Current source and synchronous cache eviction.
 */
export function createSearchCorpus(session, options) {
    if (typeof options?.onInvalidate !== "function") throw new TypeError("A synchronous derived-index invalidator is required.");
    const sources = createCorpusSources(session, options);
    let generation = 0, operation = 0, closed = false, cache = null, controller;
    let status = freezeCorpus({ state: "uninitialized", generation, items: 0, textBytes: 0, issues: [] });
    const changed = () => {
        generation++;
        synchronous(options.onInvalidate, freezeCorpus({ generation }));
    };
    function clear(state, issues = []) {
        cache = null;
        status = freezeCorpus({ state, generation: generation + 1, items: 0, textBytes: 0, issues });
        changed();
        return status;
    }
    function ensure(token) {
        if (closed || token !== operation) throw new CorpusSourceError("superseded");
    }
    function begin() {
        controller?.abort();
        controller = new AbortController();
        return { token: ++operation, signal: controller.signal };
    }
    function accept(frame) {
        const signature = corpusHash([frame.entries, frame.issues, frame.stamp]);
        if (cache?.signature !== signature) {
            // Evict the previous consumer index before making any new entries available.
            cache = null;
            changed();
        }
        cache = { signature, entries: frame.entries };
        status = freezeCorpus({
            state: frame.issues.length ? "partial" : "ready", generation,
            items: frame.entries.length,
            textBytes: frame.entries.reduce((sum, item) => sum + Buffer.byteLength(item.title) + Buffer.byteLength(item.content), 0),
            issues: frame.issues,
        });
        return status;
    }
    async function read(token, signal) {
        ensure(token);
        const frame = await sources.scan(() => ensure(token), signal);
        ensure(token);
        await sources.current(frame, () => { ensure(token); accept(frame); });
        ensure(token);
        return frame;
    }
    function failure(error, token) {
        if (closed || token !== operation) return freezeCorpus({ ...status, state: closed ? "closed" : "superseded" });
        const code = corpusErrorCode(error);
        return clear(code === "stale" || code === "superseded" ? "stale" : "unavailable", [{ sourceId: "corpus", code }]);
    }
    return {
        status: () => status,
        invalidate() {
            if (closed) return status;
            controller?.abort();
            operation++;
            return clear("stale");
        },
        close() {
            if (!closed) { closed = true; controller?.abort(); operation++; clear("closed"); }
            return status;
        },
        async rebuild() {
            if (closed) return status;
            const { token, signal } = begin();
            try { await read(token, signal); return status; }
            catch (error) { return failure(error, token); }
        },
        async index(build, publish) {
            if (typeof build !== "function" || typeof publish !== "function") throw new TypeError("An index builder and synchronous publisher are required.");
            if (closed) return status;
            const { token, signal } = begin();
            try {
                const frame = await read(token, signal), acceptedGeneration = generation;
                // Start inside the read gate, but do not hold the writer queue while awaiting local computation.
                const work = await sources.current(frame, () => { ensure(token); return { result: build(frame.entries, { signal }) }; });
                const result = await work.result;
                ensure(token);
                const fresh = await read(token, signal);
                if (acceptedGeneration !== generation) throw new CorpusSourceError("stale");
                await sources.current(fresh, () => {
                    ensure(token);
                    synchronous(publish, result, freezeCorpus({ generation }));
                });
                return status;
            } catch (error) { return failure(error, token); }
        },
        async deliver(ticket, disclose) {
            if (typeof disclose !== "function" || !ticket || !Number.isSafeInteger(ticket.generation)
                || !Array.isArray(ticket.hits) || ticket.hits.some(hit => !hit || typeof hit.id !== "string" || typeof hit.revision !== "string")
                || new Set(ticket.hits.map(hit => hit.id)).size !== ticket.hits.length) throw new TypeError("Valid ID/revision hit tickets and synchronous disclosure are required.");
            if (closed) return status;
            ticket = { generation: ticket.generation, hits: ticket.hits.map(({ id, revision }) => ({ id, revision })) };
            const { token, signal } = begin();
            try {
                const frame = await read(token, signal);
                if (ticket.generation !== generation) throw new CorpusSourceError("stale");
                const byId = new Map(frame.entries.map(item => [item.id, item]));
                const hits = ticket.hits.map(hit => {
                    const item = byId.get(hit.id);
                    if (!item || item.revision !== hit.revision) throw new CorpusSourceError("stale");
                    return item;
                });
                await sources.current(frame, () => {
                    ensure(token);
                    synchronous(disclose, freezeCorpus(hits));
                });
                return status;
            } catch (error) { return failure(error, token); }
        },
    };
}
