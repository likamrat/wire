import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, appendFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { hash, atomicJson, readJson, TAIL_LIMITS } from "../lib/collector-io.mjs";
import { assessmentSource, buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { maintenanceStateGuard } from "../lib/historical-maintenance.mjs";
import { runFailureEvidenceMaintenance, runRetrieveDiagnosticMaintenance, runEvictedFetchEvidenceMaintenance,
    runTailRetrieveDiagnosticMaintenance } from "../lib/failure-evidence-maintenance.mjs";
import { eventIdentity } from "../lib/deletion-identities.mjs";
import { createExportController } from "../lib/export.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digest = value => hash(JSON.stringify(value));
const omitted = { version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "size-excluded", messageSignal: null };
const message = "Editing is disabled for this invented item. Choose an editable item.";
const returned = { statusCode: 400, error: { error: { code: "BadRequest", message, details: [{ message: "This item must permit changes." }] } } };
const errorMessage = `MCP server 'workiq': {"results":[${JSON.stringify(returned)},${JSON.stringify(returned)},{"statusCode":200,"data":"EXCLUDED_SUCCESS_BODY"},{"data":{"text":"${"EXCLUDED_SOURCE_BODY".repeat(600)}"]}}`;
const retrieveMessage = "The invented connection needs renewed authorization. Open the client's connection settings.";
let sourceManifestPromise;
async function sourceManifest() {
    const files = [];
    for (const directory of ["lib", "scripts", "web"]) for (const name of (await readdir(path.join(root, directory))).sort()) {
        if (name.endsWith(".mjs")) files.push({ path: path.join(directory, name), sha256: hash(await readFile(path.join(root, directory, name))) });
    }
    return { root, files, sourceIdentity: digest(files) };
}
async function inventory(directory) {
    const files = [];
    async function visit(relative) {
        for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const name = path.join(relative, entry.name);
            if (entry.isDirectory()) await visit(name);
            else files.push({ path: name, sha256: hash(await readFile(path.join(directory, name))) });
        }
    }
    await visit("");
    return files;
}
async function fixture(t, { retrieve = false, contextEvicted = false, tailPrefix = false } = {}) {
    const f = await recollectionFixture(t);
    const initial = (await readFile(f.files[0], "utf8")).trim().split("\n").map(JSON.parse);
    const events = [initial[0], retrieve ? { ...initial[1], id: "prompt-invented-retrieve" } : initial[1]];
    const at = Date.parse(initial[2].timestamp);
    const targetCall = retrieve ? "invented-retrieve" : "invented-call-9", targetCallIndex = retrieve ? 0 : 8;
    for (let number = 1; number <= (retrieve ? 1 : 15); number++) {
        const call = retrieve ? targetCall : number === 1 ? "selected-A" : `invented-call-${number}`;
        events.push({ id: `start-${call}`, type: "tool.execution_start", timestamp: new Date(at + number * 100).toISOString(),
            data: { toolCallId: call, toolName: retrieve ? "workiq-retrieve" : "workiq-fetch",
                arguments: retrieve ? { query: "Find the invented draft." } : { entityUrls: ["/planner/tasks/invented-a", "/planner/tasks/invented-b"] } } });
        events.push({ id: `end-${call}`, type: "tool.execution_complete", timestamp: new Date(at + number * 100 + 50).toISOString(),
            data: { toolCallId: call, success: call !== targetCall,
                ...(call === targetCall ? { error: { code: "failure", message: retrieve ? retrieveMessage : errorMessage } } : {}) } });
    }
    events.push(...initial.slice(4));
    const lines = events.map(event => JSON.stringify(event) + "\n");
    let prefixBytes = 0;
    if (tailPrefix) {
        assert.ok(retrieve && contextEvicted);
        const prefix = initial.slice(1, 4).map(event => JSON.stringify(event) + "\n");
        let paddingBytes = TAIL_LIMITS.initialFileBytes - Buffer.byteLength(lines.slice(1).join("")) + 64;
        for (let index = 0; paddingBytes > 0; index++) {
            const padding = JSON.stringify({ id: `padding-${index}`, type: "session.info", timestamp: initial[0].timestamp, data: {} });
            const bytes = Math.min(TAIL_LIMITS.maxLineBytes, paddingBytes);
            assert.ok(bytes > padding.length);
            prefix.push(padding + " ".repeat(bytes - padding.length - 1) + "\n");
            paddingBytes -= bytes;
        }
        prefixBytes = Buffer.byteLength(prefix.join(""));
        await writeFile(f.files[0], lines[0] + prefix.join("") + lines.slice(1).join(""));
    } else await writeFile(f.files[0], lines.join(""));
    await f.collector.collectNow();
    if (tailPrefix) {
        for (let cycle = 0; cycle < 20; cycle++) {
            const index = await readJson(path.join(f.context.dataDir, "collector", "index.json"));
            if (index.sources[f.sourceId].cursor.backlogBytes === 0) break;
            await f.collector.collectNow();
        }
        const index = await readJson(path.join(f.context.dataDir, "collector", "index.json"));
        assert.ok(index.sources[f.sourceId].cursor.droppedBytes > 0, "The real initial tail window must omit a prefix.");
        assert.equal(index.sources[f.sourceId].cursor.backlogBytes, 0);
    }
    const config = f.collector.approvedRecollectionSource(), good = await loadBoardState(f.context);
    const selected = good.evidence.find(record => record.toolCalls.some(call => call.toolCallId === targetCall));
    assert.equal(selected.toolCalls.length, retrieve ? 1 : 15);
    const correct = selected.toolCalls[targetCallIndex];
    assert.equal(correct.apiResults.length, retrieve ? 0 : 3);
    const oldFailure = retrieve ? { ...omitted, messageStatus: "text-excluded" } : omitted;
    const indexFile = path.join(f.context.dataDir, "collector", "index.json"), index = await readJson(indexFile);
    const checkpointFile = path.join(f.context.dataDir, "collector", index.fingerprint, f.sourceId + ".json");
    const checkpoint = await readJson(checkpointFile);
    const completed = checkpoint.events.find(event => event.id === correct.completionEventId);
    completed.data.wireFailureEvidence = { ...oldFailure };
    delete completed.data.wireResultEvidence;
    completed.data.result.structuredContent.results = [];
    await atomicJson(checkpointFile, checkpoint);
    await replaceEvidence(f.context, records => ({ records: records.map(record => record.scenarioId !== selected.scenarioId ? record : {
        ...record, toolCalls: record.toolCalls.map(call => {
            if (call.toolCallId !== correct.toolCallId) return call;
            const { resultEvidence, ...old } = call;
            return { ...old, failureEvidence: { ...oldFailure }, apiResults: [] };
        }),
    }), importCoverage: good.importCoverage }));
    if (contextEvicted) {
        const laterAt = Date.now() - 60000, later = [{
            id: "later-prompt", type: "user.message", timestamp: new Date(laterAt).toISOString(),
            data: { content: "A separate invented request after the earlier interaction." },
        }];
        for (let number = 0; number < 160; number++) later.push(
            { id: `later-start-${number}`, type: "tool.execution_start", timestamp: new Date(laterAt + number * 100 + 1).toISOString(),
                data: { toolCallId: `later-call-${number}`, toolName: "workiq-retrieve", arguments: { query: "Invented later activity." } } },
            { id: `later-end-${number}`, type: "tool.execution_complete", timestamp: new Date(laterAt + number * 100 + 2).toISOString(),
                data: { toolCallId: `later-call-${number}`, success: true } });
        await appendFile(f.files[0], later.map(event => JSON.stringify(event) + "\n").join(""));
        await f.collector.collectNow();
        const aged = await readJson(checkpointFile);
        assert.ok(!aged.events.some(event => event.id === correct.startEventId || event.id === correct.completionEventId
            || event.data?.toolCallId === correct.toolCallId), "The real collector must age out the target before repair.");
        assert.equal(aged.events.filter(event => event.id === selected.userPrompt.sourceEventId).length, 1);
        assert.deepEqual(aged.cursor, (await readJson(indexFile)).sources[f.sourceId].cursor);
    }
    await updateBoardState(f.context, state => {
        const other = good.evidence.find(record => record.sourceSessionId === f.otherSourceId);
        state.personalEvaluation = qualityDisplayFixture({ records: [other], judgments: ["pass"], pseudonymKey: state.pseudonymKey }).state.personalEvaluation;
        state.personalEvaluation.source = assessmentSource(state, config);
    });
    const reports = createExportController(f.context), reportState = await loadBoardState(f.context);
    const preview = await reports.preview("invented-owner", undefined, { promptMode: "none", formats: ["json", "html"] }, { kind: "all", revision: reportState.revision });
    await reports.review("invented-owner", preview.previewId, true);
    await reports.confirm("invented-owner", preview.previewId, true);
    await f.stop();
    const state = await loadBoardState(f.context), record = state.evidence.find(record => record.scenarioId === selected.scenarioId);
    const model = buildAssessmentModel(state), call = record.toolCalls[targetCallIndex], completionIndex = events.findIndex(event => event.id === call.completionEventId);
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    const plan = {
        schemaVersion: 1, operationId: randomUUID(),
        attestation: { packetSha256: hash("invented explicit source-read grant"), recheckSha256: hash("invented bounded source verification"),
            stoppedRuntimePid: exited.pid, recorderIdle: true, evaluatorIdle: true, noDispatchVerified: true },
        source: { configSha256: hash(await readFile(path.join(f.context.dataDir, "collector", "config.json"))),
            indexSha256: hash(await readFile(indexFile)), ...assessmentSource(state, config), windowDays: config.windowDays },
        stateGuardSha256: maintenanceStateGuard(state),
        preservedFiles: (await inventory(f.context.dataDir)).filter(file => ![`${BOARD_ID}.state.json`,
            ...contextEvicted ? [] : [path.relative(f.context.dataDir, checkpointFile)]].includes(file.path)),
        targets: [{
            scenarioId: record.scenarioId, sourceSessionId: record.sourceSessionId,
            interactionRef: model.catalog.find(item => item.scenarioId === record.scenarioId).interactionRef, recordSha256: digest(record),
            prompt: { sourceEventId: record.userPrompt.sourceEventId, sourceTimestamp: record.userPrompt.sourceTimestamp, textSha256: hash(record.userPrompt.text) },
            call: Object.fromEntries(["tool", "toolCallId", "startEventId", "startedAt", "completionEventId", "completedAt"].map(key => [key, call[key]])),
            sourceEvent: { offset: prefixBytes + Buffer.byteLength(lines.slice(0, completionIndex).join("")), bytes: Buffer.byteLength(lines[completionIndex]),
                sha256: hash(lines[completionIndex]), startupBytes: Buffer.byteLength(lines[0]), startupSha256: hash(lines[0]) },
            ...(contextEvicted ? { checkpointContextSha256: digest(await readJson(checkpointFile)) } : { checkpointEventSha256: digest(completed) }),
        }],
    };
    const planFile = path.join(f.root, "failure-plan.json"), journalFile = path.join(f.root, "failure-journal.json");
    const sourceManifestFile = path.join(f.root, "failure-source.json");
    const manifest = await (sourceManifestPromise ??= sourceManifest());
    await writeFile(sourceManifestFile, JSON.stringify(manifest));
    const options = { dataDir: f.context.dataDir, planFile, journalFile, sourceManifestFile, sourceIdentity: manifest.sourceIdentity };
    const reseal = async () => { await writeFile(planFile, JSON.stringify(plan)); options.planSha256 = hash(await readFile(planFile)); };
    await reseal();
    return { ...f, get collector() { return f.collector; }, config, state, plan, options, checkpointFile, indexFile, correct, events, reseal, targetCallIndex };
}
const cli = (options, script = "scripts\\maintain-failure-evidence.mjs") => [script, "--mode", options.mode, "--data-dir", options.dataDir,
    "--plan", options.planFile, "--plan-sha256", options.planSha256, "--journal", options.journalFile,
    "--source-manifest", options.sourceManifestFile, "--source-identity", options.sourceIdentity,
    ...(options.reviewSha256 ? ["--review-sha256", options.reviewSha256] : [])];

