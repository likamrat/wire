import { randomUUID } from "node:crypto";
import { BoardError, loadBoardState, exclusiveBoard, mergeEvidenceWithState } from "./store.mjs";
import { collectorFor } from "./collector.mjs";
import { createSearchRetrieval } from "./search-retrieval.mjs";
import { SEARCH_MATCH_POLICY_ID } from "./search-text.mjs";
import { searchWireContract as wire } from "./search-wire-contract.mjs";
import { readSavedReportFile, readSavedComparison, readSavedComparisonFile, savedArtifact, artifactIndexFingerprint } from "./report-artifacts.mjs";
import { corpusHash, comparisonDocumentText } from "./search-corpus-content.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { buildRequestActivity } from "./activity-analytics.mjs";

const unavailableSource = () => ({ available: false, sourceConfigRef: null, sourceConfigRevision: 0 });
const currentSource = (session, state) => collectorFor(session)?.assessmentSource(state) ?? unavailableSource();
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
function validateWire(method, value) {
    try { return wire[method](value); }
    catch (error) {
        if (!(error instanceof TypeError) || !error.code) throw error;
        const failure = new BoardError(error.message, error.status);
        failure.code = error.code;
        throw failure;
    }
}

// One ordered, authenticated stream owns every disclosure and fence for a panel.
export function createLiveSearch(session, { maxPanels = 2, heartbeatMs = 1000, idleMs = 120000 } = {}) {
    const panels = new Map();
    let stopped = false, mutations = 0;
    const closing = new Set();
    const status = () => ({ panels: panels.size, closing: closing.size, maxPanels });
    function dropResults(panel) {
        panel.matches.hits.clear(); panel.matches.receipt = null;
    }
    function requestClose(panel, reason) {
        if (panel.closed || panel.closeRequested) return;
        panel.closeRequested = true;
        dropResults(panel); panel.pending = null; panel.serial++;
        // Stream failure can occur in a corpus callback; closure must not reenter it.
        queueMicrotask(() => { void closePanel(panel, reason); });
    }
    function push(panel, message, explicitRead = false) {
        if (panel.closed || panel.closeRequested || panel.response.destroyed || panel.response.writableEnded) return false;
        const line = JSON.stringify({ schemaVersion: wire.schemaVersion, panelId: panel.id, epoch: panel.epoch, ...message }) + "\n";
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
        dropResults(panel);
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
    function attach(owner, response, input) {
        validateWire("handshake", input);
        if (stopped) throw safeError("closed", 503);
        if (panels.has(owner)) throw safeError("panel-already-connected");
        if (panels.size >= maxPanels) throw safeError("search-busy", 429);
        const panel = { owner, id: randomUUID(), epoch: 0, serial: 0, latest: -1, pending: null,
            matches: { hits: new Map(), receipt: null },
            queryPurpose: null, response, lastUsed: Date.now(), closed: false };
        panel.engine = createSearchRetrieval(session, {
            source: state => currentSource(session, state),
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
        if (panel.running || panel.closed || panel.closeRequested) return;
        panel.running = (async () => {
            while (panel.pending && !panel.closed && !panel.closeRequested) {
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
                const publish = matches => {
                    if (panel.closed || panel.closeRequested || mutations || serial !== panel.serial || job.requestId !== panel.latest) return;
                    const stamp = matches.receipt;
                    const base = { schemaVersion: wire.schemaVersion, panelId: panel.id, epoch: panel.epoch, revision: observed.state.revision,
                        requestId: stamp.requestId, generation: stamp.generation, indexId: stamp.indexId,
                        mode: stamp.mode, queryPurpose: job.purpose, queryTypes: [...job.types] };
                    if (stamp.requestId !== job.requestId) throw new TypeError("Search producer request mismatch.");
                    const strictReceipt = { ...base, purpose: "strict-match-population", matchPolicyId: SEARCH_MATCH_POLICY_ID };
                    const project = values => values.map(({ content, ...hit }) => hit);
                    const event = { schemaVersion: wire.schemaVersion, panelId: panel.id, epoch: panel.epoch, event: "results",
                        purpose: job.purpose, requestId: job.requestId,
                        matches: { receipt: strictReceipt, hits: project(matches.hits), total: matches.hits.length },
                        status: panel.engine.status() };
                    if (job.purpose === "navigation") {
                        const sameTypes = values => JSON.stringify(wire.canonicalTypes(values)) === JSON.stringify(job.types);
                        if (stamp.purpose !== "strict-match-population" || stamp.matchPolicyId !== SEARCH_MATCH_POLICY_ID
                            || !sameTypes(stamp.types)) throw new TypeError("Search producer policy mismatch.");
                    }
                    if (!wire.validResults(event)) throw new TypeError("Search producer returned an invalid result set.");
                    panel.matches = { hits: new Map(matches.hits.map(hit => [hit.id, hit])), receipt: strictReceipt };
                    // Content, query and targets are not copied to logs, URLs or persistent state.
                    push(panel, event);
                };
                const input = { query: job.query, requestId: job.requestId, types: job.types };
                const result = job.purpose === "analysis"
                    ? await panel.engine.search(input, (hits, receipt) => publish({ hits, receipt }))
                    : await panel.engine.discover(input, ({ matches }) => publish(matches));
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
        const job = validateWire("query", input);
        if (Buffer.byteLength(job.query) > 65536) throw safeError("invalid-search-input", 422);
        const panel = get(owner);
        if (job.requestId <= panel.latest) return { state: "superseded" };
        panel.latest = job.requestId;
        panel.queryPurpose = job.purpose;
        dropResults(panel);
        if (!job.query.trim()) {
            panel.pending = null; panel.serial++; panel.reason = "cancelled";
            panel.engine.invalidate();
            return { state: "cancelled" };
        }
        panel.pending = job;
        push(panel, { event: "status", state: panel.running ? "queued" : "searching", requestId: job.requestId });
        pump(panel);
        return { state: "queued" };
    }
    async function open(owner, input) {
        object(input, ["id", "receipt", "openId"]);
        validateWire("receipt", input.receipt);
        if (typeof input.id !== "string" || !Number.isSafeInteger(input.openId) || input.openId < 0) throw safeError("invalid-search-open", 422);
        const panel = get(owner), set = panel.matches;
        const hit = set.hits.get(input.id), receipt = set.receipt;
        if (mutations || !hit || !wire.sameReceipt(input.receipt, receipt)) throw safeError("stale-search-target");
        if (panel.opening) throw safeError("search-open-busy", 429);
        const opening = exclusiveBoard(session, async state => {
            const valid = () => !panel.closed && !panel.closeRequested && !mutations
                && wire.sameReceipt(receipt, panel.matches.receipt)
                && set.hits.get(input.id) === hit && state.revision === receipt.revision
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
            validateWire("receipt", receipt);
            if (!wire.analysisReceipt(receipt)) throw safeError("search-membership-purpose", 422);
            if (!createRecordedResults().layers.includes(layer)) throw safeError("invalid-search-layer", 422);
            const panel = get(owner), source = currentSource(session, state);
            if (mutations || panel.queryPurpose !== "analysis" || !wire.sameReceipt(receipt, panel.matches.receipt) || state.revision !== receipt.revision
                || basis(state, source) !== panel.basis || state.deletion?.pending) throw safeError("stale-search-membership");
            if (!source.available || !wire.completeCoverage(panel.engine.status().corpus, receipt.queryTypes)) {
                throw safeError("search-membership-unavailable", 428);
            }
            const scenarios = mergeEvidenceWithState(state);
            const { scenarioIds, actionIds, parentScenarioIds } = createSearchMembership({
                revision: state.revision, scenarios, requestActivity: buildRequestActivity(scenarios),
            }, { layer }, [], [...panel.matches.hits.values()], receipt, wire);
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
        release(owner, reason = "closed") { const panel = panels.get(owner); return panel ? closePanel(panel, reason) : Promise.resolve(); },
        async close() {
            stopped = true;
            await Promise.all([...panels.values()].map(panel => closePanel(panel, "runtime-stopped")));
            await Promise.all(closing);
        },
    };
}
