import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence, exclusiveBoard } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { evaluationFixture, materializeEvaluationSource, assessed } from "./evaluation-fixture.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function client(runtime) {
    const origin = new URL(runtime.url).origin;
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const connection = await fetch(origin + "/api/session", { method: "POST", headers, body: "{}" });
    assert.equal(connection.status, 200);
    headers["X-Board-Capability"] = (await connection.json()).capability;
    return async (route, input = {}) => {
        const response = await fetch(origin + route, { method: "POST", headers, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
    };
}
async function settled(api, runRef) {
    const deadline = Date.now() + 10000;
    let result;
    do {
        result = await api("/api/evaluation/status", { runRef });
        if (!["queued", "running"].includes(result.body.phase)) return result.body;
        await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.fail("Controlled evaluation did not finish.");
}

test("normal startup/setup/close with no grant never starts a provider, reads extra evidence or changes capture/state", async t => {
    const f = await evaluationFixture(t);
    await materializeEvaluationSource(f);
    const before = await loadBoardState(f.context);
    const configFile = path.join(f.context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    let providerCalls = 0, extraReads = 0;
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { providerCalls++; throw new Error("No provider may start"); },
            readSource: async () => { extraReads++; throw new Error("No evidence may be read"); },
        },
    });
    const api = await client(runtime);
    try {
        assert.equal((await fetch(runtime.url + "health")).status, 200);
        assert.equal((await fetch(runtime.url)).status, 200);
        const setup = await api("/api/evaluation/setup", { scenarioIds: f.input.scenarioIds });
        assert.equal(setup.status, 200);
        assert.equal(setup.body.active, false);
        assert.equal(setup.body.latestRun, null);
        assert.equal((await api("/api/evaluation/start", { ...f.input, confirmed: false })).status, 422);
        assert.equal(providerCalls, 0); assert.equal(extraReads, 0);
    } finally { await runtime.close(); }
    const after = await loadBoardState(f.context);
    assert.equal(after.personalEvaluation, undefined);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.exports, before.exports);
    assert.equal(after.pseudonymKey, before.pseudonymKey);
    assert.deepEqual(await readFile(configFile), configBefore);
});

test("real routes carry controlled model origin into existing UI, four frozen formats and separate Cost, then revoke without rewriting reports", { timeout: 45000 }, async t => {
    const f = await evaluationFixture(t);
    await materializeEvaluationSource(f);
    const exports = createExportController(f.context), runtime = await startServer(f.context, exports, {
        port: 0, collector: { timers: false }, evaluation: { evaluatorFactory: f.options.evaluatorFactory },
    });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const api = await client(runtime);
    const setup = await api("/api/evaluation/setup", { scenarioIds: f.input.scenarioIds });
    const input = { ...f.input, expectedSourceRevision: setup.body.basis.sourceRevision };
    const start = await api("/api/evaluation/start", input);
    assert.equal(start.status, 200);
    const status = await settled(api, input.mutationRef);
    assert.equal(status.phase, "complete", JSON.stringify(status));
    assert.equal(f.calls.length, 2);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#home");
    await page.locator("#homeInsights .assessment-grid").waitFor();
    const accuracy = page.locator('#homeInsights [data-dimension="accuracy"]').filter({ hasText: "Model assessment" });
    assert.equal(await accuracy.locator(".assessment-value").innerText(), "50%");
    assert.match(await accuracy.innerText(), /1 \/ 2 passed.*2 \/ 2 assessed/s);
    assert.match(await page.locator('#homeInsights [data-dimension="cost"]').innerText(), /Not measured/);
    const state = await loadBoardState(f.context);
    const preview = await exports.preview("synthetic-review", undefined, { promptMode: "none", formats: ["html", "pdf", "json", "markdown"] },
        { kind: "selected", revision: state.revision, scenarioIds: input.scenarioIds });
    const modelMetric = preview.snapshot.evaluationFacts.metrics.find(metric => metric.dimension === "accuracy" && metric.origin === "model-assessed");
    assert.equal(modelMetric.value, 0.5);
    assert.equal(modelMetric.evaluator.model, "gpt-6-astra");
    for (const text of [preview.previewHtml, preview.files["product-report.md"]]) {
        assert.match(text, /Model assessment/);
        assert.match(text, /50%/);
        assert.doesNotMatch(text, /How many synthetic|Three synthetic|Two synthetic/);
    }
    await exports.review("synthetic-review", preview.previewId, true);
    const saved = (await exports.confirm("synthetic-review", preview.previewId, true)).bundle;
    const hashes = await Promise.all(Object.values(saved.files).map(async file => digest(await readFile(file))));
    const pdf = getDocument({ data: new Uint8Array(await readFile(saved.files["product-report.pdf"])), useSystemFonts: true });
    try {
        const document = await pdf.promise, text = [];
        for (let i = 1; i <= document.numPages; i++) text.push((await (await document.getPage(i)).getTextContent()).items.map(item => item.str ?? "").join(" "));
        assert.match(text.join(" "), /Model assessment/);
        assert.match(text.join(" "), /50%/);
    } finally { await pdf.destroy(); }
    assert.equal((await api("/api/evaluation/revoke", { confirmed: false })).status, 422);
    assert.equal((await api("/api/evaluation/revoke", { confirmed: true })).status, 200);
    assert.equal((await loadBoardState(f.context)).personalEvaluation.consent.state, "off");
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(async file => digest(await readFile(file)))), hashes);
    assert.equal((await api("/api/evaluation/start", input)).body.phase, "complete", "An existing operation cannot replay after revocation.");
    assert.equal(f.calls.length, 2);
    for (const workDir of f.workDirs) await assert.rejects(readdir(workDir), { code: "ENOENT" });
    assert.deepEqual(errors, []);
});

