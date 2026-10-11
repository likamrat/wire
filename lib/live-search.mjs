import { randomUUID } from "node:crypto";
import { BoardError, loadBoardState, exclusiveBoard, mergeEvidenceWithState } from "./store.mjs";
import { collectorFor } from "./collector.mjs";
import { createSearchRetrieval } from "./search-retrieval.mjs";
import { SEARCH_TYPES } from "./search-ranking.mjs";
import { readSavedReportFile, readSavedComparison, readSavedComparisonFile, savedArtifact, artifactIndexFingerprint } from "./report-artifacts.mjs";
import { corpusHash, comparisonDocumentText } from "./search-corpus-content.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { buildRequestActivity } from "./activity-analytics.mjs";

const unavailableSource = () => ({ available: false, sourceConfigRef: null, sourceConfigRevision: 0 });
const currentSource = (session, state) => collectorFor(session)?.assessmentSource(state) ?? unavailableSource();
const receiptKeys = ["panelId", "epoch", "requestId", "generation", "indexId", "modelId", "mode", "revision"];
const sameReceipt = (a, b) => a && b && receiptKeys.every(key => a[key] === b[key]);
const basis = (state, source) => corpusHash([state, state.evidence, source]);
function object(input, allowed, required = allowed) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(input, key))) {
        throw new BoardError("Invalid local search request.", 422);
    }
}
function safeError(code, status = 409) {
    const error = new BoardError(`Local search is unavailable (${code}). Read current search state before trying again.`, status);
    error.code = code;
    return error;
}

