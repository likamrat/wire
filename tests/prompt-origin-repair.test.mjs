import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, readdir, appendFile, rename } from "node:fs/promises";
import path from "node:path";
import { directMessageReference, promptInstallation } from "./prompt-authorship-fixture.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { hash, atomicJson, TAIL_LIMITS } from "../lib/collector-io.mjs";
import { assessmentSource } from "../lib/assessment-read-model.mjs";
import { maintenanceStateGuard } from "../lib/historical-maintenance.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { createCollector } from "../lib/collector.mjs";
import { completionReferenceStore } from "../lib/checkpoint-references.mjs";
import { inspectPromptOriginRepair, runPromptOriginRepair, reviewPromptOriginClass } from "../lib/prompt-origin-repair.mjs";
import { chromium, expect } from "@playwright/test";

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
async function setup(t, variant = "direct", { checkpointCompanion = false, absentTargetEvent = false, batchOrigins = 1 } = {}) {
    const plan = variant === "plan-agent", mode = variant === "mode-user", attachment = variant === "attachment-user";
    const legacy = ["legacy-agent", "archived-agent"].includes(variant), linkedPair = variant === "v10-linked-pair";
    const app = await promptInstallation(t), item = app.cases.find(row => row.name === (legacy || variant === "explicit-agent" ? "agent" : plan ? "enveloped-agent" : "human"));
    const repairItems = [item];
    if (variant === "mixed-review") repairItems.push(...app.cases.filter(row => ["enveloped-agent", "legacy", "conflict"].includes(row.name)));
    if (variant === "paged-review") {
        const agent = app.cases.find(row => row.name === "enveloped-agent");
        repairItems.push(agent);
        const events = (await readFile(app.sourceFiles[1], "utf8")).trim().split("\n").map(JSON.parse);
        const original = events.find(row => row.id === item.promptId);
        events.splice(events.findIndex(row => row.id === agent.promptId), 0, ...Array.from({ length: 5 }, () => ({
            id: randomUUID(), type: "session.info", timestamp: original.timestamp, data: { message: "x".repeat(900000) },
        })));
        events.push(original);
        await writeFile(app.sourceFiles[1], events.map(event => JSON.stringify(event) + "\n").join(""));
    }
    let companion;
    if (plan || mode || attachment || checkpointCompanion || linkedPair) {
        const events = (await readFile(app.sourceFiles[1], "utf8")).trim().split("\n").map(JSON.parse);
        const original = events.find(event => event.id === item.promptId);
        if (linkedPair) {
            item.data.content = "  Invented request.\nKeep this original text.  ";
            original.data.content = item.data.content;
            original.data.transformedContent = `<current_datetime>${original.timestamp}</current_datetime>\n\n`
                + "<copilot_working_context>Invented workspace.</copilot_working_context>\n\n"
                + item.data.content + directMessageReference();
            const i = events.indexOf(original) + 1, [start, end] = events.slice(i, i + 2);
            start.data.turnId = "invented-bound-turn";
            const request = toolCallId => ({ type: "assistant.message", id: "request-" + toolCallId, timestamp: original.timestamp,
                data: { originatingMessageId: original.data.messageId, turnId: start.data.turnId, toolRequests: [{ toolCallId }] } });
            const secondId = "invented-second-call";
            events.splice(i, 2, request(item.callId), request(secondId), start,
                { ...start, id: randomUUID(), data: { ...start.data, toolCallId: secondId } }, end,
                { ...end, id: randomUUID(), data: { ...end.data, toolCallId: secondId } });
        } else if (attachment) {
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
    if (batchOrigins > 1) {
        const events = (await readFile(app.sourceFiles[1], "utf8")).trim().split("\n").map(JSON.parse);
        let clock = Date.parse(events.at(-1).timestamp);
        const next = (type, data) => ({ id: randomUUID(), type, timestamp: new Date(clock += 100).toISOString(), data });
        for (let number = 1; number < batchOrigins; number++) {
            const prompt = next("user.message", { content: `Invented batch request ${number}.`, source: "agent-invented-batch", messageId: randomUUID() });
            const callId = `invented-batch-call-${number}`;
            repairItems.push({ promptId: prompt.id, data: prompt.data });
            events.push(prompt, next("tool.execution_start", { toolName: "workiq-ask", toolCallId: callId, arguments: { question: "Invented question." } }),
                next("tool.execution_complete", { toolCallId: callId, success: true }));
        }
        await writeFile(app.sourceFiles[1], events.map(event => JSON.stringify(event) + "\n").join(""));
    }
    await app.runtime().collector.collectNow();
    if (variant === "paged-review") await app.runtime().collector.collectNow();
    if (variant === "archived-agent") {
        const db = new DatabaseSync(app.config.appDbPath);
        try { db.prepare("UPDATE workspaces SET archived_at=? WHERE session_id=?").run(new Date().toISOString(), app.child); }
        finally { db.close(); }
        await app.runtime().collector.collectNow();
    }
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
    const older = { actor: "unknown", basis: linkedPair ? "unsupported-source" : plan ? "conflicting-source" : "invalid-source" };
    const olderVersion = linkedPair ? 10 : 6;
    const selectedIds = new Set(repairItems.map(item => item.promptId));
    for (const event of checkpoint.events.filter(event => selectedIds.has(event.id))) {
        if (legacy) { delete event.data.wirePromptAuthorship; delete event.data.wirePromptAuthorshipVersion; }
        else Object.assign(event.data, { wirePromptAuthorship: older, wirePromptAuthorshipVersion: olderVersion });
    }
    if (companion) {
        const event = checkpoint.events.find(event => event.id === companion.id);
        assert.ok(event);
        Object.assign(event.data, { wirePromptAuthorship: { actor: "unknown", basis: "unsupported-source" }, wirePromptAuthorshipVersion: 5 });
    }
    if (absentTargetEvent) checkpoint = { ...checkpoint, events: checkpoint.events.filter(event => event.id !== item.promptId) };
    await atomicJson(checkpointFile, checkpoint);
    const records = structuredClone(initial.evidence), aliases = new Map(repairItems.map(item => [item.promptId, []]));
    if (companion) delete records.find(record => record.scenarioId === app.cases[0].scenarioId).userPrompt.authorshipVersion;
    for (const record of records) {
        for (const [field, index, prompt] of [["origin", null, record.userPrompt],
            ...(record.followUpPrompts ?? []).map((prompt, index) => ["followup", index, prompt])]) {
            if (record.sourceSessionId === app.child && selectedIds.has(prompt.sourceEventId)) {
                if (legacy) { delete prompt.authorship; delete prompt.authorshipVersion; }
                else Object.assign(prompt, { authorship: older, authorshipVersion: olderVersion });
                aliases.get(prompt.sourceEventId).push({ scenarioId: record.scenarioId, field, index });
            }
        }
    }
    await replaceEvidence(app.context, () => ({ records, importCoverage: initial.importCoverage }));
    if (linkedPair) {
        assert.deepEqual(proposed, { actor: "user", basis: "host-direct-input" }, "A newly collected original qualifies.");
        await app.restart();
        await app.runtime().collector.collectNow();
        assert.equal((await app.runtime().collector.status()).metrics.lastBytesRead, 0);
        assert.deepEqual((await loadBoardState(app.context)).evidence, records, "Installing a reader is not a historical repair.");
    }
    const reports = createExportController(app.context), prior = await loadBoardState(app.context);
    const preview = await reports.preview("owned-repair", undefined, { promptMode: linkedPair ? "original" : "none", formats: ["json"] },
        linkedPair ? { kind: "selected", scenarioIds: [item.scenarioId], revision: prior.revision } : { kind: "all", revision: prior.revision });
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
        aliases: aliases.get(item.promptId).map(alias => ({ ...alias, recordSha256: digest(state.evidence.find(record => record.scenarioId === alias.scenarioId)) })),
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
    return { app, state, plan: repairPlan, target, companionTarget, sourceBytes, indexFile, checkpointFile,
        originFor: sourceEventId => ({ sourceSessionId: app.child, sourceEventId,
            sourceEvent: pin(1, sourceEventId, app.child), olderRetained: false }),
        origins: repairItems.map(item => ({ sourceSessionId: app.child, sourceEventId: item.promptId,
            sourceEvent: pin(1, item.promptId, app.child), olderRetained: false })),
        options: {
        dataDir: app.context.dataDir, planFile, planSha256: digest(repairPlan), sourceManifestFile, sourceIdentity: source.sourceIdentity,
        journalFile: path.join(app.root, "origin-journal.json"),
    } };
}

test("a reviewed v10 prompt correction preserves both explicitly linked completions and the frozen report", async t => {
    const f = await setup(t, "v10-linked-pair"), { app, origins, state } = f;
    const original = state.evidence.find(r => r.userPrompt.sourceEventId === origins[0].sourceEventId);
    const actor = { actor: "user", basis: "host-direct-input" };
    assert.deepEqual(original.userPrompt.authorship, { actor: "unknown", basis: "unsupported-source" });
    assert.equal(original.userPrompt.authorshipVersion, 10);
    const item = app.cases.find(row => row.name === "human"), callIds = [item.callId, "invented-second-call"];
    assert.deepEqual(original.toolCalls.map(call => [call.toolCallId, call.promptLink, call.reportedOutcome]), callIds.map(id => [
        id, { version: 1, promptEventId: item.promptId, requestEventId: "request-" + id }, "succeeded",
    ]));
    async function readPair(label) {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage();
            await page.goto(app.runtime().url + "#request?request=" + encodeURIComponent(original.scenarioId));
            const reader = page.locator("#contextSidebar"), group = `[data-context-group="${original.scenarioId}"]`;
            const text = reader.getByRole("region", { name: label, exact: true }).getByLabel("Exact recorded prompt text");
            await expect(text).toBeVisible();
            assert.equal(await text.textContent(), item.data.content);
            await expect(reader.locator(".reader-call-row" + group)).toHaveCount(2);
            await reader.locator(".reader-section-jumps").getByRole("button", { name: "Source", exact: true }).click();
            await expect(reader.locator(`${group} .reader-record-limits p`).first()).toHaveText("Copilot linked all 2 tool calls directly to the prompt.");
        } finally { await browser.close(); }
    }
    await app.restart();
    await readPair("Author unverified");
    await app.stop();
    const inspection = await inspectPromptOriginRepair({ dataDir: app.context.dataDir, origins });
    assert.equal(inspection.authorized, false);
    assert.deepEqual(inspection.unresolved, []);
    assert.equal(inspection.targets.length, 1);
    assert.deepEqual(inspection.targets[0].prompt.authorship, actor);
    assert.deepEqual(inspection.targets[0].aliases, f.target.aliases);
    f.plan.targets = inspection.targets;
    await writeFile(f.options.planFile, JSON.stringify(f.plan));
    f.options.planSha256 = digest(f.plan);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    assert.deepEqual(await loadBoardState(app.context), state, "Neither inspection nor preparation publishes a correction.");
    const apply = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
    const result = await runPromptOriginRepair(apply);
    assert.equal(result.alreadyCommitted, false);
    const expected = structuredClone(state.evidence);
    for (const alias of f.target.aliases) {
        const record = expected.find(r => r.scenarioId === alias.scenarioId);
        Object.assign(alias.field === "origin" ? record.userPrompt : record.followUpPrompts[alias.index],
            { authorship: actor, authorshipVersion: promptAuthorship.version });
    }
    const after = await loadBoardState(app.context);
    assert.equal(after.revision, state.revision + 1);
    assert.deepEqual(after.evidence, expected);
    assert.deepEqual(after.exports, state.exports);
    assert.equal((await runPromptOriginRepair(apply)).alreadyCommitted, true);
    assert.deepEqual(await loadBoardState(app.context), after);
    const again = await inspectPromptOriginRepair({ dataDir: app.context.dataDir, origins });
    assert.deepEqual(again.targets, []);
    assert.deepEqual(again.unresolved.map(row => row.reason), ["known-origin-copy"]);
    await app.restart();
    await app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence, expected);
    await readPair("Human prompt");
    for (const pin of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(app.context.dataDir, pin.path))), pin.sha256);
    const frozen = JSON.parse(await readFile(after.exports[0].files["product-report.json"], "utf8"));
    assert.equal(frozen.records.length, 1);
    const frozenOrigin = frozen.records[0].prompts.find(prompt => prompt.kind === "origin");
    assert.deepEqual(frozenOrigin.authorship, original.userPrompt.authorship);
    assert.equal(frozenOrigin.text, item.data.content);
    assert.deepEqual(await Promise.all(app.sourceFiles.map(file => readFile(file))), f.sourceBytes);
});

