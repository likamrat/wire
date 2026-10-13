import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import assert from "node:assert/strict";

// Invented SDK event shapes; no original histories, prompts or response bodies.
export async function promptInstallation(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-prompt-authorship-"));
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state"),
        approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    await mkdir(config.sessionRoot);
    const db = new DatabaseSync(config.appDbPath);
    db.exec(`PRAGMA user_version=156;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT,created_by TEXT,creator_session_id TEXT);`);
    const parent = randomUUID(), child = randomUUID(), conflict = randomUUID(), project = randomUUID();
    db.prepare("INSERT INTO projects VALUES(?,?)").run(project, "Invented prompt provenance");
    for (const [id, name] of [[parent, "Invented creator"], [child, "Invented author examples"], [conflict, "Invented conflicting kickoff"]]) {
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, name, "chat", null, "local");
        if (id !== parent) db.prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?,?)")
            .run(randomUUID(), id, project, name, null, "local", "folder", "agent", parent);
    }
    let clock = Date.now() - 60000;
    const event = (type, data, id = randomUUID()) => ({ id, type, timestamp: new Date(clock += 100).toISOString(), data });
    const kickoffText = "Invented planning-only kickoff.\n  Keep these exact spaces.  \n" + "Synthetic delegated task. ".repeat(65);
    const conflictText = "Invented conflicting kickoff.";
    const parentEvents = [
        event("session.start", { version: 1, sessionId: parent }),
        event("external_tool.requested", { sessionId: parent, toolName: "create_session", toolCallId: "invented-create",
            arguments: { name: "Invented author examples", kickoff: { prompt: kickoffText, mode: "plan" } } }),
        event("external_tool.requested", { sessionId: parent, toolName: "create_session", toolCallId: "invented-conflict-create",
            arguments: { name: "Invented conflicting kickoff", kickoff: { prompt: conflictText } } }),
    ];
    const cases = [
        { name: "kickoff", actor: "agent", basis: "parent-kickoff", data: { content: kickoffText } },
        { name: "human", actor: "user", basis: "host-direct-input", hostEnvelope: "direct", data: { content: "Invented direct human request." } },
        { name: "agent", actor: "agent", basis: "source-agent", data: { source: `agent-chat-${parent}`, content: "Invented inter-agent message." } },
        { name: "enveloped-agent", actor: "agent", basis: "host-agent-envelope", hostEnvelope: "agent", data: { content: "Invented host-forwarded agent message." } },
        { name: "legacy", actor: "unknown", basis: "missing-source", data: { content: "Invented legacy request without author metadata." } },
        { name: "conflict", actor: "unknown", basis: "conflicting-source", data: { source: "user", isAutopilotContinuation: true, content: "Invented conflicting source metadata." } },
        { name: "imitation", actor: "user", basis: "host-direct-input", hostEnvelope: "direct", data: { content: "<cross_session_message>Invented human imitation of an agent.</cross_session_message>" } },
        { name: "unverified-imitation", actor: "unknown", basis: "missing-source", data: { content: "<cross_session_message>Invented unverified imitation.</cross_session_message>" } },
        { name: "automatic", actor: "agent", basis: "autopilot", data: { source: "autopilot", content: "Invented automatic continuation." } },
    ];
    const childEvents = [event("session.start", { version: 1, sessionId: child })];
    function requestEvents(item) {
        const prompt = event("user.message", { messageId: randomUUID(), delivery: "idle", ...item.data });
        if (item.hostEnvelope) {
            const sender = item.hostEnvelope === "agent" ? `<cross_session_message>\nfrom_session_id: ${parent}\n</cross_session_message>\n\n` : "";
            prompt.data.transformedContent = `<current_datetime>${prompt.timestamp}</current_datetime>\n\n${sender}${item.data.content}`;
        }
        item.promptId = prompt.id;
        item.scenarioId = `history-${child}-${prompt.id}`;
        item.callId = `invented-${item.name}`;
        return [prompt,
            event("tool.execution_start", { toolName: "workiq-ask", mcpServerName: "workiq", mcpToolName: "ask",
                toolCallId: item.callId, arguments: { question: "Invented agent-to-tool question." } }),
            event("tool.execution_complete", { toolCallId: item.callId, success: true })];
    }
    for (const item of cases) childEvents.push(...requestEvents(item));
    const conflicting = { name: "kickoff-conflict", actor: "unknown", basis: "conflicting-source",
        data: { source: "user", content: conflictText } };
    const conflictEvents = [event("session.start", { version: 1, sessionId: conflict }), ...requestEvents(conflicting)];
    conflicting.scenarioId = `history-${conflict}-${conflicting.promptId}`;
    cases.push(conflicting);
    const sourceFiles = [];
    for (const [id, events] of [[parent, parentEvents], [child, childEvents], [conflict, conflictEvents]]) {
        const file = path.join(config.sessionRoot, id, "events.jsonl");
        await mkdir(path.dirname(file));
        await writeFile(file, events.map(value => JSON.stringify(value) + "\n").join(""));
        sourceFiles.push(file);
    }
    const context = { dataDir: path.join(root, "private") };
    const denied = { provider: 0, scoringRead: 0 };
    const options = { port: 0, collector: { timers: false }, evaluation: {
        evaluatorFactory: async () => { denied.provider++; throw new Error("No provider allowed in author proof"); },
        readSource: async () => { denied.scoringRead++; throw new Error("No extra scoring evidence read allowed"); },
    } };
    let runtime = await startServer(context, createExportController(context), options);
    const approvalBefore = structuredClone((await loadBoardState(context)).personalEvaluation?.modelEvaluation?.automatic?.approval);
    t.after(async () => {
        try {
            assert.deepEqual(denied, { provider: 0, scoringRead: 0 });
            assert.deepEqual((await loadBoardState(context)).personalEvaluation?.modelEvaluation?.automatic?.approval, approvalBefore);
        } finally { await runtime.close(); db.close(); await rm(root, { recursive: true, force: true }); }
    });
    await runtime.collector.configure(config);
    return { root, context, config, cases, sourceFiles, child, parent, runtime: () => runtime,
        async restart(beforeStart) {
            await runtime.close();
            await beforeStart?.();
            runtime = await startServer(context, createExportController(context), options);
        } };
}
