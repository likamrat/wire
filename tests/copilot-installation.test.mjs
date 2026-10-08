import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, copyFile, unlink, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { createEvaluationController } from "../lib/evaluation-controller.mjs";
import { evaluationFixture, materializeEvaluationSource, assessed } from "./evaluation-fixture.mjs";
import { resolveCopilotInstallation } from "../lib/copilot-installation.mjs";
import { MODEL_EVALUATION_RESPONSE_SCHEMA, MODEL_EVALUATION_RUBRIC } from "../lib/model-evaluation.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";

async function installation(t) {
    const hooks = [], cleanup = { after: action => hooks.push(action) };
    t.after(async () => { for (const action of hooks.reverse()) await action(); });
    const f = await evaluationFixture(cleanup), local = path.join(f.context.dataDir, "synthetic-localappdata");
    const sdkFile = path.join(local, "Programs", "GitHub Copilot", "copilot-sdk", "index.js");
    const cliFile = path.join(local, "Microsoft", "WinGet", "Links", "copilot.exe");
    await mkdir(path.dirname(sdkFile), { recursive: true });
    await mkdir(path.dirname(cliFile), { recursive: true });
    await writeFile(path.join(path.dirname(sdkFile), "package.json"), JSON.stringify({ type: "module" }));
    await copyFile(new URL("./fixtures/copilot-sdk-nonstarting.mjs", import.meta.url), sdkFile);
    await writeFile(cliFile, "NON-EXECUTABLE SYNTHETIC FIXTURE; NEVER LAUNCH");
    const names = ["LOCALAPPDATA", "WORKIQ_EVIDENCE_COPILOT_SDK", "WORKIQ_EVIDENCE_COPILOT_CLI"];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    process.env.LOCALAPPDATA = local;
    delete process.env.WORKIQ_EVIDENCE_COPILOT_SDK; delete process.env.WORKIQ_EVIDENCE_COPILOT_CLI;
    cleanup.after(() => {
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    });
    const { evaluatorFactory: unused, ...options } = f.options;
    const controller = createEvaluationController(f.context, options);
    cleanup.after(() => controller.close());
    f.input.scenarioIds = f.input.scenarioIds.slice(0, 1);
    return { ...f, controller, sdkFile, cliFile, local, after: cleanup.after };
}

test("the actual installedEvaluator path supplies the existing absolute WinGet executable to the synthetic SDK", async t => {
    const f = await installation(t);
    const sdk = await import(pathToFileURL(f.sdkFile).href);
    await f.controller.start("panel", f.input);
    await f.controller.settle();
    assert.equal(sdk.observed.clients.length, 1);
    assert.equal(sdk.observed.clients[0].connection.path, f.cliFile, "Production must not pass a bare PATH command to the SDK.");
    assert.deepEqual(await resolveCopilotInstallation(), { sdkPath: f.sdkFile, cliPath: sdk.observed.clients[0].connection.path },
        "Metadata preflight and production share the same resolver.");
    assert.equal(path.isAbsolute(sdk.observed.clients[0].connection.path), true);
    assert.equal(sdk.observed.sessions.length, 1);
    assert.equal(sdk.observed.processesStarted, 0);
    assert.equal(sdk.observed.clients[0].mode, "empty");
    assert.equal(sdk.observed.clients[0].useLoggedInUser, true);
    assert.deepEqual(sdk.observed.clients[0].telemetry, { captureContent: false });
    assert.equal(sdk.observed.sessions[0].model, "gpt-6-astra");
    assert.deepEqual(sdk.observed.sessions[0].availableTools, []);
    assert.deepEqual(sdk.observed.sessions[0].excludedTools, ["builtin:*", "mcp:*", "custom:*"]);
    assert.equal(sdk.observed.sessions[0].enableSessionStore, false);
    assert.equal(sdk.observed.sessions[0].memory.enabled, false);
    assert.equal(sdk.observed.sessions[0].remoteSession, "off");
    assert.equal(sdk.observed.sessions[0].enableConfigDiscovery, false);
    assert.equal(sdk.observed.sessions[0].skipCustomInstructions, true);
    assert.equal(sdk.observed.sessions[0].enableSkills, false);
    assert.equal(sdk.observed.sessions[0].enableFileHooks, false);
    assert.deepEqual(sdk.observed.sessions[0].sessionLimits, { maxAiCredits: 60 });
    assert.equal(sdk.observed.clients[0].connection.args, undefined);
});

