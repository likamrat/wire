import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile, appendFile, readdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateFixture } from "./helpers.mjs";
import { createCollector, retainEvent } from "../lib/collector.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { hash, atomicJson, readJson, contextFits, TAIL_LIMITS } from "../lib/collector-io.mjs";
import { buildRequestActivity } from "../lib/activity-analytics.mjs";
import { assessmentSource } from "../lib/assessment-read-model.mjs";
import { createExportController } from "../lib/export.mjs";
import { maintenanceStateGuard } from "../lib/historical-maintenance.mjs";
import { runRetainedErrorRepair, retainedErrorTargetKey, inspectRetainedErrorRepair } from "../lib/retained-error-repair.mjs";
import { validateCollectorIndex, withCollectorIndexBarrier } from "../lib/collector-index.mjs";
import { completionReferenceStore, hydrateCheckpointReferences, validateReferenceCheckpoint, COMPLETION_REFERENCE_LIMITS } from "../lib/checkpoint-references.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createRecollectionController } from "../lib/recollection.mjs";
import { validateBackfillCheckpoint } from "../lib/collector-backfill.mjs";
import { startServer } from "../lib/server.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digest = value => hash(JSON.stringify(value));
const oldFailure = () => ({ version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: null });
const envelope = value => "MCP server 'workiq': " + JSON.stringify(value);
const errorCarriers = call => ({ failureEvidence: call.failureEvidence, resultEvidence: call.resultEvidence, apiResults: call.apiResults });
const summarize = records => {
    const activity = buildRequestActivity(records);
    return { toolCalls: activity.tool.length, failedCalls: activity.tool.filter(row => row.outcome === "failure").length,
        returnedEntries: activity["reported-api"].length };
};
async function sourceManifest(directory) {
    const files = [];
    for (const folder of ["lib", "web", "scripts"]) for (const name of (await readdir(path.join(root, folder))).sort()) {
        if (name.endsWith(".mjs")) files.push({ path: path.join(folder, name), sha256: hash(await readFile(path.join(root, folder, name))) });
    }
    const sourceIdentity = digest(files), file = path.join(directory, "source.json");
    await writeFile(file, JSON.stringify({ root, files, sourceIdentity }));
    return { sourceManifestFile: file, sourceIdentity };
}
async function fixture(t, { formats = ["json"] } = {}) {
    const owned = await privateFixture(t, []);
    const appDbPath = path.join(owned.root, "data.db"), sessionRoot = path.join(owned.root, "session-state");
    const sources = [randomUUID(), randomUUID()], files = [], originals = new Map(), pins = new Map(), starts = new Map();
    const db = new DatabaseSync(appDbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    for (const source of sources) db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(source, "Invented retained source", "chat", null, "local");
    db.close();
    const now = Date.now(), old = now - 45 * 86400000, recent = now - 86400000;
    const event = (id, type, timestamp, data) => ({ id, type, timestamp: new Date(timestamp).toISOString(), data });
    const messages = new Map();
    for (let n = 0; n < 30; n++) {
        let tool = "workiq-retrieve", message = `The invented operation ${n} was rejected.`;
        if (n < 3) message = envelope({ "application/vnd.ms-workiq.retrieval": {
            markdown: "", retrievalHits: [], resultCount: 0, stoppedReason: "error",
        } });
        else if (n === 3) { tool = "workiq-fetch"; message = "The invented service rejected the operation. " + "Additional recorded explanation. ".repeat(20); }
        else if ([5, 6, 7].includes(n)) { tool = "workiq-fetch"; message = envelope({ results: [
            { statusCode: 400, error: { code: "BadRequest", message: `Invented returned error ${n}.` } },
        ] }); }
        else if (n >= 28) { tool = "workiq-ask"; message = envelope({ response: null, errorCode: "PolicyUnavailable", error: message }); }
        messages.set(n, { tool, message });
    }
    function legacy(events) {
        return events.map(event => retainEvent(event, { credentialExclusions: 0 })).filter(Boolean).map(event => {
            if (event.type !== "tool.execution_complete" || !event.data.toolCallId.startsWith("repair-")) return event;
            const copy = structuredClone(event);
            copy.data.wireFailureEvidence = oldFailure();
            delete copy.data.wireResultEvidence;
            copy.data.result.structuredContent.results = [];
            return copy;
        });
    }
    const eventSets = [];
    for (const [sourceIndex, source] of sources.entries()) {
        const events = [event("startup-" + sourceIndex, "session.start", old - 1000, { sessionId: source, version: 1 })];
        for (let n = 0; n < 30; n++) {
            if (([0, 1, 3].includes(n) ? 0 : 1) !== sourceIndex) continue;
            const { tool, message } = messages.get(n), at = (n < 25 ? old : recent) + n * 100;
            const args = tool === "workiq-fetch" ? { entityUrls: ["/me/messages"] }
                : tool === "workiq-ask" ? { question: "Invented question." } : { query: "Invented query." };
            const rows = [
                event("prompt-" + n, "user.message", at, { content: `Invented retained request ${n}.` }),
                event("start-" + n, "tool.execution_start", at + 1, { toolCallId: "repair-" + n, toolName: tool, arguments: args }),
                event("end-" + n, "tool.execution_complete", at + 50, { toolCallId: "repair-" + n, success: false, error: { code: "failure", message } }),
            ];
            events.push(...rows); originals.set("repair-" + n, { source, events: rows });
        }
        if (sourceIndex === 0) {
            const filler = event("filler-start", "tool.execution_start", recent + 10000,
                { toolCallId: "unselected-pending", toolName: "workiq-retrieve", arguments: { query: "" } });
            events.push(filler);
            const compact = legacy(events), pending = compact.findLast(row => row.type === "user.message");
            const ordinaryBytes = Buffer.byteLength(JSON.stringify(compact.filter(row => row !== pending)));
            filler.data.arguments.query = "x".repeat(TAIL_LIMITS.maxContextBytes - 160 - ordinaryBytes);
            assert.ok(contextFits(legacy(events)));
        }
        const file = path.join(sessionRoot, source, "events.jsonl");
        await mkdir(path.dirname(file), { recursive: true });
        const lines = events.map(row => JSON.stringify(row) + "\n");
        await writeFile(file, lines.join(""));
        let offset = 0;
        for (const [position, row] of events.entries()) {
            if (row.type === "tool.execution_start") starts.set(row.data.toolCallId, {
                offset, bytes: Buffer.byteLength(lines[position]), sha256: hash(lines[position]),
            });
            if (row.type === "tool.execution_complete") pins.set(row.data.toolCallId, {
                offset, bytes: Buffer.byteLength(lines[position]), sha256: hash(lines[position]),
                startupBytes: Buffer.byteLength(lines[0]), startupSha256: hash(lines[0]),
            });
            offset += Buffer.byteLength(lines[position]);
        }
        files.push(file); eventSets.push(events);
    }
    let collector = await createCollector(owned.context, { timers: false });
    const preferences = { appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 90, pollSeconds: 5 };
    await collector.configure(preferences); await collector.collectNow();
    const complete = await loadBoardState(owned.context), good = structuredClone(complete.evidence);
    await collector.configure({ ...preferences, windowDays: 30 }); await collector.collectNow();
    const indexFile = path.join(owned.context.dataDir, "collector", "index.json"), index = await readJson(indexFile), checkpointFiles = [];
    for (const [i, source] of sources.entries()) {
        const file = path.join(owned.context.dataDir, "collector", index.fingerprint, source + ".json");
        const saved = await readJson(file);
        saved.events = legacy(eventSets[i]);
        await atomicJson(file, saved); checkpointFiles.push(file);
    }
    const damaged = good.map(record => ({ ...record, toolCalls: record.toolCalls.map(call => call.toolCallId.startsWith("repair-")
        ? (() => { const { resultEvidence, ...rest } = call; return { ...rest, failureEvidence: oldFailure(), apiResults: [] }; })() : call) }));
    const aliasSource = damaged.find(record => record.toolCalls.some(call => call.toolCallId === "repair-4"));
    damaged.push({ ...structuredClone(aliasSource), scenarioId: "legacy-invented-alias", isLegacy: true,
        toolCalls: [structuredClone(aliasSource.toolCalls.find(call => call.toolCallId === "repair-4"))] });
    const live = await loadBoardState(owned.context);
    await replaceEvidence(owned.context, () => ({ records: damaged, importCoverage: live.importCoverage }));
    const reports = createExportController(owned.context), beforeReport = await loadBoardState(owned.context);
    const preview = await reports.preview("owned-repair-test", undefined, { saveMode: "local", promptMode: "none", formats,
        reportFocus: { version: 1, preset: "all", outcome: "all", services: [] } }, { kind: "all", revision: beforeReport.revision });
    await reports.confirm("owned-repair-test", preview.previewId, true, undefined,
        { localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false } });
    const config = collector.approvedRecollectionSource();
    await collector.close();
    const state = await loadBoardState(owned.context), targets = [];
    for (const [callId, original] of originals) {
        const canonical = good.flatMap(record => record.toolCalls).find(call => call.toolCallId === callId);
        const aliases = state.evidence.filter(record => record.sourceSessionId === original.source && record.toolCalls.some(call => call.toolCallId === callId))
            .map(record => ({ scenarioId: record.scenarioId, recordSha256: digest(record), prompt: {
                sourceEventId: record.userPrompt.sourceEventId, sourceTimestamp: record.userPrompt.sourceTimestamp, textSha256: hash(record.userPrompt.text),
            } }));
        targets.push({ sourceSessionId: original.source,
            call: Object.fromEntries(["tool", "toolCallId", "startEventId", "startedAt", "completionEventId", "completedAt"].map(key => [key, canonical[key]])),
            aliases, sourceEvent: pins.get(callId), sourceStart: starts.get(callId),
            checkpointContextSha256: digest(await readJson(checkpointFiles[sources.indexOf(original.source)])),
            proposedCarriersSha256: digest(errorCarriers(canonical)) });
    }
    const expected = structuredClone(state.evidence);
    for (const record of expected) for (const call of record.toolCalls) {
        const original = good.flatMap(record => record.toolCalls).find(value => value.toolCallId === call.toolCallId);
        if (call.toolCallId.startsWith("repair-")) Object.assign(call, structuredClone(errorCarriers(original)));
    }
    const currentIndex = await readJson(indexFile);
    const plan = {
        schemaVersion: 2, operationId: randomUUID(),
        attestation: { packetSha256: hash("fixture-only repair decision"), recheckSha256: hash("fixture-only source proof"),
            stoppedRuntimePid: 2147483000, recorderIdle: true, evaluatorIdle: true, noDispatchVerified: true },
        source: { configSha256: hash(await readFile(path.join(owned.context.dataDir, "collector", "config.json"))),
            indexSha256: hash(await readFile(indexFile)), ...assessmentSource(state, config), windowDays: 30 },
        stateGuardSha256: maintenanceStateGuard(state),
        preservedFiles: await Promise.all(state.exports.flatMap(entry => Object.values(entry.files)).map(async file =>
            ({ path: path.relative(owned.context.dataDir, file), sha256: hash(await readFile(file)) }))),
        targets, retainedErrorRepair: { version: 1, occurrences: 31,
            olderRetainedTargets: targets.filter(target => Number(target.call.toolCallId.slice(7)) < 25).map(retainedErrorTargetKey),
            referenceTargets: targets.filter(target => ["repair-0", "repair-1", "repair-3"].includes(target.call.toolCallId)).map(retainedErrorTargetKey),
            readableTargets: targets.filter(target => Number(target.call.toolCallId.slice(7)) >= 3).map(retainedErrorTargetKey),
            noCauseTargets: targets.filter(target => Number(target.call.toolCallId.slice(7)) < 3).map(retainedErrorTargetKey),
            before: summarize(state.evidence), after: summarize(expected) },
    };
    const options = { dataDir: owned.context.dataDir, planFile: path.join(owned.root, "plan.json"),
        journalFile: path.join(owned.root, "journal.json"), ...await sourceManifest(owned.root) };
    const reseal = async () => { await writeFile(options.planFile, JSON.stringify(plan)); options.planSha256 = hash(await readFile(options.planFile)); };
    await reseal();
    return { ...owned, state, expected, plan, options, reseal, sources, files, indexFile, index: currentIndex, checkpointFiles, config, originals,
        async restart() { collector = await createCollector(owned.context, { timers: false }); return collector; },
        get collector() { return collector; } };
}