for (const variant of ["legacy-agent", "archived-agent"]) test(`original selectors derive a complete sealed repair without changing source eligibility (${variant})`, async t => {
    const f = await setup(t, variant);
    const original = { sourceSessionId: f.target.sourceSessionId, sourceEventId: f.target.prompt.sourceEventId,
        sourceEvent: f.target.sourceEvent, olderRetained: false, ...(variant === "archived-agent" ? { includeArchived: true } : {}) };
    const inspection = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: [original] });
    assert.equal(inspection.authorized, false);
    assert.equal(inspection.targets.length, 1);
    assert.deepEqual(inspection.targets[0].prompt.authorship, { actor: "agent", basis: "source-agent" });
    assert.equal(inspection.targets[0].legacyUnqualified, true);
    assert.deepEqual(inspection.targets[0].aliases, f.target.aliases);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
    f.plan.targets = inspection.targets;
    await writeFile(f.options.planFile, JSON.stringify(f.plan));
    f.options.planSha256 = digest(f.plan);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    await runPromptOriginRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    const repaired = await loadBoardState(f.app.context), expected = structuredClone(f.state.evidence);
    for (const alias of f.target.aliases) {
        const record = expected.find(record => record.scenarioId === alias.scenarioId);
        Object.assign(alias.field === "origin" ? record.userPrompt : record.followUpPrompts[alias.index],
            { authorship: { actor: "agent", basis: "source-agent" }, authorshipVersion: promptAuthorship.version });
    }
    assert.deepEqual(repaired.evidence, expected);
    assert.deepEqual(repaired.importCoverage, f.state.importCoverage);
    assert.deepEqual(repaired.exports, f.state.exports);
    await f.app.restart();
    await appendFile(f.app.sourceFiles[1], JSON.stringify({ id: randomUUID(), type: "session.info",
        timestamp: new Date().toISOString(), data: { message: "Invented later append." } }) + "\n");
    await f.app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, expected);
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.app.context.dataDir, file.path))), file.sha256);
});