test("an explicit absolute CLI override reaches the production SDK without installation fallback", async t => {
    const f = await installation(t), selected = path.join(f.local, "explicit-copilot.exe");
    await writeFile(selected, "NON-EXECUTABLE EXPLICIT FIXTURE; NEVER LAUNCH");
    process.env.WORKIQ_EVIDENCE_COPILOT_CLI = selected;
    const sdk = await import(pathToFileURL(f.sdkFile).href);
    await f.controller.start("panel", f.input); await f.controller.settle();
    assert.equal(sdk.observed.clients[0].connection.path, selected);
    assert.equal((await resolveCopilotInstallation()).cliPath, selected);
    assert.equal(sdk.observed.processesStarted, 0);
});

for (const kind of ["empty", "relative", "missing", "directory", "missing-default"]) {
    test(`the production adapter rejects ${kind} CLI configuration before constructing any SDK client`, async t => {
        const f = await installation(t);
        if (kind === "missing-default") await unlink(f.cliFile);
        else process.env.WORKIQ_EVIDENCE_COPILOT_CLI = kind === "empty" ? "" : kind === "relative" ? "copilot"
            : kind === "directory" ? f.local : path.join(f.local, "does-not-exist.exe");
        const sdk = await import(pathToFileURL(f.sdkFile).href);
        await f.controller.start("panel", f.input); await f.controller.settle();
        assert.equal(sdk.observed.clients.length, 0);
        assert.equal(sdk.observed.processesStarted, 0);
        const receipt = await f.controller.status("panel", { runRef: f.input.mutationRef });
        const expected = ["empty", "relative"].includes(kind) ? "copilot-cli-path-invalid"
            : kind === "directory" ? "copilot-cli-not-file" : "copilot-cli-unavailable";
        assert.equal(receipt.results[0].diagnostic.stage, "executor-load");
        assert.equal(receipt.results[0].diagnostic.errorCode, expected);
        assert.equal(receipt.results[0].diagnostic.sendInvoked, false);
        assert.equal(receipt.costUnknown, false);
    });
}

test("an explicit synthetic SDK override uses the same validated path as metadata preflight", async t => {
    const f = await installation(t), sdkFile = path.join(f.local, "explicit-sdk.mjs");
    await copyFile(new URL("./fixtures/copilot-sdk-nonstarting.mjs", import.meta.url), sdkFile);
    process.env.WORKIQ_EVIDENCE_COPILOT_SDK = sdkFile;
    const selected = await import(pathToFileURL(sdkFile).href), defaultSdk = await import(pathToFileURL(f.sdkFile).href);
    await f.controller.start("panel", f.input); await f.controller.settle();
    assert.equal(selected.observed.clients.length, 1);
    assert.equal(defaultSdk.observed.clients.length, 0);
    assert.deepEqual(await resolveCopilotInstallation(), { sdkPath: sdkFile, cliPath: f.cliFile });
});

test("invalid SDK configuration and custom providers fail without selecting another installation", async t => {
    const f = await installation(t), sdk = await import(pathToFileURL(f.sdkFile).href);
    const environment = { LOCALAPPDATA: f.local };
    for (const [value, code] of [["", "copilot-sdk-path-invalid"], ["relative-index.js", "copilot-sdk-path-invalid"],
        [f.local, "copilot-sdk-not-file"], [path.join(f.local, "absent-sdk.mjs"), "copilot-sdk-unavailable"]]) {
        await assert.rejects(resolveCopilotInstallation({ ...environment, WORKIQ_EVIDENCE_COPILOT_SDK: value }), error => error.code === code);
    }
    await assert.rejects(resolveCopilotInstallation({ ...environment, COPILOT_PROVIDER_TEST: "synthetic" }), error => error.code === "copilot-provider-unapproved");
    assert.equal(sdk.observed.clients.length, 0);
});

