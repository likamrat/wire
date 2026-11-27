import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { discoverSources, validateSourcePaths } from "../../lib/source-discovery.mjs";
import { createCollector } from "../../lib/collector.mjs";
import { loadBoardState, mergeEvidenceWithState, replaceEvidence, updateBoardState } from "../../lib/store.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../../lib/activity-analytics.mjs";
import { createRecordedResults } from "../../web/recorded-results.mjs";
import { createDeletionController } from "../../lib/deletion.mjs";
import { createHash } from "node:crypto";
import { buildReportFacts } from "../../lib/assessment-read-model.mjs";
import { extractScenarios } from "../../lib/history.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";
import { createProfileSource } from "./source-profile-fixture.mjs";
import { interactionModelFact } from "../../lib/interaction-model.mjs";
import { evaluationRecordFingerprint } from "../../lib/evaluation-fingerprint.mjs";
import { buildSanitizedRecord } from "../../lib/export.mjs";
import { eventIdentity } from "../../lib/deletion-identities.mjs";
import { BACKFILL_DIRECTORY, validateBackfillCheckpoint } from "../../lib/collector-backfill.mjs";
import { TAIL_LIMITS } from "../../lib/collector-io.mjs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { createRecollectionController } from "../../lib/recollection.mjs";
import { createUsageRecordCountController } from "../../lib/usage-record-counting.mjs";
import { utimes } from "node:fs/promises";
import { currentStatePayload } from "../../lib/server.mjs";

// Invented app metadata and events, isolated from the user's installation.
test("source path rejection is explicit for nonstrings, relative paths and wrong basenames", () => {
    const good = { appDbPath: path.resolve("invented", "data.db"), sessionRoot: path.resolve("invented", "session-state") };
    assert.doesNotThrow(() => validateSourcePaths(good));
    for (const value of [null, undefined, 42, true, {}, [], "", "relative", path.resolve("invented", "wrong-name")]) {
        for (const key of ["appDbPath", "sessionRoot"]) {
            assert.throws(() => validateSourcePaths({ ...good, [key]: value }),
                error => error.status === 422 && error.code === "source_paths_invalid");
        }
    }
});

