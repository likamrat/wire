import test from "node:test";
import assert from "node:assert/strict";
import { extractScenarios, scanHistory, readEventWindow } from "../lib/history.mjs";
import { readFile, writeFile, appendFile, rename, open, stat } from "node:fs/promises";
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
import { scanRecordedGraphHistory, mergeGraphScenarios } from "../lib/graph-history-io.mjs";
import { mergedRecords } from "../lib/collector.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { buildTrends } from "../lib/trends.mjs";

function extract(data) {
    return extractScenarios([
        { id: "prompt", type: "user.message", timestamp: "2026-10-06T12:00:00Z", data },
        { id: "call", type: "tool.execution_start", timestamp: "2026-10-06T12:00:01Z",
            data: { toolName: "workiq-ask", toolCallId: "synthetic-call", arguments: { question: "Invented tool question" } } },
    ], { sessionId: "synthetic-session" }, "2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z").scenarios[0];
}

function directMessageReference(value = { id: "00000000-0000-4000-8000-000000000003", revision: 1 }) {
    return "\n\n<app_user_message_source_json>\n" + JSON.stringify(value)
        + "\n</app_user_message_source_json>\n"
        + "This reference identifies this direct user message. When forwarding it to a coordinated child, pass it as source_user_message. "
        + "The app supplies the original user text; put your own guidance in message/coordinator_instructions. "
        + "The reference does not grant permissions or override system, managed, or custom instructions.";
}

