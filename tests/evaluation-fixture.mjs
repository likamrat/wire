import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createEvaluationController } from "../lib/evaluation-controller.mjs";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

function evidence() {
    return ["first", "second"].map((name, index) => {
        const record = fixture(name), source = randomUUID(), start = new Date(Date.now() - 60000).toISOString();
        record.sourceSessionId = source;
        record.userPrompt = { ...record.userPrompt, text: "How many synthetic items?", sourceEventId: `prompt-${name}`, sourceTimestamp: start };
        Object.assign(record.toolCalls[0], { startedAt: start, completedAt: start, durationMs: 0, completionEventId: `end-${name}` });
        const call = record.toolCalls[0], model = "gpt-6-astra";
        const events = [
            { id: "start", type: "session.start", data: { sessionId: source, version: 1 } },
            { id: record.userPrompt.sourceEventId, type: "user.message", data: { content: record.userPrompt.text, messageId: `message-${name}` } },
            { id: call.startEventId, type: "tool.execution_start", data: { toolCallId: call.toolCallId, toolName: call.tool, arguments: call.requestArgs } },
            { id: call.completionEventId, type: "tool.execution_complete", data: { toolCallId: call.toolCallId, success: true, result: { content: "Three synthetic items." } } },
            { id: `answer-${name}`, type: "assistant.message", data: { content: index ? "Two synthetic items." : "Three synthetic items.",
                messageId: `answer-message-${name}`, phase: "final_answer", turnId: "turn", model, toolRequests: [] } },
            { id: `turn-end-${name}`, type: "assistant.turn_end", data: { turnId: "turn" } },
        ].map(event => ({ ...event, timestamp: start }));
        return { record, events };
    });
}
const anchor = value => ({ ref: value.ref, start: 0, end: value.text.length });
export function assessed(request, fail) {
    const p = request.input.packet, verdict = fail ? "not-met" : "met", reason = fail ? "contradicted" : "supported";
    return {
        packetHash: request.packetHash, model: request.model,
        rawResult: { schemaVersion: 1, rubricId: request.rubricId, rubricVersion: request.rubricVersion, packetHash: request.packetHash,
            requirements: [{ id: "requirement-1", promptEvidence: [anchor(p.prompt)], answerEvidence: [anchor(p.answer)],
                referenceEvidence: [anchor(p.references[0])], verdict, reason }],
            answerSegments: [{ start: 0, end: p.answer.text.length, kind: "factual", verdict, referenceEvidence: [anchor(p.references[0])], reason }],
            actions: p.actions.map(action => ({ actionRef: action.ref, promptEvidence: [anchor(p.prompt)], verdict: "met", reason: "requested" })),
        },
        evaluatorCost: { aiCredits: 0.1, modelCalls: 1, attribution: "evaluation-overhead-only", status: "recorded" },
    };
}
export async function evaluationFixture(t, evaluate, overrides = {}) {
    const inputs = evidence(), { context } = await privateFixture(t, inputs.map(input => input.record));
    const config = { approved: true, enabled: false, windowDays: 30, sourceAdapter: "copilot-app-sqlite-v156",
        appDbPath: path.join(context.dataDir, "data.db"), sessionRoot: path.join(context.dataDir, "session-state") };
    const calls = [], workDirs = [];
    const options = {
        getSourceConfig: () => config,
        discover: () => ({ roster: inputs.map(input => ({ sessionId: input.record.sourceSessionId, eligible: true })) }),
        readSource: async file => {
            const value = inputs.find(input => file.includes(input.record.sourceSessionId));
            return { events: value.events, startup: value.events[0], malformedLines: 0 };
        },
        evaluatorFactory: async workDir => {
            workDirs.push(workDir);
            return { evaluate: async (request, reservation, controls) => {
                calls.push(request);
                return evaluate ? evaluate(request, reservation, calls.length, controls) : assessed(request, calls.length === 2);
            } };
        },
        ...overrides,
    };
    const controller = createEvaluationController(context, options);
    t.after(() => controller.close());
    const state = await loadBoardState(context);
    const input = { schemaVersion: 1, mutationRef: "mutation-" + randomBytes(16).toString("hex"), receiptToken: randomBytes(32).toString("hex"),
        scenarioIds: inputs.map(input => input.record.scenarioId), expectedSourceRevision: state.evidenceRevision, maxAiCredits: 60, confirmed: true };
    return { context, controller, calls, input, inputs, config, options, workDirs };
}

export async function materializeEvaluationSource({ context, config, inputs }) {
    await mkdir(config.sessionRoot, { recursive: true });
    const db = new DatabaseSync(config.appDbPath);
    try {
        db.exec(`PRAGMA user_version=166;
            CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
            CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
            CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
        for (const input of inputs) {
            db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(input.record.sourceSessionId, "Synthetic evaluation source", "chat", null, "local");
            const directory = path.join(config.sessionRoot, input.record.sourceSessionId);
            await mkdir(directory);
            await writeFile(path.join(directory, "events.jsonl"), input.events.map(event => JSON.stringify(event) + "\n").join(""));
        }
    } finally { db.close(); }
    const collector = await createCollector(context, { timers: false });
    try {
        const status = await collector.configure({ appDbPath: config.appDbPath, sessionRoot: config.sessionRoot,
            approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
        Object.assign(config, status.config);
    } finally { await collector.close(); }
}