test("exact-call journal publishes only evidence fields in a 15-call record and checkpoint, preserving everything else through append/restart", async t => {
    const f = await fixture(t), before = await inventory(f.context.dataDir), checkpoint = await readJson(f.checkpointFile);
    const originalSource = await readFile(f.files[0]), boardFile = path.join(f.context.dataDir, `${BOARD_ID}.state.json`);
    const beforeBoard = hash(await readFile(boardFile)), beforeCheckpoint = hash(await readFile(f.checkpointFile));
    const prepared = await runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" });
    assert.deepEqual(await inventory(f.context.dataDir), before, "Preparation writes only the external hash-only journal.");
    const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
    const applied = await runFailureEvidenceMaintenance(options);
    assert.equal(applied.status, "complete");
    const state = await loadBoardState(f.context), expected = structuredClone(f.state.evidence);
    const target = f.plan.targets[0], repaired = expected.find(record => record.scenarioId === target.scenarioId).toolCalls[8];
    for (const key of ["failureEvidence", "resultEvidence", "apiResults"]) repaired[key] = f.correct[key];
    assert.deepEqual(state.evidence, expected);
    assert.match(createRecordedResults().failureReason(repaired), /Editing is disabled.*BadRequest.*status 400/);
    assert.equal(state.revision, f.state.revision + 1); assert.equal(state.evidenceRevision, f.state.evidenceRevision + 1);
    assert.equal(maintenanceStateGuard(state), maintenanceStateGuard(f.state));
    assert.deepEqual(state.personalEvaluation, f.state.personalEvaluation);
    assert.deepEqual(await readFile(f.files[0]), originalSource);
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.context.dataDir, file.path))), file.sha256, file.path);
    const next = await readJson(f.checkpointFile), old = structuredClone(checkpoint);
    const current = next.events.find(event => event.id === target.call.completionEventId);
    const previous = old.events.find(event => event.id === target.call.completionEventId);
    for (const field of ["wireFailureEvidence", "wireResultEvidence"]) previous.data[field] = current.data[field];
    previous.data.result.structuredContent.results = current.data.result.structuredContent.results;
    assert.deepEqual(next, old);
    assert.equal(current.data.wireResultEvidence.resultCount, null);
    assert.equal(current.data.wireResultEvidence.contentStatus, "partial");
    assert.deepEqual(current.data.result.structuredContent.results.map(entry => entry.statusCode), [400, 400, 200]);
    const journal = await readJson(f.options.journalFile);
    assert.equal(journal.core.state.beforeSha256, beforeBoard);
    assert.equal(journal.core.state.afterSha256, hash(await readFile(boardFile)));
    assert.equal(journal.core.checkpoints[0].beforeSha256, beforeCheckpoint);
    assert.equal(journal.core.checkpoints[0].afterSha256, hash(await readFile(f.checkpointFile)));
    assert.doesNotMatch(await readFile(f.options.journalFile, "utf8"), /Editing is disabled|EXCLUDED_|pseudonymKey|userPrompt|session-state/);
    const after = await inventory(f.context.dataDir);
    assert.equal((await runFailureEvidenceMaintenance(options)).alreadyCommitted, true);
    assert.deepEqual(await inventory(f.context.dataDir), after);
    await f.restart();
    const append = JSON.stringify({ id: randomUUID(), type: "assistant.turn_end", timestamp: new Date().toISOString(), data: { turnId: "unrelated" } }) + "\n";
    await appendFile(f.files[0], append); await f.collector.collectNow();
    assert.equal((await f.collector.status()).metrics.lastBytesRead, Buffer.byteLength(append));
    const later = await loadBoardState(f.context);
    assert.deepEqual(later.evidence.find(record => record.scenarioId === target.scenarioId).toolCalls,
        state.evidence.find(record => record.scenarioId === target.scenarioId).toolCalls);
    assert.deepEqual(later.personalEvaluation, state.personalEvaluation);
    await f.restart();
    assert.deepEqual((await loadBoardState(f.context)).evidence.find(record => record.scenarioId === target.scenarioId).toolCalls,
        state.evidence.find(record => record.scenarioId === target.scenarioId).toolCalls);
});