async function installation(t, { metadata174 = false, profile = false } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "workiq-dynamic-synthetic-"));
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state") };
    await mkdir(config.sessionRoot);
    const db = profile ? (await createProfileSource(root)).db : new DatabaseSync(config.appDbPath);
    if (!profile) db.exec(metadata174 ? metadata174Schema : `PRAGMA user_version=156;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
    const cleanup = [];
    t.after(async () => { for (const close of cleanup) await close(); db.close(); await rm(root, { recursive: true, force: true }); });
    function session({ archived = null, location = "local" } = {}) {
        const id = randomUUID();
        db.prepare("INSERT INTO sessions(id,title,session_type,archived_at,execution_location) VALUES(?,?,?,?,?)").run(id, "Synthetic request", "chat", archived, location);
        return id;
    }
    return { root, config, db, session, cleanup, context: { dataDir: path.join(root, "private") } };
}

test("synthetic: fresh approved app enumeration pages past 500 and uses authoritative archive/host mappings", async (t) => {
    const app = await installation(t);
    for (let n = 0; n < 510; n++) app.session();
    const archived = app.session({ archived: "2026-10-01" });
    const cloud = app.session({ location: "cloud" });
    const mapped = app.session();
    const workspace = randomUUID(), project = randomUUID();
    app.db.prepare("INSERT INTO projects VALUES(?,?)").run(project, "Synthetic project");
    app.db.prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?,?)").run(workspace, mapped, project, "Synthetic workspace", null, "local", "folder");
    const discovered = await discoverSources(app.config);
    assert.equal(discovered.counts.sessions, 513);
    assert.equal(discovered.counts.eligible, 511);
    assert.ok(discovered.counts.pages > 2);
    assert.equal(discovered.roster.find(r => r.sessionId === archived).disposition, "archived");
    assert.equal(discovered.roster.find(r => r.sessionId === cloud).disposition, "nonlocal-not-read");
    assert.equal(discovered.roster.find(r => r.sessionId === mapped).appId, workspace);
    assert.equal(discovered.roster.find(r => r.sessionId === mapped).projectId, project);
});

const event = (type, data, id = randomUUID()) => ({ id, type, timestamp: new Date().toISOString(), data });
async function logFor(app, id, events = []) {
    const file = path.join(app.config.sessionRoot, id, "events.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [event("session.start", { sessionId: id, version: 1 }), ...events].map(e => JSON.stringify(e) + "\n").join(""));
    return file;
}
const call = (id = "synthetic-call") => event("tool.execution_start", {
    toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch",
    toolCallId: id, arguments: { entityUrls: ["/me/messages"] },
});

const managedSchema = `CREATE TABLE session_managed_mcp_event_display_names(
    session_id TEXT NOT NULL,event_id TEXT NOT NULL,display_name TEXT NOT NULL,
    PRIMARY KEY(session_id,event_id));`;

test("history compatibility: an explicit closed run meters without a prompt message ID, response model, reply text or timing", async t => {
    const app = await installation(t), id = app.session(), interactionId = randomUUID();
    const tool = call("lookup"), turnId = "turn", apiCallId = "direct-api";
    const p = event("user.message", { interactionId, content: "Find the invented review notes." });
    const a = event("assistant.message", { interactionId, turnId, apiCallId, toolRequests: [{toolCallId:"lookup"}] });
    const end = event("assistant.turn_end", {turnId});
    const receipt = event("session.usage_record", {usage:{interactionId, apiCallId, model:"gpt-4.1",
        inputTokens:100, cacheReadTokens:20, cacheWriteTokens:0, outputTokens:5}});
    const close = event("session.completion_receipt", { schemaVersion:1, attempt:1, stopReason:"natural",
        eventRange:{startEventId:p.id, endEventId:end.id}, sourceEventId:end.id, successfulToolCount:1, failedToolCount:0 });
    const missing = event("assistant.message", {interactionId, turnId, apiCallId:"second-api", toolRequests:[]});
    tool.data.turnId = turnId;
    const batch = [p, a, tool, event("tool.execution_complete",{interactionId,toolCallId:"lookup",success:true,result:{content:"abcd"}}),
        missing, receipt, end, close];
    batch.forEach((e,i)=>{e.timestamp=new Date(Date.now()-10000+i*100).toISOString();});
    const file = await logFor(app,id,batch);
    let collector=await createCollector(app.context,{timers:false}); app.cleanup.push(()=>collector.close());
    await collector.configure({...app.config,approved:true,enabled:false,windowDays:30,pollSeconds:5});
    const read=async()=>(await currentStatePayload(app.context,await loadBoardState(app.context))).scenarios[0];
    await collector.collectNow();
    assert.equal((await read()).usage,null,"missing a receipt is not a whole-interaction total");
    await collector.close(); collector=await createCollector(app.context,{timers:false});
    await appendFile(file,JSON.stringify(event("session.usage_record",{usage:{...receipt.data.usage,apiCallId:"second-api",outputTokens:10}}))+"\n");
    await collector.collectNow();
    const complete=await read();
    assert.equal(complete.usage?.total,215);
    assert.equal(complete.usage?.steps.length,2);
    assert.notEqual(complete.responseTiming?.status,"measured");
    assert.deepEqual(complete.originalModel.models,[]);
    assert.equal(complete.toolCalls[0].promptLink,undefined,"usage evidence must not rewrite historical prompt authorship");
    assert.equal(complete.toolCalls[0].usageContextLinked,true,"the sized result has an explicit tool request in the same closed run");
    await appendFile(file,JSON.stringify(event("user.message",{interactionId,content:"A rival prompt claimed this run."}))+"\n");
    await collector.collectNow();
    const disputed = await read();
    assert.equal(disputed.usage,null,"a rival claim withdraws previously verified usage");
    assert.equal(disputed.toolCalls[0].usageContextLinked,undefined);
});

for (const namesSteering of [false, true]) test(`history compatibility: a steering message keeps a new Work IQ request with its running root, measured once through restart${namesSteering ? " (replies name the steering message)" : ""}`, async t => {
    const app = await installation(t), id = app.session(), interactionId = randomUUID();
    const root = event("user.message", { interactionId, messageId: "root", delivery: "idle", content: "Summarize the invented launch notes." });
    const first = event("assistant.message", { interactionId, turnId: "turn-1", apiCallId: "api-1" });
    const steer = event("user.message", { interactionId, messageId: "steer", delivery: "steering", content: "Only the invented risks, please." });
    const tool = call("steered-lookup");
    tool.data.turnId = "turn-2";
    const second = event("assistant.message", { interactionId, turnId: "turn-2", apiCallId: "api-2", toolRequests: [{ toolCallId: "steered-lookup" }],
        ...(namesSteering ? { originatingMessageId: "steer" } : {}) });
    const receipt = (apiCallId, outputTokens) => event("session.usage_record", { usage: { interactionId, apiCallId, model: "gpt-4.1",
        inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens } });
    const end = event("assistant.turn_end", { turnId: "turn-2" });
    const close = event("session.completion_receipt", { schemaVersion: 1, attempt: 1, stopReason: "natural",
        eventRange: { startEventId: root.id, endEventId: end.id }, sourceEventId: end.id, successfulToolCount: 1, failedToolCount: 0 });
    const batch = [root, first, steer, second, tool, event("tool.execution_complete", { interactionId, toolCallId: "steered-lookup", success: true }),
        receipt("api-1", 5), receipt("api-2", 10), end, close];
    batch.forEach((e, i) => { e.timestamp = new Date(Date.now() - 20000 + i * 100).toISOString(); });
    const file = await logFor(app, id, batch);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const read = async () => (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios.filter(s => s.sourceSessionId === id);
    await collector.collectNow();
    const [record, ...others] = await read();
    assert.equal(others.length, 0);
    assert.equal(record.scenarioId, `history-${id}-${root.id}`, "the run's root prompt anchors the request");
    assert.equal(record.userPrompt.text, root.data.content);
    assert.deepEqual(record.followUpPrompts.map(p => [p.sourceEventId, p.text, p.association]),
        [[steer.id, steer.data.content, "Sent while this request was still running, so it belongs to the same request."]]);
    assert.equal(record.usage?.total, 215, "both model calls of the steered run are counted once");
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await collector.collectNow();
    const after = await read();
    assert.deepEqual(after.map(s => [s.scenarioId, s.usage?.total, s.toolCalls.length]), [[record.scenarioId, 215, 1]], "restart adds no duplicate or orphan");
    const idle = event("user.message", { interactionId, messageId: "next", delivery: "idle", content: "A separate invented request." });
    const later = call("later-lookup");
    idle.timestamp = new Date(Date.now() - 5000).toISOString(); later.timestamp = new Date(Date.now() - 4000).toISOString();
    await appendFile(file, [idle, later].map(e => JSON.stringify(e) + "\n").join(""));
    await collector.collectNow();
    const separated = await read();
    assert.deepEqual(separated.map(s => s.userPrompt.sourceEventId).sort(), [root.id, idle.id].sort(), "an idle prompt in the same run stays separate");
    assert.equal(separated.find(s => s.userPrompt.sourceEventId === root.id).toolCalls.length, 1);
});

test("history compatibility: a retained steering-anchored request keeps its identity and later calls in its exchange", async t => {
    const app = await installation(t), id = app.session(), interactionId = randomUUID();
    const root = event("user.message", { interactionId, messageId: "root", delivery: "idle", content: "Review the invented plan." });
    const steer = event("user.message", { interactionId, messageId: "steer", delivery: "steering", content: "Focus on the invented budget." });
    const tool = call("saved-lookup");
    const batch = [root, steer, tool, event("tool.execution_complete", { interactionId, toolCallId: "saved-lookup", success: true })];
    batch.forEach((e, i) => { e.timestamp = new Date(Date.now() - 20000 + i * 100).toISOString(); });
    const file = await logFor(app, id, batch);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    // Records saved before this change were anchored on the steering message itself.
    const legacyId = `history-${id}-${steer.id}`;
    await replaceEvidence(app.context, current => ({ records: current.map(record => record.sourceSessionId !== id ? record : {
        ...record, scenarioId: legacyId, userPrompt: (({ association, ...prompt }) => prompt)(record.followUpPrompts[0]), followUpPrompts: [] }) }));
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    const later = call("later-lookup");
    later.timestamp = new Date(Date.now() - 5000).toISOString();
    await appendFile(file, JSON.stringify(later) + "\n");
    await collector.collectNow();
    const state = await loadBoardState(app.context);
    const records = mergeEvidenceWithState(state).filter(record => record.sourceSessionId === id);
    assert.deepEqual(records.map(record => [record.scenarioId, record.userPrompt.sourceEventId, record.toolCalls.map(c => c.toolCallId)]),
        [[legacyId, steer.id, ["saved-lookup", "later-lookup"]]], "no second record and no reassignment to the root");
});

test("history compatibility: a call in a queued run whose replies repeat the first prompt's message ID belongs to the queued prompt", async t => {
    const app = await installation(t), id = app.session(), runA = randomUUID(), runB = randomUUID();
    const first = event("user.message", { interactionId: runA, messageId: "first", delivery: "idle", content: "First invented request." });
    const second = event("user.message", { interactionId: runB, messageId: "second", delivery: "queued", content: "Queued invented request." });
    const reply = (run, turnId, apiCallId, extra = {}) => event("assistant.message", { interactionId: run, originatingMessageId: "first", turnId, apiCallId, model: "gpt-4.1", ...extra });
    const receipt = (run, apiCallId, outputTokens) => event("session.usage_record", { usage: { interactionId: run, apiCallId, model: "gpt-4.1", inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens } });
    const tool = call("queued-lookup");
    tool.data.turnId = "b-1";
    const end = event("assistant.turn_end", { turnId: "b-2" });
    const batch = [first, reply(runA, "a-1", "a-api"), receipt(runA, "a-api", 1), event("assistant.turn_end", { turnId: "a-1" }),
        second, reply(runB, "b-1", "b-api-1", { toolRequests: [{ toolCallId: "queued-lookup" }] }), tool,
        event("tool.execution_complete", { toolCallId: "queued-lookup", success: true }), receipt(runB, "b-api-1", 1), event("assistant.turn_end", { turnId: "b-1" }),
        reply(runB, "b-2", "b-api-2"), receipt(runB, "b-api-2", 2), end];
    batch.push(event("session.completion_receipt", { schemaVersion: 1, attempt: 1, stopReason: "natural",
        eventRange: { startEventId: second.id, endEventId: end.id }, sourceEventId: end.id, successfulToolCount: 1, failedToolCount: 0 }));
    batch.forEach((e, i) => { e.timestamp = new Date(Date.now() - 20000 + i * 100).toISOString(); });
    await logFor(app, id, batch);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const read = async () => (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios.filter(s => s.sourceSessionId === id);
    await collector.collectNow();
    assert.deepEqual((await read()).map(s => [s.userPrompt.sourceEventId, s.usage?.total ?? null]), [[second.id, 203]], "the reply's run names the queued prompt");
    // A record saved earlier under the first prompt keeps its identity and its call.
    const legacyId = `history-${id}-${first.id}`;
    await replaceEvidence(app.context, current => ({ records: current.map(record => record.sourceSessionId !== id ? record : {
        ...record, scenarioId: legacyId, userPrompt: { ...record.userPrompt, sourceEventId: first.id, sourceTimestamp: first.timestamp, text: first.data.content } }) }));
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await collector.collectNow();
    assert.deepEqual(mergeEvidenceWithState(await loadBoardState(app.context)).filter(r => r.sourceSessionId === id)
        .map(r => [r.scenarioId, r.toolCalls.map(c => c.toolCallId)]), [[legacyId, ["queued-lookup"]]], "no second record and no reassignment");
});

test("history compatibility: a request-only meter for a retained run survives a restart before its closure", async t => {
    const app = await installation(t), id = app.session(), interactionId = randomUUID(), turnId = "tool-turn";
    const prompt = event("user.message", { interactionId, content: "Read the invented review notes." });
    const tool = call("metered-lookup");
    tool.data.turnId = turnId;
    const response = event("assistant.message", { interactionId, turnId, apiCallId: "owned-request", toolRequests: [{ toolCallId: tool.data.toolCallId }] });
    const meter = apiCallId => event("session.usage_record", { usage: { apiCallId, model: "gpt-4.1", inputTokens: 22, outputTokens: 3 } });
    const unrelated = meter("unrelated-request"), owned = meter("owned-request");
    const file = await logFor(app, id, [unrelated, prompt, response, tool,
        event("tool.execution_complete", { toolCallId: tool.data.toolCallId, success: true }), owned]);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const read = async () => (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios[0];
    await collector.collectNow();
    assert.equal((await read()).usage, null);
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    const end = event("assistant.turn_end", { turnId });
    const closure = event("session.completion_receipt", { schemaVersion: 1, stopReason: "natural",
        eventRange: { startEventId: prompt.id, endEventId: end.id }, sourceEventId: end.id });
    await appendFile(file, [end, closure].map(e => JSON.stringify(e) + "\n").join(""));
    await collector.collectNow();
    const after = await read();
    assert.equal(after.usage?.total, 25, "the earlier numeric original is still available when the root closes");
    assert.equal(after.usage.steps.length, 1);
    const dir = path.join(app.context.dataDir, "collector");
    const { fingerprint } = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"));
    const checkpoint = JSON.parse(await readFile(path.join(dir, fingerprint, `${id}.json`), "utf8"));
    assert.equal(checkpoint.events.some(e => e.id === unrelated.id), false);
});

test("history compatibility: shared run receipts stay with their exact messages through restart and a rival withdraws them", async t => {
    const app = await installation(t), id = app.session(), interactionId = "reused-run", model = "example";
    const batch = [];
    for (const n of [1,2]) {
        const messageId = `message-${n}`, turnId = `turn-${n}`, toolCallId = `tool-${n}`, start = call(toolCallId);
        start.data.turnId = turnId;
        const response = (apiCallId, fields) => event("assistant.message", {interactionId,messageId:`response-${apiCallId}`,
            originatingMessageId:messageId,turnId,apiCallId,model,...fields});
        const receipt = (apiCallId,inputTokens) => event("session.usage_record",
            {usage:{interactionId,apiCallId,model,inputTokens,outputTokens:1}});
        batch.push(event("user.message",{messageId,interactionId,content:`Read invented item ${n}.`}),
            response(`request-${n}`,{toolRequests:[{toolCallId}]}),start,
            event("tool.execution_complete",{toolCallId,success:n===2}),
            receipt(`request-${n}`,10*n),response(`answer-${n}`,{phase:"final_answer",toolRequests:[]}),
            receipt(`answer-${n}`,20*n),event("assistant.turn_end",{turnId}));
    }
    const base = Date.now()-20000;
    batch.forEach((e,index)=>{e.timestamp=new Date(base+index*100).toISOString();});
    const file = await logFor(app,id,batch);
    let collector = await createCollector(app.context,{timers:false});
    app.cleanup.push(()=>collector.close());
    await collector.configure({...app.config,approved:true,enabled:false,windowDays:30,pollSeconds:5});
    const read = async () => (await currentStatePayload(app.context,await loadBoardState(app.context))).scenarios
        .sort((a,b)=>a.userPrompt.text.localeCompare(b.userPrompt.text));
    await collector.collectNow();
    const first = await read();
    assert.deepEqual(first.map(r=>r.usage?.total),[32,62]);
    assert.deepEqual(first.map(r=>r.toolCalls[0].toolSucceeded),[false,true]);
    await collector.close(); collector = await createCollector(app.context,{timers:false});
    await collector.collectNow();
    const reopened = await read();
    assert.deepEqual(reopened.map(r=>[r.scenarioId,r.usage?.total]),first.map(r=>[r.scenarioId,r.usage?.total]));
    await appendFile(file,JSON.stringify(event("assistant.message",{interactionId,originatingMessageId:"message-2",
        apiCallId:"request-1",model,turnId:"rival",phase:"final_answer",toolRequests:[]}))+"\n");
    await collector.collectNow();
    assert.deepEqual((await read()).map(r=>r.usage),[null,null]);
});

test("history compatibility: with its own approval, an older journal without receipts is metered from the app's per-call index and keeps it after later appends", async t => {
    const app = await installation(t, { profile: true }), id = app.session(), start = call("indexed-fetch");
    const index = new DatabaseSync(path.join(app.root, "session-store.db"));
    app.cleanup.push(() => index.close());
    index.exec(`CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT);
        CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT, model TEXT,
            input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT);`);
    const text = "Summarize the invented launch notes.";
    const batch = [event("user.message", { content: text, messageId: "older-prompt", delivery: "idle" }),
        event("assistant.turn_start", { turnId: "a" }), event("assistant.message", { turnId: "a", toolRequests: [{ toolCallId: "indexed-fetch" }] }), start,
        event("tool.execution_complete", { toolCallId: "indexed-fetch", success: true, result: { content: "INVENTED" } }), event("assistant.turn_end", { turnId: "a" }),
        event("assistant.turn_start", { turnId: "b" }), event("assistant.message", { turnId: "b", content: "Invented answer", toolRequests: [] }),
        event("assistant.turn_end", { turnId: "b" })];
    const base = Date.now() - 60000;
    batch.forEach((e, n) => { e.timestamp = new Date(base + n * 1000).toISOString(); });
    const after = id => new Date(Date.parse(batch.find(e => e.data.turnId === id && e.type === "assistant.message").timestamp) + 4).toISOString();
    index.prepare("INSERT INTO turns VALUES (?,0,?,?)").run(id, text, "Invented answer");
    index.prepare("INSERT INTO assistant_usage_events (session_id,turn_index,agent_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at) VALUES (?,0,NULL,'gpt-4.1',5000,100,4000,500,?)").run(id, after("a"));
    index.prepare("INSERT INTO assistant_usage_events (session_id,turn_index,agent_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at) VALUES (?,0,NULL,'gpt-4.1',6000,300,5500,400,?)").run(id, after("b"));
    const file = await logFor(app, id, batch);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const read = async () => (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios[0];
    assert.equal((await read()).usage, null, "Source approval alone does not read the app's token records");
    const config = (await collector.status()).config;
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5, usageRecords: true,
        expectedConfigVersion: (await collector.status()).configVersion });
    assert.equal((await collector.status()).config.usageRecords, true); assert.notEqual(config.usageRecords, true);
    // Approval applies when collection next reads the chat.
    await appendFile(file, JSON.stringify({ ...event("session.info", { infoType: "note", message: "invented" }),
        timestamp: new Date(Date.parse(batch.at(-1).timestamp) + 100).toISOString() }) + "\n");
    await collector.collectNow();
    let record = await read();
    assert.equal(record.usage?.total, 11400);
    assert.deepEqual(record.usage.tokens, { freshInput: 600, cacheRead: 9500, cacheWrite: 900, output: 400 });
    assert.equal(record.usageBasis, "copilot-usage-index");
    const later = (type, data, ms) => ({ ...event(type, data), timestamp: new Date(Date.parse(batch.at(-1).timestamp) + ms).toISOString() });
    const extension = [later("assistant.turn_start", { turnId: "c" }, 500), later("assistant.message", { turnId: "c", content: "More work" }, 700)];
    await appendFile(file, extension.map(e => JSON.stringify(e) + "\n").join(""));
    await collector.collectNow();
    assert.equal((await read()).usage, null, "Journal activity that continues the exchange retires its earlier indexed total");
    index.prepare("INSERT INTO assistant_usage_events (session_id,turn_index,agent_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at) VALUES (?,0,NULL,'gpt-4.1',7000,50,6000,0,?)")
        .run(id, new Date(Date.parse(extension[1].timestamp) + 4).toISOString());
    await appendFile(file, JSON.stringify(later("assistant.turn_end", { turnId: "c" }, 900)) + "\n");
    await collector.collectNow();
    assert.equal((await read()).usage?.total, 18450, "The closed, extended exchange is counted again with its new call");
    await appendFile(file, JSON.stringify(later("user.message", { content: "Unrelated later question.", delivery: "idle" }, 2000)) + "\n");
    await collector.collectNow();
    assert.equal((await read()).usage?.total, 18450, "A later prompt neither removes nor changes the indexed total");
    index.exec("DROP TABLE assistant_usage_events");
    await appendFile(file, JSON.stringify(later("session.info", { infoType: "note", message: "invented" }, 3000)) + "\n");
    await collector.collectNow();
    assert.equal((await read()).usage?.total, 18450, "An index WIRE cannot read never clears a total it already verified");
});
test("history compatibility: token-record approval names one Copilot account; a changed account stops the reads until approved again", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workiq-usage-account-")), cleanup = [];
    t.after(async () => { for (const close of cleanup.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
    const { db, appDbPath, sessionRoot } = await createProfileSource(root);
    cleanup.push(() => db.close());
    const id = randomUUID();
    db.prepare("INSERT INTO sessions(id,title,session_type) VALUES(?,?,?)").run(id, "Invented chat", "general_chat");
    const base = Date.now() - 120000, at = n => new Date(base + n * 1000).toISOString();
    const exchange = (text, n, a, b) => [event("user.message", { content: text, delivery: "idle" }), event("assistant.turn_start", { turnId: a }),
        event("assistant.message", { turnId: a, toolRequests: [{ toolCallId: a + "-fetch" }] }), call(a + "-fetch"),
        event("tool.execution_complete", { toolCallId: a + "-fetch", success: true, result: { content: "INVENTED" } }), event("assistant.turn_end", { turnId: a }),
        event("assistant.turn_start", { turnId: b }), event("assistant.message", { turnId: b, content: "Invented answer", toolRequests: [] }),
        event("assistant.turn_end", { turnId: b })].map((e, k) => ({ ...e, timestamp: at(n + k) }));
    const first = exchange("Summarize the invented launch notes.", 0, "a", "b"), second = exchange("List the invented owners.", 20, "c", "d");
    const file = path.join(sessionRoot, id, "events.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [event("session.start", { sessionId: id, version: 1 }), ...first].map(e => JSON.stringify(e) + "\n").join(""));
    const index = new DatabaseSync(path.join(root, "session-store.db"));
    cleanup.push(() => index.close());
    index.exec(`CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT);
        CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT, model TEXT,
            input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT);`);
    const indexed = (events, turn) => {
        index.prepare("INSERT INTO turns VALUES (?,?,?,?)").run(id, turn, events[0].data.content, "Invented answer");
        for (const reply of events.filter(e => e.type === "assistant.message")) index.prepare(`INSERT INTO assistant_usage_events (session_id,turn_index,agent_id,model,
            input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at) VALUES (?,?,NULL,'gpt-4.1',5000,100,4000,500,?)`)
            .run(id, turn, new Date(Date.parse(reply.timestamp) + 4).toISOString());
    };
    indexed(first, 0);
    const context = { dataDir: path.join(root, "private") }, config = { appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    const collector = await createCollector(context, { timers: false });
    cleanup.push(() => collector.close());
    await collector.configure({ ...config, usageRecords: true });
    await collector.collectNow();
    const read = async text => (await currentStatePayload(context, await loadBoardState(context))).scenarios.find(s => s.userPrompt?.text === text);
    assert.equal((await read(first[0].data.content)).usage?.total, 10200);
    assert.equal((await collector.status()).config.usageRecordsGrant.file, path.join(root, "session-store.db"));
    db.prepare("UPDATE projects SET github_account_id='default'").run();
    indexed(second, 1);
    await appendFile(file, second.map(e => JSON.stringify(e) + "\n").join(""));
    await collector.collectNow();
    assert.equal((await read(second[0].data.content)).usage, null, "A different Copilot account does not inherit the approval");
    assert.equal((await read(first[0].data.content)).usage?.total, 10200, "Totals counted before the change stay");
    assert.equal((await collector.status()).usageRecords, "approval-changed");
    const granted = (await collector.status()).config.usageRecordsGrant;
    await collector.configure({ ...config, pollSeconds: 15, expectedConfigVersion: (await collector.status()).configVersion });
    assert.deepEqual((await collector.status()).config.usageRecordsGrant, granted, "A cadence-only save keeps the original grant and never re-binds it");
    await appendFile(file, JSON.stringify({ ...event("session.info", { infoType: "note", message: "invented" }), timestamp: at(39) }) + "\n");
    await collector.collectNow();
    assert.equal((await read(second[0].data.content)).usage, null, "Saving preferences does not approve the new account");
    assert.equal((await collector.status()).usageRecords, "approval-changed");
    await collector.configure({ ...config, usageRecords: true, expectedConfigVersion: (await collector.status()).configVersion });
    await appendFile(file, JSON.stringify({ ...event("session.info", { infoType: "note", message: "invented" }), timestamp: at(40) }) + "\n");
    await collector.collectNow();
    assert.equal((await read(second[0].data.content)).usage?.total, 10200, "A fresh approval for the current account reads again");
    assert.equal((await collector.status()).usageRecords, "on");

    // An account change between the index read and the commit refuses that commit.
    const third = exchange("Name the invented reviewers.", 50, "e", "f");
    indexed(third, 2);
    const { default: fsSync } = await import("node:fs"), original = fsSync.statSync;
    let switched = false;
    fsSync.statSync = (target, ...rest) => {
        if (!switched && String(target).endsWith("session-store.db")) { switched = true; db.prepare("UPDATE projects SET github_account_id='workspace'").run(); }
        return original(target, ...rest);
    };
    syncBuiltinESMExports();
    t.after(() => { fsSync.statSync = original; syncBuiltinESMExports(); });
    await appendFile(file, third.map(e => JSON.stringify(e) + "\n").join(""));
    await assert.rejects(collector.collectNow(), e => [e.code, e.cause?.code].includes("COLLECTION_SOURCE_CHANGED"));
    fsSync.statSync = original; syncBuiltinESMExports();
    assert.ok(switched);
    assert.equal((await read(third[0].data.content))?.usage ?? null, null, "Nothing read under the replaced account is committed");
    await collector.collectNow().catch(() => {});
    assert.equal((await read(third[0].data.content))?.usage ?? null, null);
    assert.equal((await collector.status()).usageRecords, "approval-changed");
});
test("history compatibility: a stale token-record approval stops the next chat's index read within the same pass", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workiq-usage-two-chats-")), cleanup = [];
    t.after(async () => { for (const close of cleanup.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
    const { db, appDbPath, sessionRoot } = await createProfileSource(root);
    cleanup.push(() => db.close());
    const base = Date.now() - 120000, at = n => new Date(base + n * 1000).toISOString();
    const index = new DatabaseSync(path.join(root, "session-store.db"));
    cleanup.push(() => index.close());
    index.exec(`CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT);
        CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT, model TEXT,
            input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT);`);
    const chats = [];
    for (const [n, text] of [[0, "Summarize the invented launch notes."], [20, "List the invented owners."]]) {
        const id = randomUUID(), a = "a" + n;
        db.prepare("INSERT INTO sessions(id,title,session_type) VALUES(?,?,?)").run(id, "Invented chat", "general_chat");
        const events = [event("user.message", { content: text, delivery: "idle" }), event("assistant.turn_start", { turnId: a }),
            event("assistant.message", { turnId: a, toolRequests: [{ toolCallId: a + "-fetch" }] }), call(a + "-fetch"),
            event("tool.execution_complete", { toolCallId: a + "-fetch", success: true, result: { content: "INVENTED" } }),
            event("assistant.turn_end", { turnId: a })].map((e, k) => ({ ...e, timestamp: at(n + k) }));
        const file = path.join(sessionRoot, id, "events.jsonl");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, [event("session.start", { sessionId: id, version: 1 }), ...events].map(e => JSON.stringify(e) + "\n").join(""));
        index.prepare("INSERT INTO turns VALUES (?,0,?,?)").run(id, text, "Invented answer");
        index.prepare(`INSERT INTO assistant_usage_events (session_id,turn_index,agent_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at)
            VALUES (?,0,NULL,'gpt-4.1',5000,100,4000,500,?)`).run(id, new Date(Date.parse(events[2].timestamp) + 4).toISOString());
        chats.push({ id, text });
    }
    const context = { dataDir: path.join(root, "private") };
    const collector = await createCollector(context, { timers: false });
    cleanup.push(() => collector.close());
    // Approve, then switch the account right after the first index read of the next pass.
    const { default: fsSync } = await import("node:fs"), original = fsSync.statSync;
    const opened = [];
    fsSync.statSync = (target, ...rest) => {
        if (String(target).endsWith("session-store.db")) { opened.push(target); if (opened.length === 1) db.prepare("UPDATE projects SET github_account_id='default'").run(); }
        return original(target, ...rest);
    };
    syncBuiltinESMExports();
    t.after(() => { fsSync.statSync = original; syncBuiltinESMExports(); });
    await collector.configure({ appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5, usageRecords: true });
    opened.length = 0;
    await assert.rejects(collector.collectNow(), e => [e.code, e.cause?.code].includes("COLLECTION_SOURCE_CHANGED"));
    fsSync.statSync = original; syncBuiltinESMExports();
    assert.equal(opened.length, 1, "Once the approval is stale, the second chat's index is never opened");
    const scenarios = (await currentStatePayload(context, await loadBoardState(context))).scenarios;
    for (const chat of chats) assert.equal(scenarios.find(s => s.userPrompt?.text === chat.text)?.usage ?? null, null);
    assert.equal((await collector.status()).usageRecords, "approval-changed");
});
test("history compatibility: token records need a positively identified account; an unknown or legacy grant never reads", async t => {
    const app = await installation(t), id = app.session();
    const base = Date.now() - 60000, text = "Summarize the invented launch notes.";
    const batch = [event("user.message", { content: text, delivery: "idle" }), event("assistant.turn_start", { turnId: "a" }),
        event("assistant.message", { turnId: "a", toolRequests: [{ toolCallId: "u-fetch" }] }), call("u-fetch"),
        event("tool.execution_complete", { toolCallId: "u-fetch", success: true, result: { content: "INVENTED" } }), event("assistant.turn_end", { turnId: "a" })];
    batch.forEach((e, n) => { e.timestamp = new Date(base + n * 1000).toISOString(); });
    const file = await logFor(app, id, batch);
    const index = new DatabaseSync(path.join(app.root, "session-store.db"));
    index.exec(`CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT);
        CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT, model TEXT,
            input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT);`);
    index.prepare("INSERT INTO turns VALUES (?,0,?,?)").run(id, text, "Done");
    index.prepare(`INSERT INTO assistant_usage_events (session_id,turn_index,agent_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at)
        VALUES (?,0,NULL,'gpt-4.1',5000,100,4000,500,?)`).run(id, new Date(Date.parse(batch[2].timestamp) + 4).toISOString());
    index.close();
    const config = { ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    // First connection keeps the default request but connects without token records when the account is unidentified.
    const first = await collector.configure({ ...config, usageRecords: true });
    assert.equal(first.config.usageRecords, false);
    assert.equal(Object.hasOwn(first.config, "usageRecordsGrant"), false);
    assert.equal((await collector.status()).usageRecords, "off");
    // A later explicit request still refuses and leaves the connection unchanged.
    const before = await readFile(path.join(app.context.dataDir, "collector", "config.json"), "utf8");
    await assert.rejects(collector.configure({ ...config, usageRecords: true }), e => e.status === 422 && /can't identify the Copilot account/.test(e.message));
    assert.equal(await readFile(path.join(app.context.dataDir, "collector", "config.json"), "utf8"), before);
    await collector.close();
    const stored = path.join(app.context.dataDir, "collector", "config.json");
    const legacy = JSON.parse(await readFile(stored, "utf8"));
    await writeFile(stored, JSON.stringify({ ...legacy, usageRecords: true, usageRecordsGrant: { file: path.join(app.root, "session-store.db"), account: null } }));
    collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    assert.equal((await collector.status()).usageRecords, "approval-changed", "An unknown account never looks approved");
    await appendFile(file, JSON.stringify({ ...event("session.info", { infoType: "note", message: "invented" }), timestamp: new Date(base + 9000).toISOString() }) + "\n");
    await collector.collectNow();
    const record = (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios[0];
    assert.equal(record.usage, null, "Unknown never equals unknown");
    assert.equal((await collector.status()).usageRecords, "approval-changed");
});
test("history compatibility: Copilot's token records never replace a total the journal verified", async t => {
    const app = await installation(t, { profile: true }), id = app.session(), start = call("journal-fetch"), model = "gpt-4.1";
    const text = "Compare the invented launch notes.", later = "Now list the invented owners.";
    const receipt = apiCallId => event("session.usage_record", { usage: { apiCallId, model, interactionId: "run-a", inputTokens: 2000, outputTokens: 200 } });
    start.data.turnId = "a1";
    const first = [event("user.message", { messageId: "prompt-a", interactionId: "run-a", content: text, delivery: "idle" }),
        event("assistant.turn_start", { turnId: "a1" }),
        event("assistant.message", { apiCallId: "a-one", turnId: "a1", model, originatingMessageId: "prompt-a", toolRequests: [{ toolCallId: "journal-fetch" }] }), start,
        event("tool.execution_complete", { toolCallId: "journal-fetch", success: true, result: { content: "INVENTED" } }), receipt("a-one"),
        event("assistant.turn_end", { turnId: "a1" }), event("assistant.turn_start", { turnId: "a2" }),
        event("assistant.message", { apiCallId: "a-two", turnId: "a2", model, originatingMessageId: "prompt-a", phase: "final_answer", content: "Invented answer", toolRequests: [] }),
        receipt("a-two"), event("assistant.turn_end", { turnId: "a2" })];
    const base = Date.now() - 60000;
    first.forEach((e, n) => { e.timestamp = new Date(base + n * 100).toISOString(); });
    const file = await logFor(app, id, first);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const read = async () => (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios.find(s => s.userPrompt?.text === text);
    assert.equal((await read()).usage?.total, 4400);
    const index = new DatabaseSync(path.join(app.root, "session-store.db"));
    index.exec(`CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT);
            CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT, model TEXT,
                input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT);`);
    index.prepare("INSERT INTO turns VALUES (?,0,?,?),(?,1,?,NULL)").run(id, text, "Invented answer", id, later);
    for (const turn of ["a1", "a2"]) index.prepare("INSERT INTO assistant_usage_events (session_id,turn_index,agent_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at) VALUES (?,0,NULL,?,9000,900,0,0,?)")
        .run(id, model, new Date(Date.parse(first.find(e => e.data.turnId === turn && e.type === "assistant.message").timestamp) + 4).toISOString());
    index.close();
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5, usageRecords: true,
        expectedConfigVersion: (await collector.status()).configVersion });
    const second = [event("assistant.message", { content: "x".repeat(1100 * 1024) }),
        event("user.message", { messageId: "prompt-b", content: later, delivery: "idle" }), call("later-fetch")];
    second.forEach((e, n) => { e.timestamp = new Date(base + 5000 + n * 100).toISOString(); });
    await appendFile(file, second.map(e => JSON.stringify(e) + "\n").join(""));
    await collector.collectNow();
    const record = await read();
    assert.equal(record.usage?.total, 4400);
    assert.equal(record.usageBasis, undefined);
});
// Two invented chats read in full before token records were approved: one the app's records can count, one they can't.
async function readChatsWithoutTotals(t) {
    const app = await installation(t, { profile: true }), id = app.session(), other = app.session();
    const index = new DatabaseSync(path.join(app.root, "session-store.db"));
    app.cleanup.push(() => index.close());
    index.exec(`CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT);
        CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT, model TEXT,
            input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT);`);
    const text = "Summarize the invented launch notes.", base = Date.now() - 60000;
    const exchange = (prompt, callId) => [event("user.message", { content: prompt, delivery: "idle" }),
        event("assistant.turn_start", { turnId: "a" }), event("assistant.message", { turnId: "a", toolRequests: [{ toolCallId: callId }] }), call(callId),
        event("tool.execution_complete", { toolCallId: callId, success: true, result: { content: "INVENTED" } }), event("assistant.turn_end", { turnId: "a" }),
        event("assistant.turn_start", { turnId: "b" }), event("assistant.message", { turnId: "b", content: "Invented answer", toolRequests: [] }),
        event("assistant.turn_end", { turnId: "b" })];
    const batch = exchange(text, "indexed-fetch"), unmatched = exchange("Find the invented budget.", "unmatched-fetch");
    [...batch, ...unmatched].forEach((e, n) => { e.timestamp = new Date(base + n * 1000).toISOString(); });
    const after = turn => new Date(Date.parse(batch.find(e => e.data.turnId === turn && e.type === "assistant.message").timestamp) + 4).toISOString();
    index.prepare("INSERT INTO turns VALUES (?,0,?,?)").run(id, text, "Invented answer");
    const usage = index.prepare("INSERT INTO assistant_usage_events (session_id,turn_index,agent_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at) VALUES (?,0,NULL,'gpt-4.1',?,?,?,?,?)");
    usage.run(id, 5000, 100, 4000, 500, after("a"));
    usage.run(id, 6000, 300, 5500, 400, after("b"));
    const file = await logFor(app, id, batch);
    await logFor(app, other, unmatched);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    const settings = { ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 };
    await collector.configure(settings);
    await collector.collectNow();
    await collector.configure({ ...settings, usageRecords: true, expectedConfigVersion: (await collector.status()).configVersion });
    await collector.collectNow();
    const read = async () => (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios.find(s => s.userPrompt?.text === text);
    assert.equal((await read()).usage, null, "A chat WIRE already read stays unmeasured until it changes");
    const counting = createUsageRecordCountController(app.context);
    return { app, id, other, unmatched, file, index, usage, text, settings, counting, read, after: ms => new Date(Date.parse(unmatched.at(-1).timestamp) + ms).toISOString(),
        collector: () => collector, restart: async () => { await collector.close(); collector = await createCollector(app.context, { timers: false }); app.cleanup.push(() => collector.close()); } };
}
test("history compatibility: a profile switch at publication opens no further chat's token records and saves nothing", async t => {
    const fixture = await readChatsWithoutTotals(t), { app, counting, read, index, other, unmatched } = fixture;
    const second = "Find the invented budget.", reply = turn => new Date(Date.parse(unmatched.find(e => e.data.turnId === turn && e.type === "assistant.message").timestamp) + 4).toISOString();
    index.prepare("INSERT INTO turns VALUES (?,0,?,?)").run(other, second, "Invented answer");
    for (const turn of ["a", "b"]) fixture.usage.run(other, 4000, 200, 3000, 0, reply(turn));
    const before = await loadBoardState(app.context), preview = await counting.preview("panel");
    assert.equal(preview.counts.chats, 2, "Two chats can be counted");
    const { default: fsSync } = await import("node:fs"), original = fsSync.statSync, db = path.join(app.root, "session-store.db");
    let switched = false; const after = [];
    // The selected histories are stat'ed synchronously only by the publication guard; switch the account at its first run.
    fsSync.statSync = (target, ...rest) => {
        const name = String(target);
        if (!switched && (name.includes(fixture.id) || name.includes(other)) && name.endsWith(".jsonl")) {
            switched = true; app.db.prepare("UPDATE projects SET github_account_id='default'").run();
        } else if (switched && name.startsWith(db)) after.push(name.slice(db.length) || "main");
        return original(target, ...rest);
    };
    syncBuiltinESMExports();
    t.after(() => { fsSync.statSync = original; syncBuiltinESMExports(); });
    await assert.rejects(counting.confirm("panel", { operationId: preview.operationId, confirmed: true }));
    fsSync.statSync = original; syncBuiltinESMExports();
    assert.ok(switched, "The account changed during publication");
    for (let n = 0; n < after.length; n += 2) assert.deepEqual(after.slice(n, n + 2), ["main", "-wal"], "Only the boundary pair is stat'ed; no chat's records are opened");
    const saved = await loadBoardState(app.context);
    assert.equal(saved.revision, before.revision);
    assert.equal(saved.usageRecordCounts?.operations?.[preview.operationId], undefined);
    assert.equal((await read()).usage, null);
});
test("history compatibility: a token-record row updated in the write-ahead log before publication refuses the count", async t => {
    const fixture = await readChatsWithoutTotals(t), { app, counting, read, index } = fixture;
    index.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    const { default: fsSync } = await import("node:fs"), original = fsSync.statSync, db = path.join(app.root, "session-store.db");
    const mainStamp = () => { const s = original(db); return [s.size, s.mtimeMs, s.ctimeMs].join(":"); };
    const before = await loadBoardState(app.context), preview = await counting.preview("panel");
    let updated = false, mainUnchanged = null;
    // The selected chat's history is stat'ed synchronously only by the write guard, after every chat was reread.
    fsSync.statSync = (target, ...rest) => {
        if (!updated && String(target).includes(fixture.id)) {
            updated = true; const stamp = mainStamp();
            index.prepare("UPDATE assistant_usage_events SET output_tokens = output_tokens + 1 WHERE id = (SELECT MIN(id) FROM assistant_usage_events WHERE session_id = ?)").run(fixture.id);
            mainUnchanged = stamp === mainStamp();
        }
        return original(target, ...rest);
    };
    syncBuiltinESMExports();
    t.after(() => { fsSync.statSync = original; syncBuiltinESMExports(); });
    await assert.rejects(counting.confirm("panel", { operationId: preview.operationId, confirmed: true }), { code: "USAGE_COUNT_CHANGED" });
    fsSync.statSync = original; syncBuiltinESMExports();
    assert.ok(updated, "The row changed after its reread and before publication");
    assert.equal(mainUnchanged, true, "The update reached only the write-ahead log");
    const after = await loadBoardState(app.context);
    assert.equal(after.revision, before.revision, "Nothing was published");
    assert.equal(after.usageRecordCounts?.operations?.[preview.operationId], undefined, "No receipt was written");
    assert.equal((await read()).usage, null);
});
test("history compatibility: Check result before a delayed confirm stays unsettled until the original confirm settles it", async t => {
    const fixture = await readChatsWithoutTotals(t), { app, counting, read } = fixture;
    let clock = Date.now();
    const lapsing = createUsageRecordCountController(app.context, { now: () => clock }), stale = await lapsing.preview("panel");
    clock += 121000;
    assert.equal((await lapsing.status("panel", { operationId: stale.operationId, receiptToken: stale.receiptToken })).phase, "not-started",
        "Once the preview can no longer be confirmed, nothing was saved is final");
    const preview = await counting.preview("panel"), ask = { operationId: preview.operationId, receiptToken: preview.receiptToken };
    assert.equal((await counting.status("other-panel", ask)).phase, "verification-incomplete", "A valid preview can still be confirmed");
    await assert.rejects(counting.status("other-panel", { ...ask, receiptToken: "0".repeat(64) }), { status: 403 });
    assert.equal((await read()).usage, null);
    assert.equal((await counting.confirm("panel", { operationId: preview.operationId, confirmed: true })).phase, "complete");
    const settled = await counting.status("other-panel", ask);
    assert.equal(settled.phase, "complete");
    assert.equal((await read()).usage?.total, 11400);
    assert.equal(Object.keys((await loadBoardState(app.context)).usageRecordCounts.operations).length, 1, "One receipt, no second confirm");
});
test("history compatibility: Check result never reports nothing was saved while a count is still being confirmed", async t => {
    const fixture = await readChatsWithoutTotals(t), { app, read } = fixture;
    let release, held = new Promise(resolve => { release = resolve; });
    const counting = createUsageRecordCountController(app.context, { coordinateRecorder: async work => { await held; return work(); } });
    held = Promise.resolve(); const preview = await counting.preview("panel");
    held = new Promise(resolve => { release = resolve; });
    const confirming = counting.confirm("panel", { operationId: preview.operationId, confirmed: true });
    const pending = await counting.status("panel", { operationId: preview.operationId, receiptToken: preview.receiptToken });
    assert.equal(pending.phase, "verification-incomplete", "A confirm in flight is not reported as unsaved");
    assert.equal((await counting.status("other-panel", { operationId: preview.operationId, receiptToken: preview.receiptToken })).phase, "verification-incomplete");
    await assert.rejects(counting.status("other-panel", { operationId: preview.operationId, receiptToken: "0".repeat(64) }), { status: 403 });
    assert.equal((await read()).usage, null);
    release();
    assert.equal((await confirming).phase, "complete");
    assert.equal((await counting.status("panel", { operationId: preview.operationId, receiptToken: preview.receiptToken })).phase, "complete");
    assert.equal((await read()).usage?.total, 11400);
});
test("history compatibility: counting tokens in chats already read writes only the previewed totals, keeps one receipt and survives restart and the next append", async t => {
    const fixture = await readChatsWithoutTotals(t), { app, counting, read } = fixture;
    const before = await loadBoardState(app.context), evidence = structuredClone(before.evidence);
    const preview = await counting.preview("panel");
    assert.deepEqual(preview.counts, { interactions: 1, chats: 1, tokens: 11400, refused: 1 });
    assert.deepEqual(preview.refusals, [{ reason: "no-records", count: 1 }]);
    const unchanged = await loadBoardState(app.context);
    assert.equal(unchanged.revision, before.revision, "Preview writes nothing");
    assert.deepEqual(unchanged.evidence, evidence);

    const receipt = await counting.confirm("panel", { operationId: preview.operationId, confirmed: true });
    assert.deepEqual(receipt.counts, preview.counts);
    assert.equal(receipt.phase, "complete");
    const after = await loadBoardState(app.context);
    assert.equal(after.revision, before.revision + 1);
    for (const [n, record] of after.evidence.entries()) {
        const { usageCalls, usageGap, ...rest } = record, { usageCalls: priorCalls, usageGap: priorGap, ...prior } = evidence[n];
        assert.deepEqual(rest, prior, "Only token totals change");
        if (record.userPrompt?.text !== fixture.text) assert.deepEqual([usageCalls, usageGap], [priorCalls, priorGap], "Records outside the preview are untouched");
        else { assert.equal(usageGap, null); assert.ok(usageCalls.every(c => c.source === "copilot-usage-index")); }
    }
    const counted = await read();
    assert.equal(counted.usage?.total, 11400);
    assert.equal(counted.usageBasis, "copilot-usage-index");
    const stored = after.evidence.find(r => r.userPrompt?.text === fixture.text).usageCalls;

    assert.deepEqual(await counting.confirm("panel", { operationId: preview.operationId, confirmed: true }), receipt, "A repeated confirmation reads the original receipt");
    assert.equal((await loadBoardState(app.context)).revision, after.revision, "and writes nothing");
    assert.deepEqual(await counting.status("another-panel", { operationId: preview.operationId, receiptToken: preview.receiptToken }), receipt);
    await assert.rejects(counting.status("another-panel", { operationId: preview.operationId }), { status: 403 });
    assert.equal((await counting.status("panel", { operationId: randomUUID() })).phase, "not-started");
    assert.equal((await counting.preview("panel")).counts.interactions, 0, "A counted interaction is not offered again");

    await fixture.restart();
    await fixture.collector().collectNow();
    assert.equal((await read()).usage?.total, 11400, "Restart keeps the total");
    await appendFile(fixture.file, JSON.stringify({ ...event("session.info", { infoType: "note", message: "invented" }), timestamp: fixture.after(100) }) + "\n");
    await fixture.collector().collectNow();
    assert.equal((await read()).usage?.total, 11400, "The next append keeps the total");
    assert.deepEqual((await loadBoardState(app.context)).evidence.find(r => r.userPrompt?.text === fixture.text).usageCalls, stored,
        "Ordinary collection qualifies the same calls once it reads the chat again");
    await fixture.collector().configure({ ...fixture.settings, usageRecords: false, expectedConfigVersion: (await fixture.collector().status()).configVersion });
    await fixture.restart();
    await appendFile(fixture.file, JSON.stringify({ ...event("session.info", { infoType: "note", message: "invented" }), timestamp: fixture.after(200) }) + "\n");
    await fixture.collector().collectNow();
    assert.equal((await read()).usage?.total, 11400, "Turning records off keeps the counted total");
});
test("history compatibility: counting tokens in chats already read refuses before writing when the records, history, approval or preview change", async t => {
    const fixture = await readChatsWithoutTotals(t), { app, counting } = fixture;
    const refusedWith = async (code, change) => {
        const preview = await counting.preview("panel");
        assert.equal(preview.counts.interactions, 1);
        const revision = (await loadBoardState(app.context)).revision;
        await change();
        await assert.rejects(counting.confirm("panel", { operationId: preview.operationId, confirmed: true }),
            error => error.code === code && error.status === 409 && /^Nothing was saved\./.test(error.message));
        const state = await loadBoardState(app.context);
        assert.ok(state.revision === revision || code === "USAGE_COUNT_UNAVAILABLE", "Nothing was saved");
        assert.equal(state.usageRecordCounts, undefined);
        assert.equal((await fixture.read()).usage, null);
        assert.equal((await counting.status("panel", { operationId: preview.operationId })).phase, "not-started");
    };
    let row;
    await refusedWith("USAGE_COUNT_CHANGED", () => { row = fixture.index.prepare("UPDATE assistant_usage_events SET output_tokens = 101 WHERE output_tokens = 100").run(); });
    fixture.index.prepare("UPDATE assistant_usage_events SET output_tokens = 100 WHERE output_tokens = 101").run();
    assert.equal(row.changes, 1);
    await refusedWith("USAGE_COUNT_CHANGED", () => utimes(fixture.file, new Date(), new Date(Date.now() + 5000)));
    let clock = Date.now();
    const expiring = createUsageRecordCountController(app.context, { now: () => clock });
    const preview = await expiring.preview("panel");
    clock += 121000;
    await assert.rejects(expiring.confirm("panel", { operationId: preview.operationId, confirmed: true }), { code: "USAGE_COUNT_EXPIRED" });
    await assert.rejects(counting.confirm("panel", { operationId: preview.operationId, confirmed: true }), { code: "USAGE_COUNT_EXPIRED" },
        "Another controller's preview is never confirmed");
    await refusedWith("USAGE_COUNT_UNAVAILABLE", () => { app.db.prepare("UPDATE projects SET github_account_id='default'").run(); });
    app.db.prepare("UPDATE projects SET github_account_id='workspace'").run();
    await refusedWith("USAGE_COUNT_UNAVAILABLE", async () => {
        await fixture.collector().configure({ ...fixture.settings, usageRecords: false, expectedConfigVersion: (await fixture.collector().status()).configVersion });
    });
    await assert.rejects(counting.preview("panel"), { code: "USAGE_COUNT_UNAVAILABLE" }, "Records off hides the operation");
    await fixture.collector().configure({ ...fixture.settings, enabled: false, usageRecords: true, expectedConfigVersion: (await fixture.collector().status()).configVersion });
    await assert.rejects(counting.preview("panel"), { code: "USAGE_COUNT_UNAVAILABLE" }, "Pause blocks the operation");
});
test("history compatibility: counting tokens checks the approval immediately before each chat's records are opened", async t => {
    const { app, counting } = await readChatsWithoutTotals(t);
    const { default: fsSync } = await import("node:fs"), original = fsSync.statSync;
    let opened = 0;
    fsSync.statSync = (target, ...rest) => {
        // The Copilot account changes right after the first chat's records are opened.
        if (String(target).endsWith("session-store.db") && ++opened === 1) app.db.prepare("UPDATE projects SET github_account_id='default'").run();
        return original(target, ...rest);
    };
    syncBuiltinESMExports();
    t.after(() => { fsSync.statSync = original; syncBuiltinESMExports(); });
    await assert.rejects(counting.preview("panel"), { code: "USAGE_COUNT_UNAVAILABLE" });
    fsSync.statSync = original; syncBuiltinESMExports();
    assert.equal(opened, 1, "The next chat's records are never opened under the replaced account");
});
test("history compatibility: a pasted image inside an exchange does not hide its exact receipts, but an unreadable entry still does", async t => {
    for (const [kind, total] of [["session.binary_asset", 4400], ["assistant.message", null]]) {
        const app = await installation(t), id = app.session(), start = call("image-fetch");
        const messageId = "image-prompt", interactionId = "image-run", model = "gpt-4.1";
        start.data.turnId = "turn-one";
        const receipt = apiCallId => event("session.usage_record", { usage: { apiCallId, model, interactionId, inputTokens: 2000, outputTokens: 200 } });
        const batch = [event("user.message", { messageId, interactionId, content: "Read the invented screenshot.", delivery: "idle" }),
            event(kind, kind === "session.binary_asset" ? { mimeType: "image/png", data: "x".repeat(1100 * 1024) } : { content: "x".repeat(1100 * 1024) }),
            event("assistant.message", { apiCallId: "img-one", turnId: "turn-one", model, originatingMessageId: messageId, toolRequests: [{ toolCallId: "image-fetch" }] }), start,
            event("tool.execution_complete", { toolCallId: "image-fetch", success: true, result: { content: "INVENTED" } }), receipt("img-one"),
            event("assistant.turn_start", { turnId: "turn-two" }),
            event("assistant.message", { apiCallId: "img-two", turnId: "turn-two", model, originatingMessageId: messageId, phase: "final_answer", content: "Invented answer", toolRequests: [] }),
            receipt("img-two"), event("assistant.turn_end", { turnId: "turn-two" })];
        const base = Date.now() - 20000;
        batch.forEach((e, n) => { e.timestamp = new Date(base + n * 100).toISOString(); });
        await logFor(app, id, batch);
        const collector = await createCollector(app.context, { timers: false });
        app.cleanup.push(() => collector.close());
        await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
        await collector.collectNow();
        const record = (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios[0];
        assert.equal(record.usage?.total ?? null, total, kind);
        if (total === null) assert.equal(record.usageGap, "history-gap");
    }
});
test("history compatibility: a verified oversized Work IQ result keeps its exchange measured; a sub-agent's oversized completion still blocks it", async t => {
    for (const [kind, total] of [["main", 4400], ["metered", 4400], ["sub-agent", null]]) {
        const subagent = kind === "sub-agent";
        const app = await installation(t), id = app.session(), start = call("large-fetch");
        const messageId = "large-prompt", interactionId = "large-run", model = "gpt-4.1";
        start.data.turnId = "turn-one";
        const receipt = apiCallId => event("session.usage_record", { usage: { apiCallId, model, interactionId, inputTokens: 2000, outputTokens: 200 } });
        const done = event("tool.execution_complete", { toolCallId: "large-fetch", success: true, result: { content: "x".repeat(1100 * 1024) } });
        if (subagent) Object.assign(done, { agentId: "invented-agent" });
        // A tool that meters its own operation (for example image generation) writes toolUsage beside its large result.
        if (kind === "metered") done.data.toolUsage = { requestId: "tool-request", model: "invented-tool-model", provider: { id: "copilot" },
            inputTokens: 30, outputTokens: 12, totalTokens: 42, copilotUsage: { tokenDetails: [{ tokenCount: 30, tokenType: "input" }] } };
        const batch = [event("user.message", { messageId, interactionId, content: "Read the invented attachment.", delivery: "idle" }),
            event("assistant.message", { apiCallId: "big-one", turnId: "turn-one", model, originatingMessageId: messageId, toolRequests: [{ toolCallId: "large-fetch" }] }), start,
            done, receipt("big-one"), event("assistant.turn_start", { turnId: "turn-two" }),
            event("assistant.message", { apiCallId: "big-two", turnId: "turn-two", model, originatingMessageId: messageId, phase: "final_answer", content: "Invented answer", toolRequests: [] }),
            receipt("big-two"), event("assistant.turn_end", { turnId: "turn-two" })];
        const base = Date.now() - 20000;
        batch.forEach((e, n) => { e.timestamp = new Date(base + n * 100).toISOString(); });
        await logFor(app, id, batch);
        const collector = await createCollector(app.context, { timers: false });
        app.cleanup.push(() => collector.close());
        await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
        await collector.collectNow();
        const record = (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios[0];
        assert.equal(record.usage?.total ?? null, total, kind);
        if (total === null) assert.equal(record.usageGap, "history-gap");
    }
});
test("history compatibility: two explicitly linked usage receipts survive restart without cumulative totals or result text", async t => {
    const app = await installation(t), id = app.session(), start = call("metered-fetch");
    const model = "claude-sonnet-5-5", messageId = "metered-prompt", interactionId = "interaction-one";
    const message = (apiCallId, turnId, fields) => event("assistant.message", { apiCallId, turnId,
        model, originatingMessageId: messageId, ...fields });
    const receipt = (n, apiCallId) => event("session.usage_record", { usage: { apiCallId, model, interactionId,
        accounting: { sequence: n, sourceSessionId: id, usageId: `usage-${n}` },
        inputTokens: 16000, cacheReadTokens: 10000, cacheWriteTokens: 1000, outputTokens: 1000 } });
    start.data.turnId = "turn-one";
    const opaque = "A/+".repeat(166) + "==";
    const r1 = receipt(1, "api-one"), r2 = receipt(2, opaque);
    r1.data.usage.initiator = "user";
    r1.data.usage.interactionType = "conversation-user";
    r2.data.usage.initiator = "agent";
    r2.data.usage.interactionType = "conversation-agent";
    r2.data.usage.accounting = { usageId: opaque };
    delete r2.data.usage.interactionId;
    const batch = [event("user.message", { messageId, interactionId, content: "Read the invented schedule." }),
        message("api-one", "turn-one", { toolRequests: [{ toolCallId: "metered-fetch" }] }), start,
        event("tool.execution_complete", { toolCallId: "metered-fetch", success: true, result: { content: "INVENTED_RETURN_TEXT" } }), r1,
        event("assistant.turn_start", { turnId: "turn-two" }),
        message(opaque, "turn-two", { phase: "final_answer", content: "Invented answer", toolRequests: [] }),
        event("assistant.turn_end", { turnId: "turn-two" }), event("session.usage_checkpoint", { totalTokens: 900000 })];
    const base = Date.now() - 20000;
    batch.forEach((e, index) => { e.timestamp = new Date(base + index * 100).toISOString(); });
    const file = await logFor(app, id, batch);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const read = async () => (await currentStatePayload(app.context, await loadBoardState(app.context))).scenarios[0];
    assert.equal((await read()).usage, null);
    await collector.close(); collector = await createCollector(app.context, { timers: false });
    await appendFile(file, [r2, { ...r2, id: randomUUID() }].map(e => JSON.stringify(e) + "\n").join(""));
    await collector.collectNow();
    const record = await read();
    assert.equal(record.usage?.total, 34000);
    assert.equal(JSON.stringify(await loadBoardState(app.context)).includes(opaque),false);
    assert.equal(JSON.stringify(record).includes(opaque),false);
    assert.deepEqual(record.usage.tokens, { freshInput: 10000, cacheRead: 20000, cacheWrite: 2000, output: 2000 });
    assert.equal(record.usage.steps.length, 2);
    assert.equal(record.toolCalls[0].returnedTextBytes, 20);
    assert.doesNotMatch(JSON.stringify(record), /INVENTED_RETURN_TEXT|api-one|api-two/);
    const additional = receipt(3, "without-message-chunk");
    delete additional.data.usage.cacheReadTokens;
    await appendFile(file, JSON.stringify(additional) + "\n");
    await collector.collectNow();
    const partialCache = (await read()).usage;
    assert.equal(partialCache.total, 51000, "A directly linked receipt does not need a separate message chunk.");
    assert.equal(partialCache.tokens.cacheRead, null); assert.equal(partialCache.tokens.freshInput, null);
    assert.equal(partialCache.tokens.output, 3000);
    assert.equal(partialCache.steps.at(-1).tokens.input, 16000);
    await appendFile(file, JSON.stringify({ ...r1, id: randomUUID(), data: { usage: { ...r1.data.usage, outputTokens: 1500 } } }) + "\n");
    await collector.collectNow();
    assert.equal((await read()).usage, null);
    assert.equal((await read()).usageGap, "conflicting-receipt");
});
const managedCall = id => {
    const start = call(id);
    return { ...start, data: { ...start.data, toolName: "cc-invented-connector-fetch",
        mcpServerName: "cc-invented-connector", mcpConfigServerName: "cc-invented-connector" } };
};

test("late structured results retain only their own normalized paths across recorder restart", async t => {
    const app = await installation(t), id = app.session(), start = managedCall("returned-path");
    start.data.arguments = { entityUrls: ["/me/messages", "/me/events"] };
    app.db.exec(managedSchema);
    app.db.prepare("INSERT INTO session_managed_mcp_event_display_names VALUES(?,?,?)").run(id, start.id, "Work IQ");
    const file = await logFor(app, id, [event("user.message", { content: "Check invented items." }), start]);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow(); await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await appendFile(file, JSON.stringify(event("tool.execution_complete", { toolCallId: "returned-path", success: true,
        result: { structuredContent: { results: [{ statusCode: 200, path: "/me/events/PRIVATE-EVENT?$filter=PRIVATE-QUERY" },
            { statusCode: 403 }] } } })) + "\n");
    await collector.collectNow(); await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await collector.collectNow();
    const state = await loadBoardState(app.context);
    assert.deepEqual(state.evidence.flatMap(r => r.toolCalls).flatMap(c => c.apiResults.map(r => [r.statusCode, r.path ?? null])),
        [[200, "/me/events/{id}"], [403, null]]);
    const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json")));
    const checkpoint = await readFile(path.join(app.context.dataDir, "collector", index.fingerprint, `${id}.json`), "utf8");
    assert.doesNotMatch(checkpoint, /PRIVATE-EVENT|PRIVATE-QUERY/);
    assert.match(checkpoint, /\/me\/events\/\{id\}/);
});

test("a managed failure retains only entries from its bound connector, including after restart", async t => {
    const app = await installation(t), id = app.session();
    app.db.exec(managedSchema);
    const bind = app.db.prepare("INSERT INTO session_managed_mcp_event_display_names VALUES(?,?,?)");
    const starts = ["paired", "late", "mismatch", "unbound"].map(managedCall);
    for (const start of starts.slice(0, 3)) bind.run(id, start.id, "Work IQ");
    const finish = (key, server = "cc-invented-connector") => event("tool.execution_complete", {
        toolCallId: key, success: false, error: { code: "failure", message: `MCP server '${server}': ` + JSON.stringify({
            results: [{ statusCode: 200, data: "PRIVATE_BODY" }, { statusCode: 403,
                error: { code: "AccessDenied", message: "Access denied for the invented resource." } }], requestId: "PRIVATE_REQUEST",
        }) },
    });
    const file = await logFor(app, id, [event("user.message", { content: "Check invented items." }),
        ...starts, finish("paired"), finish("mismatch", "cc-other"), finish("unbound")]);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await appendFile(file, JSON.stringify(finish("late")) + "\n");
    await collector.collectNow();
    const state = await loadBoardState(app.context), calls = state.evidence.flatMap(r => r.toolCalls);
    assert.deepEqual(calls.map(c => c.toolCallId).sort(), ["late", "mismatch", "paired"]);
    for (const name of ["paired", "late"]) {
        const c = calls.find(c => c.toolCallId === name);
        assert.deepEqual(c.apiResults.map(r => [r.index, r.statusCode, r.errorCode]), [[0, 200, null], [1, 403, "AccessDenied"]]);
        assert.equal(c.apiResults[1].errorDiagnostic.message, "Access denied for the invented resource.");
        assert.equal(c.resultEvidence.resultCount, 2);
        assert.equal(c.reportedOutcome, "failed");
    }
    assert.deepEqual(calls.find(c => c.toolCallId === "mismatch").apiResults, []);
    const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json")));
    const checkpoint = await readFile(path.join(app.context.dataDir, "collector", index.fingerprint, `${id}.json`), "utf8");
    assert.doesNotMatch(checkpoint + JSON.stringify(calls), /PRIVATE_BODY|PRIVATE_REQUEST/);
    assert.ok(!JSON.parse(checkpoint).events.some(e => e.data.toolCallId === "unbound" && e.data.result?.structuredContent?.results?.length));
    const records = mergeEvidenceWithState(state), activity = buildRequestActivity(records);
    assert.equal(activity.tool.length, 3);
    const returned = activity["reported-api"];
    assert.deepEqual(returned.map(r => [r.status, r.outcome]), [[200, "success"], [403, "failure"], [200, "success"], [403, "failure"]]);
    assert.equal(new Set(returned.map(r => r.parentCallId)).size, 2);
    const snapshot = await currentStatePayload(app.context, state, { layer: "reported-api", filters: { scope: "all", outcomes: ["failure"] } });
    assert.deepEqual(snapshot.analytics.rows.map(r => r.id).sort(), returned.filter(r => r.status === 403).map(r => r.id).sort());
    assert.deepEqual(snapshot.requestActivity.tool, activity.tool);
    assert.match(createRecordedResults().failureReason(calls.find(c => c.toolCallId === "late")), /Returned entry 2:.*AccessDenied.*403/);
    const report = buildSanitizedRecord(records[0], state.pseudonymKey);
    assert.deepEqual(report.toolCalls.map(c => c.apiResults.map(r => r.statusCode)), calls.map(c => c.apiResults.map(r => r.statusCode)));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_BODY|PRIVATE_REQUEST/);
});

test("managed Work IQ uses event-bound app identity, including newly discovered connector calls and restart", async t => {
    const app = await installation(t), id = app.session(), other = app.session();
    app.db.exec(managedSchema);
    await logFor(app, other);
    const first = managedCall("managed-first"), unbound = managedCall("unbound-fetch");
    const wrongLabel = managedCall("other-connector"), unknown = managedCall("unknown-operation");
    unknown.data.mcpToolName = "unsupported_operation";
    unbound.data.wireManagedWorkIq = true;
    const bind = app.db.prepare("INSERT INTO session_managed_mcp_event_display_names VALUES(?,?,?)");
    bind.run(id, first.id, "Work IQ");
    bind.run(other, unbound.id, "Work IQ");
    bind.run(id, wrongLabel.id, "Another connector");
    bind.run(id, unknown.id, "Work IQ");
    const file = await logFor(app, id, [
        event("user.message", { content: "Invented managed request" }),
        first, unbound, wrongLabel, unknown,
        event("tool.execution_complete", { toolCallId: first.data.toolCallId, success: true }),
    ]);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const configFile = path.join(app.context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    await collector.collectNow();
    const firstState = await loadBoardState(app.context);
    assert.deepEqual(firstState.evidence.flatMap(row => row.toolCalls).map(call => [call.toolCallId, call.reportedOutcome]),
        [["managed-first", "succeeded"]]);
    const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json"), "utf8"));
    const checkpoint = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", index.fingerprint, `${id}.json`), "utf8"));
    const retained = checkpoint.events.find(event => event.id === first.id);
    assert.equal(retained.data.mcpServerName, "cc-invented-connector");
    assert.equal(retained.data.wireManagedWorkIq, true);
    assert.equal(checkpoint.events.some(event => event.id === unbound.id), false);
    const second = managedCall("managed-incremental");
    bind.run(id, second.id, "WorkIQ");
    await appendFile(file, [event("user.message", { content: "Invented incremental request" }), second,
        event("tool.execution_complete", { toolCallId: second.data.toolCallId, success: false })]
        .map(row => JSON.stringify(row) + "\n").join(""));
    await collector.collectNow();
    const secondState = await loadBoardState(app.context);
    assert.deepEqual(secondState.evidence.flatMap(row => row.toolCalls).map(call => [call.toolCallId, call.reportedOutcome]).sort(),
        [["managed-first", "succeeded"], ["managed-incremental", "failed"]]);
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    const unchanged = await collector.collectNow();
    assert.equal(unchanged.metrics.lastBytesRead, 0);
    assert.deepEqual((await loadBoardState(app.context)).evidence, secondState.evidence);
    assert.deepEqual(await readFile(configFile), configBefore);
});

for (const naming of ["opaque connector", "logical tool name only"]) test(
    `a managed mapping published during a read cannot strand the start behind a committed cursor: ${naming}`, async t => {
    const app = await installation(t), id = app.session();
    app.db.exec(managedSchema);
    const file = await logFor(app, id, [event("user.message", { source: "user", content: "Invented baseline." }), call("prior")]);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const indexPath = path.join(app.context.dataDir, "collector", "index.json");
    const indexBefore = JSON.parse(await readFile(indexPath));
    const checkpoint = path.join(path.dirname(indexPath), indexBefore.fingerprint, id + ".json");
    const before = await readFile(checkpoint), stateBefore = await loadBoardState(app.context);
    const start = managedCall("racing"), end = event("tool.execution_complete", { toolCallId: "racing", success: false });
    if (naming === "logical tool name only") {
        start.data.toolName = "fetch";
        delete start.data.mcpServerName;
        delete start.data.mcpConfigServerName;
        delete start.data.mcpToolName;
    }
    await appendFile(file, [start, end].map(e => JSON.stringify(e) + "\n").join(""));
    // The app supplies the event mapping after the live-tail lookup, before cursor publication.
    const readdir = fs.readdir;
    let published = false;
    const change = t.mock.method(fs, "readdir", async (...args) => {
        if (!published && path.basename(args[0]) === BACKFILL_DIRECTORY) {
            app.db.prepare("INSERT INTO session_managed_mcp_event_display_names VALUES(?,?,?)").run(id, start.id, "Work IQ");
            published = true;
        }
        return readdir(...args);
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(collector.collectNow(), { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "membership" });
    } finally { change.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(published, true);
    assert.deepEqual(await readFile(checkpoint), before);
    assert.deepEqual((await loadBoardState(app.context)).evidence, stateBefore.evidence);
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await appendFile(file, JSON.stringify(call("following")) + "\n");
    await collector.collectNow();
    const calls = (await loadBoardState(app.context)).evidence.flatMap(r => r.toolCalls);
    assert.deepEqual(calls.map(c => c.toolCallId).sort(), ["following", "prior", "racing"]);
    const recovered = calls.find(c => c.toolCallId === "racing");
    assert.deepEqual([recovered.startEventId, recovered.completionEventId, recovered.reportedOutcome], [start.id, end.id, "failed"]);
    assert.equal(JSON.parse(await readFile(checkpoint)).cursor.offset, (await stat(file)).size);
    assert.equal((await collector.collectNow()).metrics.lastBytesRead, 0);
});

test("new managed identity does not reset consumed cursors; explicit recollection can recover the skipped call", async t => {
    const app = await installation(t), id = app.session();
    app.db.exec(managedSchema);
    const start = managedCall("previously-unrecognized");
    await logFor(app, id, [event("user.message", { content: "Invented historical connector request" }), start,
        event("tool.execution_complete", { toolCallId: start.data.toolCallId, success: true })]);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence.length, 0);
    app.db.prepare("INSERT INTO session_managed_mcp_event_display_names VALUES(?,?,?)").run(id, start.id, "Work IQ");
    const unchanged = await collector.collectNow();
    assert.equal(unchanged.metrics.lastBytesRead, 0);
    assert.equal((await loadBoardState(app.context)).evidence.length, 0);
    const configFile = path.join(app.context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
    const recollection = createRecollectionController(app.context, { now: () => now });
    const preview = await recollection.preview("invented-owner", { sourceSessionIds: [id], from: day, to: day,
        timeContext: { timeZone: "UTC", locale: "en-US" }, restorePrompts: false });
    assert.equal(preview.counts.toolCalls, 1);
    assert.equal((await loadBoardState(app.context)).evidence.length, 0);
    const result = await recollection.confirm("invented-owner", { operationId: preview.operationId, confirmed: true });
    assert.equal(result.phase, "complete");
    assert.equal((await loadBoardState(app.context)).evidence[0].toolCalls[0].toolCallId, start.data.toolCallId);
    assert.deepEqual(await readFile(configFile), configBefore);
});

test("context retention uses linear serialization work and keeps late results after eviction", { timeout: 30000 }, async t => {
    const app = await installation(t, { metadata174: true }), id = app.session(), count = 1200;
    const events = [
        event("user.message", { content: "Invented context-work request", messageId: "context-original" }),
        call("context-target"),
        ...Array.from({ length: count }, (_, index) => event("user.message", {
            content: "Ordinary invented filler ".repeat(80), messageId: `context-message-${index}`,
        }, `context-work-${index}`)),
    ];
    const file = await logFor(app, id, events), sourceBefore = await readFile(file);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const configFile = path.join(app.context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    const stringify = JSON.stringify;
    let serializedEvents = 0;
    const tracked = value => value?.type === "user.message" && value.id?.startsWith("context-work-");
    const serialization = t.mock.method(JSON, "stringify", (value, ...args) => {
        if (Array.isArray(value)) for (const item of value) serializedEvents += Number(tracked(item));
        else serializedEvents += Number(tracked(value));
        return stringify(value, ...args);
    });
    let checked;
    try { checked = await collector.collectNow(); }
    finally { serialization.mock.restore(); }
    const first = await loadBoardState(app.context), target = first.evidence.find(row => row.toolCalls.some(call => call.toolCallId === "context-target"));
    assert.equal(target.userPrompt.text, "Invented context-work request");
    assert.equal(target.toolCalls[0].reportedOutcome, "unknown");
    assert.equal(checked.check.changes.added, 1);
    assert.equal(checked.historyCoverage.limited, 1);
    assert.ok(checked.metrics.contextEvictions > 0);
    assert.ok(serializedEvents <= count * 8,
        `Direct event serialization visits must remain linear: ${serializedEvents} visits for ${count} input messages`);
    t.diagnostic(JSON.stringify({ inputMessages: count, serializedEvents, contextEvictions: checked.metrics.contextEvictions }));
    const evidenceFile = path.join(app.context.dataDir, "private-evidence", first.evidenceFile), firstBytes = await readFile(evidenceFile);
    await appendFile(file, JSON.stringify(event("tool.execution_complete", { toolCallId: "context-target", success: true })) + "\n");
    const completed = await collector.collectNow(), after = await loadBoardState(app.context);
    assert.equal(completed.check.changes.added, 0);
    assert.equal(completed.check.changes.updated, 1);
    assert.equal(after.evidence.flatMap(row => row.toolCalls).length, 1);
    assert.equal(after.evidence[0].userPrompt.text, "Invented context-work request");
    assert.equal(after.evidence[0].toolCalls[0].reportedOutcome, "succeeded");
    assert.deepEqual(await readFile(configFile), configBefore);
    assert.deepEqual(await readFile(evidenceFile), firstBytes);
    assert.deepEqual((await readFile(file)).subarray(0, sourceBefore.length), sourceBefore);
    assert.equal(completed.config.enabled, false);
    const unchanged = await collector.collectNow();
    assert.equal(unchanged.metrics.lastBytesRead, 0);
    assert.equal(unchanged.check.changes.added + unchanged.check.changes.updated, 0);
});

test("bounded oversized completion metadata updates the known call without retaining its body", { timeout: 30000 }, async t => {
    const app = await installation(t, { metadata174: true }), id = app.session();
    const body = JSON.stringify({ results: [{ statusCode: 200, body: { text: "PRIVATE_OVERSIZED_RESPONSE_" + "x".repeat(2 * 1024 ** 2) } }] });
    const file = await logFor(app, id, [
        event("user.message", { content: "Invented oversized completion request" }),
        call("oversized-completion"),
        event("tool.execution_complete", { toolCallId: "oversized-completion", success: true, result: { content: body } }),
    ]);
    const sourceBefore = await readFile(file);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const configFile = path.join(app.context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    const result = await collector.collectNow(), state = await loadBoardState(app.context);
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].toolCalls.length, 1);
    const captured = state.evidence[0].toolCalls[0];
    assert.equal(captured.reportedOutcome, "succeeded");
    assert.equal(captured.toolSucceeded, true);
    assert.ok(captured.completionEventId);
    assert.deepEqual(captured.apiResults, [], "Metadata-only completion is not a claim about the unread API payload");
    assert.equal(result.check.outcome, "partial");
    assert.equal(result.metrics.oversizedLines, 1);
    const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json"), "utf8"));
    const checkpoint = await readFile(path.join(app.context.dataDir, "collector", index.fingerprint, `${id}.json`), "utf8");
    assert.equal(checkpoint.includes("PRIVATE_OVERSIZED_RESPONSE_"), false);
    assert.equal(JSON.stringify(state.evidence).includes("PRIVATE_OVERSIZED_RESPONSE_"), false);
    assert.deepEqual(await readFile(file), sourceBefore);
    assert.deepEqual(await readFile(configFile), configBefore);
    const again = await collector.collectNow();
    assert.equal(again.metrics.lastBytesRead, 0);
    assert.equal(again.check.changes.added + again.check.changes.updated, 0);
});

test("recovered completions and richer full results are never overwritten by later completion deliveries", async t => {
    const app = await installation(t, { metadata174: true }), id = app.session();
    const start = call("recorded-completion"), completed = event("tool.execution_complete", {
        toolCallId: "recorded-completion", success: true,
        result: { content: "PRIVATE_LARGE_RESULT_" + "x".repeat(2 * 1024 ** 2) },
    });
    const file = await logFor(app, id, [event("user.message", { content: "Invented completion preservation request" }), start, completed]);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const original = (await loadBoardState(app.context)).evidence[0].toolCalls[0];
    assert.equal(original.reportedOutcome, "succeeded");
    assert.deepEqual(original.apiResults, []);
    for (const completionId of [completed.id, "different-completion"]) {
        await appendFile(file, JSON.stringify({ ...completed, id: completionId,
            data: { toolCallId: start.data.toolCallId, success: true, result: { structuredContent: { results: [{ statusCode: 403 }] } } } }) + "\n");
        await collector.collectNow();
        assert.deepEqual((await loadBoardState(app.context)).evidence[0].toolCalls[0], original);
    }
    const richStart = call("rich-completion"), richEnd = event("tool.execution_complete", {
        toolCallId: "rich-completion", success: true, result: { structuredContent: { results: [{ statusCode: 403 }] } },
    });
    await appendFile(file, [event("user.message", { content: "Invented richer result" }), richStart, richEnd]
        .map(value => JSON.stringify(value) + "\n").join(""));
    await collector.collectNow();
    const rich = (await loadBoardState(app.context)).evidence.flatMap(record => record.toolCalls).find(call => call.toolCallId === "rich-completion");
    assert.deepEqual(rich.apiResults.map(result => result.statusCode), [403]);
    await appendFile(file, [richStart, { ...completed, id: "oversized-later",
        data: { ...completed.data, toolCallId: "rich-completion" } }].map(value => JSON.stringify(value) + "\n").join(""));
    await collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence.flatMap(record => record.toolCalls)
        .find(call => call.toolCallId === "rich-completion"), rich);
});

test("extended pending metadata survives unchanged checks and restart without borrowing an old start", async t => {
    const app = await installation(t, { metadata174: true }), id = app.session();
    const file = await logFor(app, id, [event("user.message", { content: "Invented partial completion" }), call("pending-completion"),
        ...Array.from({ length: 6 }, () => event("assistant.message", { content: "x".repeat(900000) }))]);
    const completion = event("tool.execution_complete", { toolCallId: "pending-completion", success: true,
        result: { content: "PRIVATE_PENDING_BODY_" + "x".repeat(1536 * 1024) } });
    await appendFile(file, JSON.stringify(completion));
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    for (let pass = 0; pass < 4; pass++) {
        await collector.collectNow();
        const current = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json")));
        if (current.sources[id].cursor.backlogBytes === current.sources[id].cursor.partialBytes) break;
    }
    const indexFile = path.join(app.context.dataDir, "collector", "index.json");
    const before = JSON.parse(await readFile(indexFile)), cursor = before.sources[id].cursor;
    assert.equal(before.schemaVersion, 3);
    assert.ok(cursor.partialBytes > 1024 ** 2 && cursor.partialBytes < 4 * 1024 ** 2);
    assert.equal((await collector.collectNow()).metrics.lastBytesRead, 0);
    const deletion = createDeletionController(app.context);
    const preview = await deletion.preview("pending-proof", { scope: "all" });
    deletion.cancel("pending-proof", preview.operationId);
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await appendFile(file, "\n");
    const completed = await collector.collectNow(), state = await loadBoardState(app.context);
    assert.ok(completed.metrics.lastBytesRead > cursor.partialBytes + 1);
    assert.ok(completed.metrics.lastBytesRead <= cursor.partialBytes + 1 + TAIL_LIMITS.chunkBytes);
    assert.equal(state.evidence[0].toolCalls[0].reportedOutcome, "unknown", "The saved start is outside the verified lookbehind and cannot authorize metadata recovery");
    const after = JSON.parse(await readFile(indexFile));
    assert.equal(after.sources[id].cursor.partialBytes, 0);
    assert.equal(after.sources[id].cursor.oversizedLines, 1);
    assert.equal(after.sources[id].cursor.offset, (await readFile(file)).length);
    assert.equal(JSON.stringify(state.evidence).includes("PRIVATE_PENDING_BODY_"), false);
    const checkpoint = await readFile(path.join(app.context.dataDir, "collector", after.fingerprint, `${id}.json`), "utf8");
    assert.equal(checkpoint.includes("PRIVATE_PENDING_BODY_"), false);
});

test("backfill resumes its own context after restart and deletion never restores its collected calls", async t => {
    const app = await installation(t, { metadata174: true }), id = app.session();
    const prompt = event("user.message", { content: "Invented prefix request across chunks" });
    const file = await logFor(app, id, [prompt, call("prefix-resume"),
        ...Array.from({ length: 6 }, () => event("assistant.message", { content: "x".repeat(900000) })),
        event("tool.execution_complete", { toolCallId: "prefix-resume", success: true,
            result: { content: [{ type: "text", text: "résumé" }], structuredContent: { results: [{ statusCode: 403 }] } } }),
    ]);
    const padding = await open(file, "a");
    try {
        await padding.writeFile(`{"id":"prefix-padding","type":"assistant.message","timestamp":"${new Date().toISOString()}","data":{"content":"`);
        const chunk = Buffer.alloc(1024 ** 2, 120);
        for (let offset = 0; offset < TAIL_LIMITS.initialFileBytes; offset += chunk.length) await padding.write(chunk);
        await padding.writeFile('"}}\n');
    } finally { await padding.close(); }
    const sourceHash = createHash("sha256").update(await readFile(file)).digest("hex");
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const first = await collector.collectNow();
    assert.equal(first.check.changes.added, 1);
    assert.equal(first.check.sourcesChecked, 1);
    assert.equal((await loadBoardState(app.context)).evidence[0].toolCalls[0].reportedOutcome, "unknown");
    const indexFile = path.join(app.context.dataDir, "collector", "index.json"), index = JSON.parse(await readFile(indexFile));
    const mainFile = path.join(app.context.dataDir, "collector", index.fingerprint, `${id}.json`);
    assert.equal(JSON.parse(await readFile(mainFile)).events.some(event => event.id === prompt.id), false);
    const prefixFile = path.join(app.context.dataDir, "collector", BACKFILL_DIRECTORY, `${id}.json`);
    assert.equal(JSON.parse(await readFile(prefixFile)).backfill.activeSource, id);
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    const second = await collector.collectNow(), state = await loadBoardState(app.context);
    assert.equal(second.check.changes.added, 0);
    assert.equal(second.check.changes.updated, 1);
    assert.equal(state.evidence[0].userPrompt.text, prompt.data.content);
    assert.deepEqual(state.evidence[0].toolCalls[0].apiResults.map(result => result.statusCode), [403]);
    assert.equal(state.evidence[0].toolCalls[0].returnedTextBytes, 8, "Prefix collection measures the original UTF-8 text across restart");
    assert.equal(JSON.parse(await readFile(prefixFile)).backfill.activeSource, null);
    assert.equal(JSON.parse(await readFile(mainFile)).events.some(event => event.id === prompt.id), false);
    const deletion = createDeletionController(app.context, { validateBackfillCheckpoint });
    const preview = await deletion.preview("prefix-delete", { scope: "all" });
    await deletion.confirm("prefix-delete", { operationId: preview.operationId, confirmed: true });
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence, []);
    assert.equal(JSON.parse(await readFile(prefixFile)).backfill.sources[0].phase, "suppressed");
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), sourceHash);
});

