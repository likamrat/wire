import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, readdir, appendFile, rename } from "node:fs/promises";
import path from "node:path";
import { promptInstallation } from "./prompt-authorship-fixture.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { hash, atomicJson } from "../lib/collector-io.mjs";
import { assessmentSource } from "../lib/assessment-read-model.mjs";
import { maintenanceStateGuard } from "../lib/historical-maintenance.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { createCollector } from "../lib/collector.mjs";
import { completionReferenceStore } from "../lib/checkpoint-references.mjs";
import { inspectPromptOriginRepair, runPromptOriginRepair } from "../lib/prompt-origin-repair.mjs";

const digest = value => hash(JSON.stringify(value));
async function manifest(root) {
    const files = [];
    async function visit(relative = "") {
        for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if ([".git", "node_modules"].includes(entry.name)) continue;
            const name = path.join(relative, entry.name);
            if (entry.isDirectory()) await visit(name);
            else files.push({ path: name, sha256: hash(await readFile(path.join(root, name))) });
        }
    }
    await visit();
    return { root, files, sourceIdentity: digest(files) };
}
async function setup(t, variant = "direct", { checkpointCompanion = false, absentTargetEvent = false } = {}) {
    const plan = variant === "plan-agent", mode = variant === "mode-user", attachment = variant === "attachment-user";
    const app = await promptInstallation(t), item = app.cases.find(row => row.name === (plan ? "enveloped-agent" : "human"));
    let companion;
    if (plan || mode || attachment || checkpointCompanion) {
        const events = (await readFile(app.sourceFiles[1], "utf8")).trim().split("\n").map(JSON.parse);
        const original = events.find(event => event.id === item.promptId);
        if (attachment) {
            const file = { type: "file", displayName: "invented-notes.md", path: "C:\\invented\\invented-notes.md" };
            item.data.content = `Read ${file.displayName} before planning.`;
            original.data.content = item.data.content;
            original.data.attachments = [file];
            original.data.transformedContent = `<current_datetime>${original.timestamp}</current_datetime>\n\n`
                + item.data.content.replace(file.displayName, `Attached file: ${file.displayName} (${file.path})`);
        } else if (mode || plan) original.data.transformedContent = mode
            ? original.data.transformedContent.replace("</current_datetime>\n\n",
                "</current_datetime>\n\n<mode_changed_notice>Invented transition.<plan_mode>Invented mode context.</plan_mode></mode_changed_notice>\n\n[[PLAN]] ")
            : original.data.transformedContent.replace("</current_datetime>\n\n", "</current_datetime>\n\n[[PLAN]] ");
        if (checkpointCompanion) {
            const at = Date.parse(events.at(-1).timestamp);
            events.push({ id: randomUUID(), type: "user.message", timestamp: new Date(at + 100).toISOString(),
                data: { content: "Invented separate following message.", source: "user" } });
            const timestamp = new Date(at + 200).toISOString(), content = "Invented checkpoint-only plan.";
            companion = { id: randomUUID(), type: "user.message", timestamp, data: { content,
                messageId: randomUUID(), delivery: "idle",
                transformedContent: `<current_datetime>${timestamp}</current_datetime>\n\n[[PLAN]] ${content}` } };
            events.push(companion);
            const completion = events.find(event => event.type === "tool.execution_complete");
            completion.data.success = false;
            completion.data.error = { code: "failure", message: "Owned preserved service error." };
        }
        await writeFile(app.sourceFiles[1], events.map(event => JSON.stringify(event) + "\n").join(""));
    }
    await app.runtime().collector.collectNow();
    const initial = await loadBoardState(app.context), record = initial.evidence.find(row => row.scenarioId === item.scenarioId);
    const proposed = record.userPrompt.authorship, sourceBytes = await Promise.all(app.sourceFiles.map(file => readFile(file)));
    const indexFile = path.join(app.context.dataDir, "collector", "index.json");
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    if (checkpointCompanion) {
        Object.assign(index, { schemaVersion: 4, completionReferenceVersion: 1,
            completionReferenceStore: completionReferenceStore(initial, app.context.dataDir), completionReferenceSources: [] });
        await atomicJson(indexFile, index);
    }
    const checkpointFile = path.join(app.context.dataDir, "collector", index.fingerprint, `${app.child}.json`);
    let checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
    const older = { actor: "unknown", basis: plan ? "conflicting-source" : "invalid-source" };
    for (const event of checkpoint.events.filter(event => event.id === item.promptId)) Object.assign(event.data,
        { wirePromptAuthorship: older, wirePromptAuthorshipVersion: 6 });
    if (companion) {
        const event = checkpoint.events.find(event => event.id === companion.id);
        assert.ok(event);
        Object.assign(event.data, { wirePromptAuthorship: { actor: "unknown", basis: "unsupported-source" }, wirePromptAuthorshipVersion: 5 });
    }
    if (absentTargetEvent) checkpoint = { ...checkpoint, events: checkpoint.events.filter(event => event.id !== item.promptId) };
    await atomicJson(checkpointFile, checkpoint);
    const records = structuredClone(initial.evidence), aliases = [];
    if (companion) delete records.find(record => record.scenarioId === app.cases[0].scenarioId).userPrompt.authorshipVersion;
    for (const record of records) {
        for (const [field, index, prompt] of [["origin", null, record.userPrompt],
            ...(record.followUpPrompts ?? []).map((prompt, index) => ["followup", index, prompt])]) {
            if (record.sourceSessionId === app.child && prompt.sourceEventId === item.promptId) {
                Object.assign(prompt, { authorship: older, authorshipVersion: 6 });
                aliases.push({ scenarioId: record.scenarioId, field, index });
            }
        }
    }
    await replaceEvidence(app.context, () => ({ records, importCoverage: initial.importCoverage }));
    const reports = createExportController(app.context), prior = await loadBoardState(app.context);
    const preview = await reports.preview("owned-repair", undefined, { promptMode: "none", formats: ["json"] },
        { kind: "all", revision: prior.revision });
    await reports.review("owned-repair", preview.previewId, true);
    const saved = (await reports.confirm("owned-repair", preview.previewId, true)).bundle;
    const state = await loadBoardState(app.context);
    function pin(sourceIndex, eventId, sourceId) {
        const lines = sourceBytes[sourceIndex].toString().split(/(?<=\n)/);
        let offset = 0;
        for (const line of lines) {
            if (!line) continue;
            if (JSON.parse(line).id === eventId) return {
                sourceIdentity: index.sources[sourceId].cursor.identity, offset, bytes: Buffer.byteLength(line), sha256: hash(line),
                startupBytes: Buffer.byteLength(lines[0]), startupSha256: hash(lines[0]),
            };
            offset += Buffer.byteLength(line);
        }
        assert.fail("Owned original event missing.");
    }
    const target = {
        sourceSessionId: app.child,
        prompt: { sourceEventId: item.promptId, sourceTimestamp: record.userPrompt.sourceTimestamp,
            textSha256: hash(item.data.content), authorship: proposed, authorshipVersion: promptAuthorship.version },
        sourceEvent: pin(1, item.promptId, app.child),
        kickoff: null,
        aliases: aliases.map(alias => ({ ...alias, recordSha256: digest(state.evidence.find(record => record.scenarioId === alias.scenarioId)) })),
        checkpointContextSha256: digest(checkpoint), olderRetained: false,
    };
    const companionTarget = companion ? { sourceSessionId: app.child, checkpointOnly: true,
        prompt: { sourceEventId: companion.id, sourceTimestamp: companion.timestamp, textSha256: hash(companion.data.content),
            authorship: { actor: "user", basis: "host-direct-input" }, authorshipVersion: promptAuthorship.version },
        sourceEvent: pin(1, companion.id, app.child), kickoff: null, aliases: [],
        checkpointContextSha256: digest(checkpoint), olderRetained: false } : null;
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    const configBytes = await readFile(path.join(app.context.dataDir, "collector", "config.json"));
    const config = JSON.parse(configBytes);
    const repairPlan = { schemaVersion: 1, operationId: randomUUID(),
        attestation: { packetSha256: hash("owned source packet"), recheckSha256: hash("owned exact recheck"),
            stoppedRuntimePid: exited.pid, recorderIdle: true, evaluatorIdle: true, noDispatchVerified: true },
        source: { configSha256: hash(configBytes),
            indexSha256: hash(await readFile(indexFile)), ...assessmentSource(state, config), windowDays: config.windowDays },
        stateGuardSha256: maintenanceStateGuard(state),
        preservedFiles: await Promise.all(Object.values(saved.files).map(async file =>
            ({ path: path.relative(app.context.dataDir, file), sha256: hash(await readFile(file)) }))),
        targets: [target, ...(companionTarget ? [companionTarget] : [])] };
    const planFile = path.join(app.root, "origin-plan.json"), sourceManifestFile = path.join(app.root, "source-manifest.json");
    const source = await manifest(path.dirname(import.meta.dirname));
    await writeFile(planFile, JSON.stringify(repairPlan)); await writeFile(sourceManifestFile, JSON.stringify(source));
    await app.stop();
    return { app, state, plan: repairPlan, target, companionTarget, sourceBytes, indexFile, checkpointFile, options: {
        dataDir: app.context.dataDir, planFile, planSha256: digest(repairPlan), sourceManifestFile, sourceIdentity: source.sourceIdentity,
        journalFile: path.join(app.root, "origin-journal.json"),
    } };
}