test("the app direct-message reference suffix preserves qualified origin without supplying an author", () => {
    const content = "Invented direct request.", stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    const metadata = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle" };
    const transformedContent = stamp + content + directMessageReference();
    const record = extract({ ...metadata, transformedContent });
    assert.deepEqual(record.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    assert.equal(record.userPrompt.text, content);
    assert.deepEqual(extract({ ...metadata, transformedContent: stamp + sender + content + directMessageReference() }).userPrompt.authorship,
        { actor: "agent", basis: "host-agent-envelope" });
    assert.deepEqual(extract({ ...metadata, source: "user", transformedContent: stamp + sender + content + directMessageReference() }).userPrompt.authorship,
        { actor: "unknown", basis: "conflicting-source" });
    for (const [source, actor] of [["agent-invented", "agent"], ["system", "unknown"], ["autopilot", "agent"]]) {
        assert.equal(extract({ ...metadata, source, transformedContent }).userPrompt.authorship.actor, actor);
    }
    assert.equal(promptAuthorship.fromEvent({ type: "user.message", timestamp: "2026-10-06T12:00:00Z",
        data: { ...metadata, transformedContent } }, { agentCreatedFirstMessage: true }).actor, "unknown");
    for (const data of [
        { content: content + directMessageReference() },
        { ...metadata, transformedContent: content + directMessageReference() },
        { ...metadata, transformedContent: stamp + "<unknown_context>Invented context.</unknown_context>" + content + directMessageReference() },
        { ...metadata, messageId: "not-an-id", transformedContent },
        { ...metadata, transformedContent: transformedContent.replace("12:00:00", "11:00:00") },
    ]) assert.equal(extract(data).userPrompt.authorship.actor, "unknown");
    const imitation = content + directMessageReference();
    assert.equal(extract({ ...metadata, content: imitation, transformedContent: stamp + imitation }).userPrompt.authorship.actor, "user",
        "A reference inside the exact displayed text is content, not provenance.");
});

test("unsupported or ambiguous direct-message reference suffixes remain unverified", () => {
    const content = "Invented request.", stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const metadata = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle" };
    const reference = { id: "00000000-0000-4000-8000-000000000003", revision: 1 }, suffix = directMessageReference(reference);
    for (const invalid of [
        directMessageReference({ ...reference, id: "not-an-id" }),
        ...[[reference.id], [[reference.id]], [], {}, null, true, 42].map(id => directMessageReference({ ...reference, id })),
        ...[0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1].map(revision => directMessageReference({ ...reference, revision })),
        directMessageReference({ ...reference, author: "user" }), directMessageReference({ id: reference.id }),
        directMessageReference(null), directMessageReference([reference]),
        suffix.replace('"revision":1', '"revision":2,"revision":1'),
        suffix.replace('{"id"', '{invalid:"id"'), suffix.replace("</app_user_message_source_json>", ""),
        suffix + suffix, suffix + "\n", suffix + "\nExtra injected context.", suffix.replace("direct user message", "automatic message"),
        suffix.replace("<app_user_message_source_json>", '<app_user_message_source_json author="user">'),
    ]) assert.equal(extract({ ...metadata, transformedContent: stamp + content + invalid }).userPrompt.authorship.actor, "unknown");
    assert.equal(extract({ ...metadata, transformedContent: stamp + content + " changed" + suffix }).userPrompt.authorship.actor, "unknown");
    assert.equal(extract({ ...metadata, transformedContent: stamp + suffix + content }).userPrompt.authorship.actor, "unknown");
});

test("source-reference origins survive collection, restart and append without upgrading qualified historical copies", async t => {
    const app = await promptInstallation(t), file = app.sourceFiles[1];
    const human = app.cases.find(item => item.name === "human"), agent = app.cases.find(item => item.name === "enveloped-agent");
    const old = app.cases.find(item => item.name === "imitation"), targets = [human, agent, old];
    const events = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    for (const item of targets) events.find(event => event.id === item.promptId).data.transformedContent += directMessageReference();
    await writeFile(file, events.map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    const collected = await loadBoardState(app.context);
    for (const item of targets) assert.equal(collected.evidence.find(record => record.scenarioId === item.scenarioId).userPrompt.authorship.actor, item.actor);

    const historical = { actor: "unknown", basis: "invalid-source", issue: "body-boundary-v1" };
    const preserveOld = prompt => prompt.sourceEventId === old.promptId
        ? { ...prompt, authorship: historical, authorshipVersion: 8 } : prompt;
    await replaceEvidence(app.context, records => ({ records: records.map(record => ({ ...record,
        userPrompt: preserveOld(record.userPrompt), followUpPrompts: record.followUpPrompts.map(preserveOld) })),
        importCoverage: collected.importCoverage }));
    const indexFile = path.join(app.context.dataDir, "collector", "index.json");
    let cursor;
    await app.restart(async () => {
        const index = JSON.parse(await readFile(indexFile, "utf8"));
        cursor = structuredClone(index.sources[app.child].cursor);
        const checkpointFile = path.join(app.context.dataDir, "collector", index.fingerprint, `${app.child}.json`);
        const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
        const retained = checkpoint.events.find(event => event.id === old.promptId);
        retained.data.wirePromptAuthorship = historical;
        retained.data.wirePromptAuthorshipVersion = 8;
        assert.ok(checkpoint.events.filter(event => targets.some(item => item.promptId === event.id))
            .every(event => !Object.hasOwn(event.data, "transformedContent")));
        await writeFile(checkpointFile, JSON.stringify(checkpoint));
    });
    await app.runtime().collector.collectNow();
    let state = await loadBoardState(app.context);
    assert.deepEqual(JSON.parse(await readFile(indexFile, "utf8")).sources[app.child].cursor, cursor);
    assert.equal((await app.runtime().collector.status()).metrics.lastBytesRead, 0, "Version 8 originals are not reopened by version 9.");
    const records = targets.map(item => state.evidence.find(record => record.scenarioId === item.scenarioId));
    const expected = ["user", "agent", "unknown"];
    const model = buildAssessmentModel(state);
    for (const [i, record] of records.entries()) {
        const author = promptAuthorship.read(record.userPrompt);
        assert.equal(author.actor, expected[i]);
        const detail = model.details.get(model.catalog.find(row => row.scenarioId === record.scenarioId).interactionRef);
        assert.deepEqual(detail.interaction.message.authorship, author);
        if (i < 2) assert.equal(promptAuthorship.display(record.userPrompt).label, i === 0 ? "My prompt" : "Agent prompt");
        else assert.match(promptAuthorship.reason(record.userPrompt), /supported host message layout/);
        const filtered = buildActivityAnalytics(records, { filters: { scope: "all", promptAuthors: [expected[i]] } });
        assert.deepEqual(filtered.rows.map(row => row.scenarioId), [record.scenarioId]);
    }
    assert.deepEqual(createPercentageCharts({ authorship: promptAuthorship }).authorUsage(records).rows.map(row => row.count), [1, 1, 1]);
    const date = events.find(event => event.id === human.promptId).timestamp.slice(0, 10);
    const trends = buildTrends(state, { expectedRevision: state.revision, from: date, to: date, filters: {},
        timeContext: { timeZone: "UTC", locale: "en-US" } }, { records });
    assert.deepEqual(trends.totals.values.authors.map(row => row.count), [1, 1, 1]);

    const exports = createExportController(app.context);
    const preview = await exports.preview("source-reference-proof", undefined, { promptMode: "original", formats: ["json", "markdown"] },
        { kind: "selected", scenarioIds: targets.map(item => item.scenarioId), revision: state.revision });
    const snapshot = JSON.parse(preview.files["product-report.json"]);
    assert.deepEqual(snapshot.records.map(record => record.prompts.find(prompt => prompt.kind === "origin").authorship.actor).sort(), [...expected].sort());
    await exports.review("source-reference-proof", preview.previewId, true);
    const saved = await exports.confirm("source-reference-proof", preview.previewId, true);
    const savedFiles = Object.values(saved.bundle.files), savedBytes = await Promise.all(savedFiles.map(file => readFile(file)));

    const laterId = randomUUID(), now = new Date().toISOString(), content = "Invented later direct request.";
    await appendFile(file, [
        { id: randomUUID(), type: "assistant.message", timestamp: now,
            data: { originatingMessageId: events.find(event => event.id === old.promptId).data.messageId,
                turnId: "invented-old-turn", toolRequests: [{ toolCallId: "invented-old-late-call" }] } },
        { id: randomUUID(), type: "tool.execution_start", timestamp: now,
            data: { toolName: "workiq-ask", toolCallId: "invented-old-late-call", turnId: "invented-old-turn",
                arguments: { question: "Invented generated tool question." } } },
        { id: laterId, type: "user.message", timestamp: now, data: { content, messageId: randomUUID(), delivery: "idle",
            transformedContent: `<current_datetime>${now}</current_datetime>\n\n${content}${directMessageReference()}` } },
        { id: randomUUID(), type: "tool.execution_start", timestamp: now,
            data: { toolName: "workiq-ask", toolCallId: "invented-new-call", arguments: { question: "Invented generated tool question." } } },
    ].map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    await app.restart();
    await app.runtime().collector.collectNow();
    state = await loadBoardState(app.context);
    const previous = state.evidence.find(record => record.scenarioId === old.scenarioId);
    assert.deepEqual(previous.userPrompt.authorship, historical);
    assert.equal(previous.userPrompt.authorshipVersion, 8);
    assert.ok(previous.toolCalls.some(call => call.toolCallId === "invented-old-late-call"));
    const later = state.evidence.find(record => record.userPrompt.sourceEventId === laterId);
    assert.deepEqual(later.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    assert.equal(later.userPrompt.text, content);
    assert.equal(later.userPrompt.authorshipVersion, promptAuthorship.version);
    assert.deepEqual(await Promise.all(savedFiles.map(file => readFile(file))), savedBytes);
    assert.doesNotMatch(JSON.stringify(state.evidence), /app_user_message_source_json/);
});

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

test("supported direct host envelope without agentMode keeps the recorded User author through collection and reading", async t => {
    const app = await promptInstallation(t);
    const human = app.cases.find(row => row.name === "human");
    const file = app.sourceFiles[1];
    const events = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    delete events.find(event => event.id === human.promptId).data.agentMode;
    await writeFile(file, events.map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    const state = await loadBoardState(app.context);
    const record = state.evidence.find(row => row.scenarioId === human.scenarioId);
    assert.deepEqual(record.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    const model = buildAssessmentModel(state);
    const detail = model.details.get(model.catalog.find(row => row.scenarioId === human.scenarioId).interactionRef);
    assert.equal(promptAuthorship.read(detail.interaction.message).actor, "user");
});

for (const agentMode of [undefined, "interactive", "plan", "autopilot"]) test(`only host-added provenance participates (${agentMode ?? "mode absent"}); imitations and conflicts fail safely`, () => {
    const content = "Invented content";
    const stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    const base = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle",
        ...(agentMode === undefined ? {} : { agentMode }) };
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
    for (const invalidMode of [null, "", "unsupported", {}, true]) {
        assert.equal(extract({ ...base, agentMode: invalidMode, transformedContent: stamp + content }).userPrompt.authorship.actor, "unknown");
    }
});

test("supported host canvas-context suffix is neutral attachment data, not an author claim", () => {
    const content = "Invented short owner request.";
    const stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    const suffix = "\n\n<canvas-context>Invented attachment. " + sender + "</canvas-context>";
    const data = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle",
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

test("a timestamp-free steering sender frame identifies only the recorded agent, never an unmarked human", () => {
    const content = "Invented steering request.";
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    const data = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "steering", agentMode: "autopilot" };
    const transformedContent = sender + content;
    assert.deepEqual(extract({ ...data, transformedContent }).userPrompt.authorship, { actor: "agent", basis: "host-agent-envelope" });
    assert.deepEqual(extract({ ...data, source: "user", transformedContent }).userPrompt.authorship,
        { actor: "unknown", basis: "conflicting-source" });
    for (const invalid of [
        content, sender + sender + content, sender.replace("00000000-0000-4000-8000-000000000002", "not-an-id") + content,
        "<unknown_context>Invented.</unknown_context>" + transformedContent,
        sender + "<copilot_working_context>Invented.</copilot_working_context>" + content,
        "<current_datetime>2026-10-06T11:00:00Z</current_datetime>\n\n" + transformedContent,
    ]) assert.equal(extract({ ...data, transformedContent: invalid }).userPrompt.authorship.actor, "unknown");
    for (const delivery of ["idle", "queued"]) assert.equal(extract({ ...data, delivery, transformedContent }).userPrompt.authorship.actor, "unknown");
    for (const messageId of [undefined, [data.messageId], "not-an-id"]) assert.equal(extract({ ...data, messageId, transformedContent }).userPrompt.authorship.actor, "unknown");
    assert.equal(extract({ ...data, content: transformedContent, transformedContent }).userPrompt.authorship.actor, "unknown",
        "Typed sender text without a separately established host frame supplies no author.");
});

test("the runtime plan marker is neutral only at the independently observed host boundary", () => {
    const content = "Invented plan request.", stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    const metadata = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle", agentMode: "plan" };
    assert.deepEqual(extract({ ...metadata, transformedContent: stamp + "[[PLAN]] " + content }).userPrompt.authorship,
        { actor: "user", basis: "host-direct-input" });
    assert.deepEqual(extract({ ...metadata, transformedContent: stamp + "[[PLAN]] " + sender + content }).userPrompt.authorship,
        { actor: "agent", basis: "host-agent-envelope" });
    assert.deepEqual(extract({ ...metadata, source: "user", transformedContent: stamp + "[[PLAN]] " + sender + content }).userPrompt.authorship,
        { actor: "unknown", basis: "conflicting-source" });
    for (const prefix of ["[[PLAN]]\n", "[[PLAN]]", "[PLAN] ", "[[PLAN]] [[PLAN]] ", "Invented: [[PLAN]] "]) {
        assert.equal(extract({ ...metadata, transformedContent: stamp + prefix + sender + content }).userPrompt.authorship.actor, "unknown");
    }
    for (const malformed of [sender + sender, sender.replace("00000000-0000-4000-8000-000000000002", "not-an-id")]) {
        assert.equal(extract({ ...metadata, transformedContent: stamp + "[[PLAN]] " + malformed + content }).userPrompt.authorship.actor, "unknown");
    }
    const imitation = "[[PLAN]] " + sender + content;
    assert.deepEqual(extract({ ...metadata, content: imitation, transformedContent: stamp + "[[PLAN]] " + imitation }).userPrompt.authorship,
        { actor: "user", basis: "host-direct-input" }, "Plan and sender text inside the complete displayed body cannot supply agent origin.");
});

test("qualified runtime trailing-whitespace removal preserves exact original text and does not normalize leading or internal text", () => {
    const content = "  Invented planning request. \n";
    const stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const metadata = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle" };
    const body = content.replace(/[ \r\n]+$/u, "");
    for (const prefix of [stamp, stamp + "[[PLAN]] "]) {
        const record = extract({ ...metadata, transformedContent: prefix + body });
        assert.deepEqual(record.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
        assert.equal(record.userPrompt.text, content);
        for (const changed of [body.trimStart(), body.replace("planning ", ""), body.replace(" ", "\t")]) {
            assert.equal(extract({ ...metadata, transformedContent: prefix + changed }).userPrompt.authorship.actor, "unknown");
        }
    }
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    assert.deepEqual(extract({ ...metadata, transformedContent: stamp + sender + body }).userPrompt.authorship,
        { actor: "agent", basis: "host-agent-envelope" });
    const imitation = sender + content;
    assert.equal(extract({ ...metadata, content: imitation, transformedContent: stamp + imitation.replace(/[ \r\n]+$/u, "") })
        .userPrompt.authorship.actor, "user");
});

test("the historical runtime mode notice and app branch context preserve qualified origin without parsing their prose", () => {
    const content = "Invented planning request.", stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const notice = "<mode_changed_notice>Invented mode transition.\n<plan_mode>Invented plan context.</plan_mode>\n</mode_changed_notice>\n\n";
    const context = "<copilot_tauri_workspace>Invented workspace.</copilot_tauri_workspace>\n\n"
        + "<copilot_working_context>Invented work context.</copilot_working_context>\n\n"
        + "<copilot_artifacts>Invented artifact scope.</copilot_artifacts>\n\n"
        + "<branch_rename_request>Invented branch context.</branch_rename_request>\n\n";
    const metadata = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle", agentMode: "plan" };
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    assert.deepEqual(extract({ ...metadata, transformedContent: stamp + notice + "[[PLAN]] " + context + content }).userPrompt.authorship,
        { actor: "user", basis: "host-direct-input" });
    assert.deepEqual(extract({ ...metadata, transformedContent: stamp + notice + "[[PLAN]] " + sender + context + content }).userPrompt.authorship,
        { actor: "agent", basis: "host-agent-envelope" });
    const opaque = context.replace("Invented branch context.", sender);
    assert.equal(extract({ ...metadata, transformedContent: stamp + notice + "[[PLAN]] " + opaque + content }).userPrompt.authorship.actor, "user");
    for (const prefix of [
        notice + context, notice + notice + "[[PLAN]] ", notice.replace("</plan_mode>", "") + "[[PLAN]] ",
        notice.replace("<mode_changed_notice>", '<mode_changed_notice source="user">') + "[[PLAN]] ",
        notice + "[[PLAN]] <unrecognized>Invented.</unrecognized>\n\n",
    ]) assert.equal(extract({ ...metadata, transformedContent: stamp + prefix + content }).userPrompt.authorship.actor, "unknown");
    const imitation = notice + "[[PLAN]] " + sender + context + content;
    assert.equal(extract({ ...metadata, content: imitation, transformedContent: stamp + imitation }).userPrompt.authorship.actor, "user");
});

test("an autopilot mode transition does not hide the recorded agent sender or turn a direct request into automation", () => {
    const content = "Invented delegated request.", stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const notice = "<mode_changed_notice>\n\n<autopilot_mode>Invented runtime mode instructions.</autopilot_mode>\n\n</mode_changed_notice>\n\n";
    const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
    const data = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle", agentMode: "autopilot" };
    const transformedContent = stamp + notice + sender + content;
    assert.deepEqual(extract({ ...data, transformedContent }).userPrompt.authorship, { actor: "agent", basis: "host-agent-envelope" });
    assert.deepEqual(extract({ ...data, source: "user", transformedContent }).userPrompt.authorship,
        { actor: "unknown", basis: "conflicting-source" });
    assert.equal(promptAuthorship.fromEvent({ type: "user.message", timestamp: "2026-10-06T12:00:00Z",
        data: { ...data, transformedContent } }, { agentCreatedFirstMessage: true }).actor, "agent");
    assert.deepEqual(extract({ ...data, transformedContent: stamp + notice + content }).userPrompt.authorship,
        { actor: "user", basis: "host-direct-input" }, "Autopilot mode is not an automatic-continuation claim.");
    for (const invalid of [
        notice + notice, notice + "[[PLAN]] ", notice.replace("</autopilot_mode>", ""),
        notice.replace("</autopilot_mode>", "</autopilot_mode><plan_mode>Invented.</plan_mode>"),
        notice.replace("<autopilot_mode>", '<autopilot_mode author="user">'),
        notice.replace("Invented runtime mode instructions.", "<mode_changed_notice>Invented nesting.</mode_changed_notice>"),
    ]) assert.equal(extract({ ...data, transformedContent: stamp + invalid + sender + content }).userPrompt.authorship.actor, "unknown");
    for (const agentMode of [undefined, "plan", "interactive"]) {
        assert.equal(extract({ ...data, agentMode, transformedContent }).userPrompt.authorship.actor, "unknown");
    }
    for (const messageId of [undefined, [data.messageId], "not-an-id"]) {
        assert.equal(extract({ ...data, messageId, transformedContent }).userPrompt.authorship.actor, "unknown");
    }
    const imitation = notice + sender + content;
    assert.equal(extract({ ...data, content: imitation, transformedContent: stamp + imitation }).userPrompt.authorship.actor, "user");
});

test("mode-transition and steering agents retain their originating authors through collection, restart and late calls", async t => {
    const app = await promptInstallation(t), file = app.sourceFiles[1];
    const items = ["human", "enveloped-agent"].map(name => app.cases.find(item => item.name === name));
    const events = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const [mode, steering] = items.map(item => events.find(event => event.id === item.promptId));
    const sender = `<cross_session_message>\nfrom_session_id: ${app.parent}\n</cross_session_message>\n\n`;
    mode.data.agentMode = "autopilot";
    mode.data.transformedContent = `<current_datetime>${mode.timestamp}</current_datetime>\n\n`
        + "<mode_changed_notice>\n\n<autopilot_mode>Invented mode context.</autopilot_mode>\n\n</mode_changed_notice>\n\n"
        + sender + mode.data.content;
    steering.data.delivery = "steering";
    steering.data.transformedContent = sender + steering.data.content;
    await writeFile(file, events.map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    const before = await loadBoardState(app.context);
    for (const item of items) assert.deepEqual(before.evidence.find(record => record.scenarioId === item.scenarioId).userPrompt.authorship,
        { actor: "agent", basis: "host-agent-envelope" });
    await app.restart();
    const now = new Date().toISOString();
    await appendFile(file, [
        { id: randomUUID(), type: "assistant.message", timestamp: now,
            data: { originatingMessageId: mode.data.messageId, turnId: "mode-later", toolRequests: [{ toolCallId: "mode-later-call" }] } },
        { id: randomUUID(), type: "tool.execution_start", timestamp: now,
            data: { toolName: "workiq-ask", toolCallId: "mode-later-call", turnId: "mode-later", arguments: { question: "Invented tool question." } } },
    ].map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    const after = await loadBoardState(app.context);
    for (const item of items) {
        const record = after.evidence.find(record => record.scenarioId === item.scenarioId);
        assert.deepEqual(record.userPrompt.authorship, { actor: "agent", basis: "host-agent-envelope" });
        assert.equal(record.userPrompt.text, item.data.content);
    }
    assert.ok(after.evidence.find(record => record.scenarioId === items[0].scenarioId).toolCalls.some(call => call.toolCallId === "mode-later-call"));
});

test("the app's one-file rich-node projection is matched exactly against its recorded attachment metadata", () => {
    const attachment = { type: "file", displayName: "invented-notes.md", path: "C:\\invented\\invented-notes.md" };
    const stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const metadata = { messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle", attachments: [attachment] };
    const descriptor = `Attached file: ${attachment.displayName} (${attachment.path})`;
    for (const content of [attachment.displayName, `Read the planning notes in ${attachment.displayName} before replying.`]) {
        const modelBody = content.replace(attachment.displayName, descriptor);
        const record = extract({ ...metadata, content, transformedContent: stamp + modelBody });
        assert.deepEqual(record.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
        assert.equal(record.userPrompt.text, content);
        const sender = "<cross_session_message>\nfrom_session_id: 00000000-0000-4000-8000-000000000002\n</cross_session_message>\n\n";
        assert.deepEqual(extract({ ...metadata, content, transformedContent: stamp + "[[PLAN]] " + sender + modelBody }).userPrompt.authorship,
            { actor: "agent", basis: "host-agent-envelope" });
        for (const attachments of [[], [attachment, attachment], [{ ...attachment, path: "C:\\invented\\different.md" }],
            [{ ...attachment, type: "directory" }], [{ type: "file", path: attachment.path }],
            [{ ...attachment, lineRange: { start: 1, end: 4 } }]]) {
            assert.equal(extract({ ...metadata, attachments, content, transformedContent: stamp + modelBody }).userPrompt.authorship.actor, "unknown");
        }
        assert.equal(extract({ ...metadata, content, transformedContent: stamp + modelBody + " changed" }).userPrompt.authorship.actor, "unknown");
    }
    const ambiguous = `${attachment.displayName} and ${attachment.displayName}`;
    assert.equal(extract({ ...metadata, content: ambiguous, transformedContent: stamp + ambiguous.replace(attachment.displayName, descriptor) })
        .userPrompt.authorship.actor, "unknown");
    const copied = "Attached file: not-a-source (C:\\invented\\not-a-source)";
    assert.equal(extract({ ...metadata, content: copied, transformedContent: stamp + copied }).userPrompt.authorship.actor, "user");
});

test("fixed host image reminder preserves direct-input provenance without accepting arbitrary system reminders", () => {
    const content = "Invented request with an attached image.";
    const stamp = "<current_datetime>2026-10-06T12:00:00Z</current_datetime>\n\n";
    const suffix = "\n\n<system_reminder>\nThe user mentioned images and they have been attached to this message in the order they were mentioned.\n</system_reminder>";
    const data = { content, messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle",
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

test("kickoff qualification preserves an uninterpretable envelope instead of inventing a source contradiction", () => {
    for (const basis of ["invalid-source", "unsupported-source"]) {
        const authorship = { actor: "unknown", basis };
        assert.deepEqual(promptAuthorship.correlateKickoff({ authorship }), authorship);
    }
    for (const authorship of [{ actor: "user", basis: "source-user" },
        { actor: "unknown", basis: "system-source" }, { actor: "unknown", basis: "conflicting-source" }]) {
        assert.deepEqual(promptAuthorship.correlateKickoff({ authorship }),
            { actor: "unknown", basis: "conflicting-source" });
    }
    assert.deepEqual(promptAuthorship.correlateKickoff({ authorship: { actor: "user", basis: "host-direct-input" } }),
        { actor: "agent", basis: "parent-kickoff" });
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
        { actor: "unknown", basis: "system-source", issue: "host-wrapper-v1" },
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
            authorship: { actor: "unknown", basis: record.scenarioId === human.scenarioId ? "invalid-source" : "unsupported-source" } } } : record),
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

test("author-only recovery preserves the full fingerprint and absent Graph field through late replay and restart", async t => {
    const app = await promptInstallation(t);
    const human = app.cases.find(row => row.name === "human");
    await app.runtime().collector.collectNow();
    const initial = await loadBoardState(app.context);
    assert.equal(Object.hasOwn(initial.evidence.find(row => row.scenarioId === human.scenarioId), "graphActivities"), false);
    await replaceEvidence(app.context, records => ({ records: records.map(record => record.scenarioId === human.scenarioId
        ? { ...record, userPrompt: { ...record.userPrompt, authorshipVersion: 4,
            authorship: { actor: "unknown", basis: "invalid-source" } } } : record), importCoverage: initial.importCoverage }));
    const before = (await loadBoardState(app.context)).evidence.find(row => row.scenarioId === human.scenarioId);
    const fingerprint = evaluationRecordFingerprint(before);
    assert.equal(Object.hasOwn(before, "graphActivities"), false);
    await app.runtime().collector.collectNow();
    const recovered = (await loadBoardState(app.context)).evidence.find(row => row.scenarioId === human.scenarioId);
    assert.equal(evaluationRecordFingerprint(recovered), fingerprint);
    assert.equal(Object.hasOwn(recovered, "graphActivities"), false);
    assert.deepEqual(recovered, { ...before, userPrompt: { ...before.userPrompt,
        authorship: { actor: "user", basis: "host-direct-input" }, authorshipVersion: promptAuthorship.version } });
    await app.restart();
    await app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence.find(row => row.scenarioId === human.scenarioId), recovered);
    const events = (await readFile(app.sourceFiles[1], "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const duplicateCompletion = events.find(event => event.type === "tool.execution_complete" && event.data.toolCallId === human.callId);
    await appendFile(app.sourceFiles[1], JSON.stringify(duplicateCompletion) + "\n");
    await app.runtime().collector.collectNow();
    const replayed = (await loadBoardState(app.context)).evidence.find(row => row.scenarioId === human.scenarioId);
    assert.equal(evaluationRecordFingerprint(replayed), fingerprint);
    assert.equal(Object.hasOwn(replayed, "graphActivities"), false);
    assert.deepEqual(replayed, recovered);
    await app.restart();
    await app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence.find(row => row.scenarioId === human.scenarioId), recovered);
});

test("metadata-only merges preserve optional field presence, call ordering and unchanged model facts", () => {
    const base = { scenarioId: "invented-row", sourceSessionId: "invented-source",
        userPrompt: { text: "Invented retained message", sourceEventId: "invented-prompt", sourceTimestamp: "2026-10-06T12:00:00Z",
            status: "full", authorship: { actor: "unknown", basis: "invalid-source" }, authorshipVersion: 4 } };
    const model = { version: 1, sourceSessionId: base.sourceSessionId, promptEventId: base.userPrompt.sourceEventId,
        promptMessageId: null, partial: true, ambiguous: false, responses: [] };
    for (const optional of [{}, { toolCalls: [], graphActivities: [], followUpPrompts: [] },
        { toolCalls: [{ toolCallId: "invented-call", order: 7 }], graphActivities: [{ activityId: "invented-graph" }],
            followUpPrompts: [], originalModelEvidence: model, responseTiming: { schemaVersion: 1, status: "unavailable", reason: "missing-final-response" } }]) {
        const before = { ...base, ...optional };
        const userPrompt = { ...before.userPrompt, authorship: { actor: "user", basis: "host-direct-input" }, authorshipVersion: 5 };
        for (const incoming of [{ ...before, userPrompt }, { ...base, userPrompt }]) {
            const after = mergedRecords([before], [incoming])[0];
            assert.deepEqual(after, { ...before, userPrompt });
            assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
            assert.equal(evaluationRecordFingerprint(after), evaluationRecordFingerprint(before));
        }
    }
});

test("author corrections still merge explicit empty Graph and genuinely new Graph, tool, model and timing facts", () => {
    const before = { scenarioId: "invented-row", sourceSessionId: "invented-source",
        userPrompt: { text: "Invented retained message", sourceEventId: "invented-prompt", sourceTimestamp: "2026-10-06T12:00:00Z",
            status: "full", authorship: { actor: "unknown", basis: "invalid-source" }, authorshipVersion: 4 },
        toolCalls: [{ toolCallId: "invented-call", order: 1 }],
        originalModelEvidence: { version: 1, sourceSessionId: "invented-source", promptEventId: "invented-prompt",
            promptMessageId: "invented-message", partial: true, ambiguous: false, responses: [] } };
    const userPrompt = { ...before.userPrompt, authorship: { actor: "user", basis: "host-direct-input" }, authorshipVersion: 5 };
    const explicitEmpty = mergedRecords([before], [{ ...before, userPrompt, graphActivities: [] }])[0];
    assert.equal(Object.hasOwn(explicitEmpty, "graphActivities"), true);
    assert.deepEqual(explicitEmpty.graphActivities, []);
    assert.notEqual(evaluationRecordFingerprint(explicitEmpty), evaluationRecordFingerprint(before),
        "Actually recorded empty Graph remains distinct from absent Graph; the fingerprint contract is unchanged");
    const incoming = { ...before, userPrompt,
        toolCalls: [{ toolCallId: "invented-call", order: 1, completionEventId: "invented-completion", durationMs: 100 },
            { toolCallId: "invented-later-call", order: 2 }],
        graphActivities: [{ activityId: "invented-graph", toolCallId: "invented-graph-call", httpStatus: 200 }],
        originalModelEvidence: { ...before.originalModelEvidence, partial: false, responses: [
            { eventId: "invented-answer", apiCallId: "invented-model-request", at: "2026-10-06T12:00:01Z",
                turnId: "invented-turn", model: "invented-original-model", modelStatus: "recorded" },
        ] },
        responseTiming: { schemaVersion: 1, status: "measured", durationMs: 1000,
            promptEventId: "invented-prompt", finalEventId: "invented-answer", completionEventId: "invented-turn-end" } };
    const after = mergedRecords([before], [incoming])[0];
    assert.deepEqual(after.userPrompt, userPrompt);
    assert.deepEqual(after.toolCalls, incoming.toolCalls);
    assert.deepEqual(after.graphActivities, incoming.graphActivities);
    assert.deepEqual(after.originalModelEvidence.responses, incoming.originalModelEvidence.responses);
    assert.deepEqual(after.responseTiming, incoming.responseTiming);
    assert.notEqual(evaluationRecordFingerprint(after), evaluationRecordFingerprint(before));
});

test("qualified mode-free authors survive a stale checkpoint and late activity without another original-event lookup", async t => {
    const app = await promptInstallation(t);
    const human = app.cases.find(row => row.name === "human");
    const file = app.sourceFiles[1];
    const events = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    delete events.find(event => event.id === human.promptId).data.agentMode;
    await writeFile(file, events.map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    const before = await loadBoardState(app.context);
    const indexFile = path.join(app.context.dataDir, "collector", "index.json");
    await replaceEvidence(app.context, records => ({ records: records.map(record => record.scenarioId === human.scenarioId
        ? { ...record, userPrompt: { ...record.userPrompt, authorshipVersion: 4,
            authorship: { actor: "unknown", basis: "invalid-source" } } } : record), importCoverage: before.importCoverage }));
    await app.restart(async () => {
        const index = JSON.parse(await readFile(indexFile, "utf8"));
        const checkpointFile = path.join(app.context.dataDir, "collector", index.fingerprint, `${app.child}.json`);
        const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
        const prompt = checkpoint.events.find(event => event.id === human.promptId);
        assert.ok(prompt, "The fixture keeps the original prompt in the incremental checkpoint");
        prompt.data.wirePromptAuthorship = { actor: "unknown", basis: "invalid-source" };
        prompt.data.wirePromptAuthorshipVersion = 4;
        await writeFile(checkpointFile, JSON.stringify(checkpoint));
    });
    await app.runtime().collector.collectNow();
    const qualified = await loadBoardState(app.context);
    const corrected = qualified.evidence.find(row => row.scenarioId === human.scenarioId).userPrompt;
    assert.deepEqual(corrected.authorship, { actor: "user", basis: "host-direct-input" });
    assert.equal(corrected.authorshipVersion, promptAuthorship.version);
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    await app.restart();
    await appendFile(file, JSON.stringify({ id: randomUUID(), type: "tool.execution_complete",
        timestamp: new Date().toISOString(), data: { toolCallId: human.callId, success: true } }) + "\n");
    await app.runtime().collector.collectNow();
    const after = await loadBoardState(app.context);
    assert.deepEqual(after.evidence.find(row => row.scenarioId === human.scenarioId).userPrompt, corrected);
    const afterIndex = JSON.parse(await readFile(indexFile, "utf8"));
    assert.deepEqual(afterIndex.sources[app.child].promptEventQualification, index.sources[app.child].promptEventQualification);
});

for (const changed of ["timestamp", "text"]) test(`source replacement with changed prompt ${changed} invalidates retained authorship through restart and late completion`, async t => {
    const app = await promptInstallation(t);
    const human = app.cases.find(row => row.name === "human");
    await app.runtime().collector.collectNow();
    const before = await loadBoardState(app.context);
    const retained = before.evidence.find(row => row.scenarioId === human.scenarioId);
    assert.equal(retained.userPrompt.authorship.actor, "user");
    const file = app.sourceFiles[1];
    const events = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    events[0].id = randomUUID();
    const replacement = events.find(event => event.id === human.promptId);
    replacement.data.source = "agent-invented-replacement";
    if (changed === "timestamp") replacement.timestamp = new Date(Date.parse(replacement.timestamp) + 1).toISOString();
    else replacement.data.content = "Invented replacement message, not the retained original.";
    replacement.data.transformedContent = `<current_datetime>${replacement.timestamp}</current_datetime>\n\n${replacement.data.content}`;
    await writeFile(file, events.map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    const after = await loadBoardState(app.context);
    const record = after.evidence.find(row => row.scenarioId === human.scenarioId);
    assert.deepEqual(record.userPrompt.authorship, { actor: "unknown", basis: "conflicting-source" });
    assert.deepEqual(record.userPrompt, { ...retained.userPrompt, authorship: record.userPrompt.authorship,
        capture: { ...retained.userPrompt.capture, conflict: true } });
    assert.deepEqual(record.toolCalls, retained.toolCalls);
    assert.equal(evaluationRecordFingerprint({ ...retained, userPrompt: record.userPrompt }), evaluationRecordFingerprint(retained),
        "Author invalidation does not change scoring identity; source replacement may independently change timing or Graph availability");
    assert.deepEqual(after.deletion, before.deletion);
    await app.restart();
    await appendFile(file, JSON.stringify({ id: randomUUID(), type: "tool.execution_complete",
        timestamp: new Date().toISOString(), data: { toolCallId: human.callId, success: true } }) + "\n");
    await app.runtime().collector.collectNow();
    const late = (await loadBoardState(app.context)).evidence.find(row => row.scenarioId === human.scenarioId);
    assert.deepEqual(late.userPrompt, record.userPrompt);
    const followup = (await loadBoardState(app.context)).evidence
        .find(row => row.scenarioId === app.cases[0].scenarioId).followUpPrompts.find(prompt => prompt.sourceEventId === human.promptId);
    assert.deepEqual(followup.authorship, { actor: "unknown", basis: "conflicting-source" });
    assert.equal(followup.text, retained.userPrompt.text);
    assert.equal(followup.sourceTimestamp, retained.userPrompt.sourceTimestamp);
    const settled = (await loadBoardState(app.context)).evidence;
    await app.runtime().collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence, settled);
    assert.equal((await app.runtime().collector.status()).metrics.lastBytesRead, 0);
});

test("manual Graph scan cannot promote an agent-created first prompt whose creator qualification is unavailable", async t => {
    const app = await promptInstallation(t);
    const file = app.sourceFiles[1], kickoff = app.cases[0];
    const events = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const first = events.findIndex(event => event.id === kickoff.promptId), original = events[first];
    original.data.transformedContent = `<current_datetime>${original.timestamp}</current_datetime>\n\n${original.data.content}`;
    events.splice(first + 1, 0,
        { id: randomUUID(), type: "tool.execution_start", timestamp: new Date(Date.parse(original.timestamp) + 1).toISOString(),
            data: { toolName: "powershell", toolCallId: "invented-first-graph", arguments: { command: "curl 'https://graph.microsoft.com/v1.0/me/messages'" } } },
        { id: randomUUID(), type: "tool.execution_complete", timestamp: new Date(Date.parse(original.timestamp) + 2).toISOString(),
            data: { toolCallId: "invented-first-graph", success: true, result: { content: "HTTP/2 200" } } });
    await writeFile(file, events.map(event => JSON.stringify(event) + "\n").join(""));
    await rename(app.sourceFiles[0], app.sourceFiles[0] + ".missing");
    await app.runtime().collector.collectNow();
    const before = await loadBoardState(app.context);
    const retained = before.evidence.find(record => record.scenarioId === kickoff.scenarioId);
    assert.deepEqual(retained.userPrompt.authorship, { actor: "unknown", basis: "missing-source" });
    const indexFile = path.join(app.context.dataDir, "collector", "index.json");
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    assert.equal(index.sources[app.child].promptQualification.reason, "creator-history-missing");
    const source = (await discoverSources(app.config)).roster.find(row => row.sessionId === app.child);
    const since = new Date(Date.now() - 86400000).toISOString(), until = new Date().toISOString();
    const inventoryPath = path.join(app.root, "invented-inventory.json");
    await writeFile(inventoryPath, JSON.stringify([{ id: app.child, name: "Invented mapped agent child" }]));
    const manual = await scanHistory({ inventoryPath, appDbPath: app.config.appDbPath, sessionRoot: app.config.sessionRoot, since, until });
    assert.deepEqual(manual.roster[0].promptCreation, source.promptCreation);
    assert.deepEqual(manual.scenarios.find(record => record.scenarioId === kickoff.scenarioId).userPrompt.authorship, retained.userPrompt.authorship);
    const scan = await scanRecordedGraphHistory({ sources: manual.roster, sessionRoot: app.config.sessionRoot, since, until });
    const scanned = scan.scenarios.find(record => record.scenarioId === kickoff.scenarioId);
    assert.deepEqual(scanned.userPrompt.authorship, retained.userPrompt.authorship);
    const merged = mergeGraphScenarios(before.evidence, scan.scenarios);
    assert.deepEqual(merged.find(record => record.scenarioId === kickoff.scenarioId).userPrompt, retained.userPrompt);
    await replaceEvidence(app.context, () => ({ records: merged, importCoverage: before.importCoverage }));
    await app.restart();
    await app.runtime().collector.collectNow();
    const after = await loadBoardState(app.context);
    assert.deepEqual(after.evidence.find(record => record.scenarioId === kickoff.scenarioId).userPrompt, retained.userPrompt);
    assert.deepEqual(JSON.parse(await readFile(indexFile, "utf8")).sources[app.child].promptQualification,
        index.sources[app.child].promptQualification);
    assert.equal(evaluationRecordFingerprint({ ...retained, userPrompt: after.evidence.find(record => record.scenarioId === kickoff.scenarioId).userPrompt }),
        evaluationRecordFingerprint(retained), "Author qualification does not change scoring identity");
    assert.deepEqual(after.deletion, before.deletion);
    await app.runtime().collector.collectNow();
    assert.equal((await app.runtime().collector.status()).metrics.lastBytesRead, 0, "Terminal unavailable creator lookup is not reopened");
});

for (const gap of ["after-first", "before-first", "windowed-after-first", "non-event-before-first"]) test(`manual Work IQ-only import preserves qualified prefix authorship (${gap})`, async t => {
    const app = await promptInstallation(t);
    const first = app.cases[0], human = app.cases.find(row => row.name === "human"), agent = app.cases.find(row => row.name === "agent");
    const file = app.sourceFiles[1];
    const original = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const initialPrompt = original.find(event => event.id === first.promptId);
    initialPrompt.data.transformedContent = `<current_datetime>${initialPrompt.timestamp}</current_datetime>\n\n${initialPrompt.data.content}`;
    const followup = original.find(event => event.id === human.promptId);
    const later = original.filter(event => [human.promptId, agent.promptId].includes(event.id)
        || [human.callId, agent.callId].includes(event.data?.toolCallId));
    const early = gap.includes("before-first");
    const broken = gap === "non-event-before-first" ? "null" : "invented malformed JSON";
    const text = [JSON.stringify(original[0]), ...(early ? [broken] : []), JSON.stringify(initialPrompt),
        ...(!early ? [broken] : []), ...later.map(event => JSON.stringify(event))].join("\n") + "\n";
    await writeFile(file, text);
    const inventoryPath = path.join(app.root, "invented-inventory.json");
    await writeFile(inventoryPath, JSON.stringify([{ id: app.child, name: "Invented Work IQ-only child" }]));
    const since = gap === "windowed-after-first" ? followup.timestamp : new Date(Date.now() - 86400000).toISOString();
    const until = new Date().toISOString();
    const imported = await scanHistory({ inventoryPath, appDbPath: app.config.appDbPath, sessionRoot: app.config.sessionRoot,
        since, until });
    assert.equal(imported.scenarios.length, 2);
    assert.equal(imported.roster[0].malformedLines, gap === "non-event-before-first" ? 0 : 1);
    const record = imported.scenarios.find(row => row.scenarioId === human.scenarioId);
    assert.deepEqual(record.userPrompt.authorship, early
        ? { actor: "unknown", basis: "missing-source" } : { actor: "user", basis: "host-direct-input" });
    assert.deepEqual(imported.scenarios.find(row => row.scenarioId === agent.scenarioId).userPrompt.authorship,
        { actor: "agent", basis: "source-agent" });
    assert.equal(record.userPrompt.authorshipVersion, promptAuthorship.version);
    assert.equal(record.userPrompt.text, followup.data.content);
    assert.equal(record.graphActivities, undefined, "No Graph projection participates in this proof");
    assert.equal(record.originalModelEvidence.truncated, true, "Correct authorship does not make incomplete model/history evidence complete");
    if (gap === "after-first") {
        const tail = await readEventWindow(file, Buffer.byteLength(later.map(event => JSON.stringify(event)).join("\n") + "\n") + 1);
        assert.equal(tail.tailTruncated, true);
        assert.equal(tail.firstPromptEventId, null);
        const extracted = extractScenarios(tail.events, imported.roster[0], since, until, {
            partialWindow: true, firstPromptEventId: tail.firstPromptEventId,
        });
        assert.deepEqual(extracted.scenarios.find(row => row.scenarioId === human.scenarioId).userPrompt.authorship,
            { actor: "unknown", basis: "missing-source" });
        assert.deepEqual(extracted.scenarios.find(row => row.scenarioId === agent.scenarioId).userPrompt.authorship,
            { actor: "agent", basis: "source-agent" });
    }
    assert.equal(await readFile(file, "utf8"), text);
});

test("targeted qualification stops at its byte budget and resumes rather than rescanning a creator", async t => {
    const app = await promptInstallation(t);
    const parentEvents = (await readFile(app.sourceFiles[0], "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const filler = Array.from({ length: 6 }, () => ({ id: randomUUID(), type: "session.info",
        timestamp: parentEvents[0].timestamp, data: { message: "Invented padding only. ".repeat(40000) } }));
    await writeFile(app.sourceFiles[0], [parentEvents[0], ...filler, ...parentEvents.slice(1)].map(event => JSON.stringify(event) + "\n").join(""));
    const roster = (await discoverSources(app.config)).roster, source = roster.find(row => row.sessionId === app.child), creator = roster.find(row => row.sessionId === app.parent);
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
    const source = (await discoverSources(app.config)).roster.find(row => row.sessionId === app.child);
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
    const source = (await discoverSources(app.config)).roster.find(row => row.sessionId === app.child);
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

test("only older format gaps yield to a newer qualified author; current gaps and conflicting authors remain unknown", () => {
    const previous = { authorship: { actor: "user", basis: "host-direct-input" }, authorshipVersion: promptAuthorship.version };
    for (const basis of ["invalid-source", "unsupported-source"]) {
        const old = { authorship: { actor: "unknown", basis }, authorshipVersion: 4 };
        assert.deepEqual(promptAuthorship.merge(previous, old), previous.authorship);
        assert.deepEqual(promptAuthorship.merge(previous, { ...old, authorshipVersion: promptAuthorship.version }), old.authorship);
    }
    for (const authorship of [{ actor: "agent", basis: "source-agent" }, { actor: "unknown", basis: "conflicting-source" }]) {
        assert.deepEqual(promptAuthorship.merge(previous, { authorship, authorshipVersion: 4 }),
            { actor: "unknown", basis: "conflicting-source" });
    }
    assert.deepEqual(promptAuthorship.merge(previous, { authorship: { actor: "unknown", basis: "system-source" }, authorshipVersion: 4 }),
        { actor: "unknown", basis: "system-source" });
    const recorded = { ...previous, sourceEventId: "invented-event", sourceTimestamp: "2026-10-06T12:00:00Z", text: "Invented retained message" };
    for (const authorshipVersion of [4, promptAuthorship.version + 1]) {
        for (const changed of [{ sourceTimestamp: "2026-10-06T12:00:01Z" }, { text: "Invented different message" }]) {
            assert.deepEqual(promptAuthorship.merge(recorded, { ...recorded, ...changed, authorshipVersion,
                authorship: { actor: "unknown", basis: "invalid-source" } }), { actor: "unknown", basis: "conflicting-source" });
        }
    }
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

test("same event ID and text in another source cannot change an ordinary follow-up author", async t => {
    const app = await promptInstallation(t);
    const human = app.cases.find(row => row.name === "human");
    const events = (await readFile(app.sourceFiles[1], "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const original = events.find(event => event.id === human.promptId);
    await appendFile(app.sourceFiles[0], [
        { ...original, data: { ...original.data, source: "agent-invented-subscribed-sender" } },
        { id: randomUUID(), type: "tool.execution_start", timestamp: new Date(Date.parse(original.timestamp) + 1).toISOString(),
            data: { toolName: "workiq-ask", toolCallId: "invented-other-source-call", arguments: { question: "Invented question" } } },
    ].map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    const records = (await loadBoardState(app.context)).evidence;
    const child = records.find(record => record.scenarioId === human.scenarioId);
    const parent = records.find(record => record.sourceSessionId === app.parent && record.userPrompt.sourceEventId === human.promptId);
    assert.deepEqual(child.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    assert.deepEqual(parent.userPrompt.authorship, { actor: "agent", basis: "source-agent" });
    const followup = records.find(record => record.scenarioId === app.cases[0].scenarioId).followUpPrompts
        .find(prompt => prompt.sourceEventId === human.promptId);
    assert.deepEqual(followup.authorship, child.userPrompt.authorship);
    assert.equal(followup.authorshipVersion, child.userPrompt.authorshipVersion);
});