test("CLI reads only sealed startup/completion regions, needs no discovery database or unrelated history, and never emits payload text", async t => {
    const f = await fixture(t);
    await rename(f.dbPath, f.dbPath + ".held");
    await rename(f.files[1], f.files[1] + ".held");
    const prepared = spawnSync(process.execPath, cli({ ...f.options, mode: "prepare" }), { cwd: root, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const applied = spawnSync(process.execPath, cli({ ...f.options, mode: "apply", reviewSha256: JSON.parse(prepared.stdout).reviewSha256 }), { cwd: root, encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    assert.doesNotMatch(prepared.stdout + applied.stdout + prepared.stderr + applied.stderr, /Editing is disabled|EXCLUDED_|invented-call|session-state/);
});

test("same-operation process recovery recognizes checkpoint, snapshot and board writes without duplicate revisions", async t => {
    for (const boundary of ["applying", "checkpoint-1", "snapshot-staged", "board-saved", "complete"]) await t.test(boundary, async t => {
        const f = await fixture(t), prepared = await runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" });
        const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
        const url = pathToFileURL(path.join(root, "lib", "failure-evidence-maintenance.mjs")).href;
        const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import { runFailureEvidenceMaintenance } from ${JSON.stringify(url)};
            await runFailureEvidenceMaintenance(${JSON.stringify(options)}, { onStep(phase) { if (phase === ${JSON.stringify(boundary)}) process.exit(77); } });
        `], { cwd: root, encoding: "utf8" });
        assert.equal(crashed.status, 77, crashed.stderr);
        const result = await runFailureEvidenceMaintenance(options);
        assert.equal(result.revision, f.state.revision + 1);
        assert.equal(result.alreadyCommitted, ["board-saved", "complete"].includes(boundary));
        const committed = await inventory(f.context.dataDir);
        assert.equal((await runFailureEvidenceMaintenance(options)).alreadyCommitted, true);
        assert.deepEqual(await inventory(f.context.dataDir), committed);
    });
});

test("wrong source/target bindings and existing richer or missing evidence are refused before preparation writes", async t => {
    for (const kind of ["two-targets", "wrong-call", "wrong-source", "offset", "length", "source-hash", "startup-hash",
        "region-limit", "proposal", "existing-detail", "existing-results", "missing-checkpoint", "missing-completion", "duplicate-completion",
        "foreign-startup", "source-success", "source-code-marker", "source-sensitive", "duplicate-call", "assessed-target"]) await t.test(kind, async t => {
        const f = await fixture(t), target = f.plan.targets[0];
        if (kind === "two-targets") f.plan.targets.push(structuredClone(target));
        if (kind === "wrong-call") target.call.toolCallId = "invented-call-8";
        if (kind === "wrong-source") target.sourceSessionId = f.otherSourceId;
        if (kind === "offset") target.sourceEvent.offset++;
        if (kind === "length") target.sourceEvent.bytes--;
        if (kind === "source-hash") target.sourceEvent.sha256 = "0".repeat(64);
        if (kind === "startup-hash") target.sourceEvent.startupSha256 = "0".repeat(64);
        if (kind === "region-limit") target.sourceEvent.bytes = 1024 ** 2 + 1;
        if (kind === "proposal") target.diagnostic = { message: "An operator cannot supply replacement prose." };
        if (["foreign-startup", "source-success", "source-code-marker", "source-sensitive"].includes(kind)) {
            const source = structuredClone(f.events), completionIndex = source.findIndex(event => event.id === target.call.completionEventId);
            if (kind === "foreign-startup") source[0].data.sessionId = f.otherSourceId;
            if (kind === "source-success") source[completionIndex].data.success = true;
            if (kind === "source-code-marker") source[completionIndex].data.error.code = "DifferentError";
            if (kind === "source-sensitive") source[completionIndex].data.error.message = errorMessage.replace("EXCLUDED_SOURCE_BODY", "Bearer " + "a".repeat(40));
            const lines = source.map(event => JSON.stringify(event) + "\n");
            await writeFile(f.files[0], lines.join(""));
            target.sourceEvent = { offset: Buffer.byteLength(lines.slice(0, completionIndex).join("")),
                bytes: Buffer.byteLength(lines[completionIndex]), sha256: hash(lines[completionIndex]),
                startupBytes: Buffer.byteLength(lines[0]), startupSha256: hash(lines[0]) };
        }
        if (kind === "duplicate-call") {
            await replaceEvidence(f.context, records => ({ records: records.map(record => record.scenarioId === target.scenarioId
                ? { ...record, toolCalls: [...record.toolCalls, structuredClone(record.toolCalls[8])] } : record), importCoverage: f.state.importCoverage }));
            target.recordSha256 = digest((await loadBoardState(f.context)).evidence.find(record => record.scenarioId === target.scenarioId));
        }
        if (kind === "assessed-target") {
            await updateBoardState(f.context, state => {
                const record = state.personalEvaluation.modelEvaluation.records[0];
                record.interactionRef = target.interactionRef;
                record.assessments.forEach(item => { item.interactionRef = target.interactionRef; item.unitRef = target.interactionRef; });
            });
            f.plan.stateGuardSha256 = maintenanceStateGuard(await loadBoardState(f.context));
        }
        if (["existing-detail", "existing-results"].includes(kind)) {
            await replaceEvidence(f.context, records => ({ records: records.map(record => record.scenarioId !== target.scenarioId ? record : {
                ...record, toolCalls: record.toolCalls.map(call => call.toolCallId !== target.call.toolCallId ? call
                    : kind === "existing-detail" ? { ...call, failureEvidence: { ...call.failureEvidence,
                        diagnostic: { version: 1, source: "completion-error", status: "recorded", message: "Already retained." } } }
                        : { ...call, apiResults: f.correct.apiResults }),
            }), importCoverage: f.state.importCoverage }));
            target.recordSha256 = digest((await loadBoardState(f.context)).evidence.find(record => record.scenarioId === target.scenarioId));
        }
        if (kind === "missing-checkpoint") await unlink(f.checkpointFile);
        if (["missing-completion", "duplicate-completion"].includes(kind)) {
            const checkpoint = await readJson(f.checkpointFile), event = checkpoint.events.find(event => event.id === target.call.completionEventId);
            if (kind === "missing-completion") checkpoint.events = checkpoint.events.filter(value => value !== event);
            else checkpoint.events.push(structuredClone(event));
            await atomicJson(f.checkpointFile, checkpoint);
        }
        await f.reseal();
        const before = await inventory(f.context.dataDir);
        await assert.rejects(runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" }));
        assert.deepEqual(await inventory(f.context.dataDir), before);
        await assert.rejects(readFile(f.options.journalFile), { code: "ENOENT" });
    });
});

test("maintenance preserves supported index versions and refuses unknown bounded-history barriers", async t => {
    for (const version of ["legacy", "current", "unknown", "invalid-barrier"]) await t.test(version, async t => {
        const f = await fixture(t), index = await readJson(f.indexFile);
        if (version === "legacy") { index.schemaVersion = 1; delete index.boundedHistoryVersion; }
        if (version === "unknown") index.schemaVersion = 3;
        if (version === "invalid-barrier") index.boundedHistoryVersion = 2;
        await atomicJson(f.indexFile, index);
        const before = await readFile(f.indexFile);
        f.plan.source.indexSha256 = hash(before);
        f.plan.preservedFiles.find(file => file.path === path.relative(f.context.dataDir, f.indexFile)).sha256 = hash(before);
        await f.reseal();
        if (["unknown", "invalid-barrier"].includes(version)) {
            await assert.rejects(runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" }), /Unsupported collector checkpoint version/);
        } else {
            const prepared = await runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" });
            await runFailureEvidenceMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
        }
        assert.deepEqual(await readFile(f.indexFile), before, "Maintenance must not install or downgrade an index barrier.");
    });
});

test("stale prepared board/checkpoint, saved bytes, source or seals refuse further writes and preserve the journal", async t => {
    for (const kind of ["board", "checkpoint", "saved-file", "source-event", "source-code", "journal"]) await t.test(kind, async t => {
        const f = await fixture(t), prepared = await runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" });
        if (kind === "board") await updateBoardState(f.context, () => {});
        if (kind === "checkpoint") await appendFile(f.checkpointFile, " ");
        if (kind === "saved-file") await appendFile(Object.values(f.state.exports[0].files)[0], " ");
        if (kind === "source-event") {
            const value = await readFile(f.files[0]);
            value[f.plan.targets[0].sourceEvent.offset + 1] = 32;
            await writeFile(f.files[0], value);
        }
        if (kind === "source-code") await writeFile(f.options.sourceManifestFile, "{}");
        if (kind === "journal") { const value = await readJson(f.options.journalFile); value.core.state.afterRevision++; await atomicJson(f.options.journalFile, value); }
        const before = await inventory(f.context.dataDir), journal = await readFile(f.options.journalFile);
        await assert.rejects(runFailureEvidenceMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 }));
        assert.deepEqual(await inventory(f.context.dataDir), before);
        assert.deepEqual(await readFile(f.options.journalFile), journal);
    });
});

test("live PID and normal or competing collector owners refuse before any source read", async t => {
    const f = await fixture(t);
    await rename(f.files[0], f.files[0] + ".held");
    const owner = await createCollector(f.context, { timers: false });
    try {
        const before = await inventory(f.context.dataDir);
        await assert.rejects(runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" }), /already owns/);
        const child = spawnSync(process.execPath, cli({ ...f.options, mode: "prepare" }), { cwd: root, encoding: "utf8" });
        assert.equal(child.status, 1); assert.match(child.stderr, /Another runtime owns/);
        assert.deepEqual(await inventory(f.context.dataDir), before);
    } finally { await owner.close(); }
    f.plan.attestation.stoppedRuntimePid = process.pid; await f.reseal();
    await assert.rejects(runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" }), /still alive/);
});

test("small retrieve restoration adds only the literal diagnostic and refuses the fetch entry point", async t => {
    const f = await fixture(t, { retrieve: true }), before = await inventory(f.context.dataDir);
    const checkpoint = await readJson(f.checkpointFile), sourceBefore = await readFile(f.files[0]);
    await assert.rejects(runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" }), /restoration variant/);
    assert.deepEqual(await inventory(f.context.dataDir), before);
    const prepared = spawnSync(process.execPath, cli({ ...f.options, mode: "prepare" }, "scripts\\maintain-retrieve-diagnostic.mjs"),
        { cwd: root, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(await inventory(f.context.dataDir), before);
    assert.doesNotMatch(prepared.stdout + prepared.stderr, /renewed authorization|Find the invented draft/);
    const options = { ...f.options, mode: "apply", reviewSha256: JSON.parse(prepared.stdout).reviewSha256 };
    await assert.rejects(runFailureEvidenceMaintenance(options), /restoration variant/);
    await runRetrieveDiagnosticMaintenance(options);
    const state = await loadBoardState(f.context), expected = structuredClone(f.state.evidence), target = f.plan.targets[0];
    expected.find(record => record.scenarioId === target.scenarioId).toolCalls[0].failureEvidence.diagnostic = f.correct.failureEvidence.diagnostic;
    assert.deepEqual(state.evidence, expected, "No result carrier, status, outcome, identity or other field is added or changed.");
    const expectedCheckpoint = structuredClone(checkpoint);
    expectedCheckpoint.events.find(event => event.id === target.call.completionEventId).data.wireFailureEvidence.diagnostic = f.correct.failureEvidence.diagnostic;
    assert.deepEqual(await readJson(f.checkpointFile), expectedCheckpoint, "Only the matching existing checkpoint diagnostic is added.");
    assert.equal(maintenanceStateGuard(state), maintenanceStateGuard(f.state));
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.context.dataDir, file.path))), file.sha256, file.path);
    assert.deepEqual(await readFile(f.files[0]), sourceBefore);
    assert.equal(state.revision, f.state.revision + 1);
    const call = state.evidence.find(record => record.scenarioId === target.scenarioId).toolCalls[0];
    assert.equal(createRecordedResults().failureReason(call), "Recorded error: " + retrieveMessage);
    assert.equal(call.failureEvidence.messageSignal, null);
    assert.equal(Object.hasOwn(call, "resultEvidence"), false);
    const after = await inventory(f.context.dataDir);
    assert.equal((await runRetrieveDiagnosticMaintenance(options)).alreadyCommitted, true);
    assert.deepEqual(await inventory(f.context.dataDir), after);
    assert.doesNotMatch(await readFile(f.options.journalFile, "utf8"), /renewed authorization|Find the invented draft/);
    await f.restart();
    const append = JSON.stringify({ id: randomUUID(), type: "assistant.turn_end", timestamp: new Date().toISOString(), data: { turnId: "unrelated" } }) + "\n";
    await appendFile(f.files[0], append); await f.collector.collectNow();
    assert.equal((await f.collector.status()).metrics.lastBytesRead, Buffer.byteLength(append));
    assert.deepEqual((await loadBoardState(f.context)).evidence.find(record => record.scenarioId === target.scenarioId).toolCalls, [call]);
});

test("small retrieve diagnostic postimages recover under the same journal after checkpoint and board process exits", async t => {
    for (const boundary of ["checkpoint-1", "board-saved"]) await t.test(boundary, async t => {
        const f = await fixture(t, { retrieve: true }), prepared = await runRetrieveDiagnosticMaintenance({ ...f.options, mode: "prepare" });
        const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
        const url = pathToFileURL(path.join(root, "lib", "failure-evidence-maintenance.mjs")).href;
        const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import { runRetrieveDiagnosticMaintenance } from ${JSON.stringify(url)};
            await runRetrieveDiagnosticMaintenance(${JSON.stringify(options)}, { onStep(phase) { if (phase === ${JSON.stringify(boundary)}) process.exit(77); } });
        `], { cwd: root, encoding: "utf8" });
        assert.equal(crashed.status, 77, crashed.stderr);
        const resumed = await runRetrieveDiagnosticMaintenance(options);
        assert.equal(resumed.revision, f.state.revision + 1);
        assert.equal(resumed.alreadyCommitted, boundary === "board-saved");
        const state = await loadBoardState(f.context);
        assert.equal(state.evidence.find(record => record.scenarioId === f.plan.targets[0].scenarioId).toolCalls[0].failureEvidence.diagnostic.message, retrieveMessage);
        const after = await inventory(f.context.dataDir);
        assert.equal((await runRetrieveDiagnosticMaintenance(options)).alreadyCommitted, true);
        assert.deepEqual(await inventory(f.context.dataDir), after);
    });
});

test("small retrieve variant refuses oversized fetch, stronger/missing/ambiguous evidence and unsupported source shapes", async t => {
    for (const kind of ["fetch", "missing-carrier", "existing-diagnostic", "duplicate-completion", "missing-completion",
        "oversized-source", "sensitive-source", "structured-source", "result-present", "stale-source"]) await t.test(kind, async t => {
        const f = await fixture(t, { retrieve: kind !== "fetch" }), target = f.plan.targets[0];
        if (["missing-carrier", "existing-diagnostic"].includes(kind)) {
            await replaceEvidence(f.context, records => ({ records: records.map(record => record.scenarioId !== target.scenarioId ? record : {
                ...record, toolCalls: record.toolCalls.map(call => {
                    if (call.toolCallId !== target.call.toolCallId) return call;
                    if (kind === "existing-diagnostic") return { ...call, failureEvidence: { ...call.failureEvidence, diagnostic: f.correct.failureEvidence.diagnostic } };
                    const { failureEvidence, ...rest } = call; return rest;
                }),
            }), importCoverage: f.state.importCoverage }));
            target.recordSha256 = digest((await loadBoardState(f.context)).evidence.find(record => record.scenarioId === target.scenarioId));
        }
        if (["missing-completion", "duplicate-completion"].includes(kind)) {
            const checkpoint = await readJson(f.checkpointFile), event = checkpoint.events.find(event => event.id === target.call.completionEventId);
            if (kind === "missing-completion") checkpoint.events = checkpoint.events.filter(value => value !== event);
            else checkpoint.events.push(structuredClone(event));
            await atomicJson(f.checkpointFile, checkpoint);
        }
        if (kind.endsWith("-source") || kind === "result-present") {
            const events = structuredClone(f.events), index = events.findIndex(event => event.id === target.call.completionEventId);
            if (kind === "oversized-source") events[index].data.error.message = "x".repeat(8193);
            if (kind === "sensitive-source") events[index].data.error.message = "Bearer " + "a".repeat(40);
            if (kind === "structured-source") events[index].data.error.message = '{"error":{"message":"Do not flatten structured bodies."}}';
            if (kind === "result-present") events[index].data.result = { content: "" };
            if (kind === "stale-source") events[index].data.error.message = "This changed source must not match the reviewed pin.";
            const lines = events.map(event => JSON.stringify(event) + "\n");
            await writeFile(f.files[0], lines.join(""));
            if (kind !== "stale-source") Object.assign(target.sourceEvent, { bytes: Buffer.byteLength(lines[index]), sha256: hash(lines[index]) });
        }
        await f.reseal();
        const before = await inventory(f.context.dataDir);
        await assert.rejects(runRetrieveDiagnosticMaintenance({ ...f.options, mode: "prepare" }));
        assert.deepEqual(await inventory(f.context.dataDir), before);
        await assert.rejects(readFile(f.options.journalFile), { code: "ENOENT" });
    });

});

test("naturally aged-out fetch repairs only the committed record and survives real bounded-context evolution", async t => {
    const f = await fixture(t, { contextEvicted: true }), target = f.plan.targets[0];
    const checkpointBefore = await readFile(f.checkpointFile), indexBefore = await readFile(f.indexFile);
    const sourceBefore = await readFile(f.files[0]), storeBefore = await inventory(f.context.dataDir);
    await assert.rejects(runFailureEvidenceMaintenance({ ...f.options, mode: "prepare" }), /metadata shape/);
    const prepared = spawnSync(process.execPath, cli({ ...f.options, mode: "prepare" }, "scripts\\maintain-evicted-fetch-evidence.mjs"),
        { cwd: root, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(await inventory(f.context.dataDir), storeBefore);
    const options = { ...f.options, mode: "apply", reviewSha256: JSON.parse(prepared.stdout).reviewSha256 }, phases = [];
    await runEvictedFetchEvidenceMaintenance(options, { onStep: phase => phases.push(phase) });
    assert.deepEqual(phases, ["applying", "snapshot-staged", "board-saved", "complete"]);
    assert.deepEqual(await readFile(f.checkpointFile), checkpointBefore);
    assert.deepEqual(await readFile(f.indexFile), indexBefore);
    assert.deepEqual(await readFile(f.files[0]), sourceBefore);
    const state = await loadBoardState(f.context), expected = structuredClone(f.state.evidence);
    const repaired = expected.find(record => record.scenarioId === target.scenarioId).toolCalls[8];
    for (const key of ["failureEvidence", "resultEvidence", "apiResults"]) repaired[key] = f.correct[key];
    assert.deepEqual(state.evidence, expected);
    assert.equal(maintenanceStateGuard(state), maintenanceStateGuard(f.state));
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.context.dataDir, file.path))), file.sha256, file.path);
    const journal = await readJson(f.options.journalFile);
    assert.equal(journal.core.checkpoints[0].beforeSha256, journal.core.checkpoints[0].afterSha256);
    const committed = await inventory(f.context.dataDir);
    assert.equal((await runEvictedFetchEvidenceMaintenance(options)).alreadyCommitted, true);
    assert.deepEqual(await inventory(f.context.dataDir), committed);

    await f.restart();
    const at = Date.now() - 1000;
    const append = [
        { id: "after-repair-prompt", type: "user.message", timestamp: new Date(at).toISOString(), data: { content: "A new invented request." } },
        { id: "after-repair-start", type: "tool.execution_start", timestamp: new Date(at + 1).toISOString(),
            data: { toolCallId: "after-repair-call", toolName: "workiq-retrieve", arguments: { query: "Invented follow-on." } } },
        { id: "after-repair-end", type: "tool.execution_complete", timestamp: new Date(at + 2).toISOString(), data: { toolCallId: "after-repair-call", success: true } },
    ].map(event => JSON.stringify(event) + "\n").join("");
    await appendFile(f.files[0], append); await f.collector.collectNow();
    assert.equal((await f.collector.status()).metrics.lastBytesRead, Buffer.byteLength(append));
    let later = await loadBoardState(f.context);
    assert.deepEqual(later.evidence.find(record => record.scenarioId === target.scenarioId).toolCalls,
        expected.find(record => record.scenarioId === target.scenarioId).toolCalls);
    assert.ok(later.evidence.some(record => record.toolCalls.some(call => call.toolCallId === "after-repair-call")));
    assert.ok(!(await readJson(f.checkpointFile)).events.some(event => event.id === target.call.startEventId || event.id === target.call.completionEventId));
    assert.deepEqual(later.personalEvaluation, state.personalEvaluation);
    await f.restart();
    const replay = structuredClone(f.events.find(event => event.id === target.call.completionEventId));
    replay.data = { toolCallId: target.call.toolCallId, success: true };
    await appendFile(f.files[0], JSON.stringify(replay) + "\n"); await f.collector.collectNow();
    later = await loadBoardState(f.context);
    assert.deepEqual(later.evidence.find(record => record.scenarioId === target.scenarioId).toolCalls,
        expected.find(record => record.scenarioId === target.scenarioId).toolCalls, "A later conflicting completion cannot replace a recorded completed call.");
    await f.stop();
    const evolved = await inventory(f.context.dataDir);
    await assert.rejects(runEvictedFetchEvidenceMaintenance(options), /configuration or index changed/);
    assert.deepEqual(await inventory(f.context.dataDir), evolved, "An old journal cannot overwrite later collector writes.");
});