for (const variant of ["direct", "plan-agent", "mode-user", "attachment-user"]) test(`sealed origin repair preserves all facts and survives restart (${variant})`, async t => {
    const f = await setup(t, variant);
    const inspected = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, targets: f.plan.targets });
    assert.equal(inspected.authorized, false);
    assert.equal(inspected.indexAfterSchema, 4);
    assert.equal(inspected.pendingFence, "completionReferenceMaintenance");
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    await assert.rejects(runPromptOriginRepair({ ...f.options, mode: "apply", reviewSha256: "0".repeat(64) }), /journal mismatch/);
    const saved = await runPromptOriginRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    const after = await loadBoardState(f.app.context);
    const finalIndex = JSON.parse(await readFile(f.indexFile, "utf8"));
    assert.equal(finalIndex.schemaVersion, 4);
    assert.equal(finalIndex.completionReferenceMaintenance, undefined);
    assert.equal(after.revision, f.state.revision + 1);
    const expected = structuredClone(f.state.evidence);
    for (const alias of f.target.aliases) {
        const record = expected.find(record => record.scenarioId === alias.scenarioId);
        Object.assign(alias.field === "origin" ? record.userPrompt : record.followUpPrompts[alias.index],
            { authorship: f.target.prompt.authorship, authorshipVersion: promptAuthorship.version });
    }
    assert.deepEqual(after.evidence, expected);
    assert.deepEqual(after.exports, f.state.exports);
    assert.equal(inspected.proposedEvidenceFile, saved.evidenceFile);
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.app.context.dataDir, file.path))), file.sha256);
    assert.deepEqual(await Promise.all(f.app.sourceFiles.map(file => readFile(file))), f.sourceBytes);
    await f.app.restart();
    await f.app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, expected);
    await appendFile(f.app.sourceFiles[1], JSON.stringify({ id: randomUUID(), type: "session.info",
        timestamp: new Date().toISOString(), data: { message: "Owned later append." } }) + "\n");
    await f.app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, expected);
});