// One ordered, authenticated stream owns every disclosure and fence for a panel.
export function createLiveSearch(session, { modelDirectory, maxPanels = 2, heartbeatMs = 1000, idleMs = 120000 } = {}) {
    const panels = new Map();
    let stopped = false, mutations = 0;
    const closing = new Set();
    const status = () => ({ panels: panels.size, closing: closing.size, maxPanels });
    function requestClose(panel, reason) {
        if (panel.closed || panel.closeRequested) return;
        panel.closeRequested = true;
        panel.hits.clear(); panel.receipt = null; panel.pending = null; panel.serial++;
        // Stream failure can occur in a corpus callback; closure must not reenter it.
        queueMicrotask(() => { void closePanel(panel, reason); });
    }
    function push(panel, message, explicitRead = false) {
        if (panel.closed || panel.closeRequested || panel.response.destroyed || panel.response.writableEnded) return false;
        const line = JSON.stringify({ panelId: panel.id, epoch: panel.epoch, ...message }) + "\n";
        // Never accumulate an unbounded network queue behind a suspended browser.
        if (Buffer.byteLength(line) + panel.response.writableLength > (explicitRead ? 48 : 8) * 1024 * 1024) {
            requestClose(panel, "slow-consumer");
            return false;
        }
        panel.response.write(line);
        return true;
    }
    function clear(panel, reason) {
        panel.epoch++;
        panel.hits.clear();
        panel.receipt = null;
        panel.basis = null;
        push(panel, { event: "fence", reason });
    }
    function closePanel(panel, reason = "closed") {
        if (panel.closed) return panel.closure ?? Promise.resolve();
        if (panel.closure) return panel.closure;
        clear(panel, reason);
        panel.closed = true;
        panel.pending = null;
        clearInterval(panel.timer);
        panel.response.end();
        const closure = panel.engine.close();
        panel.closure = Promise.allSettled([closure, panel.running, panel.opening]).then(results => {
            if (results[0].status === "rejected") throw results[0].reason;
        }).finally(() => {
            if (panels.get(panel.owner) === panel) panels.delete(panel.owner);
            closing.delete(panel.closure);
        });
        closing.add(panel.closure);
        return panel.closure;
    }
    function invalidate(reason = "changed") {
        for (const panel of panels.values()) {
            if (panel.closed) continue;
            panel.pending = null;
            panel.serial++;
            panel.reason = reason;
            panel.engine.invalidate();
        }
    }
    async function observe(panel) {
        const state = await loadBoardState(session, { readOnly: true });
        const source = currentSource(session, state);
        return { state, source, basis: basis(state, source) };
    }
    async function heartbeat(panel) {
        if (panel.closed || panel.checking) return;
        panel.checking = true;
        try {
            if (!panel.running && !panel.pending && Date.now() - panel.lastUsed > idleMs) { await closePanel(panel, "idle"); return; }
            const now = await observe(panel);
            if (panel.basis && panel.basis !== now.basis) {
                panel.pending = null; panel.serial++; panel.reason = "changed";
                panel.engine.invalidate();
            }
            panel.basis = now.basis;
            push(panel, { event: "heartbeat" });
        } catch {
            panel.reason = "state-unavailable";
            panel.engine.invalidate();
            closePanel(panel, "state-unavailable");
        } finally { panel.checking = false; }
    }
    function attach(owner, response) {
        if (stopped) throw safeError("closed", 503);
        if (panels.has(owner)) throw safeError("panel-already-connected");
        if (panels.size >= maxPanels) throw safeError("search-busy", 429);
        const panel = { owner, id: randomUUID(), epoch: 0, serial: 0, latest: -1, pending: null,
            hits: new Map(), receipt: null, response, lastUsed: Date.now(), closed: false };
        panel.engine = createSearchRetrieval(session, {
            modelDirectory, source: state => currentSource(session, state),
            onInvalidate() { clear(panel, panel.reason ?? "changed"); panel.reason = null; },
        });
        panels.set(owner, panel);
        response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
        response.flushHeaders();
        response.once("close", () => requestClose(panel, "disconnected"));
        response.once("error", () => requestClose(panel, "disconnected"));
        push(panel, { event: "connected", heartbeatMs, idleMs });
        panel.timer = setInterval(() => { void heartbeat(panel); }, heartbeatMs);
        panel.timer.unref();
        void heartbeat(panel);
    }
    function get(owner) {
        const panel = panels.get(owner);
        if (!panel || panel.closed || panel.closeRequested) throw safeError("search-disconnected", 428);
        panel.lastUsed = Date.now();
        return panel;
    }
    function pump(panel) {
        if (panel.running || panel.closed) return;
        panel.running = (async () => {
            while (panel.pending && !panel.closed) {
                const job = panel.pending;
                panel.pending = null;
                const serial = panel.serial;
                if (mutations) { push(panel, { event: "status", state: "changing", requestId: job.requestId }); continue; }
                let current = panel.engine.status();
                if (!current.indexId) {
                    push(panel, { event: "status", state: "building", requestId: job.requestId });
                    panel.reason = "indexing";
                    current = await panel.engine.build();
                }
                if (panel.closed || serial !== panel.serial) continue;
                // Typing during a build keeps only the newest complete query.
                if (panel.pending) continue;
                if (!current.indexId) {
                    push(panel, { event: "status", requestId: job.requestId, status: current, state: current.state });
                    continue;
                }
                const observed = await observe(panel);
                panel.basis = observed.basis;
                push(panel, { event: "status", state: "searching", requestId: job.requestId });
                const result = await panel.engine.search(job, (hits, receipt) => {
                    if (panel.closed || mutations || serial !== panel.serial || job.requestId !== panel.latest) return;
                    const token = { ...receipt, panelId: panel.id, epoch: panel.epoch, revision: observed.state.revision };
                    panel.hits = new Map(hits.map(hit => [hit.id, hit]));
                    panel.receipt = token;
                    panel.types = [...job.types];
                    // Content, query and targets are not copied to logs, URLs or persistent state.
                    push(panel, { event: "results", receipt: token, hits: hits.map(({ content, ...hit }) => hit),
                        status: panel.engine.status() });
                });
                if (!panel.closed && serial === panel.serial && job.requestId === panel.latest) {
                    push(panel, { event: "status", state: result.state, requestId: job.requestId, status: result });
                }
            }
        })().catch(() => {
            panel.reason = "read-failed";
            panel.engine.invalidate();
            push(panel, { event: "status", state: "unavailable" });
        }).finally(() => { panel.running = null; if (panel.pending) pump(panel); });
    }
    function query(owner, input) {
        object(input, ["query", "requestId", "types"], ["query", "requestId"]);
        if (typeof input.query !== "string" || Buffer.byteLength(input.query) > 65536
            || !Number.isSafeInteger(input.requestId) || input.requestId < 0
            || input.types !== undefined && (!Array.isArray(input.types) || input.types.some(type => !SEARCH_TYPES.includes(type)))) {
            throw safeError("invalid-search-input", 422);
        }
        const panel = get(owner);
        if (input.requestId <= panel.latest) return { state: "superseded" };
        panel.latest = input.requestId;
        panel.hits.clear(); panel.receipt = null;
        if (!input.query.trim()) {
            panel.pending = null; panel.serial++; panel.reason = "cancelled";
            panel.engine.invalidate();
            return { state: "cancelled" };
        }
        panel.pending = { query: input.query, requestId: input.requestId, types: [...(input.types ?? [])] };
        push(panel, { event: "status", state: panel.running ? "queued" : "searching", requestId: input.requestId });
        pump(panel);
        return { state: "queued" };
    }
    async function open(owner, input) {
        object(input, ["id", "receipt", "openId"]);
        object(input.receipt, receiptKeys);
        if (typeof input.id !== "string" || !Number.isSafeInteger(input.openId) || input.openId < 0) throw safeError("invalid-search-open", 422);
        const panel = get(owner), hit = panel.hits.get(input.id), receipt = panel.receipt;
        if (mutations || !hit || !sameReceipt(input.receipt, receipt)) throw safeError("stale-search-target");
        if (panel.opening) throw safeError("search-open-busy", 429);
        const opening = exclusiveBoard(session, async state => {
            const valid = () => !panel.closed && !mutations && sameReceipt(receipt, panel.receipt)
                && panel.hits.get(input.id) === hit && state.revision === receipt.revision
                && basis(state, currentSource(session, state)) === panel.basis && !state.deletion?.pending;
            if (!valid()) throw safeError("stale-search-target");
            const target = hit.target;
            let document;
            if (target.kind === "route") {
                // Descriptors come only from the corpus; the caller cannot supply a path or URL.
                document = { kind: "route", href: target.href, focus: target.focus };
            } else if (target.kind === "open-saved-comparison") {
                const artifact = savedArtifact(state, target.bundleId, "comparison"), fingerprint = artifactIndexFingerprint(artifact);
                const facts = await readSavedComparison(session, state, target.bundleId);
                if (artifact.manifestHash !== target.manifestHash
                    || corpusHash(comparisonDocumentText(facts.comparison)) !== target.documentHash) throw safeError("stale-search-target");
                const format = ["html", "json", "markdown", "pdf"].find(value => Array.isArray(artifact.formats) && artifact.formats.includes(value));
                if (!format) throw safeError("saved-comparison-format-unavailable");
                const saved = await readSavedComparisonFile(session, state, target.bundleId, format);
                if (saved.manifestHash !== target.manifestHash || saved.indexFingerprint !== fingerprint
                    || saved.artifact.bundleId !== target.bundleId || saved.format !== format) throw safeError("stale-search-target");
                document = { kind: saved.format, artifact: saved.artifact, name: saved.name, sha256: saved.sha256,
                    ...(saved.format === "pdf" ? { data: saved.bytes.toString("base64") }
                        : { text: new TextDecoder("utf-8", { fatal: true }).decode(saved.bytes) }) };
            } else {
                const saved = await readSavedReportFile(session, state, target.bundleId, target.format ?? "html");
                if (saved.manifestHash !== target.manifestHash || saved.sha256 !== target.documentHash) throw safeError("stale-search-target");
                document = { kind: saved.format, artifact: saved.artifact,
                    ...(saved.format === "pdf" ? { data: saved.bytes.toString("base64") }
                        : { text: new TextDecoder("utf-8", { fatal: true }).decode(saved.bytes) }) };
            }
            if (!valid()) throw safeError("stale-search-target");
            push(panel, { event: "opened", openId: input.openId, receipt, document }, true);
        }, { readOnly: true });
        panel.opening = opening;
        try { await opening; }
        finally { if (panel.opening === opening) panel.opening = null; }
        return { state: "opened" };
    }
    return {
        attach, query, open, status,
        membership(owner, receipt, state, layer) {
            object(receipt, receiptKeys);
            if (!createRecordedResults().layers.includes(layer)) throw safeError("invalid-search-layer", 422);
            const panel = get(owner), source = currentSource(session, state);
            if (mutations || !sameReceipt(receipt, panel.receipt) || state.revision !== receipt.revision
                || basis(state, source) !== panel.basis || state.deletion?.pending) throw safeError("stale-search-membership");
            if (!source.available || panel.engine.status().corpus.state !== "ready"
                || panel.types.length && !["interaction", "context", "reply", "action"].every(type => panel.types.includes(type))) {
                throw safeError("search-membership-unavailable", 428);
            }
            const scenarios = mergeEvidenceWithState(state);
            const { scenarioIds, actionIds, parentScenarioIds } = createSearchMembership({
                revision: state.revision, scenarios, requestActivity: buildRequestActivity(scenarios),
            }, { layer }, [], [...panel.hits.values()], receipt);
            return { scenarioIds, actionIds, parentScenarioIds };
        },
        panelStatus(owner) { const panel = get(owner); return panel.engine.status(); },
        invalidate,
        beginMutation() { mutations++; invalidate("changing"); },
        endMutation() { mutations--; invalidate("changed"); },
        cancel(owner) {
            const panel = get(owner);
            panel.pending = null; panel.serial++; panel.reason = "cancelled"; panel.engine.invalidate();
            return { state: "cancelled" };
        },
        release(owner) { const panel = panels.get(owner); return panel ? closePanel(panel) : Promise.resolve(); },
        async close() {
            stopped = true;
            await Promise.all([...panels.values()].map(panel => closePanel(panel)));
            await Promise.all(closing);
        },
    };
}
