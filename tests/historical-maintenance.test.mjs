import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, appendFile, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { atomicJson, readJson } from "../lib/collector-io.mjs";
import { createExportController } from "../lib/export.mjs";
import { assessmentSource } from "../lib/assessment-read-model.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { evaluationRecordFingerprint } from "../lib/evaluation-fingerprint.mjs";
import { runHistoricalMaintenance, maintenanceStateGuard } from "../lib/historical-maintenance.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";
import { createCollector } from "../lib/collector.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { defaultModelEvaluationState } from "../lib/model-evaluation-state.mjs";
import { AUTOMATIC_SCORE_METHOD } from "../lib/automatic-score-policy.mjs";
import { eventIdentity } from "../lib/deletion-identities.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");

async function inventory(directory) {
    const files = [];
    async function visit(relativeDirectory) {
        for (const entry of (await readdir(path.join(directory, relativeDirectory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if ([".git", "node_modules"].includes(entry.name)) continue;
            const relative = path.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) await visit(relative);
            else files.push({ path: relative, sha256: hash(await readFile(path.join(directory, relative))) });
        }
    }
    await visit("");
    return files;
}
async function sourceManifest() {
    const files = await inventory(root);
    return { root, files, sourceIdentity: hash(files) };
}

async function fixture(t) {
    const f = await recollectionFixture(t);
    for (const file of f.files) {
        const original = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
        for (const event of original) {
            if (event.type === "tool.execution_complete") Object.assign(event.data, {
                success: false,
                error: { code: "failure", message: event.data.toolCallId === "selected-A"
                    ? "Synthetic tool: MCP error -32001: Request timed out" : "SYNTHETIC_PRIVATE_ERROR_PROSE" },
                result: { structuredContent: { results: [{ statusCode: 403, error: { code: "Forbidden" } }, { statusCode: 503 }] } },
            });
            if (event.type === "user.message") Object.assign(event.data, event.id === "prompt-selected-A" ? {
                messageId: randomUUID(), agentMode: "autopilot", delivery: "idle",
                transformedContent: `<current_datetime>${event.timestamp}</current_datetime>\n\n${event.data.content}\n\n<system_reminder>\nThe user mentioned images and they have been attached to this message in the order they were mentioned.\n</system_reminder>`,
            } : { source: "system", transformedContent: "Synthetic system context" });
        }
        await writeFile(file, original.map(event => JSON.stringify(event) + "\n").join(""));
    }
    await f.collector.collectNow();
    const config = f.collector.approvedRecollectionSource();
    const indexFile = path.join(f.context.dataDir, "collector", "index.json"), index = await readJson(indexFile);
    const good = await loadBoardState(f.context);
    const proposals = good.evidence.filter(record => ["selected-A", "outside-C"].includes(record.toolCalls[0]?.toolCallId)).map(record => ({
        scenarioId: record.scenarioId, sourceSessionId: record.sourceSessionId,
        prompt: {
            sourceEventId: record.userPrompt.sourceEventId, sourceTimestamp: record.userPrompt.sourceTimestamp,
            textSha256: hash(record.userPrompt.text), authorship: record.userPrompt.authorship, authorshipVersion: promptAuthorship.version,
        },
        call: Object.fromEntries(["toolCallId", "startEventId", "startedAt", "completionEventId", "completedAt", "failureEvidence"]
            .map(key => [key, record.toolCalls[0][key]])),
    }));
    const checkpointFile = path.join(f.context.dataDir, "collector", index.fingerprint, proposals[0].sourceSessionId + ".json");
    for (const source of [f.sourceId, f.otherSourceId]) {
        const file = path.join(f.context.dataDir, "collector", index.fingerprint, source + ".json");
        const checkpoint = await readJson(file);
        for (const event of checkpoint.events) {
            if (proposals.some(target => target.call.completionEventId === event.id)) delete event.data.wireFailureEvidence;
            if (proposals.some(target => target.prompt.sourceEventId === event.id)) Object.assign(event.data, {
                wirePromptAuthorship: { actor: "unknown", basis: "invalid-source" }, wirePromptAuthorshipVersion: 3,
            });
        }
        await atomicJson(file, checkpoint);
    }
    await replaceEvidence(f.context, records => ({
        records: records.map(record => !proposals.some(target => target.scenarioId === record.scenarioId) ? record : {
            ...record, graphActivities: record.graphActivities ?? [],
            userPrompt: { ...record.userPrompt, authorship: { actor: "unknown", basis: "invalid-source" }, authorshipVersion: 3 },
            toolCalls: record.toolCalls.map(call => { const copy = { ...call }; delete copy.failureEvidence; return copy; }),
        }), importCoverage: good.importCoverage,
    }));
    const reports = createExportController(f.context), reportState = await loadBoardState(f.context);
    const preview = await reports.preview("synthetic", undefined, { promptMode: "none", formats: ["json"] }, { kind: "all", revision: reportState.revision });
    await reports.review("synthetic", preview.previewId, true);
    await reports.confirm("synthetic", preview.previewId, true);
    const state = await loadBoardState(f.context);
    const preservedFiles = [];
    for (const entry of state.exports) for (const file of Object.values(entry.files)) {
        preservedFiles.push({ path: path.relative(f.context.dataDir, file), sha256: hash(await readFile(file)) });
    }
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    assert.equal(exited.status, 0);
    const plan = {
        schemaVersion: 1, operationId: randomUUID(),
        attestation: {
            packetSha256: hash("synthetic sealed packet"), recheckSha256: hash("synthetic consumed predicate proof"),
            stoppedRuntimePid: exited.pid, recorderIdle: true, evaluatorIdle: true, noDispatchVerified: true,
        },
        source: {
            configSha256: hash(await readFile(path.join(f.context.dataDir, "collector", "config.json"))),
            indexSha256: hash(await readFile(indexFile)),
            ...assessmentSource(state, config), windowDays: config.windowDays,
        },
        stateGuardSha256: maintenanceStateGuard(state), preservedFiles,
        targets: proposals.map(proposal => ({ ...proposal, recordSha256: hash(state.evidence.find(row => row.scenarioId === proposal.scenarioId)) })),
    };
    const planFile = path.join(f.root, "plan.json"), journalFile = path.join(f.root, "journal.json");
    await writeFile(planFile, JSON.stringify(plan));
    const manifest = await sourceManifest(), sourceManifestFile = path.join(f.root, "source-manifest.json");
    await writeFile(sourceManifestFile, JSON.stringify(manifest));
    const options = { dataDir: f.context.dataDir, planFile, planSha256: hash(await readFile(planFile)),
        journalFile, sourceManifestFile, sourceIdentity: manifest.sourceIdentity };
    await f.stop();
    return { ...f, get collector() { return f.collector; }, get runtime() { return f.runtime; }, plan, options, state, checkpointFile, indexFile,
        async reseal() { await writeFile(planFile, JSON.stringify(plan)); options.planSha256 = hash(await readFile(planFile)); },
    };
}

test("actual maintenance harness publishes only two existing metadata projections and survives append/restart", async t => {
    const f = await fixture(t);
    const indexBefore = await readFile(f.indexFile), checkpointBefore = await readJson(f.checkpointFile);
    const prepared = await runHistoricalMaintenance({ ...f.options, mode: "prepare" });
    assert.equal((await loadBoardState(f.context)).revision, f.state.revision, "Preparation does not publish");
    const applied = await runHistoricalMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    assert.equal(applied.status, "complete");
    const committed = await loadBoardState(f.context);
    assert.equal(committed.revision, f.state.revision + 1);
    assert.equal(committed.evidenceRevision, f.state.evidenceRevision + 1);
    assert.deepEqual(committed.exports, f.state.exports);
    assert.deepEqual(committed.personalEvaluation, f.state.personalEvaluation);
    assert.deepEqual(committed.cards, f.state.cards);
    assert.deepEqual(await readFile(f.indexFile), indexBefore);
    assert.deepEqual((await readJson(f.checkpointFile)).cursor, checkpointBefore.cursor);
    for (const target of f.plan.targets) {
        const record = committed.evidence.find(row => row.scenarioId === target.scenarioId);
        const before = f.state.evidence.find(row => row.scenarioId === target.scenarioId);
        assert.deepEqual(record.userPrompt.authorship, target.prompt.authorship);
        assert.deepEqual(record.toolCalls[0].failureEvidence, target.call.failureEvidence);
        assert.deepEqual(record.toolCalls[0].apiResults, before.toolCalls[0].apiResults);
        assert.notEqual(evaluationRecordFingerprint(record), evaluationRecordFingerprint(before));
    }
    await f.restart();
    const event = JSON.stringify({ id: randomUUID(), type: "assistant.turn_end", timestamp: new Date().toISOString(), data: { turnId: "unrelated" } }) + "\n";
    await appendFile(f.files[0], event);
    await f.collector.collectNow();
    const after = await loadBoardState(f.context);
    for (const target of f.plan.targets) {
        const row = after.evidence.find(row => row.scenarioId === target.scenarioId);
        const published = committed.evidence.find(row => row.scenarioId === target.scenarioId);
        assert.deepEqual(row.userPrompt, published.userPrompt);
        assert.deepEqual(row.toolCalls, published.toolCalls);
    }
    assert.equal((await f.collector.status()).metrics.lastBytesRead, Buffer.byteLength(event), "Only the new synthetic append is consumed");
    await f.restart();
    await appendFile(f.files[0], event.replace(/"id":"[^"]+"/, `"id":"${randomUUID()}"`));
    await f.collector.collectNow();
    for (const target of f.plan.targets) assert.deepEqual((await loadBoardState(f.context)).evidence
        .find(row => row.scenarioId === target.scenarioId).toolCalls, committed.evidence.find(row => row.scenarioId === target.scenarioId).toolCalls);
});

test("a selected record outside the approved collection window is rejected before any checkpoint write", async t => {
    const f = await fixture(t);
    const before = await readFile(f.checkpointFile);
    const old = "2000-01-01T00:00:00.000Z";
    const first = f.plan.targets[0];
    await replaceEvidence(f.context, records => ({
        records: records.map(record => record.scenarioId === first.scenarioId
            ? { ...record, userPrompt: { ...record.userPrompt, sourceTimestamp: old } } : record),
        importCoverage: f.state.importCoverage,
    }));
    const state = await loadBoardState(f.context);
    first.prompt.sourceTimestamp = old;
    first.recordSha256 = hash(state.evidence.find(record => record.scenarioId === first.scenarioId));
    f.plan.stateGuardSha256 = maintenanceStateGuard(state);
    const checkpoint = await readJson(f.checkpointFile);
    checkpoint.events.find(event => event.id === first.prompt.sourceEventId).timestamp = old;
    await atomicJson(f.checkpointFile, checkpoint);
    await f.reseal();
    await assert.rejects(runHistoricalMaintenance({ ...f.options, mode: "prepare" }), /window/);
    assert.notDeepEqual(await readFile(f.checkpointFile), before, "Only the fixture made the earlier synthetic timestamp change");
    assert.deepEqual(await readJson(f.checkpointFile), checkpoint);
});

test("every interrupted actual write boundary resumes remaining postimages without a second board revision", async t => {
    for (const boundary of ["applying", "checkpoint-1", "checkpoint-2", "snapshot-staged", "board-saved", "complete"]) {
        await t.test(boundary, async t => {
            const f = await fixture(t);
            const prepared = await runHistoricalMaintenance({ ...f.options, mode: "prepare" });
            const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
            await assert.rejects(runHistoricalMaintenance(options, { onStep(phase) {
                if (phase === boundary) throw new Error("Synthetic interruption");
            } }), /Synthetic interruption/);
            const resume = await runHistoricalMaintenance(options);
            assert.equal(resume.revision, f.state.revision + 1);
            assert.equal(resume.alreadyCommitted, ["board-saved", "complete"].includes(boundary));
            const durable = await inventory(f.context.dataDir);
            const repeated = await runHistoricalMaintenance(options);
            assert.equal(repeated.alreadyCommitted, true);
            assert.deepEqual(await inventory(f.context.dataDir), durable, "Confirmed writes are not replayed");
            const journal = await readFile(f.options.journalFile, "utf8");
            assert.doesNotMatch(journal, /Synthetic request|PRIVATE_ERROR|transformedContent|apiResults|pseudonymKey|userPrompt/);
            assert.equal(JSON.parse(journal).phase, "complete");
        });
    }
});

function cliOptions(options) {
    return [path.join("scripts", "maintain-historical-metadata.mjs"), "--mode", options.mode,
        "--data-dir", options.dataDir, "--plan", options.planFile, "--plan-sha256", options.planSha256,
        "--journal", options.journalFile, "--source-manifest", options.sourceManifestFile, "--source-identity", options.sourceIdentity,
        ...(options.reviewSha256 ? ["--review-sha256", options.reviewSha256] : [])];
}

test("the CLI uses the same harness and never opens original histories or the source database", async t => {
    const f = await fixture(t);
    const sessionRoot = path.dirname(path.dirname(f.files[0]));
    await rename(f.dbPath, f.dbPath + ".held");
    await rename(sessionRoot, sessionRoot + ".held");
    try {
        const prepared = spawnSync(process.execPath, cliOptions({ ...f.options, mode: "prepare" }), { cwd: root, encoding: "utf8" });
        assert.equal(prepared.status, 0, prepared.stderr);
        const receipt = JSON.parse(prepared.stdout);
        const applied = spawnSync(process.execPath, cliOptions({ ...f.options, mode: "apply", reviewSha256: receipt.reviewSha256 }), { cwd: root, encoding: "utf8" });
        assert.equal(applied.status, 0, applied.stderr);
        assert.equal(JSON.parse(applied.stdout).status, "complete");
    } finally {
        await rename(f.dbPath + ".held", f.dbPath);
        await rename(sessionRoot + ".held", sessionRoot);
    }
});

test("abrupt process exit leaves recoverable checkpoint or board postimages without repeating publication", async t => {
    for (const boundary of ["checkpoint-1", "board-saved"]) {
        await t.test(boundary, async t => {
            const f = await fixture(t);
            const prepared = await runHistoricalMaintenance({ ...f.options, mode: "prepare" });
            const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
            const moduleUrl = pathToFileURL(path.join(root, "lib", "historical-maintenance.mjs")).href;
            const script = `
                import { runHistoricalMaintenance } from ${JSON.stringify(moduleUrl)};
                await runHistoricalMaintenance(${JSON.stringify(options)}, {
                    onStep(phase) { if (phase === ${JSON.stringify(boundary)}) process.exit(77); }
                });
            `;
            const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
            assert.equal(crashed.status, 77, crashed.stderr);
            const lockFile = path.join(f.context.dataDir, "collector.lock");
            assert.equal((await readJson(lockFile)).pid, crashed.pid, "The abrupt exit did not release ownership");
            const journal = await readJson(f.options.journalFile);
            assert.equal(journal.phase, boundary === "checkpoint-1" ? "applying" : "snapshot-staged",
                "The last completed write is deliberately not acknowledged in the journal");
            const resumed = spawnSync(process.execPath, cliOptions(options), { cwd: root, encoding: "utf8" });
            assert.equal(resumed.status, 0, resumed.stderr);
            const receipt = JSON.parse(resumed.stdout);
            assert.equal(receipt.status, "complete");
            assert.equal(receipt.alreadyCommitted, boundary === "board-saved");
            assert.equal(receipt.revision, f.state.revision + 1);
            await assert.rejects(readFile(lockFile), { code: "ENOENT" });
            await assert.rejects(readFile(lockFile + ".recovery"), { code: "ENOENT" });
            const durable = await inventory(f.context.dataDir);
            assert.equal((await runHistoricalMaintenance(options)).alreadyCommitted, true);
            assert.deepEqual(await inventory(f.context.dataDir), durable);
        });
    }
});

test("active normal ownership and same-process or cross-process second writers fail closed", async t => {
    const f = await fixture(t);
    const collector = await createCollector(f.context, { timers: false });
    const before = await inventory(f.context.dataDir);
    await assert.rejects(runHistoricalMaintenance({ ...f.options, mode: "prepare" }), /already owns/);
    assert.deepEqual(await inventory(f.context.dataDir), before);
    await collector.close();
    const prepared = await runHistoricalMaintenance({ ...f.options, mode: "prepare" });
    await runHistoricalMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 }, { async onStep(phase) {
        if (phase !== "applying") return;
        const other = { ...f.options, mode: "prepare", journalFile: path.join(f.root, "second-journal.json") };
        await assert.rejects(runHistoricalMaintenance(other), /already owns/);
        const child = spawnSync(process.execPath, cliOptions(other), { cwd: root, encoding: "utf8" });
        assert.equal(child.status, 1);
        assert.match(child.stderr, /Another runtime owns/);
        await assert.rejects(readFile(other.journalFile), { code: "ENOENT" });
    } });
});

test("sealed preimage drift rejects before writes across every persistence dependency", async t => {
    for (const drift of ["record", "checkpoint", "configuration", "index", "revision", "report", "journal", "source", "snapshot"]) {
        await t.test(drift, async t => {
            const f = await fixture(t);
            const prepared = await runHistoricalMaintenance({ ...f.options, mode: "prepare" });
            if (drift === "record") await replaceEvidence(f.context, records => ({
                records: records.map(record => record.scenarioId === f.plan.targets[0].scenarioId ? { ...record, sourceSessionName: "Changed" } : record),
                importCoverage: f.state.importCoverage,
            }));
            if (drift === "checkpoint") await appendFile(f.checkpointFile, " ");
            if (drift === "configuration") await appendFile(path.join(f.context.dataDir, "collector", "config.json"), " ");
            if (drift === "index") await appendFile(f.indexFile, " ");
            if (drift === "revision") await updateBoardState(f.context, () => {});
            if (drift === "report") await appendFile(path.join(f.context.dataDir, f.plan.preservedFiles[0].path), " ");
            if (drift === "journal") {
                const journal = await readJson(f.options.journalFile);
                journal.core.state.afterRevision++;
                await atomicJson(f.options.journalFile, journal);
            }
            if (drift === "source") {
                const manifest = await readJson(f.options.sourceManifestFile);
                manifest.files[0].sha256 = "0".repeat(64);
                await atomicJson(f.options.sourceManifestFile, manifest);
            }
            if (drift === "snapshot") {
                const journal = await readJson(f.options.journalFile);
                await writeFile(path.join(f.context.dataDir, "private-evidence", journal.core.snapshot.afterFile), "CONFLICTING_SYNTHETIC_SNAPSHOT");
            }
            const before = await inventory(f.context.dataDir), journalBefore = await readFile(f.options.journalFile);
            await assert.rejects(runHistoricalMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 }));
            assert.deepEqual(await inventory(f.context.dataDir), before);
            assert.deepEqual(await readFile(f.options.journalFile), journalBefore);
        });
    }
});