test("backfill preserves the same credential-excluded prompt boundary as live-tail collection", async t => {
    for (const backfill of [false, true]) {
        const app = await installation(t, { metadata174: true }), id = app.session();
        const file = await logFor(app, id, [
            event("user.message", { content: "Invented earlier unrelated request" }),
            event("user.message", { content: "Invented excluded current request", messageId: "ghp_" + "a".repeat(30) }),
            call("after-excluded-prompt"),
        ]);
        if (backfill) {
            const padding = await open(file, "a");
            try {
                await padding.writeFile(`{"id":"boundary-padding","type":"assistant.message","timestamp":"${new Date().toISOString()}","data":{"content":"`);
                const chunk = Buffer.alloc(1024 ** 2, 120);
                for (let offset = 0; offset < TAIL_LIMITS.initialFileBytes; offset += chunk.length) await padding.write(chunk);
                await padding.writeFile('"}}\n');
            } finally { await padding.close(); }
        }
        const collector = await createCollector(app.context, { timers: false });
        app.cleanup.push(() => collector.close());
        await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
        const collected = await collector.collectNow(), state = await loadBoardState(app.context);
        const record = state.evidence.find(value => value.toolCalls.some(call => call.toolCallId === "after-excluded-prompt"));
        assert.ok(record);
        if (backfill) assert.equal(collected.backfill.visitedSources, 1);
        assert.equal(record.userPrompt.text, null, `${backfill ? "Backfill" : "Live tail"} cannot borrow the preceding request`);
        assert.equal(record.userPrompt.capture.reason, "credential-excluded");
        assert.doesNotMatch(JSON.stringify(state.evidence), /ghp_|Invented excluded current request/);
    }
});