test("operator CLI uses the same sealed policy and emits receipts without diagnostic prose", async t => {
    const f = await fixture(t);
    const run = (mode, review) => spawnSync(process.execPath, [path.join(root, "scripts", "maintain-retained-errors.mjs"),
        "--mode", mode, "--data-dir", f.options.dataDir, "--plan", f.options.planFile, "--plan-sha256", f.options.planSha256,
        "--journal", f.options.journalFile, "--source-manifest", f.options.sourceManifestFile, "--source-identity", f.options.sourceIdentity,
        ...(review ? ["--review-sha256", review] : [])], { encoding: "utf8", timeout: 30000 });
    const prepared = run("prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    const receipt = JSON.parse(prepared.stdout);
    assert.equal(receipt.status, "prepared");
    const applied = run("apply", receipt.reviewSha256);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).status, "complete");
    assert.doesNotMatch(prepared.stdout + applied.stdout + prepared.stderr + applied.stderr, /invented operation|Additional recorded explanation/);
    assert.deepEqual((await loadBoardState(f.context)).evidence, f.expected);
});

test("full retained repair seals aliases and older targets, fits references, survives restart and later append", { timeout: 60000 }, async t => {
    const f = await fixture(t, { formats: ["html", "pdf", "json", "markdown"] }), checkpoints = await Promise.all(f.checkpointFiles.map(readJson));
    const sourceBytes = await Promise.all(f.files.map(file => readFile(file)));
    assert.equal(f.index.schemaVersion, 3, "Ordinary startup/collection do not install the new fence.");
    assert.ok(checkpoints.every(checkpoint => checkpoint.schemaVersion === 1));
    const inspection = await inspectRetainedErrorRepair({ dataDir: f.context.dataDir,
        targets: f.plan.targets, retainedErrorRepair: f.plan.retainedErrorRepair });
    assert.equal(inspection.prepared, false);
    assert.equal(inspection.authorized, false);
    assert.equal(inspection.canonicalCalls, 30);
    assert.equal(inspection.storedOccurrences, 31);
    assert.equal(inspection.readableRecoveries, 27);
    assert.equal(inspection.noCauseCorrections, 3);
    assert.equal(inspection.checkpoints.reduce((sum, value) => sum + value.referenceCount, 0), 3);
    await assert.rejects(readFile(f.options.journalFile), { code: "ENOENT" });
    assert.deepEqual(await readJson(f.indexFile), f.index);
    const prepared = await runRetainedErrorRepair({ ...f.options, mode: "prepare" });
    const journal = await readJson(f.options.journalFile);
    assert.equal(journal.core.snapshot.afterFile, inspection.proposedEvidenceFile);
    assert.equal(journal.core.index.afterSha256, inspection.indexAfterSha256);
    assert.deepEqual((await loadBoardState(f.context)).evidence, f.state.evidence);
    assert.deepEqual(await readJson(f.indexFile), f.index, "Prepare does not install a compatibility fence.");
    const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
    const applied = await runRetainedErrorRepair(options);
    assert.equal(applied.status, "complete");
    const after = await loadBoardState(f.context), index = await readJson(f.indexFile);
    assert.deepEqual(after.evidence, f.expected);
    assert.equal(after.revision, f.state.revision + 1);
    assert.equal(index.schemaVersion, 4);
    assert.equal(index.completionReferenceMaintenance, undefined);
    assert.deepEqual(index.sources, f.index.sources);
    assert.deepEqual(summarize(after.evidence), { ...f.plan.retainedErrorRepair.before,
        returnedEntries: f.plan.retainedErrorRepair.before.returnedEntries + 3 });
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.context.dataDir, file.path))), file.sha256);
    const compact = await readJson(f.checkpointFiles[0]);
    assert.equal(compact.schemaVersion, 2);
    assert.equal(compact.events.filter(event => event.data?.wireCompletionRef === 1).length, 3);
    assert.ok(contextFits(compact.events));
    assert.deepEqual(compact.cursor, checkpoints[0].cursor);
    const nonTargets = events => events.filter(event => !["end-0", "end-1", "end-3"].includes(event.id));
    assert.deepEqual(nonTargets(compact.events), nonTargets(checkpoints[0].events));
    const projected = hydrateCheckpointReferences(compact, { state: after, dataDir: f.context.dataDir, index, sourceSessionId: f.sources[0] });
    assert.equal(projected.find(event => event.id === "end-3").data.wireFailureEvidence.diagnostic.message,
        f.expected.flatMap(record => record.toolCalls).find(call => call.toolCallId === "repair-3").failureEvidence.diagnostic.message);
    assert.equal((await runRetainedErrorRepair(options)).alreadyCommitted, true);
    assert.equal((await loadBoardState(f.context)).revision, after.revision);
    await f.restart();
    assert.deepEqual(await readJson(f.indexFile), index, "Startup never migrates or advances the fence.");
    await appendFile(f.files[0], JSON.stringify({ id: "later-info", type: "session.info", timestamp: new Date().toISOString(), data: { message: "Invented later activity." } }) + "\n");
    await f.collector.collectNow();
    const later = await loadBoardState(f.context);
    for (const record of f.expected) for (const call of record.toolCalls.filter(call => call.toolCallId.startsWith("repair-"))) {
        const actual = later.evidence.find(value => value.scenarioId === record.scenarioId).toolCalls.find(value => value.toolCallId === call.toolCallId);
        assert.deepEqual(errorCarriers(actual), errorCarriers(call));
    }
    const laterCompact = await readJson(f.checkpointFiles[0]);
    assert.ok(contextFits(laterCompact.events));
    assert.deepEqual(nonTargets(laterCompact.events), nonTargets(compact.events), "Hydration does not cause unrelated context eviction.");
    assert.equal(laterCompact.events.filter(event => event.data?.wireCompletionRef === 1).length, 3);
    assert.equal((await readJson(f.indexFile)).schemaVersion, 4);
    assert.deepEqual(await readFile(f.files[1]), sourceBytes[1]);
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.context.dataDir, file.path))), file.sha256);
});

