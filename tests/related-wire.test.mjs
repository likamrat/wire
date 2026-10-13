import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { searchWireContract as wire, createSearchWireContract } from "../lib/search-wire-contract.mjs";
import { SEARCH_MATCH_POLICY_ID, SEARCH_RELATED, SEARCH_TYPES } from "../lib/search-ranking.mjs";
import { searchFixture, searchRecords, saveSearchComparison } from "./live-search-fixture.mjs";
import { loadBoardState, exclusiveBoard } from "../lib/store.mjs";
import { validatePeriodSemanticSelection } from "../lib/period-comparison.mjs";

const receipt = (purpose = "strict-match-population", queryPurpose = "analysis") => ({
    schemaVersion: 2, panelId: randomUUID(), epoch: 1, requestId: 2, generation: 3,
    indexId: "a".repeat(64), modelId: "b".repeat(64), revision: 4, mode: "hybrid",
    queryPurpose, queryTypes: [...wire.allTypes], purpose,
    ...(purpose === "strict-match-population" ? { matchPolicyId: SEARCH_MATCH_POLICY_ID } : { relatedPolicyId: SEARCH_RELATED.id }),
});
const query = (text, requestId, purpose = "navigation", types) => ({
    schemaVersion: 2, query: text, requestId, purpose, ...(types === undefined ? {} : { types }),
});
const waitFor = async (read, description) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Missing search proof event: " + description);
};