test("an unrelated append after checkpoint compaction preserves a completed interaction's model history", async t => {
    const app = await installation(t), id = app.session();
    const at = Date.now() - 10000;
    const write = (e, ms) => ({ ...e, timestamp: new Date(at + ms).toISOString() });
    const p = write(event("user.message", { content: "Review the harbor notes.", messageId: "first" }), 0);
    const response = write(event("assistant.message", { model: "Alder", originatingMessageId: "first", phase: "final_answer",
        content: "Harbor notes reviewed.", turnId: "first-turn", apiCallId: "first-request" }), 20);
    const file = await logFor(app, id, [p, write(call(), 10), response, write(event("assistant.turn_end", { turnId: "first-turn" }), 30)]);
    let collector = await createCollector(app.context, { timers: false }); app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const [original] = (await loadBoardState(app.context)).evidence;
    assert.equal(original.originalModelEvidence.partial, false);
    const append = events => appendFile(file, events.map(e => JSON.stringify(e) + "\n").join(""));
    await append([write(event("user.message", { content: "A different request.", messageId: "second" }), 40),
        ...Array.from({ length: 320 }, (_, i) => write(event("assistant.turn_start", { turnId: `later-${i}` }), 50 + i))]);
    await collector.collectNow(); await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await append([write(event("assistant.turn_end", { turnId: "later-319" }), 400)]);
    await collector.collectNow();
    const [retained] = (await loadBoardState(app.context)).evidence;
    assert.deepEqual(retained.responseTiming, original.responseTiming);
    assert.deepEqual(retained.originalModelEvidence, original.originalModelEvidence);
});