test("reference fence, checkpoints and evidence publication resume only their sealed operation", { timeout: 120000 }, async t => {
    for (const boundary of ["compatibility-fence", "checkpoint-1", "checkpoint-2", "snapshot-staged", "board-saved", "complete"]) {
        await t.test(boundary, async t => {
            const f = await fixture(t), prepared = await runRetainedErrorRepair({ ...f.options, mode: "prepare" });
            const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
            await assert.rejects(runRetainedErrorRepair(options, { onStep(phase) { if (phase === boundary) throw Error("owned interruption"); } }), /owned interruption/);
            await assert.rejects(createCollector(f.context, { timers: false }), /unfinished/);
            await assert.rejects(runRetainedErrorRepair({ ...f.options, mode: "prepare" }), /existing maintenance journal/);
            const resumed = await runRetainedErrorRepair(options);
            assert.equal(resumed.status, "complete");
            const state = await loadBoardState(f.context);
            assert.deepEqual(state.evidence, f.expected);
            assert.equal(state.revision, f.state.revision + 1);
            assert.equal((await readJson(f.indexFile)).completionReferenceMaintenance, undefined);
            await f.restart(); await f.collector.collectNow();
            for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.context.dataDir, file.path))), file.sha256);
        });

    }
});

test("abrupt process exits leave a fenced same-journal recovery, including source-free finalization of sealed postimages", { timeout: 90000 }, async t => {
    for (const boundary of ["compatibility-fence", "checkpoint-1", "snapshot-staged", "board-saved"]) {
        await t.test(boundary, async t => {
            const f = await fixture(t), prepared = await runRetainedErrorRepair({ ...f.options, mode: "prepare" });
            const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
            const script = `import { runRetainedErrorRepair } from ${JSON.stringify(pathToFileURL(path.join(root, "lib", "retained-error-repair.mjs")).href)};
                await runRetainedErrorRepair(JSON.parse(process.argv[1]), { onStep(phase) { if (phase === process.argv[2]) process.exit(84); } });`;
            const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(options), boundary],
                { encoding: "utf8", timeout: 30000 });
            assert.equal(child.status, 84, child.stderr);
            await assert.rejects(createCollector(f.context, { timers: false }), /unfinished/);
            if (boundary === "board-saved") await rename(f.files[0], f.files[0] + ".unavailable");
            const result = await runRetainedErrorRepair(options);
            assert.equal(result.status, "complete");
            assert.equal((await loadBoardState(f.context)).revision, f.state.revision + 1);
            assert.deepEqual((await loadBoardState(f.context)).evidence, f.expected);
            assert.equal((await readJson(f.indexFile)).completionReferenceMaintenance, undefined);
        });
    }
});