test("source deletion purges model dependencies and old receipts never recreate evaluated records", async t => {
    const f = await evaluationFixture(t);
    await materializeEvaluationSource(f);
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false }, evaluation: { evaluatorFactory: f.options.evaluatorFactory },
    });
    t.after(() => runtime.close());
    const api = await client(runtime), setup = await api("/api/evaluation/setup", { scenarioIds: f.input.scenarioIds });
    const input = { ...f.input, expectedSourceRevision: setup.body.basis.sourceRevision };
    assert.equal((await api("/api/evaluation/start", input)).status, 200);
    assert.equal((await settled(api, input.mutationRef)).phase, "complete");
    const exports = createExportController(f.context), before = await loadBoardState(f.context);
    const report = await exports.preview("synthetic-review", undefined, { promptMode: "none", formats: ["json"] },
        { kind: "selected", revision: before.revision, scenarioIds: input.scenarioIds });
    await exports.review("synthetic-review", report.previewId, true);
    const saved = (await exports.confirm("synthetic-review", report.previewId, true)).bundle;
    const reportFile = Object.values(saved.files)[0], frozenHash = digest(await readFile(reportFile));
    const preview = await api("/api/deletion/preview", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    assert.equal(preview.status, 200);
    const removed = await api("/api/deletion/confirm", { operationId: preview.body.operationId, confirmed: true });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const state = await loadBoardState(f.context);
    assert.equal(state.personalEvaluation.modelEvaluation.records.length, 0);
    assert.equal((await api("/api/evaluation/status", { runRef: input.mutationRef })).body.phase, "purged");
    assert.equal((await api("/api/evaluation/start", input)).body.phase, "purged");
    assert.equal(f.calls.length, 2);
    assert.equal(digest(await readFile(reportFile)), frozenHash);
});

test("source deletion aborts owned work, removes temporary packets before success and rejects a late result", { timeout: 15000 }, async t => {
    let release, aborted = 0;
    const f = await evaluationFixture(t, async (request, _reservation, _call, { signal }) => {
        await writeFile(path.join(f.workDirs.at(-1), "synthetic-packet.txt"), "SYNTHETIC ONLY");
        return new Promise(resolve => {
            release = () => resolve(assessed(request, false));
            signal.addEventListener("abort", () => { aborted++; release(); }, { once: true });
            if (signal.aborted) release();
        });
    });
    await materializeEvaluationSource(f);
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false }, evaluation: { evaluatorFactory: f.options.evaluatorFactory },
    });
    try {
        const api = await client(runtime), setup = await api("/api/evaluation/setup", { scenarioIds: f.input.scenarioIds });
        const input = { ...f.input, expectedSourceRevision: setup.body.basis.sourceRevision };
        assert.equal((await api("/api/evaluation/start", input)).status, 200);
        while (!release) await new Promise(resolve => setImmediate(resolve));
        const preview = await api("/api/deletion/preview", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
        assert.equal(preview.status, 200);
        const removed = await api("/api/deletion/confirm", { operationId: preview.body.operationId, confirmed: true });
        assert.equal(removed.status, 200, JSON.stringify(removed.body));
        assert.equal(aborted, 1);
        for (const workDir of f.workDirs) await assert.rejects(readdir(workDir), { code: "ENOENT" });
        const receipt = await api("/api/evaluation/status", { runRef: input.mutationRef });
        assert.equal(receipt.body.phase, "purged");
        assert.equal(receipt.body.costUnknown, true);
        assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.records.length, 0);
        assert.equal(f.calls.length, 1);
    } finally { release?.(); await runtime.close(); }
});