test("one original-selector review repairs eighteen origins and every matching copy as one sealed operation", async t => {
    const f = await setup(t, "direct", { batchOrigins: 18 });
    const inspection = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: f.origins });
    assert.equal(inspection.targets.length, 18);
    assert.deepEqual(inspection.unresolved, []);
    f.plan.targets = inspection.targets;
    await writeFile(f.options.planFile, JSON.stringify(f.plan));
    f.options.planSha256 = digest(f.plan);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    await runPromptOriginRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    const expected = structuredClone(f.state.evidence);
    for (const target of inspection.targets) for (const alias of target.aliases) {
        const record = expected.find(record => record.scenarioId === alias.scenarioId);
        Object.assign(alias.field === "origin" ? record.userPrompt : record.followUpPrompts[alias.index],
            { authorship: target.prompt.authorship, authorshipVersion: promptAuthorship.version });
    }
    const after = await loadBoardState(f.app.context);
    assert.equal(after.revision, f.state.revision + 1);
    assert.deepEqual(after.evidence, expected);
    assert.deepEqual(after.exports, f.state.exports);
    await f.app.restart();
    await f.app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, expected);
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.app.context.dataDir, file.path))), file.sha256);
});

test("an origin review explicitly excludes known and unverified authors without fabricating targets", async t => {
    const f = await setup(t);
    const unresolved = f.originFor(f.app.cases.find(item => item.name === "legacy").promptId);
    const known = f.originFor(f.app.cases.find(item => item.name === "agent").promptId);
    const mixed = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: [...f.origins, unresolved, known] });
    assert.equal(mixed.targets.length, 1);
    assert.deepEqual(mixed.unresolved.map(row => row.reason).sort(), ["author-unverified", "known-origin-copy"]);
    const unchanged = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: [unresolved, known] });
    assert.equal(unchanged.status, "nothing-qualified");
    assert.deepEqual(unchanged.targets, []);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
});