async function panel(t, runtime) {
    const origin = new URL(runtime.url).origin, controller = new AbortController();
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const call = async (route, input) => {
        const response = await fetch(origin + route, { method: "POST", headers, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
    };
    const session = await call("/api/session", {});
    headers["X-Board-Capability"] = session.body.capability;
    const response = await fetch(origin + "/api/search/events", {
        method: "POST", headers, body: '{"schemaVersion":2}', signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const events = [], reader = response.body.getReader(), decoder = new TextDecoder();
    let readFailure;
    const reading = (async () => {
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n")) >= 0) {
                events.push(JSON.parse(buffer.slice(0, end)));
                buffer = buffer.slice(end + 1);
            }
        }
    })().catch(error => { if (!controller.signal.aborted) readFailure = error; });
    const wait = predicate => waitFor(() => {
        if (readFailure) throw readFailure;
        return events.find(predicate);
    }, "ordered stream");
    const close = async () => { controller.abort(); await reading; };
    t.after(close);
    await wait(event => event.event === "connected");
    return { call, events, wait, close, headers };
}

function periodInput(state, token, layer = "tool") {
    return {
        schemaVersion: 1, expectedRevision: state.revision,
        options: { layer, filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-30", to: "2026-09-30" }, later: { from: "2026-09-30", to: "2026-10-01" } },
        semanticSelection: { receipt: token }, withinServices: [],
    };
}

test("v2 contract closes every discriminant and policy/type stamp without upgrading old receipts", () => {
    const factory = new Function("return (" + createSearchWireContract.toString() + ")")();
    const copy = factory({ matchPolicyId: SEARCH_MATCH_POLICY_ID, relatedPolicyId: SEARCH_RELATED.id, types: SEARCH_TYPES });
    for (const contract of [wire, copy]) {
        assert.throws(() => contract.handshake({}), error => error.code === "search-protocol-changed" && error.status === 409);
        for (const purpose of [undefined, null, "related", "Navigation", 1]) {
            assert.throws(() => contract.query({ ...query("car", 1), purpose }), error => error.code === "invalid-search-input");
        }
        assert.deepEqual(contract.query(query("car", 1)).types, contract.allTypes);
        assert.deepEqual(contract.query(query("car", 2, "analysis", ["reply", "action"])).types, ["action", "reply"]);
        for (const types of [["reply", "reply"], ["invalid"], null, "interaction"]) {
            assert.throws(() => contract.query(query("car", 3, "navigation", types)));
        }
        const strict = receipt(), navigation = receipt("strict-match-population", "navigation"), related = receipt("related-navigation", "navigation");
        assert.equal(contract.analysisReceipt(strict), true);
        assert.equal(contract.analysisReceipt(navigation), false);
        assert.equal(contract.analysisReceipt(related), false);
        assert.equal(contract.sameReceipt(strict, structuredClone(strict)), true);
        const { schemaVersion, queryPurpose, queryTypes, purpose, matchPolicyId, ...old } = strict;
        assert.throws(() => contract.receipt(old), error => error.code === "search-protocol-changed");
        for (const altered of [
            { ...related, purpose: "strict-match-population" }, { ...related, queryPurpose: "analysis" },
            { ...strict, relatedPolicyId: SEARCH_RELATED.id }, { ...strict, matchPolicyId: "0".repeat(64) },
            { ...strict, queryTypes: [] }, { ...strict, queryTypes: [...strict.queryTypes].reverse() },
            { ...strict, queryTypes: ["unknown"] }, { ...strict, mode: "unavailable" },
        ]) assert.equal(contract.validReceipt(altered), false);
        for (const key of ["panelId", "epoch", "requestId", "generation", "indexId", "modelId", "revision", "queryPurpose", "queryTypes"]) {
            const altered = { ...strict, [key]: typeof strict[key] === "number" ? strict[key] + 1
                : key === "queryTypes" ? ["interaction"] : key === "queryPurpose" ? "navigation" : key === "panelId" ? randomUUID() : "c".repeat(64) };
            assert.equal(contract.sameReceipt(strict, altered), false, key);
        }
    }
    assert.throws(() => validatePeriodSemanticSelection({ receipt: receipt("related-navigation", "navigation") }), /strict analysis receipt/);
    assert.throws(() => validatePeriodSemanticSelection({ receipt: receipt("strict-match-population", "navigation") }), /strict analysis receipt/);
});

test("real v2 HTTP discovery cannot become analytical or paired report authority, even with forged labels", { timeout: 60000 }, async t => {
    const app = await searchFixture(t);
    const a = await panel(t, app.runtime), b = await panel(t, app.runtime);
    const before = await loadBoardState(app.context);
    const origin = new URL(app.runtime.url).origin;
    const oldHandshake = await fetch(origin + "/api/search/events", {
        method: "POST", headers: a.headers, body: "{}",
    });
    assert.equal(oldHandshake.status, 409);
    assert.equal((await oldHandshake.json()).code, "search-protocol-changed");
    assert.equal((await a.call("/api/search/query", { query: "fix my car", requestId: 0 })).status, 409);
    assert.equal((await a.call("/api/search/query", { ...query("fix my car", 0), purpose: "related" })).status, 422);
    await a.call("/api/search/query", query("fix my car", 1));
    const navigation = await a.wait(event => event.event === "results" && event.requestId === 1);
    assert.equal(wire.validResults(navigation), true);
    assert.equal(navigation.matches.total, 0);
    assert.ok(navigation.related.hits.some(hit => hit.target.href === "#request?request=search-1"));
    assert.equal(navigation.related.coverage.populationComplete, false);
    const car = navigation.related.hits.find(hit => hit.target.href === "#request?request=search-1");
    assert.equal((await a.call("/api/search/query", query("fix my car", 1, "analysis"))).body.state, "superseded",
        "Reusing the navigation request ID cannot change its owned query purpose");
    assert.equal((await a.call("/api/search/open", { id: car.id, receipt: navigation.related.receipt, openId: 1 })).status, 200);
    const opened = await a.wait(event => event.event === "opened" && event.openId === 1);
    assert.equal(opened.document.href, car.target.href);
    assert.equal((await b.call("/api/search/open", { id: car.id, receipt: navigation.related.receipt, openId: 1 })).status, 409);
    assert.equal((await a.call("/api/search/open", { id: car.id, receipt: navigation.matches.receipt, openId: 2 })).status, 409,
        "A Matches stamp cannot open an ID owned only by Related");
    const forged = { ...navigation.matches.receipt, queryPurpose: "analysis" };
    const promoted = { ...navigation.related.receipt, purpose: "strict-match-population",
        queryPurpose: "analysis", matchPolicyId: SEARCH_MATCH_POLICY_ID };
    delete promoted.relatedPolicyId;
    const changedLabel = { ...navigation.related.receipt, purpose: "strict-match-population" };
    for (const token of [navigation.related.receipt, navigation.matches.receipt, forged, promoted, changedLabel,
        { ...forged, queryTypes: ["action", "context", "interaction", "reply"] },
        { ...forged, matchPolicyId: "0".repeat(64) }, { ...forged, revision: forged.revision + 1 }]) {
        const result = await a.call("/api/period-comparison", periodInput(before, token));
        assert.ok([409, 422].includes(result.status), "Related/navigation cannot select period cohorts");
    }
    await a.call("/api/search/query", query("physician", 2, "analysis"));
    const strict = await a.wait(event => event.event === "results" && event.requestId === 2);
    assert.equal(wire.validResults(strict), true);
    assert.equal(Object.hasOwn(strict, "related"), false);
    assert.ok(strict.matches.hits.every(hit => hit.match !== "related"));
    assert.equal((await a.call("/api/search/open", { id: car.id, receipt: strict.matches.receipt, openId: 3 })).status, 409,
        "A later legitimate strict receipt still cannot select the earlier Related-only target");
    for (const token of [navigation.related.receipt, promoted]) {
        assert.ok([409, 422].includes((await a.call("/api/search/open", { id: car.id, receipt: token, openId: 3 })).status));
    }
    const noRelatedInput = query("fix my car", 3, "analysis");
    await b.call("/api/search/query", noRelatedInput);
    const emptyStrict = await b.wait(event => event.event === "results" && event.requestId === 3);
    assert.equal(emptyStrict.matches.total, 0, "The original F09 strict miss stays unchanged");
    assert.equal(Object.hasOwn(emptyStrict, "related"), false, "Analysis never calls discovery");
    const emptyPair = await b.call("/api/period-comparison", periodInput(before, emptyStrict.matches.receipt));
    assert.equal(emptyPair.status, 200, emptyPair.body.error);
    assert.equal(emptyPair.body.periods.baseline.rowIds.length, 0, "A valid empty strict set never widens to Related");
    const pair = await a.call("/api/period-comparison", periodInput(before, strict.matches.receipt));
    assert.equal(pair.status, 200, pair.body.error);
    assert.deepEqual(pair.body.periods.baseline.scenarioIds, ["search-0"]);
    const previewInput = { periodComparison: pair.body, options: { promptMode: "none", formats: ["json"], timeContext: pair.body.timeContext } };
    for (const token of [navigation.related.receipt, forged, promoted, { ...strict.matches.receipt, purpose: "related-navigation" }]) {
        const result = await a.call("/api/preview", { ...previewInput, semanticSelection: { receipt: token } });
        assert.ok([409, 422].includes(result.status), "Preview must not bypass strict receipt admission");
    }
    const preview = await a.call("/api/preview", { ...previewInput, semanticSelection: { receipt: strict.matches.receipt } });
    assert.equal(preview.status, 200, preview.body.error);
    await a.call("/api/search/query", query("", 3, "analysis"));
    const review = await a.call("/api/privacy-review", { previewId: preview.body.previewId, disclosureReviewed: true, timeContext: pair.body.timeContext });
    assert.equal(review.status, 200, review.body.error);
    await a.call("/api/cancel-preview", { previewId: preview.body.previewId });
    assert.deepEqual((await loadBoardState(app.context)).exports, before.exports);
    assert.doesNotMatch(JSON.stringify((await a.call("/api/search/status", {})).body), /fix my car|physician|garage/);
    for (const key of ["evidence", "cards", "personalEvaluation"]) {
        assert.deepEqual((await loadBoardState(app.context))[key], before[key], "Search and preparation do not alter retained evidence/permissions");
    }
});

test("v2 navigation sends every policy candidate, keeps types/requests distinct, and fences both sets", { timeout: 60000 }, async t => {
    const records = searchRecords(63).map(record => ({
        ...record, sourceSessionName: "Invented same source label",
        userPrompt: { ...record.userPrompt, text: "The mechanic repaired a broken automobile in the garage." }, followUpPrompts: [],
    }));
    const app = await searchFixture(t, { records });
    const a = await panel(t, app.runtime), b = await panel(t, app.runtime);
    await a.call("/api/search/query", query("fix my car", 1, "navigation", ["interaction"]));
    const result = await a.wait(event => event.event === "results" && event.requestId === 1);
    assert.equal(wire.validResults(result), true);
    assert.equal(result.related.total, 63);
    assert.equal(new Set(result.related.hits.map(hit => hit.id)).size, 63);
    assert.deepEqual([0, 20, 40, 60].map(start => result.related.hits.slice(start, start + 20).length), [20, 20, 20, 3]);
    const last = result.related.hits[62];
    assert.equal((await a.call("/api/search/open", { id: last.id, receipt: result.related.receipt, openId: 1 })).status, 200);
    for (const token of [
        { ...result.related.receipt, queryTypes: [...wire.allTypes] },
        { ...result.related.receipt, requestId: 2 }, { ...result.related.receipt, epoch: 0 },
        { ...result.related.receipt, relatedPolicyId: "c".repeat(64) },
    ]) assert.ok([409, 422].includes((await a.call("/api/search/open", { id: last.id, receipt: token, openId: 2 })).status));
    await b.call("/api/search/query", query("fix my car", 1, "navigation", ["interaction"]));
    await b.wait(event => event.event === "results");
    const fencesA = a.events.filter(event => event.event === "fence").length, fencesB = b.events.filter(event => event.event === "fence").length;
    assert.equal((await b.call("/api/move", { scenarioId: "search-0", toState: "reviewing" })).status, 200);
    await waitFor(() => a.events.filter(event => event.event === "fence").length > fencesA
        && b.events.filter(event => event.event === "fence").length > fencesB, "two-panel fence");
    assert.equal((await a.call("/api/search/open", { id: last.id, receipt: result.related.receipt, openId: 3 })).status, 409);
    await a.call("/api/search/query", query("fix my car", 2, "navigation", ["interaction"]));
    await a.call("/api/search/query", query("fix", 3, "navigation", ["interaction"]));
    await a.call("/api/search/query", query("mechanic", 4, "analysis"));
    const final = await a.wait(event => event.event === "results" && event.requestId === 4);
    assert.equal(Object.hasOwn(final, "related"), false);
    assert.equal(final.matches.hits.length, 63);
    await a.call("/api/search/cancel", {});
    assert.equal((await a.call("/api/search/open", { id: final.matches.hits[0].id, receipt: final.matches.receipt, openId: 4 })).status, 409);
    await a.close(); await b.close(); await app.runtime.search.close();
    assert.deepEqual(app.runtime.search.status(), { panels: 0, closing: 0, maxPanels: 2 });
});

test("v2 lexical-only discovery is explicit, partial sources are not complete authority, and missing sources fence both maps", { timeout: 20000 }, async t => {
    const app = await searchFixture(t, { reply: false, search: { modelDirectory: "missing-local-model", heartbeatMs: 50 } });
    const a = await panel(t, app.runtime);
    await a.call("/api/search/query", query("physician", 1));
    const navigation = await a.wait(event => event.event === "results" && event.requestId === 1);
    assert.equal(wire.validResults(navigation), true);
    assert.equal(navigation.matches.receipt.mode, "lexical-only");
    assert.equal(navigation.status.corpus.state, "partial");
    assert.equal(Object.hasOwn(navigation, "related"), false);
    await a.call("/api/search/query", query("physician", 2, "analysis"));
    const strict = await a.wait(event => event.event === "results" && event.requestId === 2);
    const state = await loadBoardState(app.context);
    assert.equal((await a.call("/api/period-comparison", periodInput(state, strict.matches.receipt))).status, 428);
    await app.runtime.collector.close();
    await a.wait(event => event.event === "fence" && event.epoch > strict.epoch);
    assert.equal((await a.call("/api/search/open", { id: strict.matches.hits[0].id, receipt: strict.matches.receipt, openId: 1 })).status, 409);
});

test("v2 contract rejects overlap, truncated totals and Related completeness claims", () => {
    const token = receipt("strict-match-population", "navigation");
    const { matchPolicyId, ...base } = token;
    const related = { ...base, purpose: "related-navigation", relatedPolicyId: SEARCH_RELATED.id };
    const hit = { id: "one", revision: "1".repeat(64), type: "interaction", excerpt: "Invented car record", match: "related", purpose: "navigate-only" };
    const event = { schemaVersion: 2, panelId: token.panelId, epoch: token.epoch, event: "results", purpose: "navigation",
        requestId: token.requestId, matches: { receipt: token, hits: [], total: 0 },
        related: { receipt: related, hits: [hit], total: 1,
            coverage: { evaluatedItems: 63, corpusState: "ready", retrieval: "policy-selected-candidates", populationComplete: false } },
        status: { mode: token.mode, indexId: token.indexId, modelId: token.modelId, corpus: { state: "ready", generation: token.generation } } };
    assert.equal(wire.validResults(event), true);
    const mismatch = structuredClone(event); mismatch.related.total = 63;
    assert.equal(wire.validResults(mismatch), false);
    const complete = structuredClone(event); complete.related.coverage.populationComplete = true;
    assert.equal(wire.validResults(complete), false);
    const overlap = structuredClone(event); const { purpose, ...strictHit } = hit;
    overlap.matches.hits.push({ ...strictHit, match: "exact" }); overlap.matches.total = 1;
    assert.equal(wire.validResults(overlap), false);
    assert.equal(wire.validResults({ ...event, purpose: "analysis" }), false);
});

test("v2 all ten typed destinations open only from their owned set; category receipts cannot be repurposed", { timeout: 40000 }, async t => {
    const app = await searchFixture(t, { formats: ["json", "json"] });
    await saveSearchComparison(app, ["json"]);
    const a = await panel(t, app.runtime);
    const queries = { interaction: "physician", context: "subsequent medical", reply: "lab results", action: "403",
        tool: "workiq-fetch", service: "Calendar", report: "Saved report", comparison: "Saved comparison",
        view: "Recorded timing", setting: "Theme" };
    let requestId = 0;
    for (const [type, text] of Object.entries(queries)) {
        await a.call("/api/search/query", query(text, ++requestId, "navigation", [type]));
        const event = await a.wait(value => value.event === "results" && value.requestId === requestId);
        assert.equal(wire.validResults(event), true);
        assert.deepEqual(event.matches.receipt.queryTypes, [type]);
        assert.deepEqual(event.related.receipt.queryTypes, [type]);
        assert.ok(event.matches.hits.length > 0, type);
        assert.ok([...event.matches.hits, ...event.related.hits].every(hit => hit.type === type));
        const hit = event.matches.hits[0];
        assert.equal((await a.call("/api/search/open", { id: hit.id, receipt: event.matches.receipt, openId: requestId })).status, 200);
        const opened = await a.wait(value => value.event === "opened" && value.openId === requestId);
        assert.equal(opened.document.kind, ["report", "comparison"].includes(type) ? "json" : "route");
        const reuse = { ...event.matches.receipt, queryPurpose: "analysis", queryTypes: [...wire.allTypes] };
        assert.equal((await a.call("/api/period-comparison", periodInput(await loadBoardState(app.context), reuse))).status, 409);
    }
    await a.call("/api/search/query", query("An ancient violin concerto played underwater in a distant galaxy.", ++requestId));
    const none = await a.wait(value => value.event === "results" && value.requestId === requestId);
    assert.equal(none.matches.total, 0); assert.equal(none.related.total, 0);
    assert.equal(none.related.coverage.populationComplete, false);
});

test("v2 permission revocation clears Matches and Related before acknowledgment without deleting approved frozen content", { timeout: 30000 }, async t => {
    const app = await searchFixture(t, { formats: ["json"] });
    const a = await panel(t, app.runtime), b = await panel(t, app.runtime);
    await a.call("/api/search/query", query("fix my car", 1, "navigation", ["interaction"]));
    const car = await a.wait(value => value.event === "results");
    assert.ok(car.related.total > 0);
    await b.call("/api/search/query", query("lab results", 1, "navigation", ["reply"]));
    const reply = await b.wait(value => value.event === "results");
    assert.equal(reply.matches.total, 1);
    const state = await loadBoardState(app.context), source = app.runtime.collector.assessmentSource(state);
    const revoked = await a.call("/api/assessment/consent/set", {
        schemaVersion: 1, mutationRef: `mutation-${randomUUID().replaceAll("-", "")}`,
        expectedSourceRevision: state.evidenceRevision, expectedConsentRevision: state.personalEvaluation.consent.revision,
        policyVersion: 1, enabled: false, categories: [], sourceConfigRef: source.sourceConfigRef,
        sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
    });
    assert.equal(revoked.status, 200, revoked.body.error);
    await a.wait(value => value.event === "fence" && value.epoch > car.epoch);
    await b.wait(value => value.event === "fence" && value.epoch > reply.epoch);
    assert.equal((await a.call("/api/search/open", { id: car.related.hits[0].id, receipt: car.related.receipt, openId: 1 })).status, 409);
    assert.equal((await b.call("/api/search/open", { id: reply.matches.hits[0].id, receipt: reply.matches.receipt, openId: 1 })).status, 409);
    await a.call("/api/search/query", query("Saved report", 2, "navigation", ["report"]));
    const saved = await a.wait(value => value.event === "results" && value.requestId === 2);
    assert.equal(wire.validResults(saved), true);
    assert.equal(saved.status.corpus.state, "partial");
    assert.equal(saved.related.coverage.corpusState, "partial");
    assert.equal(saved.related.coverage.populationComplete, false);
    assert.equal(saved.matches.total, 1);
    assert.equal((await a.call("/api/search/open", { id: saved.matches.hits[0].id, receipt: saved.matches.receipt, openId: 2 })).status, 200);
    await appendFile(app.bundles[0].files["product-report.json"], "\nUnreviewed bytes");
    assert.equal((await a.call("/api/search/open", { id: saved.matches.hits[0].id, receipt: saved.matches.receipt, openId: 3 })).status, 409);
    assert.equal(a.events.some(event => event.event === "opened" && event.openId === 3), false);
});

test("v2 Related Open closure and stream backpressure discard every owned map without late bytes", { timeout: 30000 }, async t => {
    const app = await searchFixture(t);
    const events = [];
    const response = Object.assign(new EventEmitter(), { writableLength: 0, destroyed: false,
        writeHead() {}, flushHeaders() {}, write(line) { events.push(JSON.parse(line)); }, end() { this.emit("close"); } });
    app.runtime.search.attach("related-close-owner", response, { schemaVersion: 2 });
    app.runtime.search.query("related-close-owner", query("fix my car", 1, "navigation", ["interaction"]));
    const result = await waitFor(() => events.find(event => event.event === "results"), "Related real-model read");
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const lock = exclusiveBoard(app.context, async () => { entered.resolve(); await release.promise; }, { readOnly: true });
    await entered.promise;
    const opening = app.runtime.search.open("related-close-owner", { id: result.related.hits[0].id, receipt: result.related.receipt, openId: 1 });
    const rejected = assert.rejects(opening, /stale-search-target/);
    let closed = false;
    const closing = app.runtime.search.release("related-close-owner").then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, false);
    release.resolve(); await lock; await rejected; await closing;
    assert.equal(events.some(event => event.event === "opened"), false);
    const blocked = [];
    const slow = Object.assign(new EventEmitter(), { writableLength: 0, destroyed: false,
        writeHead() {}, flushHeaders() {}, write(line) {
            const value = JSON.parse(line); blocked.push(value);
            if (value.event === "status" && value.state === "searching" && blocked.some(event => event.event === "fence")) {
                this.writableLength = 9 * 1024 * 1024;
            }
        }, end() { this.emit("close"); } });
    app.runtime.search.attach("related-slow-owner", slow, { schemaVersion: 2 });
    app.runtime.search.query("related-slow-owner", query("fix my car", 1));
    await waitFor(() => app.runtime.search.status().panels === 0, "slow-consumer actual helper exit");
    assert.equal(blocked.some(event => event.event === "results"), false, "A too-large queued frame is not silently truncated");
    assert.equal(app.runtime.search.status().closing, 0);
});