test("reference resolution rejects wrong ownership, missing facts, conflicting aliases and untrusted markers", async t => {
    const f = await fixture(t), prepared = await runRetainedErrorRepair({ ...f.options, mode: "prepare" });
    await runRetainedErrorRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    const state = await loadBoardState(f.context), index = await readJson(f.indexFile), checkpoint = await readJson(f.checkpointFiles[0]);
    const context = { state, dataDir: f.context.dataDir, index, sourceSessionId: f.sources[0] };
    if (process.platform === "win32") assert.equal(completionReferenceStore(state, f.context.dataDir.toUpperCase()), index.completionReferenceStore);
    assert.equal(withCollectorIndexBarrier(index).schemaVersion, 4);
    assert.throws(() => validateCollectorIndex({ ...index, schemaVersion: 3 }), /Unsupported/);
    for (const change of [
        value => { value.completionReferences.store = "0".repeat(64); },
        value => { value.completionReferences.fingerprint = "0".repeat(64); },
        value => { value.completionReferences.sourceIdentity = "different"; },
        value => { value.schemaVersion = 1; },
        value => { value.events.find(event => event.data?.wireCompletionRef).data.wireCompletionRef = 2; },
        value => { value.events.find(event => event.data?.wireCompletionRef).timestamp = new Date().toISOString(); },
    ]) {
        const copy = structuredClone(checkpoint); change(copy);
        assert.throws(() => hydrateCheckpointReferences(copy, context), /reference/i);
    }
    assert.throws(() => hydrateCheckpointReferences(checkpoint, { ...context, dataDir: path.join(f.root, "another-store") }), /reference/i);
    assert.throws(() => hydrateCheckpointReferences(checkpoint, { ...context, records: [] }), /reference/i);
    const conflicted = structuredClone(state.evidence);
    const original = conflicted.find(record => record.toolCalls.some(call => call.toolCallId === "repair-3"));
    conflicted.push({ ...structuredClone(original), scenarioId: "unsealed-conflicting-alias",
        toolCalls: original.toolCalls.map(call => ({ ...call, failureEvidence: oldFailure() })) });
    assert.throws(() => hydrateCheckpointReferences(checkpoint, { ...context, records: conflicted }), /reference/i);
    const source = { id: "source-forgery", type: "tool.execution_complete", timestamp: new Date().toISOString(),
        data: { toolCallId: "forged-call", success: false, wireCompletionRef: 1, error: { code: "failure", message: "Invented source error." } } };
    assert.equal(Object.hasOwn(retainEvent(source, { credentialExclusions: 0 }).data, "wireCompletionRef"), false);
    const missing = structuredClone(checkpoint);
    missing.events = [...Array(COMPLETION_REFERENCE_LIMITS.references + 1)].map((_, i) => ({
        ...checkpoint.events.find(event => event.data?.wireCompletionRef), id: "ref-" + i,
        data: { ...checkpoint.events.find(event => event.data?.wireCompletionRef).data, toolCallId: "ref-" + i },
    }));
    assert.throws(() => validateReferenceCheckpoint(missing, { index, sourceSessionId: f.sources[0] }), /reference/i);
    const oversized = structuredClone(state.evidence);
    const large = oversized.flatMap(record => record.toolCalls).find(call => call.toolCallId === "repair-3");
    large.apiResults = Array.from({ length: 9 }, (_, index) => ({ index, indexKind: "response-array-position",
        statusCode: 403, errorCode: "AccessDenied", evidenceLevel: "intermediary-reported", paginationPresent: null,
        errorDiagnostic: { version: 1, source: "result-error", status: "recorded", code: "AccessDenied", message: "x".repeat(8192) } }));
    assert.throws(() => hydrateCheckpointReferences(checkpoint, { ...context, records: oversized }), { code: "CHECKPOINT_REFERENCE_LIMIT" });
});