test("operators can discover and review a mixed historical author cohort without supplying original-event pins", async t => {
    const f = await setup(t, "mixed-review");
    const cli = (...args) => spawnSync(process.execPath, [path.resolve("scripts/maintain-prompt-origins.mjs"),
        "--data-dir", f.app.context.dataDir, ...args], { encoding: "utf8" });
    function run(...args) {
        const reply = cli(...args);
        assert.equal(reply.status, 0, reply.stderr);
        return JSON.parse(reply.stdout);
    }
    const catalog = run("--mode", "list");
    assert.equal(catalog.batches.length, 1);
    assert.equal(catalog.batches[0].origins.length, 4);
    const review = run("--mode", "review", "--batch", catalog.batches[0].batch);
    assert.deepEqual(review.targets.map(t => t.prompt.authorship.basis).sort(), ["host-agent-envelope", "host-direct-input"]);
    assert.deepEqual(review.unresolved.map(row => row.authorship.basis).sort(), ["conflicting-source", "missing-source"]);
    assert.equal(review.authorized, false);
    assert.deepEqual(await loadBoardState(f.app.context), f.state);
    for (const item of f.app.cases) assert.ok(!JSON.stringify([catalog, review]).includes(item.data.content));
    f.plan.targets = review.targets;
    await writeFile(f.options.planFile, JSON.stringify(f.plan));
    f.options.planSha256 = digest(f.plan);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    await runPromptOriginRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 });
    await f.app.restart(); await f.app.runtime().collector.collectNow();
    const expected = structuredClone(f.state.evidence);
    for (const { aliases, prompt } of review.targets) for (const alias of aliases) {
        const r = expected.find(record => record.scenarioId === alias.scenarioId);
        Object.assign(alias.field === "origin" ? r.userPrompt : r.followUpPrompts[alias.index],
            { authorship: prompt.authorship, authorshipVersion: promptAuthorship.version });
    }
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, expected);
    assert.deepEqual(run("--mode", "list").batches.map(batch => batch.origins.length), [2]);
});