for (const drift of ["origin", "creator", "alias", "checkpoint"]) test(`read-only origin repair refuses ${drift} drift`, async t => {
    const f = await setup(t, "plan-agent");
    if (drift === "origin") f.target.sourceEvent.sha256 = "0".repeat(64);
    if (drift === "creator") f.target.kickoff = {};
    if (drift === "alias") f.target.aliases[0].scenarioId = "not-the-bound-record";
    if (drift === "checkpoint") f.target.checkpointContextSha256 = "0".repeat(64);
    await assert.rejects(inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, targets: [f.target] }), {
        origin: /Original prompt region changed/,
        creator: /without a creator-history lookup/,
        alias: /origin-copy population changed/,
        checkpoint: /checkpoint preimage changed/,
    }[drift]);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
});

for (const interruption of ["checkpoint-1", "board-saved"]) test(
    `an interrupted prompt repair blocks normal startup and resumes the same operation (${interruption})`, async t => {
    const f = await setup(t, "plan-agent");
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
    await assert.rejects(runPromptOriginRepair(options, { onStep(phase) {
        if (phase === interruption) throw new Error("Owned interruption at sealed boundary.");
    } }), /Owned interruption/);
    const interrupted = await loadBoardState(f.app.context);
    assert.equal(interrupted.revision, f.state.revision + Number(interruption === "board-saved"));
    await assert.rejects(createCollector(f.app.context, { timers: false }), error => error.code === "RETAINED_REPAIR_PENDING");
    assert.deepEqual(await loadBoardState(f.app.context), interrupted, "Refused startup cannot reconcile a half-applied state.");
    if (interruption === "board-saved") await rename(f.app.sourceFiles[1], f.app.sourceFiles[1] + ".moved");
    const resumed = await runPromptOriginRepair(options);
    assert.equal(resumed.alreadyCommitted, interruption === "board-saved");
    assert.equal((await loadBoardState(f.app.context)).revision, f.state.revision + 1);
    if (interruption === "board-saved") assert.deepEqual(await loadBoardState(f.app.context), interrupted);
    assert.equal(JSON.parse(await readFile(f.indexFile, "utf8")).completionReferenceMaintenance, undefined);
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.app.context.dataDir, file.path))), file.sha256);
});