const identity = () => ({
    schemaVersion: 1, mutationRef: "mutation-" + randomBytes(16).toString("hex"),
    receiptToken: randomBytes(32).toString("hex"), confirmed: true,
});
async function automaticRuntime(f) {
    await materializeEvaluationSource(f);
    const exports = createExportController(f.context);
    const runtime = await startServer(f.context, exports, { port: 0, collector: { timers: false } });
    f.after(() => runtime.close());
    const origin = new URL(runtime.url).origin, headers = { Origin: origin, "Content-Type": "application/json" };
    const connected = await fetch(origin + "/api/session", { method: "POST", headers, body: "{}" });
    assert.equal(connected.status, 200);
    headers["X-Board-Capability"] = (await connected.json()).capability;
    const api = async (route, input = {}) => {
        const response = await fetch(origin + route, { method: "POST", headers, body: JSON.stringify(input) });
        assert.equal(response.status, 200, route);
        return response.json();
    };
    await runtime.collector.setEnabled(true);
    await runtime.collector.collectNow();
    const setup = await api("/api/evaluation/automatic/setup");
    const approval = {
        ...identity(), expectedSourceRevision: setup.sourceRevision, expectedApprovalRevision: setup.approvalRevision,
        source: setup.source, method: setup.method, chatRefs: setup.chats.map(chat => chat.chatRef),
        evidenceCategories: ["prompt", "answer", "references", "intent"], maxCalls: 2, maxAiCredits: 60,
    };
    return { runtime, exports, api, approval };
}
async function settledState(context, count) {
    const deadline = Date.now() + 10000;
    do {
        const state = await loadBoardState(context), runs = state.personalEvaluation?.modelEvaluation?.runs ?? [];
        if (runs.length >= count && runs.every(run => !["queued", "running"].includes(run.phase))) return state;
        await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.fail("The synthetic installed-adapter automatic witness did not settle.");
}
function respond(sdk, change = value => value) {
    sdk.setSyntheticResponder(({ message, timeout, options, emit }) => {
        assert.deepEqual(message.responseSchema, MODEL_EVALUATION_RESPONSE_SCHEMA);
        assert.equal(timeout, 120000);
        assert.equal(options.model, "gpt-6-astra");
        const input = JSON.parse(message.prompt);
        const result = assessed({
            input, packetHash: input.packetHash, model: options.model,
            rubricId: MODEL_EVALUATION_RUBRIC.id, rubricVersion: MODEL_EVALUATION_RUBRIC.version,
        }, input.packet.answer.text === "Two synthetic items.");
        emit({ type: "assistant.usage", data: {
            apiCallId: `synthetic-${sdk.observed.sends}`, model: options.model, copilotUsage: { totalNanoAiu: 100000000 },
        } });
        return { type: "assistant.message", data: { content: JSON.stringify(change(result.rawResult)) } };
    });
}

test("default installed adapter persists all three automatic dimensions through real source reads, routes and a frozen new report", { timeout: 20000 }, async t => {
    const f = await installation(t), sdk = await import(pathToFileURL(f.sdkFile).href);
    respond(sdk);
    const { runtime, exports, api, approval } = await automaticRuntime(f);
    assert.equal(sdk.observed.clients.length, 0, "Collection and setup cannot authorize a model call.");
    await api("/api/evaluation/automatic/approve", approval);
    await settledState(f.context, 1);
    await runtime.collector.collectNow();
    const state = await settledState(f.context, 2), data = state.personalEvaluation.modelEvaluation;
    assert.equal(data.records.length, 2);
    assert.ok(data.runs.every(run => run.phase === "complete" && run.callsReserved === 1 && !run.costUnknown));
    assert.equal(sdk.observed.sends, 2);
    assert.equal(sdk.observed.processesStarted, 0);
    assert.equal(sdk.observed.disconnects, 2);
    assert.equal(sdk.observed.stops, 2);
    assert.equal(f.calls.length, 0, "The fixture's injected evaluatorFactory must never be used.");
    assert.equal(state.personalEvaluation.consent.state, "off");
    const metrics = buildAssessmentModel(state).overview.metrics.filter(metric => metric.origin === "model-assessed");
    const expected = { accuracy: 0.5, "answer-trust": 0.5, "action-trust": 1 };
    assert.equal(metrics.length, 3);
    for (const metric of metrics) {
        assert.equal(metric.value, expected[metric.dimension]);
        assert.deepEqual(metric.coverage, { covered: 2, eligible: 2 });
        assert.equal(metric.evaluator.model, "gpt-6-astra");
        assert.equal(metric.evaluator.rubricVersion, 1);
    }
    for (const detail of buildAssessmentModel(state).details.values()) {
        assert.equal(detail.metrics.filter(metric => metric.origin === "model-assessed").length, 3);
    }
    assert.doesNotMatch(JSON.stringify(data), /How many synthetic|Three synthetic|Two synthetic/);
    const preview = await exports.preview("synthetic-installed-witness", undefined, { promptMode: "none", formats: ["json", "markdown"] },
        { kind: "selected", revision: state.revision, scenarioIds: state.evidence.map(record => record.scenarioId) });
    for (const metric of preview.snapshot.evaluationFacts.metrics.filter(metric => metric.origin === "model-assessed")) {
        assert.equal(metric.value, expected[metric.dimension]);
        assert.deepEqual(metric.coverage, { covered: 2, eligible: 2 });
    }
    await exports.review("synthetic-installed-witness", preview.previewId, true);
    const saved = (await exports.confirm("synthetic-installed-witness", preview.previewId, true)).bundle;
    const before = await Promise.all(Object.values(saved.files).map(file => readFile(file)));
    await api("/api/evaluation/automatic/approve", approval);
    await runtime.collector.collectNow();
    assert.equal(sdk.observed.sends, 2, "Receipt lookup/reconciliation never replay completed work.");
    await api("/api/evaluation/automatic/revoke", identity());
    await runtime.collector.collectNow();
    assert.equal(sdk.observed.sends, 2);
    assert.equal(buildAssessmentModel(await loadBoardState(f.context)).overview.metrics.some(metric => metric.origin === "model-assessed"), false);
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(file => readFile(file))), before);
    for (const run of data.runs) assert.deepEqual(await readdir(path.join(f.context.dataDir, "evaluation-work", run.runRef)), []);
});