test("later pages locate a candidate and disqualify a competing original; source drift invalidates the review", async t => {
    const f = await setup(t, "paged-review"), dataDir = f.app.context.dataDir, file = f.app.sourceFiles[1];
    await rename(file, file + ".absent");
    const { batches: [{ batch }] } = await reviewPromptOriginClass({ dataDir });
    await rename(file + ".absent", file);
    const first = await reviewPromptOriginClass({ dataDir, batch });
    assert.equal(first.status, "continue");
    assert.equal(first.targets, undefined);
    const changed = structuredClone(first.continuation);
    changed.core.found = {};
    await assert.rejects(reviewPromptOriginClass({ dataDir, batch, continuation: changed }), /continuation is stale or invalid/);
    const previous = path.join(f.app.root, "previous.json");
    await writeFile(previous, JSON.stringify(first));
    const reply = spawnSync(process.execPath, [path.resolve("scripts/maintain-prompt-origins.mjs"),
        "--mode", "review", "--batch", batch, "--previous", previous, "--data-dir", dataDir], { encoding: "utf8" });
    assert.equal(reply.status, 0, reply.stderr);
    const reviewed = JSON.parse(reply.stdout);
    assert.deepEqual(reviewed.targets.map(target => target.prompt.authorship.basis), ["host-agent-envelope"]);
    assert.deepEqual(reviewed.unresolved.map(row => row.reason), ["duplicate-original"]);
    f.plan.targets = reviewed.targets;
    await writeFile(f.options.planFile, JSON.stringify(f.plan));
    f.options.planSha256 = digest(f.plan);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    await appendFile(file, JSON.stringify({ type: "session.info", id: randomUUID(), timestamp: new Date().toISOString(), data: {} }) + "\n");
    await assert.rejects(runPromptOriginRepair({ ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 }),
        /source changed since the complete historical author review/);
    assert.deepEqual(await loadBoardState(f.app.context), f.state);
});

test("archived history requires explicit inclusion and fresh local provenance, not an archive flag alone", async t => {
    const f = await setup(t, "archived-agent"), origin = { ...f.origins[0], includeArchived: true };
    const scope = { dataDir: f.app.context.dataDir, includeArchived: true };
    assert.deepEqual((await reviewPromptOriginClass({ dataDir: scope.dataDir })).batches, []);
    const { batches: [{ batch }] } = await reviewPromptOriginClass(scope);
    assert.equal((await reviewPromptOriginClass({ ...scope, batch })).targets[0].sourceMapping.archived, true);
    await assert.rejects(inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: f.origins }), /explicitly included archived-local/);
    const db = new DatabaseSync(f.app.config.appDbPath);
    try { db.prepare("UPDATE sessions SET execution_location='cloud' WHERE id=?").run(f.app.child); }
    finally { db.close(); }
    await assert.rejects(reviewPromptOriginClass({ ...scope, batch }), /no longer eligible/);
    await assert.rejects(inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: [origin] }), /explicitly included archived-local/);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
});

