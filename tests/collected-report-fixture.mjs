import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { privateFixture } from "./helpers.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";

export async function collectedReportSource(t, { recordedAnswers = false } = {}) {
    const cleanup = [], { root, context } = await privateFixture({ after: work => cleanup.push(work) }, []);
    const appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    const sourceId = randomUUID(), file = path.join(sessionRoot, sourceId, "events.jsonl");
    const db = new DatabaseSync(appDbPath);
    try {
        db.exec(metadata174Schema);
        db.prepare("INSERT INTO sessions(id,title,session_type,execution_location) VALUES(?,?,?,?)")
            .run(sourceId, "Invented collected report source", "chat", "local");
    } finally { db.close(); }
    const lines = rows => rows.map(row => JSON.stringify(row) + "\n").join("");
    const events = content => {
        const toolCallId = randomUUID(), timestamp = new Date().toISOString();
        return [
            { type: "user.message", data: { content } },
            { type: "tool.execution_start", data: { toolName: "workiq-retrieve", toolCallId,
                arguments: { query: "invented report source" } } },
            { type: "tool.execution_complete", data: { toolCallId, success: true } },
            ...(recordedAnswers ? [{ type: "assistant.message", data: { content: "Recorded reply to " + content } }] : []),
        ].map(event => ({ ...event, id: randomUUID(), timestamp }));
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, lines([{ id: randomUUID(), type: "session.start", timestamp: new Date().toISOString(),
        data: { sessionId: sourceId, version: 1 } }, ...events("Original reviewed request.")]));
    const collector = await createCollector(context, { timers: false }), resources = [];
    t.after(async () => {
        for (const work of resources.reverse()) await work();
        await collector.close();
        for (const work of cleanup.reverse()) await work();
    });
    await collector.configure({ appDbPath, sessionRoot, approved: true, enabled: !recordedAnswers, windowDays: 30, pollSeconds: 5 });
    if (recordedAnswers) {
        const source = collector.assessmentSource(await loadBoardState(context));
        await updateBoardState(context, state => {
            const personal = defaultPersonalEvaluation();
            personal.source = source;
            personal.consent = { ...personal.consent, state: "enabled", revision: 1, categories: ["answer"],
                sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision,
                grantedAt: new Date().toISOString(), grantOrigin: "explicit-in-app-setup" };
            state.personalEvaluation = personal;
        });
    }
    await collector.collectNow();
    if (recordedAnswers) await collector.setEnabled(true);
    const append = () => appendFile(file, lines(events("Later request in the same collected chat.")));
    return { context, collector, root, beforeCleanup: work => resources.push(work), appendOnly: append, async append() {
        await append();
        await collector.collectNow();
    } };
}