test("missing stores are never initialized and missing retained events are never recreated", async t => {
    await t.test("missing board", async t => {
        const f = await fixture(t);
        await unlink(path.join(f.context.dataDir, `${BOARD_ID}.state.json`));
        const before = await inventory(f.context.dataDir);
        await assert.rejects(runHistoricalMaintenance({ ...f.options, mode: "prepare" }), { code: "ENOENT" });
        assert.deepEqual(await inventory(f.context.dataDir), before);
    });
    await t.test("evicted completion", async t => {
        const f = await fixture(t), checkpoint = await readJson(f.checkpointFile);
        checkpoint.events = checkpoint.events.filter(event => event.type !== "tool.execution_complete");
        await atomicJson(f.checkpointFile, checkpoint);
        const prepared = await runHistoricalMaintenance({ ...f.options, mode: "prepare" });
        await runHistoricalMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
        assert.deepEqual((await readJson(f.checkpointFile)).events.map(event => event.id), checkpoint.events.map(event => event.id));
        await f.restart();
        await appendFile(f.files[0], JSON.stringify({ id: randomUUID(), type: "assistant.turn_end", timestamp: new Date().toISOString(), data: {} }) + "\n");
        await f.collector.collectNow();
        for (const target of f.plan.targets) assert.deepEqual((await loadBoardState(f.context)).evidence
            .find(row => row.scenarioId === target.scenarioId).toolCalls[0].failureEvidence, target.call.failureEvidence);
    });
    await t.test("missing checkpoint", async t => {
        const f = await fixture(t);
        await unlink(f.checkpointFile);
        const prepared = await runHistoricalMaintenance({ ...f.options, mode: "prepare" });
        await runHistoricalMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
        await assert.rejects(readFile(f.checkpointFile), { code: "ENOENT" });
    });
});