test("reviewing an older retained window needs its own choice at listing and original lookup", async t => {
    const f = await setup(t), dataDir = f.app.context.dataDir;
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 31 * 86400000 });
    const current = await reviewPromptOriginClass({ dataDir });
    assert.deepEqual(current.batches, []);
    assert.equal(current.excluded["outside-current-window"], 1);
    const { batches: [{ batch }] } = await reviewPromptOriginClass({ dataDir, includeOlder: true });
    await assert.rejects(reviewPromptOriginClass({ dataDir, batch }), /stale or unavailable/);
    const review = await reviewPromptOriginClass({ dataDir, batch, includeOlder: true });
    assert.deepEqual(review.targets.map(t => [t.prompt.authorship.actor, t.olderRetained]), [["user", true]]);
});

test("a legacy exception cannot overwrite a known checkpoint author whose version is absent", async t => {
    const f = await setup(t, "legacy-agent");
    const checkpoint = JSON.parse(await readFile(f.checkpointFile, "utf8"));
    const event = checkpoint.events.find(event => event.id === f.target.prompt.sourceEventId);
    event.data.wirePromptAuthorship = { actor: "user", basis: "source-user" };
    delete event.data.wirePromptAuthorshipVersion;
    await atomicJson(f.checkpointFile, checkpoint);
    const scope = { dataDir: f.app.context.dataDir };
    const { batches: [{ batch }] } = await reviewPromptOriginClass(scope);
    const reviewed = await reviewPromptOriginClass({ ...scope, batch });
    assert.deepEqual(reviewed.targets, []);
    assert.deepEqual(reviewed.unresolved.map(row => row.reason), ["incompatible-checkpoint-copy"]);
    await assert.rejects(inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: f.origins }), /not the reviewed older unqualified origin/);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
});

for (const variant of ["legacy-agent", "explicit-agent", "direct"]) test(`repair authority cannot fall back to cached mappings (${variant})`, async t => {
    const f = await setup(t, variant);
    const inspection = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: f.origins });
    const targets = structuredClone(inspection.targets);
    delete targets[0].sourceMapping;
    const db = new DatabaseSync(f.app.config.appDbPath);
    try { db.prepare("UPDATE sessions SET execution_location='cloud' WHERE id=?").run(f.app.child); }
    finally { db.close(); }
    await assert.rejects(inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, targets }), /source mapping guard|local source disposition changed/);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
});

test("the older host-target format remains usable only with the same freshly verified source identity", async t => {
    const f = await setup(t);
    const coverage = structuredClone(f.state.importCoverage);
    for (const row of coverage.roster) delete row.localSourceVerified;
    await replaceEvidence(f.app.context, () => ({ records: f.state.evidence, importCoverage: coverage }));
    const inspected = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, targets: [f.target] });
    assert.equal(inspected.targets.length, 1);
    assert.deepEqual(inspected.targets[0].prompt.authorship, f.target.prompt.authorship);
    const db = new DatabaseSync(f.app.config.appDbPath);
    try { db.prepare("UPDATE workspaces SET project_id=? WHERE session_id=?").run(randomUUID(), f.app.child); }
    finally { db.close(); }
    await assert.rejects(inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, targets: [f.target] }), /compatible target's source mapping changed/);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
});

test("both inspection entries reserve all original revalidation passes before reading", async t => {
    const f = await setup(t);
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const origins = ids.map(sourceEventId => ({ ...f.origins[0], sourceEventId,
        sourceEvent: { ...f.origins[0].sourceEvent, bytes: TAIL_LIMITS.maxLineBytes } }));
    const targets = ids.map(sourceEventId => ({ ...f.target, prompt: { ...f.target.prompt, sourceEventId },
        sourceEvent: { ...f.target.sourceEvent, bytes: TAIL_LIMITS.maxLineBytes } }));
    await assert.rejects(inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins }), /reads exceed the existing cycle budget/);
    await assert.rejects(inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, targets }), /reads exceed the existing cycle budget/);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
});