test("original model metadata survives collection, context eviction and restart without capturing replies", async t => {
    const app = await installation(t), id = app.session(), now = Date.now() - 10000;
    const timed = (type, data, ms, eventId) => ({ ...event(type, data, eventId), timestamp: new Date(now + ms).toISOString() });
    const prompt = timed("user.message", { content: "Invented model request", messageId: "original-message" }, 0);
    const start = { ...call("model-call"), timestamp: new Date(now + 10).toISOString() };
    start.data.model = "tool-hint-only";
    const response = (model, ms, turn) => timed("assistant.message", { model, originatingMessageId: "original-message",
        apiCallId: `api-${turn}`, turnId: turn, phase: "final_answer", toolRequests: [],
        content: "PRIVATE_MODEL_REPLY", reasoningText: "PRIVATE_MODEL_REASONING" }, ms);
    const first = response("recorded-model-a", 100, "first");
    const file = await logFor(app, id, [prompt, start, first, timed("assistant.turn_end", { turnId: "first" }, 101)]);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    let state = await loadBoardState(app.context);
    const scenarioId = state.evidence[0].scenarioId;
    assert.equal(interactionModelFact(state.evidence[0]).value, "recorded-model-a");
    const filler = Array.from({ length: 2050 }, (_, index) =>
        timed("user.message", { content: "Unrelated invented prompt", messageId: `other-${index}` }, index + 200));
    const updatedStart = { ...start, data: { ...start.data, arguments: { entityUrls: ["/me/events"] } } };
    await appendFile(file, [updatedStart, ...filler].map(value => JSON.stringify(value) + "\n").join(""));
    await collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence[0].toolCalls[0].requestArgs.entityUrls, ["/me/events"],
        "model conflict tracking must not change last-delivered tool metadata semantics");
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    const last = response("recorded-model-b", 3000, "second");
    await appendFile(file, [last, timed("assistant.turn_end", { turnId: "second" }, 3001)].map(value => JSON.stringify(value) + "\n").join(""));
    const originalBytes = await readFile(file);
    await collector.collectNow();
    state = await loadBoardState(app.context);
    const retained = state.evidence.find(value => value.scenarioId === scenarioId);
    assert.equal(interactionModelFact(retained).value, "recorded-model-a then recorded-model-b (partial record)");
    assert.equal(retained.originalModelEvidence.responses.length, 2);
    assert.doesNotMatch(JSON.stringify(state.evidence), /PRIVATE_MODEL/);
    assert.equal(state.personalEvaluation, undefined);
    const fingerprint = createHash("sha256").update(JSON.stringify([app.config.appDbPath, app.config.sessionRoot, 30])).digest("hex");
    assert.doesNotMatch(await readFile(path.join(app.context.dataDir, "collector", fingerprint, id + ".json"), "utf8"), /PRIVATE_MODEL/);
    assert.deepEqual(await readFile(file), originalBytes);
});