test("installing the supported plan parser does not reclassify already-retained v6 origins", async t => {
    const f = await setup(t, "plan-agent");
    await f.app.restart();
    await f.app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
    assert.equal((await loadBoardState(f.app.context)).evidence.find(record => record.scenarioId === f.target.aliases.find(alias =>
        alias.field === "origin").scenarioId).userPrompt.authorship.actor, "unknown");
});

test("a named checkpoint-only companion preserves known origins, repaired carriers and prior receipts without creating records", async t => {
    const f = await setup(t, "plan-agent", { checkpointCompanion: true, absentTargetEvent: true });
    const before = JSON.parse(await readFile(f.checkpointFile, "utf8"));
    const known = f.state.evidence.find(record => record.scenarioId === f.app.cases[0].scenarioId);
    assert.deepEqual(known.userPrompt.authorship, { actor: "agent", basis: "parent-kickoff" });
    assert.equal(Object.hasOwn(known.userPrompt, "authorshipVersion"), false);
    const carriers = before.events.filter(event => event.type === "tool.execution_complete");
    assert.ok(carriers.some(event => event.data.wireFailureEvidence));
    const receipts = ["operation", "plan", "journal"].map(name => path.join(f.app.root, `prior-completed-${name}.json`));
    for (const file of receipts) await writeFile(file, JSON.stringify({ phase: "complete", checkpointSha256: digest(before), invented: true }));
    const receiptBytes = await Promise.all(receipts.map(file => readFile(file)));
    const inspection = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, targets: f.plan.targets });
    const companion = inspection.origins.find(origin => origin.checkpointOnly);
    assert.equal(companion.copies, 0);
    assert.deepEqual(companion.before, []);
    assert.equal(inspection.checkpoints[0].prompts.find(prompt => prompt.sourceEventId === f.target.prompt.sourceEventId).retained, false);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    await runPromptOriginRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    const after = await loadBoardState(f.app.context), checkpoint = JSON.parse(await readFile(f.checkpointFile, "utf8"));
    assert.equal(hash(await readFile(f.indexFile)), f.plan.source.indexSha256, "Existing completed schema-4 registry and binding stay unchanged.");
    assert.equal(after.evidence.length, f.state.evidence.length);
    assert.equal(after.evidence.some(record => record.userPrompt.sourceEventId === f.companionTarget.prompt.sourceEventId), false);
    assert.deepEqual(after.evidence.find(record => record.scenarioId === known.scenarioId), known);
    assert.deepEqual(checkpoint.events.filter(event => event.type === "tool.execution_complete"), carriers);
    assert.equal(checkpoint.events.some(event => event.id === f.target.prompt.sourceEventId), false, "Absent context stays absent.");
    const changed = checkpoint.events.find(event => event.id === f.companionTarget.prompt.sourceEventId);
    assert.deepEqual(changed.data.wirePromptAuthorship, { actor: "user", basis: "host-direct-input" });
    const expected = structuredClone(before);
    Object.assign(expected.events.find(event => event.id === changed.id).data,
        { wirePromptAuthorship: changed.data.wirePromptAuthorship, wirePromptAuthorshipVersion: promptAuthorship.version });
    assert.deepEqual(checkpoint, expected, "Only the named checkpoint author fields may change.");
    assert.notEqual(digest(checkpoint), digest(before));
    assert.deepEqual(await Promise.all(receipts.map(file => readFile(file))), receiptBytes);
    assert.deepEqual(after.exports, f.state.exports);
    await f.app.restart();
    await f.app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, after.evidence);
});

test("a known contradictory checkpoint-only author refuses restoration", async t => {
    const f = await setup(t, "plan-agent", { checkpointCompanion: true });
    const checkpoint = JSON.parse(await readFile(f.checkpointFile, "utf8"));
    checkpoint.events.find(event => event.id === f.companionTarget.prompt.sourceEventId).data.wirePromptAuthorship =
        { actor: "agent", basis: "source-agent" };
    await atomicJson(f.checkpointFile, checkpoint);
    for (const target of f.plan.targets) target.checkpointContextSha256 = digest(checkpoint);
    await assert.rejects(inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, targets: f.plan.targets }),
        /not the reviewed older unqualified origin/);
    assert.deepEqual(JSON.parse(await readFile(f.checkpointFile, "utf8")), checkpoint);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
});