test("retained-only scope refuses drift, missing aliases, needless references and unapproved older targets before writes", { timeout: 90000 }, async t => {
    for (const change of ["older-window", "alias", "unnecessary-reference", "missing-reference", "source-start", "counts", "record", "cursor-bound"]) {
        await t.test(change, async t => {
            const f = await fixture(t);
            if (change === "older-window") f.plan.retainedErrorRepair.olderRetainedTargets = [];
            if (change === "alias") { f.plan.targets.find(target => target.aliases.length === 2).aliases.pop(); f.plan.retainedErrorRepair.occurrences--; }
            if (change === "unnecessary-reference") f.plan.retainedErrorRepair.referenceTargets.push(retainedErrorTargetKey(f.plan.targets.find(target => target.call.toolCallId === "repair-4")));
            if (change === "missing-reference") f.plan.retainedErrorRepair.referenceTargets.pop();
            if (change === "source-start") f.plan.targets[0].sourceStart.sha256 = "0".repeat(64);
            if (change === "counts") f.plan.retainedErrorRepair.after.returnedEntries++;
            if (change === "record") f.plan.targets[0].aliases[0].recordSha256 = "0".repeat(64);
            if (change === "cursor-bound") {
                const index = await readJson(f.indexFile), checkpoint = await readJson(f.checkpointFiles[0]);
                index.sources[f.sources[0]].cursor.droppedBytes = -1;
                checkpoint.cursor.droppedBytes = -1;
                await atomicJson(f.indexFile, index); await atomicJson(f.checkpointFiles[0], checkpoint);
                f.plan.source.indexSha256 = hash(await readFile(f.indexFile));
                for (const target of f.plan.targets.filter(target => target.sourceSessionId === f.sources[0])) {
                    target.checkpointContextSha256 = digest(checkpoint);
                }
            }
            await f.reseal();
            const before = await loadBoardState(f.context), index = await readFile(f.indexFile);
            const checkpoints = await Promise.all(f.checkpointFiles.map(file => readFile(file)));
            await assert.rejects(runRetainedErrorRepair({ ...f.options, mode: "prepare" }));
            assert.deepEqual(await loadBoardState(f.context), before);
            assert.deepEqual(await readFile(f.indexFile), index);
            for (const [i, file] of f.checkpointFiles.entries()) assert.deepEqual(await readFile(file), checkpoints[i]);
            await assert.rejects(readFile(f.options.journalFile), { code: "ENOENT" });
        });
    }
});

