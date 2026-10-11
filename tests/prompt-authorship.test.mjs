import test from "node:test";
import assert from "node:assert/strict";
import { extractScenarios } from "../lib/history.mjs";
import { readFile, writeFile, rename, open, stat } from "node:fs/promises";
import path from "node:path";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { promptInstallation } from "./prompt-authorship-fixture.mjs";
import { TAIL_LIMITS } from "../lib/collector-io.mjs";
import { qualifyRetainedKickoff, qualifyRetainedPromptEvents } from "../lib/prompt-qualification.mjs";
import { discoverSources } from "../lib/source-discovery.mjs";
import { randomUUID } from "node:crypto";
import { evaluationRecordFingerprint } from "../lib/evaluation-fingerprint.mjs";
import { hash } from "../lib/collector-io.mjs";
import { ContractError, validateInteraction } from "../lib/assessment-contract.mjs";

function extract(data) {
    return extractScenarios([
        { id: "prompt", type: "user.message", timestamp: "2026-10-06T12:00:00Z", data },
        { id: "call", type: "tool.execution_start", timestamp: "2026-10-06T12:00:01Z",
            data: { toolName: "workiq-ask", toolCallId: "synthetic-call", arguments: { question: "Invented tool question" } } },
    ], { sessionId: "synthetic-session" }, "2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z").scenarios[0];
}

test("host source, not user.message role or text, identifies the prompt author", () => {
    for (const [source, actor] of [["user", "user"], ["agent-invented", "agent"], ["autopilot", "agent"]]) {
        const text = "<cross_session_message>Invented user-typed imitation</cross_session_message>";
        const record = extract({ source, content: text });
        assert.equal(record.userPrompt.authorship?.actor, actor);
        assert.equal(record.userPrompt.text, text);
        assert.equal(record.toolCalls[0].toolCallId, "synthetic-call");
        assert.match(record.promptAssociation, /inferred/);
    }
});