test("aged-out record-only operation resumes snapshot/board postimages without any checkpoint write", async t => {
    for (const boundary of ["snapshot-staged", "board-saved"]) await t.test(boundary, async t => {
        const f = await fixture(t, { contextEvicted: true }), checkpoint = await readFile(f.checkpointFile);
        const prepared = await runEvictedFetchEvidenceMaintenance({ ...f.options, mode: "prepare" });
        const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
        const url = pathToFileURL(path.join(root, "lib", "failure-evidence-maintenance.mjs")).href;
        const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import { runEvictedFetchEvidenceMaintenance } from ${JSON.stringify(url)};
            await runEvictedFetchEvidenceMaintenance(${JSON.stringify(options)}, { onStep(phase) { if (phase === ${JSON.stringify(boundary)}) process.exit(77); } });
        `], { cwd: root, encoding: "utf8" });
        assert.equal(crashed.status, 77, crashed.stderr);
        const resumed = await runEvictedFetchEvidenceMaintenance(options);
        assert.equal(resumed.revision, f.state.revision + 1);
        assert.equal(resumed.alreadyCommitted, boundary === "board-saved");
        assert.deepEqual(await readFile(f.checkpointFile), checkpoint);
        const after = await inventory(f.context.dataDir);
        assert.equal((await runEvictedFetchEvidenceMaintenance(options)).alreadyCommitted, true);
        assert.deepEqual(await inventory(f.context.dataDir), after);
    });
});

test("aged-out branch refuses missing files/boundaries, partial identities, context drift, generation mismatch and deletion conflicts", async t => {
    for (const kind of ["missing-file", "missing-prompt", "partial-start", "partial-completion", "sibling-start", "unconsumed", "generation", "dropped-prefix",
        "context-drift", "deleted-completion"]) await t.test(kind, async t => {
        const f = await fixture(t, { contextEvicted: true }), target = f.plan.targets[0];
        const checkpoint = await readJson(f.checkpointFile), index = await readJson(f.indexFile);
        if (kind === "missing-file") await unlink(f.checkpointFile);
        if (kind === "missing-prompt") checkpoint.events = checkpoint.events.filter(event => event.id !== target.prompt.sourceEventId);
        if (kind.startsWith("partial-")) checkpoint.events.unshift(structuredClone(f.events.find(event =>
            event.id === (kind === "partial-start" ? target.call.startEventId : target.call.completionEventId))));
        if (kind === "sibling-start") checkpoint.events.unshift(structuredClone(f.events.find(event => event.id === "start-invented-call-8")));
        if (kind === "unconsumed") checkpoint.cursor.offset = index.sources[f.sourceId].cursor.offset = target.sourceEvent.offset;
        if (kind === "generation") checkpoint.cursor.identity = index.sources[f.sourceId].cursor.identity = "different-source-generation";
        if (kind === "dropped-prefix") checkpoint.cursor.droppedBytes = index.sources[f.sourceId].cursor.droppedBytes = target.sourceEvent.offset;
        if (kind === "context-drift") checkpoint.diagnostics.contextEvictions++;
        if (kind === "deleted-completion") {
            await updateBoardState(f.context, state => { state.deletion = { schemaVersion: 1, identities: [], contextCalls: [],
                events: [eventIdentity(f.sourceId, target.call.completionEventId)] }; });
            f.plan.stateGuardSha256 = maintenanceStateGuard(await loadBoardState(f.context));
        }
        if (kind !== "missing-file") {
            await atomicJson(f.checkpointFile, checkpoint);
            if (kind !== "context-drift") target.checkpointContextSha256 = digest(checkpoint);
            f.plan.preservedFiles.find(file => file.path === path.relative(f.context.dataDir, f.checkpointFile)).sha256 = hash(await readFile(f.checkpointFile));
        }
        await atomicJson(f.indexFile, index);
        f.plan.source.indexSha256 = hash(await readFile(f.indexFile));
        f.plan.preservedFiles.find(file => file.path === path.relative(f.context.dataDir, f.indexFile)).sha256 = f.plan.source.indexSha256;
        await f.reseal();
        const before = await inventory(f.context.dataDir);
        await assert.rejects(runEvictedFetchEvidenceMaintenance({ ...f.options, mode: "prepare" }));
        assert.deepEqual(await inventory(f.context.dataDir), before);
        await assert.rejects(readFile(f.options.journalFile), { code: "ENOENT" });
    });
});

test("tail-context retrieve restores only a consumed-tail diagnostic while preserving a visited prefix gap", async t => {
    const f = await fixture(t, { retrieve: true, contextEvicted: true, tailPrefix: true }), target = f.plan.targets[0];
    const originalPlan = structuredClone(f.plan), indexBytes = await readFile(f.indexFile), checkpointBytes = await readFile(f.checkpointFile);
    const index = JSON.parse(indexBytes), checkpoint = JSON.parse(checkpointBytes), source = index.sources[f.sourceId];
    assert.ok(source.cursor.droppedBytes > 0);
    assert.equal(source.cursor.backlogBytes, 0);
    assert.equal(source.backfill.phase, "visited");
    assert.equal(source.backfill.omittedBytes, source.cursor.droppedBytes);
    assert.equal(source.backfill.boundaryGap, true);
    assert.equal(source.backfillPending, false);
    assert.ok(target.sourceEvent.offset >= source.cursor.droppedBytes);
    assert.ok(target.sourceEvent.offset + target.sourceEvent.bytes <= source.cursor.offset);
    assert.equal(checkpoint.events.filter(event => event.id === target.prompt.sourceEventId).length, 1);
    assert.ok(!checkpoint.events.some(event => event.id === target.call.startEventId || event.id === target.call.completionEventId));
    const preserved = await inventory(f.context.dataDir);
    await assert.rejects(runRetrieveDiagnosticMaintenance({ ...f.options, mode: "prepare" }), /metadata shape/);
    await assert.rejects(runEvictedFetchEvidenceMaintenance({ ...f.options, mode: "prepare" }), /restoration variant/);
    for (const kind of ["omitted-target", "zero-prefix", "pending-prefix", "wrong-prefix-fence", "different-generation", "partial-call", "missing-prompt"]) await t.test(kind, async () => {
        const changedIndex = structuredClone(index), changedCheckpoint = structuredClone(checkpoint);
        const row = changedIndex.sources[f.sourceId];
        if (kind === "omitted-target" || kind === "zero-prefix") {
            row.cursor.droppedBytes = kind === "zero-prefix" ? 0 : target.sourceEvent.offset + 1;
            row.backfill.omittedBytes = row.cursor.droppedBytes;
        }
        if (kind === "pending-prefix") { row.backfill.phase = "reading"; row.backfillPending = true; }
        if (kind === "wrong-prefix-fence") row.backfill.omittedBytes++;
        if (kind === "different-generation") row.cursor.identity = "different-source-generation";
        changedCheckpoint.cursor = structuredClone(row.cursor);
        if (kind === "partial-call") changedCheckpoint.events.unshift(structuredClone(f.events.find(event => event.id === target.call.startEventId)));
        if (kind === "missing-prompt") changedCheckpoint.events = changedCheckpoint.events.filter(event => event.id !== target.prompt.sourceEventId);
        await atomicJson(f.indexFile, changedIndex); await atomicJson(f.checkpointFile, changedCheckpoint);
        f.plan.source.indexSha256 = hash(await readFile(f.indexFile));
        f.plan.targets[0].checkpointContextSha256 = digest(changedCheckpoint);
        for (const file of [f.indexFile, f.checkpointFile]) f.plan.preservedFiles.find(pin => pin.path === path.relative(f.context.dataDir, file)).sha256 = hash(await readFile(file));
        await f.reseal();
        const before = await inventory(f.context.dataDir);
        await assert.rejects(runTailRetrieveDiagnosticMaintenance({ ...f.options, mode: "prepare" }));
        assert.deepEqual(await inventory(f.context.dataDir), before);
        await assert.rejects(readFile(f.options.journalFile), { code: "ENOENT" });
        await writeFile(f.indexFile, indexBytes); await writeFile(f.checkpointFile, checkpointBytes);
        Object.assign(f.plan, structuredClone(originalPlan)); await f.reseal();
    });
    assert.deepEqual(await inventory(f.context.dataDir), preserved);
    const prepared = spawnSync(process.execPath, cli({ ...f.options, mode: "prepare" }, "scripts\\maintain-tail-retrieve-diagnostic.mjs"),
        { cwd: root, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(await inventory(f.context.dataDir), preserved);
    const options = { ...f.options, mode: "apply", reviewSha256: JSON.parse(prepared.stdout).reviewSha256 };
    const url = pathToFileURL(path.join(root, "lib", "failure-evidence-maintenance.mjs")).href;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { runTailRetrieveDiagnosticMaintenance } from ${JSON.stringify(url)};
        await runTailRetrieveDiagnosticMaintenance(${JSON.stringify(options)}, { onStep(phase) { if (phase === "snapshot-staged") process.exit(77); } });
    `], { cwd: root, encoding: "utf8" });
    assert.equal(crashed.status, 77, crashed.stderr);
    const applied = await runTailRetrieveDiagnosticMaintenance(options);
    assert.equal(applied.revision, f.state.revision + 1);
    const state = await loadBoardState(f.context), expected = structuredClone(f.state.evidence);
    expected.find(record => record.scenarioId === target.scenarioId).toolCalls[0].failureEvidence.diagnostic = f.correct.failureEvidence.diagnostic;
    assert.deepEqual(state.evidence, expected);
    assert.equal(maintenanceStateGuard(state), maintenanceStateGuard(f.state));
    assert.deepEqual(await readFile(f.indexFile), indexBytes);
    assert.deepEqual(await readFile(f.checkpointFile), checkpointBytes);
    for (const pin of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.context.dataDir, pin.path))), pin.sha256, pin.path);
    const journal = await readJson(f.options.journalFile);
    assert.equal(journal.core.checkpoints[0].beforeSha256, journal.core.checkpoints[0].afterSha256);
    assert.equal((await runTailRetrieveDiagnosticMaintenance(options)).alreadyCommitted, true);
    const call = state.evidence.find(record => record.scenarioId === target.scenarioId).toolCalls[0];
    assert.equal(createRecordedResults().failureReason(call), "Recorded error: " + retrieveMessage);
    assert.equal(Object.hasOwn(call, "resultEvidence"), false);
    await f.restart();
    const at = Date.now() - 1000, append = [
        { id: "tail-after-repair-prompt", type: "user.message", timestamp: new Date(at).toISOString(), data: { content: "Later invented tail activity." } },
        { id: "tail-after-repair-start", type: "tool.execution_start", timestamp: new Date(at + 1).toISOString(),
            data: { toolCallId: "tail-after-repair-call", toolName: "workiq-retrieve", arguments: { query: "Invented follow-on." } } },
        { id: "tail-after-repair-end", type: "tool.execution_complete", timestamp: new Date(at + 2).toISOString(), data: { toolCallId: "tail-after-repair-call", success: true } },
    ].map(event => JSON.stringify(event) + "\n").join("");
    await appendFile(f.files[0], append); await f.collector.collectNow();
    assert.equal((await f.collector.status()).metrics.lastBytesRead, Buffer.byteLength(append));
    const later = await loadBoardState(f.context);
    assert.deepEqual(later.evidence.find(record => record.scenarioId === target.scenarioId).toolCalls, [call]);
    assert.equal((await readJson(f.indexFile)).sources[f.sourceId].backfill.boundaryGap, true);
    assert.ok(!(await readJson(f.checkpointFile)).events.some(event => event.id === target.call.completionEventId || event.id === target.call.startEventId));
    await f.restart();
    assert.deepEqual((await loadBoardState(f.context)).evidence.find(record => record.scenarioId === target.scenarioId).toolCalls, [call]);
});
