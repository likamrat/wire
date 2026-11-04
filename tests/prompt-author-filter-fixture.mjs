import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import assert from "node:assert/strict";

export async function authorFilterFixture(t, { serviceCases = false, longNames = false } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-author-filter-"));
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state"),
        approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    await mkdir(config.sessionRoot);
    const db = new DatabaseSync(config.appDbPath);
    db.exec(`PRAGMA user_version=166;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT,created_by TEXT,creator_session_id TEXT);`);
    const chatId = randomUUID(), otherChatId = randomUUID(), projectId = randomUUID(), otherProjectId = randomUUID();
    const newer = Math.floor((Date.now() - 3600000) / 3600000) * 3600000, older = newer - 86400000, cases = {};
    const definitions = [
        ["ownMail", "user", "/me/messages", [true, false], older, "Invented owner mail request."],
        ["agentMail", "agent", "/me/messages", [false], older, "Invented delegated mail request."],
        ["ownCalendar", "user", "/me/events", [true], newer, "<cross_session_message>Invented owner imitation, not an agent sender.</cross_session_message>"],
        ["agentCalendar", "agent", "/me/events", [true], newer, "Invented delegated calendar request."],
        ["unverified", "unknown", "/me/messages", [true], older, "Invented legacy message without author evidence."],
        ["conflicting", "unknown", "/me/messages", [true], newer, "Invented conflicting author fields."],
        ["otherAgent", "agent", "/me/drive", [true], older, "Invented other-chat file request."],
        ...(serviceCases ? [
            ["multiFiles", "user", ["/me/drive", "/me/messages"], [true], older, "Invented multi-service request."],
            ["failedFiles", "agent", "/me/drive", [false], older, "Invented failed file request."],
            ["partialFiles", "user", ["/me/drive", "/unsupported/resource"], [true], older, "Invented partially mapped request."],
            ["missingUser", "user", [], [false], older, "Invented missing-target request."],
            ["missingAgent", "agent", [], [true], newer, "Invented delegated missing target."],
            ["schema", "user", "/me/drive", [true], older, "Invented preparation.", "get_schema"],
            ["assistance", "unknown", null, [true], older, "Invented assistance with no downstream target.", "ask"],
        ] : []),
    ];
    for (const [id, name] of [[projectId, longNames ? "Invented lighthouse research and cross-functional operational readiness planning project" : "Invented project A"],
        [otherProjectId, "Invented project B"]]) db.prepare("INSERT INTO projects VALUES(?,?)").run(id, name);
    const event = (type, data, timestamp) => ({ id: randomUUID(), type, data, timestamp: new Date(timestamp).toISOString() });
    const sourceFiles = [];
    for (const [id, project, name] of [[chatId, projectId, longNames ? "Invented harbor research conversation about long-running coordination and information availability" : "Invented author conversation"],
        [otherChatId, otherProjectId, "Invented other conversation"]]) {
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, name, "project", null, "local");
        db.prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), id, project, name, null, "local", "folder", "user", null);
        const events = [event("session.start", { version: 1, sessionId: id }, older - 1000)];
        for (const [key, actor, endpoint, successes, baseAt, content, operation = "fetch"] of definitions.filter(definition => (definition[0] === "otherAgent") === (id === otherChatId))) {
            const at = baseAt + definitions.findIndex(definition => definition[0] === key) * 1000;
            const prompt = event("user.message", { content, messageId: randomUUID(), delivery: "idle", agentMode: "autopilot" }, at);
            if (actor === "agent") prompt.data.source = `agent-${randomUUID()}`;
            else if (actor === "user") prompt.data.transformedContent = `<current_datetime>${prompt.timestamp}</current_datetime>\n\n${content}`;
            else if (key === "conflicting") Object.assign(prompt.data, { source: "user", isAutopilotContinuation: true });
            events.push(prompt);
            const callIds = [];
            successes.forEach((success, index) => {
                const toolCallId = `invented-${key}-${index + 1}`; callIds.push(toolCallId);
                events.push(event("tool.execution_start", { toolName: `workiq-${operation}`, mcpServerName: "workiq", mcpToolName: operation,
                    toolCallId, parentToolCallId: "invented-agent-executor", arguments: operation === "get_schema" ? { path: endpoint, operationType: "fetch" }
                        : operation === "ask" ? { question: content } : { entityUrls: Array.isArray(endpoint) ? endpoint : [endpoint] } }, at + 100 + index * 100),
                event("tool.execution_complete", { toolCallId, success, result: { structuredContent: { results: [{ statusCode: success ? 200 : 503 }] } } }, at + 150 + index * 100));
            });
            cases[key] = { key, actor, content, callIds, sourceSessionId: id, sourceEventId: prompt.id, scenarioId: `history-${id}-${prompt.id}`, at: prompt.timestamp };
        }
        events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const file = path.join(config.sessionRoot, id, "events.jsonl");
        await mkdir(path.dirname(file));
        await writeFile(file, events.map(value => JSON.stringify(value) + "\n").join(""));
        sourceFiles.push(file);
    }
    const context = { dataDir: path.join(root, "private") }, exports = createExportController(context);
    const denied = { provider: 0, scoringRead: 0 };
    const runtime = await startServer(context, exports, { port: 0, collector: { timers: false }, evaluation: {
        evaluatorFactory: async () => { denied.provider++; throw new Error("No provider allowed in author proof"); },
        readSource: async () => { denied.scoringRead++; throw new Error("No extra scoring evidence read allowed"); },
    } });
    const approvalBefore = structuredClone((await loadBoardState(context)).personalEvaluation?.modelEvaluation?.automatic?.approval);
    const clients = [];
    t.after(async () => {
        try {
            for (const close of clients) await close();
            assert.deepEqual(denied, { provider: 0, scoringRead: 0 });
            assert.deepEqual((await loadBoardState(context)).personalEvaluation?.modelEvaluation?.automatic?.approval, approvalBefore);
        }
        finally { await runtime.close(); db.close(); await rm(root, { recursive: true, force: true }); }
    });
    await runtime.collector.configure(config);
    await runtime.collector.collectNow();
    return { root, config, context, exports, runtime, cases, sourceFiles, chatId, otherChatId, projectId, otherProjectId, closeClient: close => clients.unshift(close),
        state: await loadBoardState(context), olderDay: new Date(older).toISOString().slice(0, 10), newerDay: new Date(newer).toISOString().slice(0, 10) };
}