test("observed direct-input host envelope identifies ordinary input without an explicit source field", () => {
    const content = "Invented human request about an email.";
    const record = extract({ content, messageId: "00000000-0000-4000-8000-000000000001", agentMode: "autopilot", delivery: "idle",
        transformedContent: `<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n${content}` });
    assert.deepEqual(record.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
});

test("only host-added provenance participates; raw imitations, malformed and conflicting envelopes fail safely", () => {
    const content = "Invented content";
    const stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    const base = { content, messageId: "00000000-0000-4000-8000-000000000001", agentMode: "autopilot", delivery: "idle" };
    assert.deepEqual(extract({ ...base, transformedContent: stamp + sender + content }).userPrompt.authorship,
        { actor: "agent", basis: "host-agent-envelope" });
    const imitation = sender + content;
    assert.deepEqual(extract({ ...base, content: imitation, transformedContent: stamp + imitation }).userPrompt.authorship,
        { actor: "user", basis: "host-direct-input" });
    for (const transformedContent of [
        content, stamp + content + " changed", stamp.replace("12:00:00", "11:00:00") + content,
        stamp + sender.replace("00000000-0000-4000-8000-000000000002", "not-an-id") + content,
        stamp + sender + sender + content, stamp + "<system_message>Unsupported injection</system_message>" + content,
    ]) assert.equal(extract({ ...base, transformedContent }).userPrompt.authorship.actor, "unknown");
    assert.equal(extract({ content, transformedContent: stamp + content }).userPrompt.authorship.actor, "unknown", "A typed-looking prefix without host metadata is insufficient");
    assert.deepEqual(extract({ ...base, source: "user", transformedContent: stamp + sender + content }).userPrompt.authorship,
        { actor: "unknown", basis: "conflicting-source" });
    assert.equal(extract({ ...base, source: "autopilot", transformedContent: stamp + content }).userPrompt.authorship.actor, "agent");
    assert.equal(extract({ ...base, source: "system", transformedContent: stamp + content }).userPrompt.authorship.actor, "unknown");
    assert.equal(promptAuthorship.fromEvent({ type: "user.message", timestamp: "2026-10-06T12:00:00Z",
        data: { ...base, transformedContent: stamp + content } }, { agentCreatedFirstMessage: true }).actor, "unknown");
});

test("supported host canvas-context suffix is neutral attachment data, not an author claim", () => {
    const content = "Invented short owner request.";
    const stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    const suffix = "\n\n<canvas-context>Invented attachment. " + sender + "</canvas-context>";
    const data = { content, messageId: "00000000-0000-4000-8000-000000000001", agentMode: "autopilot", delivery: "idle",
        transformedContent: stamp + content + suffix };
    assert.deepEqual(extract(data).userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    assert.equal(extract({ ...data, source: "agent-invented" }).userPrompt.authorship.actor, "agent");
    assert.equal(extract({ ...data, source: "user", transformedContent: stamp + sender + content + suffix }).userPrompt.authorship.basis, "conflicting-source");
    assert.equal(promptAuthorship.fromEvent({ type: "user.message", timestamp: "2026-10-06T12:00:00Z", data }, { agentCreatedFirstMessage: true }).actor, "unknown");
    for (const invalid of [
        suffix + "<extra>Invented extra wrapper</extra>",
        suffix.replace("<canvas-context>", '<canvas-context author="user">'),
        suffix.replace("</canvas-context>", ""),
        suffix + suffix,
    ]) assert.equal(extract({ ...data, transformedContent: stamp + content + invalid }).userPrompt.authorship.actor, "unknown");
    const imitation = content + suffix;
    assert.equal(extract({ ...data, content: imitation, transformedContent: stamp + imitation }).userPrompt.authorship.actor, "user",
        "Tags inside the exact displayed body cannot establish Agent provenance");
});

test("fixed host image reminder preserves direct-input provenance without accepting arbitrary system reminders", () => {
    const content = "Invented request with an attached image.";
    const stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const suffix = "\n\n<system_reminder>\nThe user mentioned images and they have been attached to this message in the order they were mentioned.\n</system_reminder>";
    const data = { content, messageId: "00000000-0000-4000-8000-000000000001", agentMode: "autopilot", delivery: "idle",
        transformedContent: stamp + content + suffix };
    assert.deepEqual(extract(data).userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    for (const invalid of [suffix + suffix, suffix.replace("images", "instructions"), suffix + "\n<extra>untrusted</extra>",
        suffix.replace("<system_reminder>", '<system_reminder source="user">')]) {
        assert.equal(extract({ ...data, transformedContent: stamp + content + invalid }).userPrompt.authorship.actor, "unknown");
    }
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    assert.equal(extract({ ...data, transformedContent: stamp + sender + content + suffix }).userPrompt.authorship.actor, "agent");
    assert.equal(extract({ ...data, source: "user", transformedContent: stamp + sender + content + suffix }).userPrompt.authorship.basis, "conflicting-source");
    assert.equal(promptAuthorship.fromEvent({ type: "user.message", timestamp: "2026-10-06T12:00:00Z", data },
        { agentCreatedFirstMessage: true }).actor, "unknown");
    const imitation = content + suffix;
    assert.equal(extract({ ...data, content: imitation, transformedContent: stamp + imitation }).userPrompt.authorship.actor, "user");
});

test("explicit system context explains unverified author without guessing from handoff prose", () => {
    const prompt = extract({ source: "system", content: "Invented handoff-style request.",
        transformedContent: "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\nDifferent injected context." }).userPrompt;
    assert.deepEqual(prompt.authorship, { actor: "unknown", basis: "system-source" });
    assert.match(promptAuthorship.reason(prompt), /system-supplied context/);
    assert.match(promptAuthorship.reason({ authorship: { actor: "unknown", basis: "invalid-source" } }), /host message format/);
});

test("normalized interaction reading preserves precise parsed author gaps without changing membership", () => {
    let membership, fingerprint;
    for (const [data, basis] of [
        [{ source: "system" }, "system-source"],
        [{}, "missing-source"],
        [{ source: "unsupported-invented-source" }, "unsupported-source"],
        [{ source: "user", isAutopilotContinuation: true }, "conflicting-source"],
        [{ isAutopilotContinuation: "true" }, "invalid-source"],
    ]) {
        const record = extract({ ...data, content: "<cross_session_message>Invented copied tag, not author evidence.</cross_session_message>" });
        const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: [record], exports: [] };
        const before = structuredClone(state), model = buildAssessmentModel(state);
        const detail = [...model.details.values()][0];
        assert.deepEqual(promptAuthorship.read(detail.interaction.message), { actor: "unknown", basis });
        assert.equal(promptAuthorship.reason(detail.interaction.message), promptAuthorship.reason(record.userPrompt));
        assert.equal(detail.interaction.message.origin, "recorded-unverified");
        assert.equal(detail.interaction.message.association, "nearest-preceding");
        assert.equal(model.catalog.length, 1);
        assert.equal(model.catalog[0].status, "retained");
        membership ??= detail.interaction.members;
        fingerprint ??= evaluationRecordFingerprint(record);
        assert.deepEqual(detail.interaction.members, membership);
        assert.equal(evaluationRecordFingerprint(record), fingerprint);
        assert.deepEqual(state, before);
    }
});

test("normalized author transport is strict while legacy messages remain unchanged", () => {
    const record = extract({ source: "system", content: "Invented system context." });
    const interaction = [...buildAssessmentModel({ revision: 1, pseudonymKey: "a".repeat(64),
        evidence: [record], exports: [] }).details.values()][0].interaction;
    for (const authorship of [
        undefined, null, {}, { actor: "unknown", basis: "source-user" },
        { actor: "unknown", basis: "invented-basis" },
        { actor: "unknown", basis: "system-source", sourceId: "invented-raw-sender" },
        { actor: "user", basis: "source-user" },
    ]) {
        assert.throws(() => validateInteraction({ ...interaction, message: { ...interaction.message, authorship } }), ContractError);
    }
    const legacy = structuredClone(interaction);
    delete legacy.message.authorship;
    const bytes = JSON.stringify(legacy);
    assert.equal(validateInteraction(legacy), legacy);
    assert.equal(JSON.stringify(legacy), bytes);
    assert.deepEqual(promptAuthorship.read(legacy.message), { actor: "unknown", basis: "legacy-missing" });
});

async function makeOldCheckpoint(app) {
    await app.runtime().collector.collectNow();
    const state = await loadBoardState(app.context);
    const records = structuredClone(state.evidence);
    for (const record of records) {
        delete record.userPrompt.authorship;
        delete record.userPrompt.authorshipVersion;
        for (const prompt of record.followUpPrompts) { delete prompt.authorship; delete prompt.authorshipVersion; }
    }
    await replaceEvidence(app.context, () => ({ records, importCoverage: state.importCoverage }));
    await app.restart(async () => {
        const file = path.join(app.context.dataDir, "collector", "index.json");
        const index = JSON.parse(await readFile(file, "utf8"));
        delete index.promptOrigins;
        for (const source of Object.values(index.sources)) {
            delete source.firstPromptEventId;
            delete source.promptStartObserved;
            delete source.promptQualification;
            delete source.promptEventQualification;
        }
        await writeFile(file, JSON.stringify(index));
    });
}

test("an existing retained kickoff gains author metadata without rewinding cursors, changing membership or rewriting frozen reports", async t => {
    const app = await promptInstallation(t);
    await makeOldCheckpoint(app);
    const before = await loadBoardState(app.context), originalFiles = await Promise.all(app.sourceFiles.map(file => readFile(file)));
    const indexPath = path.join(app.context.dataDir, "collector", "index.json");
    const beforeIndex = JSON.parse(await readFile(indexPath, "utf8"));
    const exports = createExportController(app.context);
    const preview = await exports.preview("invented-panel", undefined, { promptMode: "original", formats: ["html", "json", "markdown"] },
        { kind: "selected", scenarioIds: [app.cases[0].scenarioId], revision: before.revision });
    await exports.review("invented-panel", preview.previewId, true);
    const saved = await exports.confirm("invented-panel", preview.previewId, true);
    const frozenFiles = Object.values(saved.bundle.files), frozenBytes = await Promise.all(frozenFiles.map(file => readFile(file)));
    assert.match(preview.previewHtml, /Author not verified/);
    await app.runtime().collector.collectNow();
    const after = await loadBoardState(app.context), afterIndex = JSON.parse(await readFile(indexPath, "utf8"));
    assert.deepEqual(after.evidence.find(record => record.scenarioId === app.cases[0].scenarioId).userPrompt.authorship,
        { actor: "agent", basis: "parent-kickoff" });
    assert.deepEqual(after.evidence.find(record => record.scenarioId === app.cases.find(item => item.name === "human").scenarioId).userPrompt.authorship,
        { actor: "user", basis: "host-direct-input" }, "Recover the original host envelope, never default stripped retained metadata");
    for (const record of after.evidence) {
        const previous = before.evidence.find(value => value.scenarioId === record.scenarioId);
        assert.equal(record.userPrompt.text, previous.userPrompt.text);
        assert.equal(record.userPrompt.sourceEventId, previous.userPrompt.sourceEventId);
        assert.deepEqual(record.toolCalls, previous.toolCalls);
    }
    for (const [id, source] of Object.entries(beforeIndex.sources)) assert.deepEqual(afterIndex.sources[id].cursor, source.cursor);
    assert.deepEqual(after.deletion, before.deletion);
    assert.deepEqual(await Promise.all(frozenFiles.map(file => readFile(file))), frozenBytes);
    assert.deepEqual(await Promise.all(app.sourceFiles.map(file => readFile(file))), originalFiles);
    assert.ok(afterIndex.metrics.lastBytesRead > 0 && afterIndex.metrics.lastBytesRead <= TAIL_LIMITS.cycleBytes);
    await app.runtime().collector.collectNow();
    assert.equal((await app.runtime().collector.status()).metrics.lastBytesRead, 0, "Unchanged logs are not scanned again for already-qualified origins");
    const newPreview = await exports.preview("invented-panel", undefined, { promptMode: "original", formats: ["html"] },
        { kind: "selected", scenarioIds: [app.cases[0].scenarioId], revision: (await loadBoardState(app.context)).revision });
    assert.match(newPreview.previewHtml, /<h4\b[^>]*data-prompt-actor="agent"[^>]*>Agent prompt<\/h4>/);
});

test("missing original creator history never invents the legacy kickoff author", async t => {
    const app = await promptInstallation(t);
    await makeOldCheckpoint(app);
    await rename(app.sourceFiles[0], app.sourceFiles[0] + ".missing");
    await app.runtime().collector.collectNow();
    const state = await loadBoardState(app.context);
    assert.equal(promptAuthorship.read(state.evidence.find(record => record.scenarioId === app.cases[0].scenarioId).userPrompt).actor, "unknown");
    const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json"), "utf8"));
    assert.equal(index.sources[app.child].promptQualification.reason, "creator-history-missing");
    await app.runtime().collector.collectNow();
    assert.equal((await app.runtime().collector.status()).metrics.lastBytesRead, 0);
    await rename(app.sourceFiles[0] + ".missing", app.sourceFiles[0]);
    await app.runtime().collector.collectNow();
    assert.equal(promptAuthorship.read((await loadBoardState(app.context)).evidence.find(record => record.scenarioId === app.cases[0].scenarioId).userPrompt).actor, "agent");
});

test("old completed classifier lookups do not strand exact image and system records or rescan after qualification", async t => {
    const app = await promptInstallation(t);
    const file = app.sourceFiles[1];
    const events = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const human = app.cases.find(row => row.name === "human"), system = app.cases.find(row => row.name === "legacy");
    const humanEvent = events.find(event => event.id === human.promptId);
    humanEvent.data.transformedContent += "\n\n<system_reminder>\nThe user mentioned images and they have been attached to this message in the order they were mentioned.\n</system_reminder>";
    Object.assign(events.find(event => event.id === system.promptId).data, { source: "system" });
    await writeFile(file, events.map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    const before = await loadBoardState(app.context);
    await replaceEvidence(app.context, records => ({ records: records.map(record => [human.scenarioId, system.scenarioId].includes(record.scenarioId)
        ? { ...record, userPrompt: { ...record.userPrompt, authorshipVersion: 3,
            authorship: { actor: "unknown", basis: record.scenarioId === human.scenarioId ? "invalid-source" : "unsupported-source" } } } : record)
            .map(record => ({ ...record, graphActivities: record.graphActivities ?? [] })),
        importCoverage: before.importCoverage }));
    const originalBytes = await readFile(file);
    const old = await loadBoardState(app.context);
    const indexFile = path.join(app.context.dataDir, "collector", "index.json");
    let mainCursor;
    await app.restart(async () => {
        const index = JSON.parse(await readFile(indexFile, "utf8"));
        const source = index.sources[app.child];
        mainCursor = structuredClone(source.cursor);
        const targets = old.evidence.filter(record => [human.scenarioId, system.scenarioId].includes(record.scenarioId));
        source.promptEventQualification = { status: "complete", lookupVersion: 2, classifierVersion: 3, identity: source.cursor.identity,
            matchedEventIds: targets.map(record => record.userPrompt.sourceEventId),
            targetKeys: targets.map(record => hash(JSON.stringify([record.userPrompt.sourceEventId, record.userPrompt.sourceTimestamp,
                hash(record.userPrompt.text)]))).sort() };
        await writeFile(indexFile, JSON.stringify(index));
    });
    await app.runtime().collector.collectNow();
    const after = await loadBoardState(app.context);
    assert.deepEqual(after.evidence.find(record => record.scenarioId === human.scenarioId).userPrompt.authorship,
        { actor: "user", basis: "host-direct-input" });
    assert.deepEqual(after.evidence.find(record => record.scenarioId === system.scenarioId).userPrompt.authorship,
        { actor: "unknown", basis: "system-source" });
    for (const record of after.evidence) {
        assert.equal(evaluationRecordFingerprint(record), evaluationRecordFingerprint(old.evidence.find(item => item.scenarioId === record.scenarioId)));
    }
    assert.deepEqual(JSON.parse(await readFile(indexFile, "utf8")).sources[app.child].cursor, mainCursor);
    assert.deepEqual(await readFile(file), originalBytes);
    assert.deepEqual(after.deletion, old.deletion);
    await app.runtime().collector.collectNow();
    assert.equal((await app.runtime().collector.status()).metrics.lastBytesRead, 0);
});

test("targeted qualification stops at its byte budget and resumes rather than rescanning a creator", async t => {
    const app = await promptInstallation(t);
    const parentEvents = (await readFile(app.sourceFiles[0], "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const filler = Array.from({ length: 6 }, () => ({ id: randomUUID(), type: "session.info",
        timestamp: parentEvents[0].timestamp, data: { message: "Invented padding only. ".repeat(40000) } }));
    await writeFile(app.sourceFiles[0], [parentEvents[0], ...filler, ...parentEvents.slice(1)].map(event => JSON.stringify(event) + "\n").join(""));
    const roster = discoverSources(app.config).roster, source = roster.find(row => row.sessionId === app.child), creator = roster.find(row => row.sessionId === app.parent);
    const events = (await readFile(app.sourceFiles[1], "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const records = extractScenarios(events, source, new Date(Date.now() - 86400000).toISOString(), new Date().toISOString()).scenarios;
    const budget = TAIL_LIMITS.chunkBytes + 131328;
    const first = await qualifyRetainedKickoff(app.config, source, creator, records, undefined, budget);
    assert.equal(first.checkpoint.status, "pending");
    assert.ok(first.checkpoint.cursor.offset > 0);
    assert.ok(first.bytesRead <= budget);
    const second = await qualifyRetainedKickoff(app.config, source, creator, records, first.checkpoint, budget);
    assert.equal(second.checkpoint.status, "qualified");
    assert.deepEqual(second.authorship, { actor: "agent", basis: "parent-kickoff" });
    assert.ok(second.bytesRead <= budget);
});

test("ordinary retained-message qualification resumes within its shared byte budget", async t => {
    const app = await promptInstallation(t);
    const events = (await readFile(app.sourceFiles[1], "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const human = app.cases.find(item => item.name === "human");
    const position = events.findIndex(event => event.id === human.promptId);
    const filler = Array.from({ length: 6 }, () => ({ id: randomUUID(), type: "session.info",
        timestamp: events[0].timestamp, data: { message: "Invented padding only. ".repeat(40000) } }));
    await writeFile(app.sourceFiles[1], [...events.slice(0, position), ...filler, ...events.slice(position)].map(event => JSON.stringify(event) + "\n").join(""));
    const source = discoverSources(app.config).roster.find(row => row.sessionId === app.child);
    const record = { userPrompt: { sourceEventId: human.promptId, text: human.data.content, sourceTimestamp: events[position].timestamp } };
    const budget = TAIL_LIMITS.chunkBytes + 131328;
    const first = await qualifyRetainedPromptEvents(app.config, source, [record], undefined, budget);
    assert.equal(first.checkpoint.status, "pending");
    assert.deepEqual(first.updates, []);
    assert.ok(first.bytesRead <= budget);
    const second = await qualifyRetainedPromptEvents(app.config, source, [record], first.checkpoint, budget);
    assert.equal(second.checkpoint.status, "complete");
    assert.ok(second.bytesRead <= budget);
    assert.deepEqual(second.updates, [{ eventId: human.promptId, authorship: { actor: "user", basis: "host-direct-input" } }]);
});

test("a retained early event outside the byte tail is qualified within the same source and cycle budgets", async t => {
    const app = await promptInstallation(t), human = app.cases.find(item => item.name === "human");
    const original = (await readFile(app.sourceFiles[1], "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const target = original.find(event => event.id === human.promptId);
    const padding = JSON.stringify({ id: randomUUID(), type: "session.info", timestamp: new Date(Date.now() - 10000).toISOString(),
        data: { message: "Invented bounded lookup padding. ".repeat(300) } }) + "\n";
    const chunk = padding.repeat(64), handle = await open(app.sourceFiles[1], "a");
    try {
        let bytes = (await handle.stat()).size;
        while (bytes <= TAIL_LIMITS.initialFileBytes + 4 * 1024 ** 2) {
            await handle.write(chunk); bytes += Buffer.byteLength(chunk);
        }
    } finally { await handle.close(); }
    assert.ok((await stat(app.sourceFiles[1])).size > TAIL_LIMITS.initialFileBytes);
    const source = discoverSources(app.config).roster.find(row => row.sessionId === app.child);
    const records = [{ userPrompt: { sourceEventId: target.id, sourceTimestamp: target.timestamp, text: target.data.content } }];
    const result = await qualifyRetainedPromptEvents(app.config, source, records, undefined, TAIL_LIMITS.cycleBytes);
    assert.equal(result.checkpoint.status, "complete");
    assert.deepEqual(result.updates, [{ eventId: target.id, authorship: { actor: "user", basis: "host-direct-input" } }]);
    assert.ok(result.bytesRead <= TAIL_LIMITS.cycleBytes);
    assert.ok(result.checkpoint.lookupBytes <= TAIL_LIMITS.initialFileBytes);
    const missing = [{ userPrompt: { ...records[0].userPrompt, sourceEventId: randomUUID() } }];
    let checkpoint, spent = 0, exhausted;
    for (let cycle = 0; cycle < 4; cycle++) {
        exhausted = await qualifyRetainedPromptEvents(app.config, source, missing, checkpoint, TAIL_LIMITS.cycleBytes);
        assert.deepEqual(exhausted.updates, [], "Matching wording without the original ID cannot establish an author");
        assert.ok(exhausted.bytesRead <= TAIL_LIMITS.cycleBytes);
        spent += exhausted.bytesRead;
        checkpoint = exhausted.checkpoint;
        if (checkpoint.status !== "pending") break;
    }
    assert.equal(checkpoint.status, "unavailable");
    assert.equal(checkpoint.reason, "original-event-lookup-budget");
    assert.ok(spent <= TAIL_LIMITS.initialFileBytes);
    const noRetry = await qualifyRetainedPromptEvents(app.config, source, missing, checkpoint, TAIL_LIMITS.cycleBytes);
    assert.equal(noRetry.bytesRead, 0, "Exhausted source budget cannot silently start another sweep");
});

test("missing, conflicting and invalid metadata never fall back to wording or role", () => {
    for (const data of [
        { content: "<cross_session_message>Not proof</cross_session_message>" },
        { source: "system", content: "I am a human" },
        { source: "user", isAutopilotContinuation: true, content: "Conflict" },
    ]) assert.equal(extract(data).userPrompt.authorship.actor, "unknown");
    assert.deepEqual(promptAuthorship.read({ authorship: { actor: "user", basis: "source-agent" } }),
        { actor: "unknown", basis: "invalid-source" });
    for (const authorship of [{}, 1, true, [], { actor: "user" }, { actor: "user", basis: "source-user", sourceId: "invented-raw-id" }]) {
        assert.deepEqual(promptAuthorship.read({ authorship }), { actor: "unknown", basis: "invalid-source" });
        assert.doesNotThrow(() => promptAuthorship.reason({ authorship }));
    }
    assert.equal(extract({ source: "user", isAutopilotContinuation: "true", content: "Invalid flag" }).userPrompt.authorship.actor, "unknown");
    assert.equal(promptAuthorship.read({ provenance: "human-authored" }).actor, "unknown");
});

test("real collector retains author evidence, qualifies kickoffs and survives restart without source rewrites", async t => {
    const app = await promptInstallation(t);
    const original = await Promise.all(app.sourceFiles.map(file => readFile(file)));
    await app.runtime().collector.collectNow();
    const state = await loadBoardState(app.context);
    const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json"), "utf8"));
    const checkpoint = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", index.fingerprint, `${app.child}.json`), "utf8"));
    assert.ok(checkpoint.events.filter(event => event.type === "user.message").every(event => !Object.hasOwn(event.data, "transformedContent")));
    for (const item of app.cases) {
        const record = state.evidence.find(record => record.scenarioId === item.scenarioId);
        assert.ok(record, item.name);
        assert.deepEqual(record.userPrompt.authorship, { actor: item.actor, basis: item.basis }, item.name);
        assert.equal(record.userPrompt.text, item.data.content, item.name);
        assert.equal(record.toolCalls[0].toolCallId, item.callId);
    }
    const model = buildAssessmentModel(state);
    for (const item of model.catalog) {
        const detail = model.details.get(item.interactionRef);
        const prompt = state.evidence.find(record => record.scenarioId === item.scenarioId).userPrompt;
        assert.ok(["user", "agent", "recorded-unverified"].includes(detail.interaction.message.origin));
        assert.deepEqual(detail.interaction.message.authorship, prompt.authorship);
        assert.equal(promptAuthorship.reason(detail.interaction.message), promptAuthorship.reason(prompt));
        assert.equal(detail.interaction.message.association, "nearest-preceding");
    }
    await app.restart();
    await app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence, state.evidence);
    assert.deepEqual(await Promise.all(app.sourceFiles.map(file => readFile(file))), original);
});