test("deleted identities, stronger metadata, duplicate events, extra payload fields and context overflow fail before writes", async t => {
    for (const defect of ["deleted", "author", "failure", "duplicate", "payload", "overflow", "live-pid", "pending-cleanup"]) {
        await t.test(defect, async t => {
            const f = await fixture(t), target = f.plan.targets[0];
            if (defect === "deleted") await updateBoardState(f.context, state => {
                state.deletion = { schemaVersion: 1, identities: [], events: [eventIdentity(target.sourceSessionId, target.prompt.sourceEventId)], contextCalls: [] };
            });
            if (defect === "pending-cleanup") await updateBoardState(f.context, state => {
                state.deletion = { schemaVersion: 1, identities: [], events: [], contextCalls: [], pending: "synthetic",
                    operations: { synthetic: { kind: "artifact-deletion" } } };
            });
            if (["author", "failure"].includes(defect)) await replaceEvidence(f.context, records => ({
                records: records.map(record => record.scenarioId !== target.scenarioId ? record : defect === "author"
                    ? { ...record, userPrompt: { ...record.userPrompt, authorship: { actor: "agent", basis: "source-agent" } } }
                    : { ...record, toolCalls: record.toolCalls.map(call => ({ ...call, failureEvidence: { ...target.call.failureEvidence, code: "Different" } })) }),
                importCoverage: f.state.importCoverage,
            }));
            if (["duplicate", "overflow"].includes(defect)) {
                const checkpoint = await readJson(f.checkpointFile);
                if (defect === "duplicate") checkpoint.events.push(checkpoint.events.find(event => event.id === target.call.completionEventId));
                else checkpoint.events.push({ id: "large-unrelated", type: "user.message", timestamp: target.prompt.sourceTimestamp, data: { content: "x".repeat(512 * 1024) } });
                await atomicJson(f.checkpointFile, checkpoint);
            }
            if (defect === "payload") target.call.failureEvidence.rawMessage = "UNAPPROVED_PRIVATE_MESSAGE";
            if (defect === "live-pid") f.plan.attestation.stoppedRuntimePid = process.pid;
            const current = await loadBoardState(f.context);
            target.recordSha256 = hash(current.evidence.find(record => record.scenarioId === target.scenarioId));
            f.plan.stateGuardSha256 = maintenanceStateGuard(current);
            await f.reseal();
            const before = await inventory(f.context.dataDir);
            await assert.rejects(runHistoricalMaintenance({ ...f.options, mode: "prepare" }));
            assert.deepEqual(await inventory(f.context.dataDir), before);
            await assert.rejects(readFile(f.options.journalFile), { code: "ENOENT" });
        });
    }
});

