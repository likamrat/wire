import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { privateFixture, fixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { seedRetainedReply } from "./search-corpus-fixture.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";

export function searchRecords(count = 3) {
    return Array.from({ length: count }, (_, index) => {
        const row = fixture(`search-${index}`);
        row.sourceSessionName = `Invented local conversation ${index}`;
        row.userPrompt.text = [
            "The physician treated an injured patient in the hospital.",
            "The mechanic repaired a broken automobile in the garage.",
            "Employees cannot sign in because their credentials have expired.",
        ][index % 3];
        row.followUpPrompts = [{ text: "Arrange a subsequent medical appointment.", status: "full", provenance: "human-authored" }];
        row.httpRecords = [{ recordId: `http-${index}`, classification: "direct-graph-http", synthetic: false,
            observedGraphHttp: true, responseOrigin: "https://graph.microsoft.com", method: "GET", apiVersion: "v1.0",
            responsePath: { path: "/me/calendarView", query: [] }, startedAt: row.capturedAt,
            durationMs: 12, status: index === 0 ? 403 : 200, transportError: null }];
        return row;
    });
}
export async function searchFixture(t, { records = searchRecords(), formats = [], search, reply = true, sessionTtlMs } = {}) {
    const cleanups = [];
    const { context, root } = await privateFixture({ after: fn => cleanups.push(fn) }, records);
    const sessionRoot = path.join(root, "session-state");
    await mkdir(sessionRoot);
    await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
    const config = { schemaVersion: 1, approved: true, approvedAt: "2026-10-01T12:00:00.000Z",
        appDbPath: path.join(root, "data.db"), sessionRoot, enabled: false, windowDays: 30, pollSeconds: 60 };
    const db = new DatabaseSync(config.appDbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.close();
    await writeFile(path.join(context.dataDir, "collector", "config.json"), JSON.stringify(config));
    const exports = createExportController(context);
    let providerCalls = 0;
    const runtime = await startServer(context, exports, { port: 0, collector: { timers: false },
        search: typeof search === "function" ? search(root) : search, sessionTtlMs,
        evaluation: {
            evaluatorFactory: async () => { providerCalls++; throw new Error("Provider work forbidden in search proof."); },
            readSource: async () => { providerCalls++; throw new Error("Assessment source reads forbidden in search proof."); },
        } });
    t.after(async () => {
        await runtime.close(); for (const cleanup of cleanups) await cleanup();
        assert.equal(providerCalls, 0);
    });
    if (reply) await seedRetainedReply(context, runtime.collector.assessmentSource(await loadBoardState(context)),
        "The lab results show a steady recovery.");
    const bundles = [];
    for (const format of formats) {
        const preview = await exports.preview("live-proof", undefined, { promptMode: "original", formats: [format] },
            { kind: "all", revision: (await loadBoardState(context)).revision });
        await exports.review("live-proof", preview.previewId, true);
        bundles.push((await exports.confirm("live-proof", preview.previewId, true)).bundle);
    }
    return { runtime, context, root, exports, bundles, config };
}
export async function streamPanel(runtime, { purpose = "navigation" } = {}) {
    const origin = new URL(runtime.url).origin;
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const session = await (await fetch(origin + "/api/session", { method: "POST", headers, body: "{}" })).json();
    headers["X-Board-Capability"] = session.capability;
    const api = async (path, body = {}) => {
        const input = path === "/api/search/query" ? { schemaVersion: searchWireContract.schemaVersion, purpose, ...body } : body;
        const response = await fetch(origin + path, { method: "POST", headers, body: JSON.stringify(input) });
        return { code: response.status, body: await response.json() };
    };
    const controller = new AbortController();
    const response = await fetch(origin + "/api/search/events", { method: "POST", headers,
        body: JSON.stringify({ schemaVersion: searchWireContract.schemaVersion }), signal: controller.signal });
    if (!response.ok) return { response, api, close: () => controller.abort() };
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const events = [], waiters = [];
    const reading = (async () => {
        let buffer = "";
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n")) >= 0) {
                const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
                events.push(event);
                for (const waiter of [...waiters]) if (waiter.match(event)) {
                    clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event);
                }

            }
        }
    })().catch(error => { if (!controller.signal.aborted) throw error; });
    const wait = (match, timeout = 30000) => {
        const found = events.find(match);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
            const waiter = { match, resolve, timer: setTimeout(() => reject(new Error("Expected local search event missing: "
                + JSON.stringify(events.filter(event => event.event !== "heartbeat").map(event => ({
                    event: event.event, state: event.state, requestId: event.requestId ?? event.receipt?.requestId,
                    reason: event.reason, issues: event.status?.corpus?.issues,
                }))))), timeout) };
            waiters.push(waiter);
        });
    };
    await wait(event => event.event === "connected");
    return { api, events, wait, response, async close() { controller.abort(); await reading; } };
}

export async function saveSearchComparison(app, formats) {
    const preview = await app.exports.previewComparison("frozen-search-proof", app.bundles[0].bundleId, app.bundles[1].bundleId, { formats });
    await app.exports.reviewComparison("frozen-search-proof", preview.previewId, true);
    return (await app.exports.confirmComparison("frozen-search-proof", preview.previewId, true)).bundle;
}