test("range deletion removes only dependent assessments and preserves unrelated model facts", async t => {
    const f = await evaluationFixture(t);
    const earlier = new Date(Date.now() - 86400000).toISOString();
    f.inputs[0].record.userPrompt.sourceTimestamp = earlier;
    Object.assign(f.inputs[0].record.toolCalls[0], { startedAt: earlier, completedAt: earlier });
    f.inputs[0].events.forEach(event => { event.timestamp = earlier; });
    const original = await loadBoardState(f.context);
    await replaceEvidence(f.context, () => ({ records: f.inputs.map(input => input.record), importCoverage: original.importCoverage }));
    await materializeEvaluationSource(f);
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false }, evaluation: { evaluatorFactory: f.options.evaluatorFactory },
    });
    try {
        const api = await client(runtime), setup = await api("/api/evaluation/setup", { scenarioIds: f.input.scenarioIds });
        const input = { ...f.input, expectedSourceRevision: setup.body.basis.sourceRevision };
        assert.equal((await api("/api/evaluation/start", input)).status, 200);
        assert.equal((await settled(api, input.mutationRef)).phase, "complete");
        const before = await loadBoardState(f.context), survivor = before.personalEvaluation.modelEvaluation.records[1];
        const preview = await api("/api/deletion/preview", {
            scope: "range", from: earlier.slice(0, 10), to: earlier.slice(0, 10), timeContext: { timeZone: "UTC", locale: "en-US" },
        });
        assert.equal(preview.status, 200);
        const removed = await api("/api/deletion/confirm", { operationId: preview.body.operationId, confirmed: true });
        assert.equal(removed.status, 200, JSON.stringify(removed.body));
        const after = await loadBoardState(f.context), data = after.personalEvaluation.modelEvaluation;
        assert.deepEqual(data.records, [survivor]);
        assert.equal(data.runs[0].scope.length, 1);
        assert.equal(data.grants[0].interactionRefs.length, 1);
        const accuracy = buildAssessmentModel(after).overview.metrics.find(metric => metric.origin === "model-assessed" && metric.dimension === "accuracy");
        assert.equal(accuracy.value, 0);
        assert.deepEqual(accuracy.coverage, { covered: 1, eligible: 1 });
        assert.equal((await api("/api/evaluation/start", input)).body.phase, "purged");
        assert.equal(f.calls.length, 2);
    } finally { await runtime.close(); }
});

test("normal startup recovers an interrupted reservation and private work without any provider or extra evidence read", async t => {
    const f = await evaluationFixture(t, async () => { throw new Error("Synthetic interrupted call"); });
    await materializeEvaluationSource(f);
    const setup = await f.controller.setup({ scenarioIds: f.input.scenarioIds });
    await f.controller.start("old-panel", { ...f.input, expectedSourceRevision: setup.basis.sourceRevision });
    await f.controller.settle();
    await f.controller.close();
    await exclusiveBoard(f.context, async (state, save) => {
        const run = state.personalEvaluation.modelEvaluation.runs[0];
        Object.assign(run, { phase: "running", costUnknown: false, completedAt: null, error: null, results: [] });
        await save(state);
    });
    const workDir = path.join(f.context.dataDir, "evaluation-work", f.input.mutationRef, "1");
    await mkdir(workDir, { recursive: true });
    await writeFile(path.join(workDir, "synthetic-packet.txt"), "INVENTED INTERRUPTED PACKET");
    const before = await loadBoardState(f.context), configFile = path.join(f.context.dataDir, "collector", "config.json");
    const configBefore = await readFile(configFile);
    let providerCalls = 0, reads = 0;
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { providerCalls++; throw new Error("Recovery cannot submit"); },
            readSource: async () => { reads++; throw new Error("Recovery cannot read original evidence"); },
        },
    });
    try {
        const api = await client(runtime);
        const receipt = await api("/api/evaluation/status", { runRef: f.input.mutationRef, receiptToken: f.input.receiptToken });
        assert.equal(receipt.status, 200);
        assert.equal(receipt.body.phase, "uncertain");
        assert.equal(receipt.body.costUnknown, true);
        assert.equal(providerCalls, 0);
        assert.equal(reads, 0);
        await assert.rejects(readdir(workDir), { code: "ENOENT" });
        const after = await loadBoardState(f.context);
        assert.deepEqual(after.evidence, before.evidence);
        assert.deepEqual(after.exports, before.exports);
        assert.deepEqual(after.personalEvaluation.consent, before.personalEvaluation.consent);
        assert.deepEqual(await readFile(configFile), configBefore);
    } finally { await runtime.close(); }
});