test("original unknown billing and newer failed assessment receipts remain byte-identical and cannot dispatch", async t => {
    const f = await fixture(t), at = new Date().toISOString(), ref = (kind, c) => `${kind}-${c.repeat(32)}`;
    const source = f.plan.source, approvalRef = ref("approval", "a");
    await updateBoardState(f.context, state => {
        state.personalEvaluation = defaultPersonalEvaluation();
        const data = state.personalEvaluation.modelEvaluation = defaultModelEvaluationState();
        data.automatic = { schemaVersion: 1, revision: 1, receipts: [], approval: {
            schemaVersion: 1, approvalRef, revision: 1, state: "enabled", sourceConfigRef: source.sourceConfigRef,
            sourceConfigRevision: source.sourceConfigRevision, windowDays: source.windowDays, chatRefs: [ref("chat", "b")],
            method: { ...AUTOMATIC_SCORE_METHOD }, evidenceCategories: ["prompt", "answer", "references", "intent"],
            maxCalls: 6, maxAiCredits: 180, approvedAt: at, origin: "explicit-automatic-score-approval",
        } };
        for (const [index, c] of ["c", "d", "e"].entries()) {
            const grantRef = ref("grant", c), interactionRef = ref("interaction", c);
            data.grants.push({ grantRef, state: "enabled", sourceConfigRef: source.sourceConfigRef,
                sourceConfigRevision: source.sourceConfigRevision, interactionRefs: [interactionRef], model: "synthetic-evaluator",
                maxCalls: 1, maxAiCredits: 60, grantedAt: at, revokedAt: null,
                origin: index ? "explicit-in-app-evaluation" : "approved-chat-automatic", ...(!index ? { automaticApprovalRef: approvalRef } : {}) });
            data.runs.push({
                runRef: ref("run", c), grantRef, ownerHash: hash("owner"), inputHash: hash("input"), receiptTokenHash: hash(c),
                phase: index ? "failed" : "uncertain", startedAt: at, completedAt: at, callsReserved: 1,
                spentAiCredits: index ? 2 : 10, costUnknown: !index, results: index ? [{ interactionRef, status: "failed", reason: "result-validation" }] : [],
                scope: [], basis: { sourceRevision: state.evidenceRevision, membershipRevision: state.evidenceRevision, consentRevision: 0, overrideRevision: 0, deletionEpoch: 0 },
                error: index ? "evaluation-failed" : "runtime-restarted",
                ...(!index ? { automatic: { approvalRef, approvalRevision: 1, attemptKey: hash("attempt"), interactionKey: hash("interaction") } } : {}),
            });
        }
    });
    const before = await loadBoardState(f.context), ledger = JSON.stringify(before.personalEvaluation);
    const configFile = path.join(f.context.dataDir, "collector", "config.json"), config = await readJson(configFile);
    config.enabled = true;
    await atomicJson(configFile, config);
    f.plan.source.configSha256 = hash(await readFile(configFile));
    f.plan.stateGuardSha256 = maintenanceStateGuard(before);
    await f.reseal();
    const prepared = await runHistoricalMaintenance({ ...f.options, mode: "prepare" });
    assert.equal(prepared.noDispatchReason, "unknown-billing");
    await runHistoricalMaintenance({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    assert.equal(JSON.stringify((await loadBoardState(f.context)).personalEvaluation), ledger);
    for (const phase of ["running", "complete"]) {
        await updateBoardState(f.context, state => {
            state.personalEvaluation.modelEvaluation.runs[0].phase = phase;
            state.personalEvaluation.modelEvaluation.runs[0].costUnknown = false;
        });
        f.plan.stateGuardSha256 = maintenanceStateGuard(await loadBoardState(f.context));
        await f.reseal();
        const beforeAttempt = await inventory(f.context.dataDir);
        await assert.rejects(runHistoricalMaintenance({ ...f.options, mode: "prepare", journalFile: path.join(f.root, `guard-${phase}.json`) }),
            phase === "running" ? /work is pending/ : /no durable no-dispatch guard/);
        assert.deepEqual(await inventory(f.context.dataDir), beforeAttempt);
    }
});