async function legacyModelInstallation(t, { spacingMs = 2000 } = {}) {
    const app = await installation(t), id = app.session(), now = Date.now() - spacingMs - 10000;
    const timed = (type, data, ms, eventId) => ({ ...event(type, data, eventId), timestamp: new Date(now + ms).toISOString() });
    const events = [0, 1].flatMap(index => [
        timed("user.message", { content: "Invented legacy request", messageId: `message-${index}` }, index * spacingMs, `prompt-${index}`),
        { ...call(`model-${index}`), timestamp: new Date(now + index * spacingMs + 10).toISOString(),
            data: { ...call(`model-${index}`).data, model: "tool-only-hint" } },
        timed("assistant.message", { originatingMessageId: `message-${index}`, apiCallId: "x".repeat(480) + index,
            model: `original-model-${index}`, turnId: `${index}`, phase: "final_answer", toolRequests: [],
            content: "PRIVATE_MODEL_REPLY", reasoningText: "PRIVATE_MODEL_REASONING" }, index * spacingMs + 100, `response-${index}`),
        timed("assistant.turn_end", { turnId: `${index}` }, index * spacingMs + 101, `end-${index}`),
    ]);
    const file = await logFor(app, id, events);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    const first = await loadBoardState(app.context);
    assert.equal(interactionModelFact(first.evidence[0]).value, "original-model-0");
    await replaceEvidence(app.context, records => ({ records: records.map(record => {
        const { originalModelEvidence, ...legacy } = record;
        return legacy;
    }), importCoverage: first.importCoverage }));
    const fingerprint = createHash("sha256").update(JSON.stringify([app.config.appDbPath, app.config.sessionRoot, 30])).digest("hex");
    const checkpointFile = path.join(app.context.dataDir, "collector", fingerprint, id + ".json");
    const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
    for (const event of checkpoint.events) if (event.type === "assistant.message") delete event.data.wireOriginalModel;
    await writeFile(checkpointFile, JSON.stringify(checkpoint));
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await collector.collectNow();
    const before = await loadBoardState(app.context);
    assert.ok(before.evidence.every(record => interactionModelFact(record).value === "Not verified (tool metadata only)"));
    return { ...app, id, file, before, collector, checkpointFile, restart: async () => {
        await collector.close();
        collector = await createCollector(app.context, { timers: false });
        return collector;
    } };
}

test("explicit original-model qualification repairs only selected legacy EOF metadata and survives restart", async t => {
    const app = await legacyModelInstallation(t);
    const input = { operationId: randomUUID(), scenarioIds: [app.before.evidence[0].scenarioId],
        expectedSourceRevision: app.before.evidenceRevision };
    const sourceBefore = await readFile(app.file), checkpointBefore = await readFile(app.checkpointFile);
    const indexFile = path.join(app.context.dataDir, "collector", "index.json"), indexBefore = await readFile(indexFile);
    const fingerprints = app.before.evidence.map(evaluationRecordFingerprint), key = "a".repeat(64);
    const reports = app.before.evidence.map(record => buildSanitizedRecord(record, key));
    const result = await app.collector.qualifyInteractionModels(input);
    assert.equal(result.phase, "complete");
    assert.equal(result.applied, 1);
    const after = await loadBoardState(app.context);
    assert.equal(interactionModelFact(after.evidence[0]).value, "original-model-0");
    assert.deepEqual(after.evidence[1], app.before.evidence[1]);
    assert.deepEqual(after.evidence.map(({ originalModelEvidence, ...record }) => record), app.before.evidence);
    assert.deepEqual(after.evidence.map(evaluationRecordFingerprint), fingerprints);
    assert.deepEqual(after.evidence.map(record => buildSanitizedRecord(record, key)), reports);
    for (const field of ["cards", "exports", "personalEvaluation", "deletion", "pseudonymKey"]) assert.deepEqual(after[field], app.before[field]);
    assert.deepEqual(await readFile(app.file), sourceBefore);
    assert.deepEqual(await readFile(app.checkpointFile), checkpointBefore);
    assert.deepEqual(await readFile(indexFile), indexBefore);
    assert.doesNotMatch(JSON.stringify(after), /PRIVATE_MODEL/);
    assert.deepEqual(await app.collector.qualifyInteractionModels(input), result);
    const restarted = await app.restart();
    assert.deepEqual((await restarted.status()).interactionModelQualification, result);
    assert.deepEqual(await restarted.qualifyInteractionModels(input), result);
    assert.equal((await loadBoardState(app.context)).revision, after.revision);
    assert.equal(interactionModelFact((await loadBoardState(app.context)).evidence[0]).value, "original-model-0");
    await appendFile(app.file, JSON.stringify(event("session.info", {})) + "\n");
    await restarted.collectNow();
    assert.equal(interactionModelFact((await loadBoardState(app.context)).evidence[0]).value, "original-model-0",
        "Ordinary collection must not reinterpret pre-model checkpoint omissions as conflicting original metadata.");
    await assert.rejects(restarted.qualifyInteractionModels({ ...input, scenarioIds: [app.before.evidence[1].scenarioId] }), /identity.*different scope/);
    await assert.rejects(restarted.qualifyInteractionModels({ ...input, operationId: randomUUID() }), /Source evidence changed/);
    await restarted.setEnabled(false);
    await assert.rejects(restarted.qualifyInteractionModels({ ...input, operationId: randomUUID(),
        expectedSourceRevision: after.evidenceRevision }), /already be enabled/);
});

test("original-model qualification leaves all selected evidence untouched for missing, conflicting or deleted metadata", async t => {
    const app = await legacyModelInstallation(t), original = await readFile(app.file, "utf8");
    for (const failure of ["missing", "conflicting", "deleted"]) {
        const events = original.trim().split("\n").map(line => JSON.parse(line));
        const response = events.find(event => event.id === "response-1");
        if (failure === "missing") delete response.data.model;
        if (failure === "conflicting") events.push({ ...response, data: { ...response.data, model: "conflicting-model" } });
        if (failure === "deleted") await updateBoardState(app.context, state => {
            state.deletion = { schemaVersion: 1, identities: [], contextCalls: [],
                events: [eventIdentity(app.id, "response-1")], operations: {} };
        });
        await writeFile(app.file, events.map(event => JSON.stringify(event) + "\n").join(""));
        const before = await loadBoardState(app.context), stateFile = path.join(app.context.dataDir, "workiq-evidence-board-v1.state.json");
        const stateBytes = await readFile(stateFile), checkpointBytes = await readFile(app.checkpointFile);
        const input = { operationId: randomUUID(), scenarioIds: before.evidence.map(record => record.scenarioId),
            expectedSourceRevision: before.evidenceRevision };
        const result = await app.collector.qualifyInteractionModels(input);
        assert.equal(result.phase, "unavailable", failure);
        assert.equal(result.applied, 0);
        assert.equal(result.results[1].reason, failure === "missing" ? "unverified" : failure === "deleted" ? "deleted-model-dependency" : "conflicting");
        assert.deepEqual(await app.collector.qualifyInteractionModels(input), result);
        assert.deepEqual(await readFile(stateFile), stateBytes, failure);
        assert.deepEqual(await readFile(app.checkpointFile), checkpointBytes);
        assert.deepEqual((await loadBoardState(app.context)).evidence, before.evidence);
    }
});

test("original-model qualification rejects stale, unapproved and noneligible scope before reading or writing", async t => {
    const app = await legacyModelInstallation(t);
    const input = { operationId: randomUUID(), scenarioIds: [app.before.evidence[0].scenarioId],
        expectedSourceRevision: app.before.evidenceRevision };
    const stateFile = path.join(app.context.dataDir, "workiq-evidence-board-v1.state.json"), bytes = await readFile(stateFile);
    for (const invalid of [
        { ...input, expectedSourceRevision: input.expectedSourceRevision - 1 },
        { ...input, scenarioIds: ["not-retained"] },
        { ...input, scenarioIds: [input.scenarioIds[0], input.scenarioIds[0]] },
        { ...input, source: "unapproved" },
    ]) await assert.rejects(app.collector.qualifyInteractionModels(invalid));
    app.db.prepare("UPDATE sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(), app.id);
    await assert.rejects(app.collector.qualifyInteractionModels(input), /no longer eligible/);
    assert.deepEqual(await readFile(stateFile), bytes);
    const other = await installation(t), unapproved = await createCollector(other.context, { timers: false });
    other.cleanup.push(() => unapproved.close());
    await assert.rejects(unapproved.qualifyInteractionModels(input), /already be enabled/);
});

for (const scope of ["range", "all"]) test(`model qualification receipts retain no record identifiers through ${scope} deletion, managed copies and restart`, async t => {
    const app = await legacyModelInstallation(t, { spacingMs: 86400000 });
    const stateFile = path.join(app.context.dataDir, "workiq-evidence-board-v1.state.json");
    const selected = app.before.evidence[0], input = { operationId: randomUUID(),
        scenarioIds: [selected.scenarioId], expectedSourceRevision: app.before.evidenceRevision };
    const result = await app.collector.qualifyInteractionModels(input);
    const copy = await readFile(stateFile);
    await writeFile(path.join(app.context.dataDir, "prior-state.snapshot.json"), copy);
    await writeFile(path.join(app.context.dataDir, "collector", "before-dynamic-state.json"), copy);
    const deletion = createDeletionController(app.context);
    const day = selected.userPrompt.sourceTimestamp.slice(0, 10);
    const preview = await deletion.preview("model-proof", { scope, ...(scope === "range" ? { from: day, to: day } : {}),
        timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("model-proof", { operationId: preview.operationId, confirmed: true });
    const afterDelete = await loadBoardState(app.context);
    assert.equal(afterDelete.evidence.length, scope === "all" ? 0 : 1);
    const receipt = afterDelete.originalModelQualification;
    assert.ok(receipt, "A content-free receipt retains lost-response meaning without restoring data.");
    assert.ok(!JSON.stringify(receipt).includes(selected.scenarioId));
    assert.ok(!JSON.stringify((await app.collector.status()).interactionModelQualification).includes(selected.scenarioId));
    const rootFiles = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true }))
        .map(entry => entry.isDirectory() ? rootFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
    for (const file of await rootFiles(app.context.dataDir)) {
        if (!file.endsWith(".json")) continue;
        const text = await readFile(file, "utf8");
        assert.ok(!text.includes(selected.scenarioId), `Deleted record identifier remains in ${path.relative(app.context.dataDir, file)}`);
    }
    const restarted = await app.restart();
    const stateBytes = await readFile(stateFile);
    assert.deepEqual((await restarted.status()).interactionModelQualification, result);
    assert.deepEqual(await restarted.qualifyInteractionModels(input), result);
    assert.deepEqual(await readFile(stateFile), stateBytes, "Replaying a receipt after deletion cannot restore metadata or advance the revision.");
    assert.deepEqual((await loadBoardState(app.context)).evidence, afterDelete.evidence);
});

test("collector checkpoints never retain full, empty, malformed, multiline or oversized JSON response payloads", async t => {
    const app = await installation(t), id = app.session();
    const payload = { statusCode: 403, error: { code: "failure", message: "Access denied", stack: "PRIVATE_STACK" }, body: { name: "PRIVATE_PERSON" } };
    const results = [
        { content: JSON.stringify(payload) },
        { content: [{ type: "text", text: JSON.stringify({ ...payload, results: [] }) }] },
        { content: [{ type: "text", text: JSON.stringify({ ...payload, results: [{ statusCode: 403, body: { text: "PRIVATE_ENTITY" } }] }) }] },
        { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] },
        { content: [{ type: "text", text: '{"statusCode":403,"body":{"name":"PRIVATE_MALFORMED"' }] },
        { content: [{ type: "text", text: '{"statusCode":403,"body":{"name":"PRIVATE_OVERSIZED","padding":"' + "x".repeat(256001) + '"}}' }] },
        { content: [{ type: "text", text: '```json\n{"statusCode":403,"body":"PRIVATE_FENCED"}\n```' }] },
        { content: [{ type: "text", text: '{"statusCode":403,"body":"PRIVATE_BLOCK_ONE"}' }, { type: "text", text: '{"statusCode":503,"body":"PRIVATE_BLOCK_TWO"}' }] },
        { structuredContent: { statusCode: { body: "PRIVATE_STATUS" }, httpStatus: "PRIVATE_STATUS", body: "PRIVATE_STRUCTURED" } },
    ];
    const events = [event("user.message", { content: "Invented checkpoint privacy case" }),
        ...results.flatMap((result, index) => [call(`payload-${index}`), event("tool.execution_complete", { toolCallId: `payload-${index}`, success: false, result })])];
    const file = await logFor(app, id, events);
    const sourceBefore = await readFile(file);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const fingerprint = createHash("sha256").update(JSON.stringify([app.config.appDbPath, app.config.sessionRoot, 30])).digest("hex");
    const checkpoint = await readFile(path.join(app.context.dataDir, "collector", fingerprint, id + ".json"), "utf8");
    const state = await loadBoardState(app.context);
    assert.doesNotMatch(checkpoint, /PRIVATE_/);
    assert.doesNotMatch(JSON.stringify(state.evidence), /PRIVATE_/);
    assert.equal(state.evidence.flatMap(record => record.toolCalls).length, results.length);
    assert.equal(state.evidence[0].toolCalls[2].apiResults[0].statusCode, 403);
    assert.equal(state.evidence[0].toolCalls[0].failureEvidence.code, "failure");
    const direct = extractScenarios(events, { sessionId: id }, events[0].timestamp, events.at(-1).timestamp).scenarios;
    assert.doesNotMatch(JSON.stringify(direct), /PRIVATE_/);
    assert.deepEqual(await readFile(file), sourceBefore);
});

test("scoped metadata qualification recovers final timing without rewinding primary cursors or retaining answer text", { timeout: 20000 }, async t => {
    const app = await installation(t), id = app.session(), now = Date.now() - 5000;
    const prompt = { ...event("user.message", { content: "Synthetic timing request", messageId: "message" }), timestamp: new Date(now).toISOString() };
    const start = { ...call("timing-call"), timestamp: new Date(now + 100).toISOString() };
    const complete = { ...event("tool.execution_complete", { toolCallId: "timing-call", success: true }), timestamp: new Date(now + 500).toISOString() };
    const answer = { ...event("assistant.message", { content: "PRIVATE_TIMING_ANSWER", phase: "final_answer", turnId: "turn", toolRequests: [] }), timestamp: new Date(now + 1200).toISOString() };
    const end = { ...event("assistant.turn_end", { turnId: "turn" }), timestamp: new Date(now + 1250).toISOString() };
    const file = await logFor(app, id, [prompt, start, complete, answer, end]);
    const collector = await createCollector(app.context);
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const first = await loadBoardState(app.context);
    const recordId = first.evidence[0].scenarioId;
    await replaceEvidence(app.context, current => ({
        records: current.map(record => { const copy = { ...record }; delete copy.responseTiming; return copy; }),
        importCoverage: first.importCoverage,
    }));
    const before = await loadBoardState(app.context), status = await collector.status();
    const primary = status.cursors.find(row => row.sessionId === id).cursor.offset;
    const sourceHash = createHash("sha256").update(await readFile(file)).digest("hex");
    const operationId = randomUUID();
    await collector.qualifyResponseTimings({ operationId, scenarioIds: [recordId], expectedSourceRevision: before.evidenceRevision });
    const deadline = Date.now() + 12000;
    let afterStatus;
    do {
        await new Promise(resolve => setTimeout(resolve, 50));
        afterStatus = await collector.status();
    } while (afterStatus.responseTimingQualification.phase === "pending" && Date.now() < deadline);
    assert.equal(afterStatus.responseTimingQualification.phase, "complete");
    assert.equal(afterStatus.responseTimingQualification.results[0].status, "measured");
    assert.equal(afterStatus.cursors.find(row => row.sessionId === id).cursor.offset, primary);
    const final = await loadBoardState(app.context);
    assert.equal(final.evidence[0].responseTiming.durationMs, 1200);
    assert.equal(final.personalEvaluation, undefined);
    assert.doesNotMatch(JSON.stringify(final.evidence), /PRIVATE_TIMING_ANSWER/);
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), sourceHash);
    assert.equal((await collector.qualifyResponseTimings({ operationId, scenarioIds: [recordId], expectedSourceRevision: before.evidenceRevision })).phase, "complete");
    await collector.setEnabled(false);
    await assert.rejects(collector.qualifyResponseTimings({ operationId: randomUUID(), scenarioIds: [recordId], expectedSourceRevision: final.evidenceRevision }), /already be enabled/);
});

test("compatible metadata174 manual check collects new activity instead of unsupported-version failure", async t => {
    const app = await installation(t, { metadata174: true }), id = app.session();
    app.db.exec("PRAGMA user_version=156");
    const file = await logFor(app, id, [event("user.message", { content: "Invented compatible upgrade" }), call("before-upgrade")]);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const configFile = path.join(app.context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    const before = await collector.status(), stateBefore = await loadBoardState(app.context);
    app.db.exec("PRAGMA user_version=174");
    await appendFile(file, JSON.stringify(call("after-upgrade")) + "\n");
    const sourcesBefore = await Promise.all([app.config.appDbPath, file].map(name => readFile(name)));
    const receipt = await collector.collectNow();
    assert.equal(receipt.discovery.schemaVersion, 174);
    assert.equal(receipt.discovery.adapter, before.discovery.adapter);
    assert.equal(receipt.configVersion, before.configVersion);
    assert.equal(receipt.check.changes.added, 1);
    assert.ok(receipt.cursors[0].cursor.offset > before.cursors[0].cursor.offset);
    const state = await loadBoardState(app.context);
    assert.equal(state.evidence[0].toolCalls.length, 2);
    assert.deepEqual(state.personalEvaluation, stateBefore.personalEvaluation);
    assert.deepEqual(await readFile(configFile), configBefore);
    assert.deepEqual(await Promise.all([app.config.appDbPath, file].map(name => readFile(name))), sourcesBefore);
    const unchanged = await collector.collectNow();
    assert.equal(unchanged.check.changes.added, 0);
    assert.equal(unchanged.check.changes.updated, 0);
    assert.equal(unchanged.metrics.lastBytesRead, 0);
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    const restarted = await collector.collectNow();
    assert.equal(restarted.discovery.schemaVersion, 174);
    assert.equal(restarted.configVersion, before.configVersion);
    assert.deepEqual(restarted.cursors[0].cursor, unchanged.cursors[0].cursor);
    assert.equal(restarted.metrics.lastBytesRead, 0);
    assert.deepEqual((await loadBoardState(app.context)).evidence, state.evidence);
});

test("compatible additive metadata upgrade is reconciled by automatic collection without changing approval or capture", { timeout: 10000 }, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const app = await installation(t, { metadata174: true }), id = app.session();
    app.db.exec("PRAGMA user_version=166");
    const file = await logFor(app, id, [event("user.message", { content: "Invented interval upgrade" }), call("interval-before")]);
    let committed;
    const collector = await createCollector(app.context, { onCommitted: check => committed?.(check) });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    const before = await collector.status(), stateBefore = await loadBoardState(app.context);
    const configFile = path.join(app.context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    for (const version of [174, 175]) {
        app.db.exec(`PRAGMA user_version=${version}`);
        if (version === 175) app.db.exec("ALTER TABLE sessions ADD COLUMN unrelated_feature TEXT; CREATE INDEX invented_title_index ON sessions(title)");
        await appendFile(file, JSON.stringify(call(`interval-after-${version}`)) + "\n");
        const next = new Promise(resolve => { committed = resolve; });
        t.mock.timers.tick(31000);
        const receipt = await next, status = await collector.status(), state = await loadBoardState(app.context);
        assert.equal(status.discovery.schemaVersion, version);
        assert.equal(status.state, "collecting-on-interval");
        assert.equal(receipt.changes.added, 1);
        assert.equal(status.lastCheck, null, "An automatic cycle does not fabricate a manual-check receipt");
        assert.ok(status.cursors[0].cursor.offset > before.cursors[0].cursor.offset);
        assert.equal(state.evidence[0].toolCalls.length, version === 174 ? 2 : 3);
        assert.deepEqual(state.personalEvaluation, stateBefore.personalEvaluation);
        assert.deepEqual(await readFile(configFile), configBefore);
        assert.equal(status.configVersion, before.configVersion);
        assert.equal(status.config.sourceAdapter, before.config.sourceAdapter);
    }
});

test("compatible version changes do not interpret unfamiliar workspace types as eligible local histories", async t => {
    const app = await installation(t), id = app.session(), project = randomUUID();
    app.db.exec("PRAGMA user_version=175");
    app.db.prepare("INSERT INTO projects VALUES(?,?)").run(project, "Invented future mapping");
    app.db.prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(), id, project, "Invented unknown workspace", null, "local", "new-unverified-type");
    const discovered = await discoverSources(app.config);
    assert.equal(discovered.roster[0].eligible, false);
    assert.equal(discovered.roster[0].disposition, "unmapped-workspace-type");
});

