import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";

const identity = () => ({ schemaVersion: 1, mutationRef: "mutation-" + randomBytes(16).toString("hex"), receiptToken: randomBytes(32).toString("hex"), confirmed: true });
async function client(runtime) {
    const origin = new URL(runtime.url).origin, headers = { Origin: origin, "Content-Type": "application/json" };
    const connected = await fetch(origin + "/api/session", { method: "POST", headers, body: "{}" });
    headers["X-Board-Capability"] = (await connected.json()).capability;
    return async (route, input = {}) => {
        const response = await fetch(origin + route, { method: "POST", headers, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
    };
}
async function settled(context, count) {
    const deadline = Date.now() + 10000;
    do {
        const state = await loadBoardState(context), runs = state.personalEvaluation?.modelEvaluation?.runs ?? [];
        if (runs.length >= count && runs.every(run => !["queued", "running"].includes(run.phase))) return state;
        await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.fail("Controlled automatic scoring did not settle.");
}

test("normal collector cycles feed approved automatic scores into the real existing UI and immutable report facts", { timeout: 45000 }, async t => {
    const cleanup = [], f = await evaluationFixture({ after: action => cleanup.push(action) });
    await materializeEvaluationSource(f);
    const exports = createExportController(f.context);
    const runtime = await startServer(f.context, exports, { port: 0, collector: { timers: false }, evaluation: { evaluatorFactory: f.options.evaluatorFactory } });
    let browser;
    t.after(async () => { try { await browser?.close(); await runtime.close(); } finally { for (const action of cleanup.reverse()) await action(); } });
    await runtime.collector.setEnabled(true);
    await runtime.collector.collectNow();
    assert.equal(f.calls.length, 0, "Collection permission is not score-processing permission.");
    const api = await client(runtime), setup = await api("/api/evaluation/automatic/setup");
    assert.equal(setup.status, 200);
    assert.equal(setup.body.chats.length, 2);
    const input = {
        ...identity(), expectedSourceRevision: setup.body.sourceRevision, expectedApprovalRevision: setup.body.approvalRevision,
        source: setup.body.source, method: setup.body.method, chatRefs: setup.body.chats.map(chat => chat.chatRef),
        evidenceCategories: ["prompt", "answer", "references", "intent"], maxCalls: 2, maxAiCredits: 60,
    };
    assert.equal((await api("/api/evaluation/automatic/approve", input)).status, 200);
    await settled(f.context, 1);
    await runtime.collector.collectNow();
    const state = await settled(f.context, 2);
    assert.equal(f.calls.length, 2);
    assert.equal(state.personalEvaluation.consent.state, "off");
    browser = await chromium.launch();
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#home");
    const accuracy = page.locator('#homeInsights [data-dimension="accuracy"]').filter({ hasText: "Model assessment" });
    await accuracy.waitFor();
    assert.equal(await accuracy.locator(".assessment-value").innerText(), "50%");
    assert.match(await accuracy.innerText(), /1 \/ 2 passed.*2 \/ 2 assessed/s);
    assert.equal(await page.locator('#homeInsights [data-dimension="cost"]').count(), 0);
    const ids = state.evidence.map(record => record.scenarioId);
    const preview = await exports.preview("synthetic-automatic-report", undefined, { promptMode: "none", formats: ["html", "json", "markdown", "pdf"] },
        { kind: "selected", revision: state.revision, scenarioIds: ids });
    assert.equal(preview.snapshot.evaluationFacts.metrics.find(metric => metric.dimension === "accuracy" && metric.origin === "model-assessed").value, 0.5);
    await exports.review("synthetic-automatic-report", preview.previewId, true);
    const saved = (await exports.confirm("synthetic-automatic-report", preview.previewId, true)).bundle;
    const hashes = () => Promise.all(Object.values(saved.files).map(async file => createHash("sha256").update(await readFile(file)).digest("hex")));
    const before = await hashes();
    const stop = await api("/api/evaluation/automatic/revoke", identity());
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    await runtime.collector.collectNow();
    assert.equal(f.calls.length, 2);
    assert.deepEqual(await hashes(), before);
    assert.equal((await api("/api/evaluation/automatic/setup")).body.snapshot.state, "off");
    assert.deepEqual(errors, []);
});

test("an observer failure cannot turn a completed collection cycle into collection failure", async t => {
    const cleanup = [], f = await evaluationFixture({ after: action => cleanup.push(action) });
    await materializeEvaluationSource(f);
    const runtime = await startServer(f.context, createExportController(f.context), { port: 0,
        collector: { timers: false, onCommitted: () => { throw Object.assign(new Error("Synthetic observer failure"), { code: "SYNTHETIC_OBSERVER_FAILURE" }); } },
        evaluation: { evaluatorFactory: async () => { throw new Error("No provider is authorized"); } },
    });
    t.after(async () => { try { await runtime.close(); } finally { for (const action of cleanup.reverse()) await action(); } });
    const collected = await runtime.collector.collectNow();
    assert.ok(collected.check);
    assert.equal((await runtime.collector.status()).error, null);
    assert.equal(f.calls.length, 0);
});

test("automatic summary reads paused approved status without changing state or running a provider", async t => {
    const cleanup = [], denied = [], f = await evaluationFixture({ after: action => cleanup.push(action) });
    await materializeEvaluationSource(f);
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { denied.push("provider"); throw new Error("Summary proof denies provider work."); },
            readSource: async () => { denied.push("source"); throw new Error("Summary proof denies evaluation source reads."); },
        },
    });
    t.after(async () => { try { await runtime.close(); } finally { for (const action of cleanup.reverse()) await action(); } });
    const api = await client(runtime), before = await loadBoardState(f.context);
    const sourceFiles = [f.config.appDbPath, ...f.inputs.map(input => path.join(f.config.sessionRoot, input.record.sourceSessionId, "events.jsonl"))];
    const sourceBefore = await Promise.all(sourceFiles.map(file => readFile(file)));
    for (let index = 0; index < 3; index++) {
        const result = await api("/api/evaluation/automatic/summary");
        assert.equal(result.status, 200);
        assert.equal(result.body.snapshot.state, "off");
        assert.equal(result.body.snapshot.reason, "not-approved");
        assert.equal(result.body.snapshot.usage.callsReserved, 0);
        assert.equal(result.body.snapshot.approval, null);
        assert.ok(result.body.source.sourceConfigRef);
    }
    for (const input of [null, [], true, false, 1, 0, "", "summary", { confirmed: true }]) {
        assert.equal((await api("/api/evaluation/automatic/summary", input)).status, 400, `Reject ${JSON.stringify(input)}`);
    }
    assert.deepEqual(await loadBoardState(f.context), before);
    assert.deepEqual(await Promise.all(sourceFiles.map(file => readFile(file))), sourceBefore);
    assert.equal((await runtime.collector.status()).config.enabled, false);
    assert.deepEqual(denied, []);
    assert.deepEqual(f.calls, []);
});
