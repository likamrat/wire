import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { discoverSources } from "../lib/source-discovery.mjs";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState, mergeEvidenceWithState, replaceEvidence } from "../lib/store.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createHash } from "node:crypto";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";

// Invented app metadata and events, isolated from the user's installation.
async function installation(t, { metadata174 = false } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "workiq-dynamic-synthetic-"));
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state") };
    await mkdir(config.sessionRoot);
    const db = new DatabaseSync(config.appDbPath);
    db.exec(metadata174 ? metadata174Schema : `PRAGMA user_version=156;
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
    const discovered = discoverSources(app.config);
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
    const discovered = discoverSources(app.config);
    assert.equal(discovered.roster[0].eligible, false);
    assert.equal(discovered.roster[0].disposition, "unmapped-workspace-type");
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
    assert.equal(facts.metrics.find(metric => metric.dimension === "accuracy").reason, "unsupported-check");
    const unchanged = await collector.collectNow();
    assert.equal(unchanged.check.changes.added, 0);
    assert.equal(unchanged.check.changes.updated, 0);
    app.db.exec("PRAGMA user_version=167");
    assert.equal(discoverSources(app.config).schemaVersion, 167, "Version-only changes still require the same validated mapping");
    app.db.exec("PRAGMA user_version=166; ALTER TABLE sessions RENAME COLUMN execution_location TO removed_location");
    assert.throws(() => discoverSources(app.config), /Unsupported sessions mapping/);
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
    const app = await installation(t);
    for (let i = 0; i < 90; i++) await logFor(app, app.session());
    const collector = await createCollector(app.context);
    app.cleanup.push(() => collector.close());
    await collector.configure({ ...app.config, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    const deadline = Date.now() + 9000;
    let observed;
    while (Date.now() < deadline) {
        observed = await collector.status();
        if (observed.state === "collecting") break;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(observed.state, "collecting", "Exercise a real already-running background cycle");
    const id = app.session();
    await logFor(app, id, [event("user.message", { content: "Synthetic source added during background cycle" }), call("new-during-cycle")]);
    const [one, two, paused] = await Promise.all([collector.collectNow(), collector.collectNow(), collector.setEnabled(false, observed.configVersion)]);
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