for (const boundary of ["applying", "snapshot-staged"]) test(`pinned original drift blocks effects and preserves same-journal recovery (${boundary})`, async t => {
    const f = await setup(t, "legacy-agent");
    const inspection = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: f.origins });
    f.plan.targets = inspection.targets;
    await writeFile(f.options.planFile, JSON.stringify(f.plan));
    f.options.planSha256 = digest(f.plan);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
    await assert.rejects(runPromptOriginRepair(options, { async onStep(phase) {
        if (phase !== boundary) return;
        const events = (await readFile(f.app.sourceFiles[1], "utf8")).trim().split("\n").map(JSON.parse);
        const changed = events.find(event => event.id === f.origins[0].sourceEventId);
        const padding = " ".repeat(changed.data.source.length - "system".length);
        changed.data.source = "system";
        const text = events.map(event => {
            const line = JSON.stringify(event);
            return (event === changed ? line.replace('"source":"system"', `"source":${padding}"system"`) : line) + "\n";
        }).join("");
        assert.equal(Buffer.byteLength(text), f.sourceBytes[1].length, "Provenance drift must be caught even when file size is unchanged.");
        await writeFile(f.app.sourceFiles[1], text);
    } }), /Original prompt region changed/);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
    if (boundary === "snapshot-staged") {
        await assert.rejects(createCollector(f.app.context, { timers: false }), error => error.code === "RETAINED_REPAIR_PENDING");
    } else assert.equal(JSON.parse(await readFile(f.indexFile, "utf8")).completionReferenceMaintenance, undefined);
    await writeFile(f.app.sourceFiles[1], f.sourceBytes[1]);
    await runPromptOriginRepair(options);
    assert.equal((await loadBoardState(f.app.context)).revision, f.state.revision + 1);
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.app.context.dataDir, file.path))), file.sha256);
});

test("a committed bound legacy repair finalizes without replaying unavailable original sources", async t => {
    const f = await setup(t, "legacy-agent");
    const inspection = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: f.origins });
    f.plan.targets = inspection.targets;
    await writeFile(f.options.planFile, JSON.stringify(f.plan));
    f.options.planSha256 = digest(f.plan);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
    await assert.rejects(runPromptOriginRepair(options, { onStep(phase) {
        if (phase === "board-saved") throw new Error("Invented interruption after committed board.");
    } }), /Invented interruption/);
    const committed = await loadBoardState(f.app.context);
    await rename(f.app.sourceFiles[1], f.app.sourceFiles[1] + ".moved");
    const db = new DatabaseSync(f.app.config.appDbPath);
    try { db.prepare("UPDATE sessions SET execution_location='cloud' WHERE id=?").run(f.app.child); }
    finally { db.close(); }
    const resumed = await runPromptOriginRepair(options);
    assert.equal(resumed.alreadyCommitted, true);
    assert.deepEqual(await loadBoardState(f.app.context), committed);
    assert.equal(JSON.parse(await readFile(f.indexFile, "utf8")).completionReferenceMaintenance, undefined);
});

test("source mapping drift after preparation refuses the write and the same journal resumes only with its original scope", async t => {
    const f = await setup(t, "archived-agent");
    const inspection = await inspectPromptOriginRepair({ dataDir: f.app.context.dataDir, origins: [{ ...f.origins[0], includeArchived: true }] });
    f.plan.targets = inspection.targets;
    await writeFile(f.options.planFile, JSON.stringify(f.plan));
    f.options.planSha256 = digest(f.plan);
    const prepared = await runPromptOriginRepair({ ...f.options, mode: "prepare" });
    const options = { ...f.options, mode: "apply", reviewSha256: prepared.reviewSha256 };
    const move = location => {
        const db = new DatabaseSync(f.app.config.appDbPath);
        try { db.prepare("UPDATE sessions SET execution_location=? WHERE id=?").run(location, f.app.child); }
        finally { db.close(); }
    };
    await assert.rejects(runPromptOriginRepair(options, { onStep(phase) {
        if (phase === "snapshot-staged") move("cloud");
    } }), /source disposition changed/);
    assert.deepEqual((await loadBoardState(f.app.context)).evidence, f.state.evidence);
    await assert.rejects(createCollector(f.app.context, { timers: false }), error => error.code === "RETAINED_REPAIR_PENDING");
    move("local");
    await runPromptOriginRepair(options);
    assert.equal((await loadBoardState(f.app.context)).revision, f.state.revision + 1);
    for (const file of f.plan.preservedFiles) assert.equal(hash(await readFile(path.join(f.app.context.dataDir, file.path))), file.sha256);
});

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