test("a metadata-read refusal recovers on the next ordinary interval without changing approval or retained facts", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const app = await installation(t), id = app.session();
    app.db.exec("PRAGMA journal_mode=WAL; UPDATE sessions SET title='Invented interval recovery'");
    await logFor(app, id, [event("user.message", { content: "Invented retained request" }), call()]);
    let committed;
    const collector = await createCollector(app.context, { onCommitted: check => committed?.(check) });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    const before = await loadBoardState(app.context), statusBefore = await collector.status();
    const configFile = path.join(app.context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    const interval = Promise.withResolvers(), prepare = DatabaseSync.prototype.prepare;
    const log = t.mock.method(console, "error", () => {});
    const metadataChange = t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (sql === "PRAGMA user_version") {
            const get = statement.get.bind(statement);
            statement.get = () => {
                const result = get();
                app.db.exec("INSERT OR REPLACE INTO projects VALUES('unrelated-project','Invented concurrent metadata')");
                return result;
            };
        }
        return statement;
    });
    let diagnostic;
    try {
        await assert.rejects(collector.collectNow(), { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "metadata-read" });
        // The last good roster is less than 30 seconds old. It must not clear the failed read.
        committed = check => interval.resolve(check);
        log.mock.mockImplementation((_label, failure) => interval.resolve(failure));
        t.mock.timers.tick(5000);
        diagnostic = await interval.promise;
    }
    finally { metadataChange.mock.restore(); log.mock.restore(); }
    await setImmediate();
    assert.deepEqual(diagnostic, { code: "COLLECTION_SOURCE_CHANGED", stage: "source-read", sourceChange: "metadata-read" });
    const refused = await collector.status();
    assert.equal(refused.state, "error");
    assert.deepEqual(refused.cursors, statusBefore.cursors);
    assert.deepEqual(await loadBoardState(app.context), before);
    const next = new Promise(resolve => { committed = resolve; });
    t.mock.timers.tick(5000);
    await next;
    const recovered = await collector.status();
    assert.equal(recovered.state, "collecting-on-interval");
    assert.equal(recovered.error, null);
    assert.equal(recovered.connected, true);
    assert.equal(recovered.lastCheck, null, "Automatic recovery must not fabricate a manual check.");
    assert.equal(recovered.revision, statusBefore.revision);
    assert.equal(recovered.metrics.lastBytesRead, 0);
    assert.deepEqual(await readFile(configFile), configBefore);
    assert.deepEqual(await loadBoardState(app.context), before);
    t.diagnostic(JSON.stringify({ diagnostic, recovery: "next scheduled interval", unchangedRevision: recovered.revision }));
});

test("incompatible required metadata fails before histories, retaining evidence, cursor, receipt and approval", async t => {
    const incompatible = [
        ["missing table", "DROP TABLE workspaces", /Unsupported workspaces mapping.*174.*table missing/],
        ...Object.entries({
            sessions: ["id", "title", "session_type", "archived_at", "execution_location"],
            workspaces: ["id", "session_id", "project_id", "name", "archived_at", "host_id", "workspace_type"],
            projects: ["id", "name"],
        }).flatMap(([table, fields]) => fields.map(field => [
            `missing ${table}.${field}`, `ALTER TABLE ${table} RENAME COLUMN ${field} TO removed_${field}`,
            new RegExp(`Unsupported ${table} mapping.*${field}`),
        ])),
        ["different storage type", "ALTER TABLE workspaces RENAME COLUMN host_id TO removed_host; ALTER TABLE workspaces ADD COLUMN host_id INTEGER", /Unsupported workspaces mapping.*host_id/],
        ["view instead of table", "ALTER TABLE sessions RENAME TO old_sessions; CREATE VIEW sessions AS SELECT * FROM old_sessions", /Unsupported sessions mapping.*table missing/],
        ["generated eligibility", "ALTER TABLE sessions RENAME COLUMN execution_location TO removed_location; ALTER TABLE sessions ADD COLUMN execution_location TEXT GENERATED ALWAYS AS ('local') VIRTUAL", /Unsupported sessions mapping.*execution_location/],
        ["lost primary key", "ALTER TABLE projects RENAME TO old_projects; CREATE TABLE projects(id TEXT,name TEXT)", /Unsupported projects mapping.*sole primary key/],
        ["composite primary key", "ALTER TABLE projects RENAME TO old_projects; CREATE TABLE projects(id TEXT,name TEXT,PRIMARY KEY(id,name))", /Unsupported projects mapping.*sole primary key/],
        ["opaque required value", "UPDATE sessions SET archived_at=X'00'", /Unsupported sessions mapping.*values must remain text or null/],
        ["opaque project name", "UPDATE projects SET name=X'00'", /Unsupported projects mapping.*values must remain text or null/],
        ["unpageable identity", "INSERT INTO sessions(id) VALUES('')", /Unsupported sessions mapping.*IDs cannot be completely enumerated/],
        ["newer incompatible version", "PRAGMA user_version=999; DROP TABLE projects", /Unsupported projects mapping.*999/],
        ["predating known mapping", "PRAGMA user_version=155", /Unsupported Copilot app metadata version 155/],
    ];
    for (const [name, change, error] of incompatible) await t.test(name, async t => {
        const app = await installation(t, { metadata174: true }), id = app.session();
        const project = randomUUID();
        app.db.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run(project, "Invented retained project");
        app.db.prepare("INSERT INTO workspaces(id,session_id,project_id,name,workspace_type) VALUES(?,?,?,?,?)")
            .run(randomUUID(), id, project, "Invented retained workspace", "folder");
        const file = await logFor(app, id, [event("user.message", { content: "Invented last good request" }), call("retained")]);
        const collector = await createCollector(app.context, { timers: false });
        app.cleanup.push(() => collector.close());
        const settings = { ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
        await collector.configure(settings);
        await collector.collectNow();
        const before = await loadBoardState(app.context), status = await collector.status();
        const root = path.join(app.context.dataDir, "collector"), index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
        const protectedFiles = ["config.json", "index.json", "last-check.json", path.join(index.fingerprint, id + ".json")].map(name => path.join(root, name));
        protectedFiles.push(path.join(app.context.dataDir, "private-evidence", before.evidenceFile));
        const protectedBytes = await Promise.all(protectedFiles.map(name => readFile(name)));
        app.db.exec(change);
        await appendFile(file, JSON.stringify(call("must-not-read-on-failure")) + "\n");
        await assert.rejects(collector.collectNow(), error);
        const failed = await collector.status();
        assert.equal(failed.state, "error");
        assert.equal(failed.connected, false);
        assert.match(failed.error, /[Nn]o history was replaced/);
        assert.deepEqual(failed.cursors, status.cursors);
        assert.deepEqual(failed.lastCheck, status.lastCheck);
        await assert.rejects(collector.configure(settings), error);
        assert.deepEqual(await loadBoardState(app.context), before);
        assert.deepEqual(await Promise.all(protectedFiles.map(name => readFile(name))), protectedBytes);
    });
});

test("optional creator metadata never guesses authorship on compatible174", async t => {
    const cases = [
        ["verified pair", "", "agent"],
        ["no pair", "ALTER TABLE workspaces DROP COLUMN created_by; ALTER TABLE workspaces DROP COLUMN creator_session_id", "unknown"],
        ["partial pair", "ALTER TABLE workspaces DROP COLUMN creator_session_id", "unknown"],
        ["incompatible optional type", "ALTER TABLE workspaces RENAME COLUMN creator_session_id TO old_creator; ALTER TABLE workspaces ADD COLUMN creator_session_id BLOB; UPDATE workspaces SET creator_session_id=old_creator", "unknown"],
        ["opaque optional value", "UPDATE workspaces SET creator_session_id=CAST(creator_session_id AS BLOB)", "unknown"],
        ["invalid creator identity", "UPDATE workspaces SET creator_session_id='not-a-session'", "unknown"],
        ["unsupported actor", "ALTER TABLE workspaces DROP COLUMN created_by; ALTER TABLE workspaces ADD COLUMN created_by TEXT; UPDATE workspaces SET created_by='robot'", "unknown"],
        ["explicit user creator is not prompt authorship", "UPDATE workspaces SET created_by='user'", "unknown"],
    ];
    for (const [name, change, actor] of cases) await t.test(name, async t => {
        const app = await installation(t, { metadata174: true }), id = app.session(), parent = app.session(), project = randomUUID();
        const content = "Invented exact creator kickoff";
        app.db.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run(project, "Invented project");
        app.db.prepare("INSERT INTO workspaces(id,session_id,project_id,name,workspace_type,created_by,creator_session_id) VALUES(?,?,?,?,?,?,?)")
            .run(randomUUID(), id, project, "Invented child", "folder", "agent", parent);
        if (change) app.db.exec(change);
        await logFor(app, parent, [event("external_tool.requested", {
            sessionId: parent, toolName: "create_session", toolCallId: "invented-create", arguments: { kickoff: { prompt: content } },
        })]);
        await logFor(app, id, [event("user.message", { content }), call()]);
        const collector = await createCollector(app.context, { timers: false });
        app.cleanup.push(() => collector.close());
        await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
        const receipt = await collector.collectNow(), state = await loadBoardState(app.context);
        assert.equal(receipt.check.outcome, "complete");
        const source = receipt.discovery.roster.find(row => row.sessionId === id);
        assert.equal(source.promptCreation?.actor ?? "unknown", actor);
        assert.equal(state.evidence[0].userPrompt.authorship.actor, actor);
        assert.equal(state.evidence[0].toolCalls.length, 1);
    });
});

test("approved schema156 collection continues after compatible schema166 upgrade without changing source or replaying membership", async t => {
    const app = await installation(t), id = app.session();
    const prompt = event("user.message", { content: "Synthetic schema upgrade request" });
    const start = call("upgrade-call");
    start.timestamp = new Date(Date.now() - 2000).toISOString();
    const file = await logFor(app, id, [prompt, start]);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const configFile = path.join(app.context.dataDir, "collector", "config.json");
    const configBefore = await readFile(configFile);
    app.db.exec("PRAGMA user_version=166; ALTER TABLE sessions ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT 0");
    const complete = event("tool.execution_complete", { toolCallId: "upgrade-call", success: true, result: { structuredContent: { results: [{ statusCode: 200 }] } } });
    complete.timestamp = new Date(Date.parse(start.timestamp) + 1200).toISOString();
    await appendFile(file, JSON.stringify(complete) + "\n");
    const receipt = await collector.collectNow();
    assert.equal(receipt.discovery.schemaVersion, 166);
    assert.equal(receipt.check.changes.added, 0);
    assert.equal(receipt.check.changes.updated, 1);
    assert.deepEqual(await readFile(configFile), configBefore, "Adapter compatibility does not renew source approval or change cadence/capture");
    const state = await loadBoardState(app.context);
    const { facts } = buildReportFacts(state.evidence, state);
    assert.equal(facts.recordedOutcomes.filter(row => row.kind === "tool-call").length, 1);
    assert.equal(facts.recordedOutcomes.find(row => row.kind === "tool-call").outcome, "success");
    assert.equal(facts.metrics.find(metric => metric.definitionId === "tool-duration").value, 1200);
    assert.equal(facts.metrics.some(metric => metric.dimension === "accuracy"), false,
        "A metadata schema upgrade must not restore retired accuracy placeholders");
    const unchanged = await collector.collectNow();
    assert.equal(unchanged.check.changes.added, 0);
    assert.equal(unchanged.check.changes.updated, 0);
    app.db.exec("PRAGMA user_version=167");
    assert.equal((await discoverSources(app.config)).schemaVersion, 167, "Version-only changes still require the same validated mapping");
    app.db.exec("PRAGMA user_version=166; ALTER TABLE sessions RENAME COLUMN execution_location TO removed_location");
    await assert.rejects(discoverSources(app.config), /Unsupported sessions mapping/);
});

test("deleted activity stays absent through late completion, rotation, window change, eligibility and restart; new same-chat call survives", async t => {
    const app = await installation(t), id = app.session();
    const prompt = event("user.message", { content: "DELETE_ME_秘密" });
    const start = call("deleted-call");
    const file = await logFor(app, id, [prompt, start]);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    const settings = { ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    await collector.configure(settings);
    await collector.collectNow();
    const hash = async name => createHash("sha256").update(await readFile(name)).digest("hex");
    const protectedBefore = [await hash(file), await hash(app.config.appDbPath), await hash(path.join(app.context.dataDir, "collector", "config.json"))];
    const deletion = createDeletionController(app.context);
    const preview = await deletion.preview("panel", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("panel", { operationId: preview.operationId, confirmed: true });
    assert.deepEqual([await hash(file), await hash(app.config.appDbPath), await hash(path.join(app.context.dataDir, "collector", "config.json"))], protectedBefore);
    assert.deepEqual((await loadBoardState(app.context)).evidence, []);
    await appendFile(file, JSON.stringify(event("tool.execution_complete", { toolCallId: "deleted-call", success: true })) + "\n");
    await collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence, []);
    await logFor(app, id, [prompt, start, call("fresh-same-chat")]);
    await collector.collectNow();
    assert.deepEqual((await loadBoardState(app.context)).evidence.flatMap(record => record.toolCalls.map(call => call.toolCallId)), ["fresh-same-chat"]);
    assert.doesNotMatch(JSON.stringify((await loadBoardState(app.context)).evidence), /DELETE_ME/);
    await collector.configure({ ...settings, windowDays: 90 });
    app.db.prepare("UPDATE sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(), id);
    await collector.collectNow();
    app.db.prepare("UPDATE sessions SET archived_at=NULL WHERE id=?").run(id);
    await collector.collectNow();
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await collector.collectNow();
    const retained = (await loadBoardState(app.context)).evidence;
    assert.deepEqual(retained.flatMap(record => record.toolCalls.map(call => call.toolCallId)), ["fresh-same-chat"]);
    const checkpointFiles = await import("node:fs/promises").then(fs => fs.readdir(path.join(app.context.dataDir, "collector"), { recursive: true }));
    for (const name of checkpointFiles.filter(name => name.endsWith(`${id}.json`))) {
        assert.doesNotMatch(await readFile(path.join(app.context.dataDir, "collector", name), "utf8"), /DELETE_ME|deleted-call/);
    }
});

test("manual check owns a completed receipt and applied revision for new calls and late results", async t => {
    const app = await installation(t), id = app.session();
    const file = await logFor(app, id, [event("user.message", { content: "Synthetic fresh check" }), call()]);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const first = await collector.collectNow();
    assert.ok(first.check?.id, "Collect now must return its own completed check, not just mutable runtime status");
    assert.equal(first.state, "paused");
    assert.equal(first.check.revision, (await loadBoardState(app.context)).revision);
    assert.equal(first.check.changes.added, 1);
    assert.equal(first.check.changes.updated, 0);
    assert.equal(first.check.outcome, "complete");
    assert.ok(Date.parse(first.check.completedAt) >= Date.parse(first.check.startedAt));
    await appendFile(file, JSON.stringify(event("tool.execution_complete", { toolCallId: "synthetic-call", success: true })) + "\n");
    const later = await collector.collectNow();
    assert.notEqual(later.check.id, first.check.id);
    assert.equal(later.check.changes.added, 0);
    assert.equal(later.check.changes.updated, 1);
    assert.equal(later.check.changes.items[0].id, "synthetic-call");
    const windowBeforeNoop = (await loadBoardState(app.context)).importCoverage;
    const unchanged = await collector.collectNow();
    assert.equal(unchanged.check.changes.added, 0);
    assert.equal(unchanged.check.changes.updated, 0);
    assert.equal(unchanged.check.revision, later.check.revision);
    assert.equal(unchanged.config.enabled, false);
    assert.equal(unchanged.checkedWindow.until, unchanged.lastCheckedAt);
    assert.equal(Date.parse(unchanged.checkedWindow.until) - Date.parse(unchanged.checkedWindow.since), 30 * 86400000);
    assert.ok(unchanged.checkedWindow.until >= later.checkedWindow.until);
    assert.deepEqual((await loadBoardState(app.context)).importCoverage, windowBeforeNoop, "No-change checks do not rewrite the evidence window");
});

test("manual callers coalesce behind an in-flight interval cycle and still reconcile new sources", { timeout: 20000 }, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const app = await installation(t);
    const file = await logFor(app, app.session());
    const collector = await createCollector(app.context);
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), realOpen = fs.open;
    let held = false;
    const opening = t.mock.method(fs, "open", async (...args) => {
        if (args[0] === file && !held) { held = true; entered.resolve(); await release.promise; }
        return realOpen(...args);
    });
    syncBuiltinESMExports();
    app.cleanup.unshift(() => { release.resolve(); opening.mock.restore(); syncBuiltinESMExports(); });
    await appendFile(file, JSON.stringify(event("assistant.message", { content: "Invented interval IO barrier" })) + "\n");
    t.mock.timers.tick(5000);
    await entered.promise;
    const observed = await collector.status();
    assert.equal(observed.state, "collecting", "Exercise a real already-running background cycle");
    const id = app.session();
    await logFor(app, id, [event("user.message", { content: "Synthetic source added during background cycle" }), call("new-during-cycle")]);
    const pending = [collector.collectNow(), collector.collectNow(), collector.setEnabled(false, observed.configVersion)];
    release.resolve();
    const [one, two, paused] = await Promise.all(pending);
    assert.equal(one.check.id, two.check.id, "Overlapping manual requests share the owned check");
    assert.equal(one.check.changes.added, 1);
    assert.ok(one.discovery.roster.some(row => row.sessionId === id));
    assert.ok((await loadBoardState(app.context)).evidence.some(row => row.sourceSessionId === id));
    assert.equal(one.config.enabled, true);
    assert.equal(two.config.enabled, true);
    assert.equal(one.check.configVersion, one.configVersion, "A queued configuration change cannot interleave the owned check");
    assert.equal(paused.config.enabled, false);
});

test("a bounded manual cycle reports pending bytes and unfinished entries instead of complete no-change", async t => {
    const app = await installation(t), id = app.session();
    const file = await logFor(app, id);
    const filler = event("assistant.message", { content: "x".repeat(8192) });
    await appendFile(file, (JSON.stringify(filler) + "\n").repeat(600));
    await appendFile(file, [event("user.message", { content: "Synthetic beyond first chunk" }), call("after-chunk")].map(e => JSON.stringify(e) + "\n").join(""));
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const first = await collector.collectNow();
    assert.equal(first.check.outcome, "partial");
    assert.equal(first.check.pendingSources, 1);
    assert.equal(first.check.changes.added, 0);
    assert.equal(first.metrics.lastBytesRead, 4 * 1024 * 1024);
    const second = await collector.collectNow();
    assert.equal(second.check.changes.added, 1);
    assert.equal(second.check.pendingSources, 0);
    assert.equal(second.check.outcome, "complete");
    const completion = JSON.stringify(event("tool.execution_complete", { toolCallId: "after-chunk", success: true }));
    await appendFile(file, completion);
    const unfinished = await collector.collectNow();
    assert.equal(unfinished.check.outcome, "partial");
    assert.equal(unfinished.check.partialSources, 1);
    assert.equal(unfinished.check.changes.updated, 0);
    await appendFile(file, "\n");
    const finished = await collector.collectNow();
    assert.equal(finished.check.changes.updated, 1);
    assert.equal(finished.check.outcome, "complete");
});

test("manual novelty ignores unchanged legacy aliases and unidentified records, including beside a real addition", async t => {
    const app = await installation(t), id = app.session();
    const file = await logFor(app, id, [event("user.message", { content: "Synthetic canonical alias case" }), call("canonical"), event("tool.execution_complete", { toolCallId: "canonical", success: true })]);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const state = await loadBoardState(app.context), original = state.evidence[0];
    await replaceEvidence(app.context, () => ({ records: [
        ...state.evidence,
        { ...original, scenarioId: "legacy-alias", isLegacy: true, toolCalls: original.toolCalls.map(c => ({ ...c, toolSucceeded: false, reportedOutcome: "failed" })) },
        { ...original, scenarioId: "unidentified", isLegacy: true, toolCalls: [
            { tool: "workiq-fetch", reportedOutcome: "failed" }, { tool: "workiq-fetch", reportedOutcome: "succeeded" },
        ] },
    ], importCoverage: state.importCoverage }));
    const before = await loadBoardState(app.context);
    const unchanged = await collector.collectNow();
    assert.equal(unchanged.check.beforeRevision, unchanged.check.revision);
    assert.deepEqual(unchanged.check.changes, { added: 0, updated: 0, items: [] }, "Unchanged raw aliases cannot manufacture novelty");
    assert.equal((await loadBoardState(app.context)).evidenceFile, before.evidenceFile);
    await appendFile(file, [event("user.message", { content: "Synthetic genuinely new action" }), call("new-action")].map(e => JSON.stringify(e) + "\n").join(""));
    const added = await collector.collectNow();
    assert.equal(added.check.changes.added, 1);
    assert.equal(added.check.changes.updated, 0);
    assert.equal(added.check.changes.items[0].id, "new-action");
    assert.ok(added.check.changes.items[0].rowId);
    assert.ok(added.check.revision > added.check.beforeRevision);
});

test("legacy receipt novelty is corrected only by an unchanged committed revision, without rewriting its bytes", async t => {
    const app = await installation(t);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const receipt = (await collector.collectNow()).check;
    await collector.close();
    const file = path.join(app.context.dataDir, "collector", "last-check.json");
    const legacy = { ...receipt, schemaVersion: 1, beforeRevision: receipt.revision, changes: { added: 0, updated: 4, items: [] } };
    const bytes = JSON.stringify(legacy);
    await writeFile(file, bytes);
    collector = await createCollector(app.context, { timers: false });
    const corrected = (await collector.status()).lastCheck;
    assert.equal(corrected.schemaVersion, 2);
    assert.deepEqual(corrected.changes, { added: 0, updated: 0, items: [] });
    assert.match(corrected.correction, /unchanged committed revision/);
    assert.equal(await readFile(file, "utf8"), bytes);
    await collector.close();
    await writeFile(file, JSON.stringify({ ...legacy, beforeRevision: legacy.revision - 1 }));
    collector = await createCollector(app.context, { timers: false });
    const uncertain = await collector.status();
    assert.equal(uncertain.lastCheck, null);
    assert.match(uncertain.lastCheckWarning, /cannot be reused/);
});

test("synthetic: empty store connects, discovers a new session, tails starts and late completions without duplicate counts", async (t) => {
    const app = await installation(t);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    const id = app.session();
    const prompt = event("user.message", { content: "Synthetic dynamic prompt" });
    const file = await logFor(app, id, [prompt, call()]);
    await collector.collectNow();
    let state = await loadBoardState(app.context);
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].userPrompt.text, prompt.data.content);
    assert.equal(state.evidence[0].toolCalls[0].reportedOutcome, "unknown");
    await appendFile(file, JSON.stringify(event("tool.execution_complete", {
        toolCallId: "synthetic-call", success: true, result: { structuredContent: { results: [{ status: 200, body: { secretEntity: "not retained" } }] } },
    })) + "\n");
    await collector.collectNow();
    state = await loadBoardState(app.context);
    assert.equal(state.evidence[0].toolCalls.length, 1);
    assert.equal(state.evidence[0].toolCalls[0].reportedOutcome, "succeeded");
    const revision = state.revision;
    const indexPath = path.join(app.context.dataDir, "collector", "index.json");
    const checkpointBytes = await readFile(indexPath);
    await collector.collectNow();
    assert.equal((await loadBoardState(app.context)).revision, revision);
    assert.deepEqual(await readFile(indexPath), checkpointBytes, "No-op checks do not rewrite durable cursor files.");
    const status = await collector.status();
    assert.equal(status.metrics.lastBytesRead, 0);
    assert.equal(status.discovery.counts.eligible, 1);
    assert.ok(status.lastNewDataAt);
    assert.equal(JSON.stringify(status).includes("Synthetic dynamic prompt"), false);
});