test("ordinary collection refuses a missing canonical dependency without erasing its referenced checkpoint", async t => {
    const f = await fixture(t), prepared = await runRetainedErrorRepair({ ...f.options, mode: "prepare" });
    await runRetainedErrorRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    const state = await loadBoardState(f.context);
    await replaceEvidence(f.context, () => ({ records: state.evidence.map(record => ({
        ...record, toolCalls: record.toolCalls.filter(call => call.toolCallId !== "repair-3"),
    })), importCoverage: state.importCoverage }));
    const before = await readFile(f.checkpointFiles[0]);
    await f.restart(); await f.collector.collectNow();
    assert.equal((await readJson(f.indexFile)).sources[f.sources[0]].errorCode, "CHECKPOINT_REFERENCE_INVALID");
    assert.deepEqual(await readFile(f.checkpointFiles[0]), before);
    assert.ok(!(await loadBoardState(f.context)).evidence.flatMap(record => record.toolCalls).some(call => call.toolCallId === "repair-3"));
});

test("deletion removes reference dependencies; ordinary recollection keeps its approved window and frozen files", async t => {
    const f = await fixture(t), prepared = await runRetainedErrorRepair({ ...f.options, mode: "prepare" });
    await runRetainedErrorRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    const before = await Promise.all(f.checkpointFiles.map(readJson));
    await f.restart();
    const deletion = createDeletionController(f.context, { validateBackfillCheckpoint });
    const review = await deletion.preview("owned-panel", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("owned-panel", { operationId: review.operationId, confirmed: true });
    assert.equal((await loadBoardState(f.context)).evidence.length, 0);
    const checkpoint = await readJson(f.checkpointFiles[0]);
    assert.equal(checkpoint.schemaVersion, 2);
    assert.equal(checkpoint.events.some(event => event.data?.wireCompletionRef), false);
    assert.deepEqual(checkpoint.cursor, before[0].cursor);
    await f.collector.collectNow();
    assert.equal((await loadBoardState(f.context)).evidence.length, 0);
    const recollection = createRecollectionController(f.context);
    const oldDay = f.plan.targets.find(target => target.call.toolCallId === "repair-0").call.startedAt.slice(0, 10);
    await assert.rejects(recollection.preview("owned-panel", { sourceSessionIds: [f.sources[0]], from: oldDay, to: oldDay,
        restorePrompts: false, timeContext: { timeZone: "UTC", locale: "en-US" } }), /approved collection window/);
    const day = f.plan.targets.find(target => target.call.toolCallId === "repair-28").call.startedAt.slice(0, 10);
    const selected = await recollection.preview("owned-panel", { sourceSessionIds: [f.sources[1]], from: day, to: day,
        restorePrompts: false, timeContext: { timeZone: "UTC", locale: "en-US" } });
    await recollection.confirm("owned-panel", { operationId: selected.operationId, confirmed: true });
    const restored = (await loadBoardState(f.context)).evidence.flatMap(record => record.toolCalls);
    assert.ok(restored.some(call => call.toolCallId === "repair-28"));
    assert.ok(!restored.some(call => call.toolCallId === "repair-0"));
    await f.collector.close(); await f.restart(); await f.collector.collectNow();
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.context.dataDir, file.path))), file.sha256);
    assert.equal(f.collector.approvedRecollectionSource().windowDays, 30);
});

