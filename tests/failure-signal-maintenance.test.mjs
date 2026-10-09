import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, appendFile, unlink, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluationFixture, materializeEvaluationSource, assessed } from "./evaluation-fixture.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { createCollector } from "../lib/collector.mjs";
import { completeWorkIqCall } from "../lib/history.mjs";
import { atomicJson, hash, readJson } from "../lib/collector-io.mjs";
import { assessmentSource, buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { evaluationRecordFingerprint } from "../lib/evaluation-fingerprint.mjs";
import { maintenanceStateGuard } from "../lib/historical-maintenance.mjs";
import { runFailureSignalMaintenance } from "../lib/failure-signal-maintenance.mjs";
import { createExportController } from "../lib/export.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digest = value => hash(JSON.stringify(value));
const beforeSignal = { version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: null };
const afterSignal = { ...beforeSignal, messageSignal: "workiq-sign-in-required" };
async function inventory(directory) {
    const files = [];
    async function visit(relative) {
        for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if ([".git", "node_modules"].includes(entry.name)) continue;
            const name = path.join(relative, entry.name);
            if (entry.isDirectory()) await visit(name);
            else files.push({ path: name, sha256: hash(await readFile(path.join(directory, name))) });
        }
    }
    await visit("");
    return files;
}
async function fixture(t) {
    const f = await evaluationFixture(t, request => assessed(request, false));
    for (const input of f.inputs) {
        input.record.graphActivities = [];
        input.record.toolCalls[0].requestArgs = { entityUrls: ["/me?$select=creationType"] };
        input.record.toolCalls[0].requestedApiPath = "/me";
        input.events[2].data.arguments = input.record.toolCalls[0].requestArgs;
        input.events[4].data.content = "Three synthetic items.";
    }
    const first = f.inputs[0], call = first.record.toolCalls[0];
    first.events[3].data = { toolCallId: call.toolCallId, success: false,
        error: { code: "failure", message: "Synthetic excluded error prose." } };
    first.record.toolCalls[0] = completeWorkIqCall(call, first.events[3]);
    await materializeEvaluationSource(f);
    const collector = await createCollector(f.context, { timers: false });
    try { await collector.collectNow(); } finally { await collector.close(); }
    const collected = await loadBoardState(f.context);
    await replaceEvidence(f.context, () => ({ records: f.inputs.map(input => input.record), importCoverage: collected.importCoverage }));
    f.input.scenarioIds = [f.inputs[1].record.scenarioId];
    f.input.expectedSourceRevision = (await loadBoardState(f.context)).evidenceRevision;
    f.input.maxAiCredits = 30;
    await f.controller.start("synthetic", f.input); await f.controller.settle();
    const reports = createExportController(f.context), reportState = await loadBoardState(f.context);
    const preview = await reports.preview("synthetic", undefined, { promptMode: "none", formats: ["json"] }, { kind: "all", revision: reportState.revision });
    await reports.review("synthetic", preview.previewId, true); await reports.confirm("synthetic", preview.previewId, true);
    const state = await loadBoardState(f.context), model = buildAssessmentModel(state);
    assert.equal(state.personalEvaluation.modelEvaluation.records.length, 1);
    const record = state.evidence.find(record => record.scenarioId === first.record.scenarioId);
    const indexFile = path.join(f.context.dataDir, "collector", "index.json"), index = await readJson(indexFile);
    const checkpointFile = path.join(f.context.dataDir, "collector", index.fingerprint, record.sourceSessionId + ".json");
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    const directory = path.dirname(f.context.dataDir);
    const plan = {
        schemaVersion: 1, operationId: randomUUID(),
        attestation: { packetSha256: hash("invented bounded evidence"), recheckSha256: hash("invented prior finite sign-in predicate"),
            stoppedRuntimePid: exited.pid, recorderIdle: true, evaluatorIdle: true, noDispatchVerified: true },
        source: { configSha256: hash(await readFile(path.join(f.context.dataDir, "collector", "config.json"))),
            indexSha256: hash(await readFile(indexFile)), ...assessmentSource(state, f.config), windowDays: f.config.windowDays },
        stateGuardSha256: maintenanceStateGuard(state),
        preservedFiles: (await inventory(f.context.dataDir)).filter(file => ![
            `${BOARD_ID}.state.json`, path.relative(f.context.dataDir, checkpointFile),
        ].includes(file.path) && file.path !== "data.db" && !file.path.startsWith(`session-state${path.sep}`)),
        targets: [{
            scenarioId: record.scenarioId, sourceSessionId: record.sourceSessionId,
            interactionRef: model.catalog.find(row => row.scenarioId === record.scenarioId).interactionRef,
            recordSha256: digest(record),
            prompt: { sourceEventId: record.userPrompt.sourceEventId, sourceTimestamp: record.userPrompt.sourceTimestamp, textSha256: hash(record.userPrompt.text) },
            call: Object.fromEntries(["toolCallId", "startEventId", "startedAt", "completionEventId", "completedAt"].map(key => [key, record.toolCalls[0][key]])),
        }],
    };
    const planFile = path.join(directory, "signal-plan.json"), journalFile = path.join(directory, "signal-journal.json");
    const sourceManifestFile = path.join(directory, "signal-source.json"), files = await inventory(root);
    const sourceIdentity = digest(files);
    await writeFile(sourceManifestFile, JSON.stringify({ root, files, sourceIdentity }));
    const options = { dataDir: f.context.dataDir, planFile, journalFile, sourceManifestFile, sourceIdentity };
    const reseal = async () => { await writeFile(planFile, JSON.stringify(plan)); options.planSha256 = hash(await readFile(planFile)); };
    await reseal();
    return { ...f, state, plan, options, checkpointFile, indexFile, reseal };
}
function cliOptions(options) {
    return ["scripts\\maintain-failure-signal.mjs", "--mode", options.mode, "--data-dir", options.dataDir,
        "--plan", options.planFile, "--plan-sha256", options.planSha256, "--journal", options.journalFile,
        "--source-manifest", options.sourceManifestFile, "--source-identity", options.sourceIdentity,
        ...(options.reviewSha256 ? ["--review-sha256", options.reviewSha256] : [])];
}
test("one failed unassessed call and its existing checkpoint gain only the finite signal; later same-endpoint score and all other bytes survive", async t => {
    const f = await fixture(t), checkpoint = await readJson(f.checkpointFile);
    const originalState = hash(await readFile(path.join(f.context.dataDir, `${BOARD_ID}.state.json`)));
    const originalCheckpoint = hash(await readFile(f.checkpointFile));
    const prepared = await runFailureSignalMaintenance({ ...f.options, mode: "prepare" });
    assert.equal((await loadBoardState(f.context)).revision, f.state.revision);
    const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
    const applied = await runFailureSignalMaintenance(options);
    assert.equal(applied.status, "complete");
    const after = await loadBoardState(f.context), expected = structuredClone(f.state.evidence);
    expected[0].toolCalls[0].failureEvidence = afterSignal;
    assert.deepEqual(after.evidence, expected);
    const expectedCheckpoint = structuredClone(checkpoint);
    expectedCheckpoint.events.find(event => event.id === f.plan.targets[0].call.completionEventId).data.wireFailureEvidence.messageSignal = afterSignal.messageSignal;
    assert.deepEqual(await readJson(f.checkpointFile), expectedCheckpoint);
    assert.equal(after.revision, f.state.revision + 1); assert.equal(after.evidenceRevision, f.state.evidenceRevision + 1);
    assert.equal(maintenanceStateGuard(after), maintenanceStateGuard(f.state));
    assert.deepEqual(after.personalEvaluation, f.state.personalEvaluation);
    assert.equal(evaluationRecordFingerprint(after.evidence[1]), evaluationRecordFingerprint(f.state.evidence[1]));
    assert.equal(buildAssessmentModel(after).details.get(f.state.personalEvaluation.modelEvaluation.records[0].interactionRef).reviewStatus.assessment.result, "assessed");
    const journal = await readJson(f.options.journalFile);
    assert.equal(journal.core.state.beforeSha256, originalState);
    assert.equal(journal.core.checkpoints[0].beforeSha256, originalCheckpoint);
    assert.equal(journal.core.snapshot.beforeFile, f.state.evidenceFile);
    assert.equal(journal.core.snapshot.afterFile, after.evidenceFile);
    assert.equal(journal.core.state.afterSha256, hash(await readFile(path.join(f.context.dataDir, `${BOARD_ID}.state.json`))));
    assert.equal(journal.core.checkpoints[0].afterSha256, hash(await readFile(f.checkpointFile)));
    const bytes = await inventory(f.context.dataDir);
    assert.equal((await runFailureSignalMaintenance(options)).alreadyCommitted, true);
    assert.deepEqual(await inventory(f.context.dataDir), bytes);
    assert.doesNotMatch(await readFile(f.options.journalFile, "utf8"), /Synthetic|creationType|pseudonymKey|userPrompt/);
    const firstSource = path.join(f.config.sessionRoot, f.inputs[0].record.sourceSessionId, "events.jsonl");
    await appendFile(firstSource, JSON.stringify({ id: randomUUID(), type: "assistant.turn_end", timestamp: new Date().toISOString(), data: { turnId: "unrelated" } }) + "\n");
    const collector = await createCollector(f.context, { timers: false });
    try { await collector.collectNow(); } finally { await collector.close(); }
    const restarted = await loadBoardState(f.context);
    assert.deepEqual(restarted.evidence.find(record => record.toolCalls.some(call => call.toolCallId === f.plan.targets[0].call.toolCallId)).toolCalls[0].failureEvidence, afterSignal);
    assert.deepEqual(restarted.personalEvaluation, after.personalEvaluation);
});
test("single-target CLI never needs original histories or database, and rejects the two-target contract", async t => {
    const f = await fixture(t);
    await rename(f.config.appDbPath, f.config.appDbPath + ".held");
    await rename(f.config.sessionRoot, f.config.sessionRoot + ".held");
    const prepared = spawnSync(process.execPath, cliOptions({ ...f.options, mode: "prepare" }), { cwd: root, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const applied = spawnSync(process.execPath, cliOptions({ ...f.options, mode: "apply", reviewSha256: JSON.parse(prepared.stdout).reviewSha256 }), { cwd: root, encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    f.plan.targets.push(structuredClone(f.plan.targets[0])); await f.reseal();
    await assert.rejects(runFailureSignalMaintenance({ ...f.options, mode: "prepare" }), /exactly one/);
});
test("checkpoint and board process interruption recover exact postimages without a duplicate revision", async t => {
    for (const boundary of ["applying", "checkpoint-1", "snapshot-staged", "board-saved", "complete"]) await t.test(boundary, async t => {
        const f = await fixture(t), prepared = await runFailureSignalMaintenance({ ...f.options, mode: "prepare" });
        const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
        const moduleUrl = pathToFileURL(path.join(root, "lib", "failure-signal-maintenance.mjs")).href;
        const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import { runFailureSignalMaintenance } from ${JSON.stringify(moduleUrl)};
            await runFailureSignalMaintenance(${JSON.stringify(options)}, { onStep(phase) { if (phase === ${JSON.stringify(boundary)}) process.exit(77); } });
        `], { cwd: root, encoding: "utf8" });
        assert.equal(crashed.status, 77, crashed.stderr);
        const resumed = await runFailureSignalMaintenance(options);
        assert.equal(resumed.revision, f.state.revision + 1);
        assert.equal(resumed.alreadyCommitted, ["board-saved", "complete"].includes(boundary));
        const bytes = await inventory(f.context.dataDir);
        assert.equal((await runFailureSignalMaintenance(options)).alreadyCommitted, true);
        assert.deepEqual(await inventory(f.context.dataDir), bytes);
    });
});
test("normal owner and competing in-process or cross-process maintenance writers are refused", async t => {
    const f = await fixture(t), owner = await createCollector(f.context, { timers: false });
    try {
        const bytes = await inventory(f.context.dataDir);
        await assert.rejects(runFailureSignalMaintenance({ ...f.options, mode: "prepare" }), /already owns/);
        const child = spawnSync(process.execPath, cliOptions({ ...f.options, mode: "prepare" }), { cwd: root, encoding: "utf8" });
        assert.equal(child.status, 1); assert.match(child.stderr, /Another runtime owns/);
        assert.deepEqual(await inventory(f.context.dataDir), bytes);
    } finally { await owner.close(); }
});
test("stale record, checkpoint, state, saved file or source seals reject before any repair write", async t => {
    for (const kind of ["record", "checkpoint", "state", "saved-file", "source", "journal"]) await t.test(kind, async t => {
        const f = await fixture(t), prepared = await runFailureSignalMaintenance({ ...f.options, mode: "prepare" });
        if (kind === "record") await replaceEvidence(f.context, records => ({ records: records.map((record, i) => i ? record : { ...record, sourceSessionName: "Changed" }), importCoverage: f.state.importCoverage }));
        if (kind === "checkpoint") await appendFile(f.checkpointFile, " ");
        if (kind === "state") await updateBoardState(f.context, () => {});
        if (kind === "saved-file") await appendFile(Object.values(f.state.exports[0].files)[0], " ");
        if (kind === "source") await writeFile(f.options.sourceManifestFile, "{}");
        if (kind === "journal") { const j = await readJson(f.options.journalFile); j.core.state.afterRevision++; await atomicJson(f.options.journalFile, j); }
        const bytes = await inventory(f.context.dataDir), journal = await readFile(f.options.journalFile);
        await assert.rejects(runFailureSignalMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 }));
        assert.deepEqual(await inventory(f.context.dataDir), bytes); assert.deepEqual(await readFile(f.options.journalFile), journal);
    });
});
test("scored or attempted target, wrong interaction, stronger signal, missing source/store and conflicting checkpoint fail closed", async t => {
    for (const kind of ["scored", "attempted", "interaction", "signal", "missing-source", "missing-board", "checkpoint-signal", "checkpoint-postimage", "checkpoint-duplicate"]) await t.test(kind, async t => {
        const f = await fixture(t), target = f.plan.targets[0];
        if (["scored", "attempted"].includes(kind)) {
            await updateBoardState(f.context, state => {
                const data = state.personalEvaluation.modelEvaluation;
                if (kind === "scored") data.records[0].interactionRef = target.interactionRef;
                else data.runs[0].scope[0].interactionRef = target.interactionRef;
                if (kind === "scored") data.records[0].assessments.forEach(item => { item.interactionRef = target.interactionRef; item.unitRef = target.interactionRef; });
            });
            f.plan.stateGuardSha256 = maintenanceStateGuard(await loadBoardState(f.context));
        }
        if (kind === "interaction") target.interactionRef = "interaction-" + "0".repeat(32);
        if (kind === "signal") {
            await replaceEvidence(f.context, records => ({ records: records.map((record, i) => i ? record : { ...record, toolCalls: [{ ...record.toolCalls[0], failureEvidence: afterSignal }] }), importCoverage: f.state.importCoverage }));
            target.recordSha256 = digest((await loadBoardState(f.context)).evidence[0]);
        }
        if (kind === "missing-source") {
            const index = await readJson(f.indexFile); delete index.sources[target.sourceSessionId]; await atomicJson(f.indexFile, index);
            f.plan.source.indexSha256 = hash(await readFile(f.indexFile));
            f.plan.preservedFiles = f.plan.preservedFiles.filter(file => file.path !== path.relative(f.context.dataDir, f.indexFile));
        }
        if (kind === "missing-board") await unlink(path.join(f.context.dataDir, `${BOARD_ID}.state.json`));
        if (kind.startsWith("checkpoint-")) {
            const checkpoint = await readJson(f.checkpointFile), event = checkpoint.events.find(event => event.id === target.call.completionEventId);
            if (kind === "checkpoint-signal") event.data.wireFailureEvidence.messageSignal = "request-timeout";
            else if (kind === "checkpoint-postimage") event.data.wireFailureEvidence.messageSignal = afterSignal.messageSignal;
            else checkpoint.events.push(structuredClone(event));
            await atomicJson(f.checkpointFile, checkpoint);
        }
        await f.reseal();
        const bytes = await inventory(f.context.dataDir);
        await assert.rejects(runFailureSignalMaintenance({ ...f.options, mode: "prepare" }),
            ["scored", "attempted"].includes(kind) ? /scored, attempted or enrolled/ : undefined);
        assert.deepEqual(await inventory(f.context.dataDir), bytes);
        await assert.rejects(readFile(f.options.journalFile), { code: "ENOENT" });
    });
});
test("missing completion or checkpoint is not recreated", async t => {
    for (const missing of ["event", "checkpoint"]) await t.test(missing, async t => {
        const f = await fixture(t), checkpoint = await readJson(f.checkpointFile);
        if (missing === "checkpoint") await unlink(f.checkpointFile);
        else { checkpoint.events = checkpoint.events.filter(event => event.id !== f.plan.targets[0].call.completionEventId); await atomicJson(f.checkpointFile, checkpoint); }
        const prepared = await runFailureSignalMaintenance({ ...f.options, mode: "prepare" });
        await runFailureSignalMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
        if (missing === "checkpoint") await assert.rejects(readFile(f.checkpointFile), { code: "ENOENT" });
        else assert.deepEqual(await readJson(f.checkpointFile), checkpoint);
    });
});