test("synthetic: archiving stops current eligibility without deleting evidence; unarchive restores it", async (t) => {
    const app = await installation(t), id = app.session();
    await logFor(app, id, [event("user.message", { content: "Synthetic archive prompt" }), call()]);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    const original = await loadBoardState(app.context);
    app.db.prepare("UPDATE sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(), id);
    await collector.collectNow();
    const archived = await loadBoardState(app.context);
    assert.equal(buildActivityAnalytics(mergeEvidenceWithState(archived)).totals.count, 0);
    assert.deepEqual(archived.evidence, original.evidence);
    assert.deepEqual(archived.cards, original.cards);
    assert.equal(buildActivityAnalytics(mergeEvidenceWithState(archived), { filters: { scope: "all" } }).totals.count, 1);
    app.db.prepare("UPDATE sessions SET archived_at=NULL WHERE id=?").run(id);
    await collector.collectNow();
    assert.equal(buildActivityAnalytics(mergeEvidenceWithState(await loadBoardState(app.context))).totals.count, 1);
});

test("synthetic: UTF-8 partial tails, duplicates, rotation and restart checkpoints preserve identity and parallel order", async (t) => {
    const app = await installation(t), id = app.session();
    const prompt = event("user.message", { content: "Synthetic caf\u00e9 request" }), first = call("parallel-b"), second = call("parallel-a");
    first.timestamp = second.timestamp;
    const file = await logFor(app, id);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    const encoded = Buffer.from(JSON.stringify(prompt) + "\n");
    const cut = encoded.indexOf(Buffer.from("\u00e9")) + 1;
    await appendFile(file, encoded.subarray(0, cut));
    await collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    await appendFile(file, Buffer.concat([encoded.subarray(cut), Buffer.from([first, second, first].map(e => JSON.stringify(e) + "\n").join(""))]));
    await collector.collectNow();
    let calls = (await loadBoardState(app.context)).evidence[0].toolCalls;
    assert.deepEqual(calls.map(c => c.toolCallId), ["parallel-b", "parallel-a"]);
    assert.equal((await loadBoardState(app.context)).evidence[0].userPrompt.text, prompt.data.content);
    await logFor(app, id, [prompt, first, second, event("tool.execution_complete", { toolCallId: "parallel-b", success: false })]);
    await collector.collectNow();
    calls = (await loadBoardState(app.context)).evidence[0].toolCalls;
    assert.equal(calls.length, 2);
    assert.equal(calls[0].reportedOutcome, "failed");
    assert.equal((await collector.status()).cursors[0].cursor.rotations, 1);
    await collector.collectNow();
    assert.equal((await collector.status()).metrics.lastBytesRead, 0);
});

test("synthetic: shared Graph classifier promotes a late status and retains code references separately", async (t) => {
    const app = await installation(t), id = app.session();
    const graph = event("tool.execution_start", { toolName: "powershell", toolCallId: "graph-call", arguments: { command: "curl -i https://graph.microsoft.com/v1.0/me/messages" } });
    const code = event("tool.execution_start", { toolName: "powershell", toolCallId: "code-call", arguments: { command: "git diff # https://graph.microsoft.com/v1.0/me/calendarView" } });
    const file = await logFor(app, id, [event("user.message", { content: "Synthetic Graph request" }), graph, code]);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    await appendFile(file, JSON.stringify(event("tool.execution_complete", { toolCallId: "graph-call", success: true, result: { content: "HTTP/2 200\nBODY_NOT_RETAINED" } })) + "\n");
    await collector.collectNow();
    const state = await loadBoardState(app.context), records = mergeEvidenceWithState(state);
    assert.equal(buildActivityAnalytics(records, { layer: "direct-request" }).totals.count, 1);
    assert.equal(buildActivityAnalytics(records, { layer: "recorded-http" }).totals.count, 1);
    assert.equal(buildActivityAnalytics(records, { layer: "code-reference" }).totals.count, 1);
    assert.doesNotMatch(JSON.stringify(state.evidence), /BODY_NOT_RETAINED/);
});

test("synthetic: missing/unsupported sources retain last good data; pause/resume and single writer are explicit", { timeout: 20000 }, async (t) => {
    const app = await installation(t), id = app.session();
    const file = await logFor(app, id, [event("user.message", { content: "Synthetic lifecycle request" }), call()]);
    let collector = await createCollector(app.context);
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    await assert.rejects(createCollector(app.context), /owns this store/);
    await collector.setEnabled(false);
    await appendFile(file, JSON.stringify(call("after-pause")) + "\n");
    await new Promise(resolve => setTimeout(resolve, 5200));
    assert.equal((await loadBoardState(app.context)).evidence[0].toolCalls.length, 1);
    await collector.setEnabled(true);
    await new Promise(resolve => setTimeout(resolve, 5300));
    assert.equal((await loadBoardState(app.context)).evidence[0].toolCalls.length, 2);
    await collector.setEnabled(false);
    const before = await loadBoardState(app.context);
    app.db.exec("PRAGMA user_version=174; ALTER TABLE sessions RENAME COLUMN execution_location TO removed_location");
    await assert.rejects(collector.collectNow(), /Unsupported sessions mapping.*174/);
    assert.equal((await collector.status()).state, "error");
    assert.equal((await loadBoardState(app.context)).evidenceFile, before.evidenceFile);
    app.db.exec("PRAGMA user_version=156; ALTER TABLE sessions RENAME COLUMN removed_location TO execution_location");
    await rm(file);
    await collector.collectNow();
    const missing = await collector.status();
    assert.equal(missing.sourceErrors, 1);
    assert.deepEqual(missing.historyIssues[0].reasons, ["missing"]);
    assert.ok(missing.historyIssues[0].lastAttemptAt);
    assert.equal(missing.historyIssues[0].hasPriorEvidence, true);
    const afterMissing = await loadBoardState(app.context);
    assert.deepEqual(afterMissing.evidence, before.evidence);
    assert.deepEqual(afterMissing.cards, before.cards);
    assert.equal(afterMissing.importCoverage.counts.failed, 1);
    assert.equal(afterMissing.importCoverage.dynamic.historyCoverage.unavailable, 1);
    assert.deepEqual(buildActivityAnalytics(mergeEvidenceWithState(afterMissing)).totals, buildActivityAnalytics(mergeEvidenceWithState(before)).totals);
    await readFile(path.join(app.context.dataDir, "private-evidence", before.evidenceFile));
    await collector.close();
    collector = await createCollector(app.context, { timers: false });
    assert.equal((await collector.status()).config.enabled, false);
});

test("synthetic: a recovered read clears its issue without duplicate evidence; archiving a missing source is not a failure", async t => {
    const app = await installation(t), id = app.session();
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    assert.equal((await collector.status()).historyCoverage.unavailable, 1);
    const file = await logFor(app, id, [event("user.message", { content: "Synthetic restored history" }), call()]);
    await collector.collectNow();
    assert.equal((await collector.status()).historyCoverage.unavailable, 0);
    assert.deepEqual((await collector.status()).historyIssues, []);
    assert.equal((await collector.status()).cursors[0].errorCode, null);
    await collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence[0].toolCalls.length, 1);
    await rm(file);
    await collector.collectNow();
    app.db.prepare("UPDATE sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(), id);
    await collector.collectNow();
    assert.equal((await collector.status()).sourceErrors, 0);
    assert.deepEqual((await collector.status()).historyIssues, []);
    assert.equal((await loadBoardState(app.context)).importCoverage.counts.failed, 0);
});

test("synthetic: unavailable logs do not roll back other sources' cursor/coverage progress", async t => {
    const app = await installation(t), good = app.session();
    await logFor(app, good, [event("user.message", { content: "Synthetic independent source" }), call()]);
    for (let i = 0; i < 12; i++) app.session();
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    let status = await collector.status();
    assert.equal(status.cursors.length, 13);
    assert.equal(status.sourceErrors, 12);
    assert.ok(status.cursors.find(row => row.sessionId === good).cursor.offset > 0);
    await collector.collectNow();
    status = await collector.status();
    assert.equal(status.metrics.lastBytesRead, 0);
    assert.equal(status.cursors.length, 13);
});

test("synthetic: late Work IQ and Graph completions update durable evidence even after context eviction", async t => {
    const app = await installation(t), id = app.session();
    const graph = event("tool.execution_start", { toolName: "powershell", toolCallId: "late-graph", arguments: { command: "curl -i https://graph.microsoft.com/v1.0/me/messages" } });
    const file = await logFor(app, id, [event("user.message", { content: "Synthetic late result" }), call(), graph]);
    let collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    await collector.close();
    const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json"), "utf8"));
    const checkpoint = path.join(app.context.dataDir, "collector", index.fingerprint, `${id}.json`);
    const saved = JSON.parse(await readFile(checkpoint, "utf8"));
    saved.events = [];
    await writeFile(checkpoint, JSON.stringify(saved));
    await appendFile(file, [
        event("tool.execution_complete", { toolCallId: "synthetic-call", success: true }),
        event("tool.execution_complete", { toolCallId: "late-graph", success: true, result: { content: "HTTP/2 204" } }),
    ].map(e => JSON.stringify(e) + "\n").join(""));
    collector = await createCollector(app.context, { timers: false });
    await collector.collectNow();
    const records = mergeEvidenceWithState(await loadBoardState(app.context));
    assert.equal(records.length, 1);
    assert.equal(records[0].toolCalls.length, 1);
    assert.equal(records[0].toolCalls[0].reportedOutcome, "succeeded");
    assert.equal(buildActivityAnalytics(records, { layer: "recorded-http" }).totals.count, 1);
});

test("synthetic: approval, schema and stale-write validation never replace the valid configuration", async t => {
    const app = await installation(t);
    const collector = await createCollector(app.context, { timers: false });
    app.cleanup.push(() => collector.close());
    const input = { ...app.config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    assert.equal((await collector.status()).configVersion, null);
    await assert.rejects(collector.configure({ ...input, approved: false, expectedConfigVersion: null }), /Approve a local source/);
    assert.equal((await collector.status()).config, null);
    await collector.configure({ ...input, expectedConfigVersion: null });
    const before = await collector.status(), file = path.join(app.context.dataDir, "collector", "config.json");
    const saved = await readFile(file);
    for (const invalid of [
        { approved: false }, { pollSeconds: 1 }, { windowDays: 365 }, { appDbPath: "relative\\data.db" },
        { sessionRoot: path.join(app.root, "missing", "session-state") }, { unexpected: true },
    ]) {
        await assert.rejects(collector.configure({ ...input, ...invalid, expectedConfigVersion: before.configVersion }));
        assert.deepEqual(await readFile(file), saved);
        assert.deepEqual((await collector.status()).config, before.config);
    }
    app.db.exec("PRAGMA user_version=174; ALTER TABLE sessions RENAME COLUMN execution_location TO removed_location");
    await assert.rejects(collector.configure({ ...input, expectedConfigVersion: before.configVersion }), /Unsupported sessions mapping.*174/);
    assert.deepEqual(await readFile(file), saved);
    app.db.exec("PRAGMA user_version=156; ALTER TABLE sessions RENAME COLUMN removed_location TO execution_location");
    await collector.configure({ ...input, pollSeconds: 15, expectedConfigVersion: before.configVersion });
    const current = await readFile(file), status = await collector.status();
    assert.equal(status.config.enabled, false, "Preference saves never implicitly resume");
    assert.notEqual(status.configVersion, before.configVersion);
    assert.equal(status.config.expectedConfigVersion, undefined, "Concurrency guard is not persisted as source permission");
    await assert.rejects(collector.configure({ ...input, expectedConfigVersion: before.configVersion }), /changed in another panel/);
    await assert.rejects(collector.setEnabled(true, before.configVersion), /changed in another panel/);
    assert.deepEqual(await readFile(file), current);
    assert.equal((await collector.status()).config.enabled, false);
    await collector.setEnabled(true, status.configVersion);
    assert.equal((await collector.status()).config.enabled, true);
});