test("source switching keeps the reader fence and cannot hydrate another source namespace", async t => {
    const f = await fixture(t), prepared = await runRetainedErrorRepair({ ...f.options, mode: "prepare" });
    await runRetainedErrorRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    const original = await readJson(f.checkpointFiles[0]), state = await loadBoardState(f.context);
    const alternate = path.join(f.root, "alternate"), appDbPath = path.join(alternate, "data.db"), sessionRoot = path.join(alternate, "session-state");
    await mkdir(sessionRoot, { recursive: true });
    const db = new DatabaseSync(appDbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.close();
    await f.restart();
    await f.collector.configure({ appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await f.collector.collectNow();
    const index = await readJson(f.indexFile);
    assert.equal(index.schemaVersion, 4);
    assert.throws(() => hydrateCheckpointReferences(original, { state, dataDir: f.context.dataDir, index, sourceSessionId: f.sources[0] }), /reference/i);
    await f.collector.configure({ appDbPath: f.config.appDbPath, sessionRoot: f.config.sessionRoot,
        approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await f.collector.collectNow();
    assert.equal((await readJson(f.indexFile)).schemaVersion, 4);
    assert.equal((await readJson(f.indexFile)).sources[f.sources[0]].error, null);
    assert.deepEqual(await readJson(f.checkpointFiles[0]), original);
});

test("revoked normal HTTP capability cannot acquire or expose referenced completion evidence", async t => {
    const f = await fixture(t), prepared = await runRetainedErrorRepair({ ...f.options, mode: "prepare" });
    await runRetainedErrorRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    const runtime = await startServer(f.context, createExportController(f.context), { port: 0, sourcePolicy: "copilot-only",
        collector: { timers: false }, createAccess: () => createCopilotRuntimeAccess(f.context) });
    try {
        const origin = new URL(runtime.url).origin;
        let capability;
        const post = async (route, input) => {
            const response = await fetch(origin + route, { method: "POST", headers: {
                Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1",
                ...(capability ? { "X-Board-Capability": capability } : {}),
            }, body: JSON.stringify(input) });
            return { status: response.status, body: await response.json() };
        };
        capability = (await post("/api/session", {})).body.capability;
        assert.equal((await post("/api/canvas", { action: "collect_now", input: {} })).status, 200);
        const before = await loadBoardState(f.context), checkpoint = await readFile(f.checkpointFiles[0]);
        assert.equal((await post("/api/session/release", {})).status, 200);
        const refused = await post("/api/canvas", { action: "collect_now", input: {} });
        assert.notEqual(refused.status, 200);
        assert.doesNotMatch(JSON.stringify(refused.body), /invented operation|Additional recorded explanation|PolicyUnavailable/);
        assert.deepEqual((await loadBoardState(f.context)).evidence, before.evidence);
        assert.deepEqual(await readFile(f.checkpointFiles[0]), checkpoint);
    } finally { await runtime.close(); }
});