test("default installed adapter rejects incomplete answer coverage, persists observed usage and cannot publish synthetic scores", { timeout: 20000 }, async t => {
    const f = await installation(t), sdk = await import(pathToFileURL(f.sdkFile).href);
    respond(sdk, result => ({ ...result, answerSegments: [] }));
    const { runtime, api, approval } = await automaticRuntime(f);
    await api("/api/evaluation/automatic/approve", approval);
    const state = await settledState(f.context, 1), data = state.personalEvaluation.modelEvaluation;
    assert.equal(data.records.length, 0);
    assert.equal(data.runs[0].phase, "failed");
    assert.equal(data.runs[0].spentAiCredits, 0.1);
    assert.equal(data.runs[0].costUnknown, false);
    assert.equal(data.runs[0].results[0].diagnostic.stage, "result-validation");
    assert.equal(data.runs[0].results[0].diagnostic.errorCode, "incomplete-answer-coverage",
        "The exact strict predicate must survive the content-free failed-attempt receipt.");
    assert.equal((await api("/api/evaluation/automatic/summary")).snapshot.reason, "evaluation-failed");
    await runtime.collector.collectNow();
    assert.equal(sdk.observed.sends, 1);
    assert.equal(sdk.observed.disconnects, 1);
    assert.equal(sdk.observed.stops, 1);
    assert.equal(sdk.observed.processesStarted, 0);
    assert.equal(buildAssessmentModel(state).overview.metrics.some(metric => metric.origin === "model-assessed"), false);
});

test("automatic source admission preserves the exact oversized-reference exclusion without SDK calls, reservations or dropped evidence", { timeout: 20000 }, async t => {
    const f = await installation(t), sdk = await import(pathToFileURL(f.sdkFile).href);
    for (const input of f.inputs) {
        const completion = input.events.find(event => event.type === "tool.execution_complete");
        completion.data.result.structuredContent = { payload: "x".repeat(90203) };
        assert.equal(Buffer.byteLength(JSON.stringify(completion.data.result.structuredContent)), 90217);
    }
    respond(sdk);
    const { runtime, api, approval } = await automaticRuntime(f);
    approval.chatRefs = approval.chatRefs.slice(0, 1);
    await api("/api/evaluation/automatic/approve", approval);
    const state = await settledState(f.context, 1), data = state.personalEvaluation.modelEvaluation;
    assert.equal(data.records.length, 0);
    assert.equal(data.runs[0].callsReserved, 0);
    assert.equal(data.runs[0].costUnknown, false);
    assert.equal(data.runs[0].results[0].reason, "evidence-limit");
    assert.equal(data.runs[0].results[0].diagnostic.stage, "packet-build");
    assert.deepEqual(data.runs[0].results[0].diagnostic.size, {
        kind: "reference-structured", measured: 90217, limit: 65536, unit: "bytes",
    });
    assert.equal(data.runs[0].results[0].diagnostic.sendInvoked, false);
    await runtime.collector.collectNow();
    assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.runs.length, 1);
    assert.equal(sdk.observed.clients.length, 0);
    assert.equal(sdk.observed.sends, 0);
    assert.equal(sdk.observed.processesStarted, 0);
});
