import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectGraphCommand, extractGraphActivities, projectGraphActivity, validateGraphActivity, classifyWorkload } from "../lib/graph-history.mjs";
import { scanRecordedGraphHistory, mergeGraphScenarios } from "../lib/graph-history-io.mjs";
import { buildActivityAnalytics, getActivityDrilldown } from "../lib/activity-analytics.mjs";
import { buildAnalytics as core, OUTCOMES } from "../lib/analytics.mjs";
import { interactionModelFact } from "../lib/interaction-model.mjs";

// Synthetic records only; never import this file's fixtures into real user state.
const source = { sessionId: "11111111-1111-4111-8111-111111111111", projectId: "project-test", eligible: true, checkedAt: "2026-10-04T00:00:00Z", archiveEvidence: { archived_at: null, workspaces: [] } };
const stamp = (n) => `2026-10-01T00:${String(n).padStart(2, "0")}:00Z`;
const prompt = (n = 0, text = "Synthetic Office scenario") => ({ id: `prompt-${n}`, type: "user.message", timestamp: stamp(n), data: { content: text } });
const start = (n, command, tool = "powershell", extra = {}) => ({ id: `start-${n}`, type: "tool.execution_start", timestamp: stamp(n), data: { toolCallId: `call-${n}`, toolName: tool, arguments: { command }, ...extra } });
const finish = (n, output, success = true) => ({ id: `end-${n}`, type: "tool.execution_complete", timestamp: new Date(Date.parse(stamp(n)) + 1000).toISOString(), data: { toolCallId: `call-${n}`, success, result: { content: output } } });
const extract = (events) => extractGraphActivities(events, source);
const graphScenario = (command = "curl 'https://graph.microsoft.com/v1.0/me/messages'", status = "HTTP/2 200") => extract([prompt(), start(2, command), finish(2, status)]).scenarios[0];
const work = (id, target, extras = {}) => ({ tool: "workiq-fetch", toolCallId: id, startEventId: `e-${id}`, toolSucceeded: true, reportedOutcome: "succeeded", requestArgs: { entityUrls: [target] }, startedAt: stamp(1), apiResults: [], ...extras });
const scenario = (calls, extras = {}) => ({ scenarioId: "s", sourceSessionId: source.sessionId, projectId: source.projectId, workloadKind: "recorded-history", toolCalls: calls, ...extras });

test("Graph history preserves mode-free host authorship when merging an exact retained prompt", async t => {
    const root = await mkdtemp(path.join(tmpdir(), "wire-author-graph-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const folder = path.join(root, source.sessionId);
    await mkdir(folder);
    const user = prompt();
    Object.assign(user.data, { messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle",
        transformedContent: `<current_datetime>${user.timestamp}</current_datetime>\n\n${user.data.content}` });
    const events = [{ id: "startup", type: "session.start", data: { sessionId: source.sessionId, version: 1 } },
        user, start(1, "curl 'https://graph.microsoft.com/v1.0/me/messages'"), finish(1, "HTTP/2 200")];
    await writeFile(path.join(folder, "events.jsonl"), events.map(value => JSON.stringify(value)).join("\n"));
    const scan = await scanRecordedGraphHistory({ sources: [source], sessionRoot: root, since: "2026-10-01", until: "2026-10-02" });
    const record = scan.scenarios[0];
    assert.deepEqual(record.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    const previous = { ...record, userPrompt: { ...record.userPrompt,
        authorship: { actor: "unknown", basis: "invalid-source" }, authorshipVersion: 4 } };
    const merged = mergeGraphScenarios([previous], scan.scenarios)[0];
    assert.deepEqual(merged.userPrompt, record.userPrompt);
    assert.deepEqual(merged.graphActivities, record.graphActivities);
    assert.deepEqual(mergeGraphScenarios([previous], [{ ...record, sourceSessionId: "22222222-2222-4222-8222-222222222222" }])[0].userPrompt, previous.userPrompt);
    for (const mismatch of [{ sourceTimestamp: stamp(4) }, { text: "Invented replacement prompt" }]) {
        const changed = { ...record, userPrompt: { ...record.userPrompt, ...mismatch } };
        assert.deepEqual(mergeGraphScenarios([record], [changed])[0].userPrompt,
            { ...record.userPrompt, authorship: { actor: "unknown", basis: "conflicting-source" } });
    }
});

for (const prefix of ["complete", "malformed", "oversized", "tail", "malformed-after-first", "windowed"]) {
    test(`agent-created Graph history preserves first-message context with a ${prefix} prefix`, async t => {
        const root = await mkdtemp(path.join(tmpdir(), "wire-graph-creator-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const folder = path.join(root, source.sessionId);
        await mkdir(folder);
        const created = { ...source, promptCreation: { actor: "agent", creatorSessionId: "22222222-2222-4222-8222-222222222222" } };
        const first = prompt(), followup = prompt(2), relayed = prompt(4);
        for (const event of [first, followup, relayed]) Object.assign(event.data, {
            messageId: "00000000-0000-4000-8000-000000000001", delivery: "idle",
            transformedContent: `<current_datetime>${event.timestamp}</current_datetime>\n\n${event.data.content}`,
        });
        relayed.data.source = "agent-invented-subscribed-sender";
        const graph = n => start(n, "curl 'https://graph.microsoft.com/v1.0/me/messages'");
        const startup = JSON.stringify({ id: "startup", type: "session.start", data: { sessionId: source.sessionId, version: 1 } });
        const beginning = [first, graph(1)], ending = [followup, graph(3), relayed, graph(5)];
        const padding = JSON.stringify({ id: "ignored", type: "session.info", data: { content: "x".repeat(4000) } });
        const before = prefix === "malformed" ? ["invented invalid JSON"] : prefix === "oversized" ? [padding] : [];
        const middle = prefix === "tail" ? [padding] : prefix === "malformed-after-first" ? ["invented invalid JSON"] : [];
        const text = [startup, ...before, ...beginning.map(JSON.stringify), ...middle, ...ending.map(JSON.stringify)].join("\n") + "\n";
        await writeFile(path.join(folder, "events.jsonl"), text);
        const scan = await scanRecordedGraphHistory({
            sources: [created], sessionRoot: root, since: prefix === "windowed" ? stamp(2) : "2026-10-01", until: "2026-10-02",
            ...(prefix === "oversized" ? { maxLineBytes: 1024 } : {}),
            ...(prefix === "tail" ? { maxFileBytes: Buffer.byteLength(ending.map(JSON.stringify).join("\n") + "\n") + 1 } : {}),
        });
        const prompts = new Map(scan.scenarios.map(record => [record.userPrompt.sourceEventId, record.userPrompt.authorship]));
        if (!["tail", "windowed"].includes(prefix)) assert.deepEqual(prompts.get(first.id), { actor: "unknown", basis: "missing-source" });
        assert.deepEqual(prompts.get(followup.id), ["complete", "malformed-after-first", "windowed"].includes(prefix)
            ? { actor: "user", basis: "host-direct-input" } : { actor: "unknown", basis: "missing-source" });
        assert.deepEqual(prompts.get(relayed.id), { actor: "agent", basis: "source-agent" });
    });
}

test("Graph-only historical import retains original model metadata without changing its timing or result projections", async t => {
    const root = await mkdtemp(path.join(tmpdir(), "wire-model-graph-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const folder = path.join(root, source.sessionId);
    await mkdir(folder);
    const user = prompt(); user.data.messageId = "model-prompt";
    const response = { id: "model-answer", type: "assistant.message", timestamp: stamp(3), data: {
        model: "original-graph-model", apiCallId: "graph-model-request", originatingMessageId: "model-prompt",
        turnId: "model-turn", phase: "final_answer", content: "PRIVATE_GRAPH_MODEL_ANSWER", toolRequests: [],
    } };
    const events = [{ id: "startup", type: "session.start", data: { sessionId: source.sessionId } },
        user, start(1, "curl 'https://graph.microsoft.com/v1.0/me/messages'"), finish(1, "HTTP/2 200"),
        response, { id: "turn-end", type: "assistant.turn_end", timestamp: stamp(4), data: { turnId: "model-turn" } }];
    await writeFile(path.join(folder, "events.jsonl"), events.map(value => JSON.stringify(value)).join("\n"));
    const scan = await scanRecordedGraphHistory({ sources: [source], sessionRoot: root, since: "2026-10-01", until: "2026-10-02" });
    assert.equal(interactionModelFact(scan.scenarios[0]).value, "original-graph-model");
    assert.equal(scan.scenarios[0].responseTiming.status, "unavailable", "model capture must not change the legacy timing projection");
    assert.equal(scan.coverage.outputVisibleStatuses, 1);
    assert.doesNotMatch(JSON.stringify(scan.scenarios), /PRIVATE_GRAPH_MODEL_ANSWER/);
    const previous = { ...scan.scenarios[0] }; delete previous.originalModelEvidence;
    assert.equal(interactionModelFact(mergeGraphScenarios([previous], scan.scenarios)[0]).value, "original-graph-model");
});

function invariant(a) {
    assert.equal(OUTCOMES.reduce((n, o) => n + a.totals[o], 0), a.totals.count);
    assert.equal(a.groups.reduce((n, g) => n + g.total, 0), a.totals.count);
    assert.equal(a.workloadGroups.reduce((n, g) => n + g.total, 0), a.totals.count);
    assert.equal(a.timeSeries.points.reduce((n, g) => n + g.total, 0) + a.timeSeries.undatedCount, a.totals.count);
    assert.equal(a.visibleGroups.reduce((n, g) => n + g.total, 0) + (a.otherGroup?.total ?? 0), a.totals.count);
}

test("synthetic: literal REST/curl/JS/Python request intent preserves method and Office resource", () => {
    for (const [command, method, workload] of [
        ["curl -X POST 'https://graph.microsoft.com/v1.0/me/sendMail'", "POST", "Mail"],
        ["Invoke-RestMethod -Method GET -Uri 'https://graph.microsoft.com/beta/me/calendarView'", "GET", "Calendar"],
        ["node -e \"fetch('https://graph.microsoft.com/v1.0/me/drive/root/children')\"", "GET", "Files"],
        ["python -c \"requests.get('https://graph.microsoft.com/v1.0/teams/team-secret/channels/channel-secret/messages')\"", "GET", "Teams"],
        ["requests.request('POST', 'https://graph.microsoft.com/v1.0/me/sendMail')", "POST", "Mail"],
        ["axios.get('https://graph.microsoft.com/v1.0/me/contacts')", "GET", "People"],
        ["Invoke-MgGraphRequest -Method GET -Uri '/v1.0/me/messages'", "GET", "Mail"],
        ["Get-MgUserCalendarView -UserId 'private-user'", "GET", "Calendar"],
        ["m365 request --url 'https://graph.microsoft.com/v1.0/me/messages' --method GET", "GET", "Mail"],
    ]) {
        const { sites } = inspectGraphCommand(command);
        assert.equal(sites.length, 1, command);
        assert.equal(sites[0].evidenceLevel, "requested-direct-graph");
        assert.equal(sites[0].method, method);
        assert.equal(classifyWorkload(sites[0].endpoint), workload);
        assert.doesNotMatch(JSON.stringify(sites), /team-secret|channel-secret|private-user/);
    }
});

test("synthetic: no code fixture/read/diff becomes an execution; unresolved and conditional routes stay uncertain", () => {
    for (const command of [
        "git diff -- src/api.ts # https://graph.microsoft.com/v1.0/me/messages",
        "Get-Content 'source' # https://graph.microsoft.com/v1.0/me/messages",
        "const testTransport = () => fetch('https://graph.microsoft.com/v1.0/me/messages')",
        "for (const item of items) fetch('https://graph.microsoft.com/v1.0/me/messages')",
        "function later() { fetch('https://graph.microsoft.com/v1.0/me/messages') }",
    ]) assert.ok(inspectGraphCommand(command).sites.every((s) => s.evidenceLevel === "code-reference"));
    assert.ok(inspectGraphCommand("Invoke-MgGraphRequest -Uri $dynamic").exclusions.includes("unresolved-sdk-or-cli-target"));
    assert.ok(inspectGraphCommand("curl $dynamic").exclusions.includes("unresolved-network-target"));
});

test("synthetic: SDK version remains unknown unless explicit; printed literal status is not a response observation", () => {
    const sites = inspectGraphCommand("import {Client} from '@microsoft/microsoft-graph-client'; client.api('/me/messages').get()").sites;
    assert.equal(sites.length, 1);
    assert.equal(sites[0].endpoint.apiVersion, null);
    assert.equal(inspectGraphCommand("import {Client} from '@microsoft/microsoft-graph-client'; client.api('/beta/me/messages').get()").sites[0].endpoint.apiVersion, "beta");
    const s = graphScenario("fetch('https://graph.microsoft.com/v1.0/me/messages'); console.log('statusCode: 200')", "statusCode: 200");
    assert.equal(s.graphActivities[0].httpStatus, null);
});

test("synthetic: visible HTTP status only when unambiguous actual request output, never tool success", () => {
    const s = graphScenario();
    assert.equal(s.graphActivities[0].httpStatus, 200);
    assert.equal(s.graphActivities[0].evidenceLevel, "output-visible-http");
    assert.equal(s.graphActivities[0].requestCount, null);
    for (const output of ["success=true", '{"status":200}', "HTTP/1.1 301\nHTTP/2 200", "diff --git a b\n+ statusCode: 200", "fixture statusCode: 200"]) {
        assert.equal(graphScenario(undefined, output).graphActivities[0].httpStatus, null);
    }
    const batch = graphScenario("curl 'https://graph.microsoft.com/v1.0/me/messages'; curl 'https://graph.microsoft.com/v1.0/me/events'");
    assert.equal(batch.graphActivities.length, 2);
    assert.ok(batch.graphActivities.every((a) => a.httpStatus === null));
    assert.equal(core([s], { layer: "http" }).totals.count, 0);
});

test("synthetic: failed Work IQ then Graph is possible fallback, not proven cause; later completion not earlier failure", () => {
    const events = [prompt(), start(1, "", "workiq-fetch"), finish(1, "failure", false), start(2, "curl 'https://graph.microsoft.com/v1.0/me/messages'"), finish(2, "statusCode: 403", false)];
    const activity = extract(events).scenarios[0].graphActivities[0];
    assert.equal(activity.fallback.association, "same-prompt-after-failure");
    assert.equal(activity.fallback.causeProven, false);
    assert.deepEqual(activity.fallback.precedingWorkIqCallIds, ["call-1"]);
    const late = events.map((e) => e.id === "end-1" ? { ...e, timestamp: stamp(3) } : e);
    assert.equal(extract(late).scenarios[0].graphActivities[0].fallback.association, "same-prompt-sequence");
    const transitioned = [prompt(), start(1, "", "workiq-fetch"), finish(1, "failure", false), prompt(2, "WorkIQ failed; switch to Graph instead."), start(3, "curl 'https://graph.microsoft.com/v1.0/me/messages'")];
    assert.equal(extract(transitioned).scenarios[0].graphActivities[0].fallback.association, "explicit-transition");
});

test("synthetic: temporal association requires prompt/nearby sequence and never upgrades code intent", () => {
    const events = [prompt(), start(1, "", "workiq-fetch"), finish(1, "failure", false), prompt(2), start(3, "curl 'https://graph.microsoft.com/v1.0/me/messages'")];
    assert.equal(extract(events).scenarios[0].graphActivities[0].fallback.association, "none");
    const code = extract([prompt(), start(1, "", "workiq-fetch"), finish(1, "", false), start(2, "git diff # https://graph.microsoft.com/v1.0/me/messages")]).scenarios[0].graphActivities[0];
    assert.equal(code.fallback.association, "none");
});

test("synthetic: recorded script source invocation is code analysis, not invented wire traffic", () => {
    const patch = "*** Begin Patch\n*** Add File: C:\\local\\probe.mjs\n+fetch('https://graph.microsoft.com/v1.0/me/messages');\n*** End Patch";
    const result = extract([prompt(), start(1, patch, "apply_patch"), start(2, "node 'C:\\local\\probe.mjs'"), finish(2, "statusCode: 200")]);
    const activities = result.scenarios[0].graphActivities;
    assert.ok(activities.some((a) => a.sourceKind === "recorded-script"));
    assert.ok(activities.every((a) => a.evidenceLevel === "code-reference" && a.httpStatus === null));
});

test("synthetic: duplicates dedup and bounded extraction fails/discloses rather than silently guessing", () => {
    const e = [prompt(), start(1, "curl 'https://graph.microsoft.com/v1.0/me/messages'")];
    assert.equal(extract([...e, ...e]).scenarios[0].graphActivities.length, 1);
    assert.throws(() => extractGraphActivities(e, source, { maxEvents: 1 }), RangeError);
    assert.equal(extractGraphActivities(e, source, { maxTextChars: 4 }).exclusions["command-text-bound"], 1);
    assert.throws(() => extractGraphActivities(e, source, { since: "invalid" }), TypeError);
});

test("synthetic: credentials are excluded, full original prompt remains local otherwise", () => {
    for (const secret of ["github_pat_" + "x".repeat(25), "xoxb-" + "x".repeat(25), "-----BEGIN PRIVATE KEY-----", "Bearer " + "x".repeat(25)]) {
        assert.equal(inspectGraphCommand(`curl 'https://graph.microsoft.com/v1.0/me/messages' # ${secret}`).sites.length, 0);
        const s = extract([prompt(0, secret), start(1, "curl 'https://graph.microsoft.com/v1.0/me/messages'")]).scenarios[0];
        assert.equal(s.userPrompt.status, "unavailable");
        assert.equal(s.userPrompt.text, null);
    }
    assert.equal(graphScenario().userPrompt.text, "Synthetic Office scenario");
    assert.ok(graphScenario().graphActivities[0].evidenceRefs.some((r) => r.role === "prompt"));
});

test("synthetic: strict projection rejects malformed enums and preserves privacy with pseudonym refs", () => {
    const a = graphScenario().graphActivities[0];
    const projected = projectGraphActivity(a, (kind, value) => value == null ? null : `${kind}-pseudonym`);
    assert.equal(projected.startedAt, undefined);
    assert.equal(projected.httpStatus, 200);
    assert.equal(projected.workload, "Mail");
    assert.doesNotMatch(JSON.stringify(projected), /11111111|Synthetic Office|start-2|call-2/);
    assert.equal(validateGraphActivity(projected), projected);
    const queryActivity = graphScenario("curl 'https://graph.microsoft.com/v1.0/me/messages?$filter=PRIVATE_QUERY'").graphActivities[0];
    const queryProjection = projectGraphActivity(queryActivity, (kind, value) => value == null ? null : `${kind}-pseudonym`);
    assert.deepEqual(queryProjection.endpoint.queryShape, ["$filter"]);
    assert.doesNotMatch(JSON.stringify(queryProjection), /PRIVATE_QUERY/);
    for (const extras of [{ evidenceLevel: "unknown" }, { tool: "custom-secret" }, { sourceKind: "hidden-traffic" }, { countUnit: "real-http" }, { fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: true } }]) {
        assert.throws(() => projectGraphActivity({ ...a, ...extras }, (k, v) => v), TypeError);
    }
});

test("synthetic: workload classification keeps Teams messages vs Mail, and batch unit remains one", () => {
    const records = [scenario([work("a", "/me/messages"), work("b", "/me/calendarView"), work("c", "/teams/secret/channels/secret/messages"), work("d", "/me/messages", { requestArgs: { entityUrls: ["/me/messages", "/me/calendarView"] } })])];
    const a = buildActivityAnalytics(records);
    assert.equal(a.totals.count, 4);
    assert.deepEqual(a.workloadGroups.map((g) => g.label).sort(), ["Calendar", "Mail", "Multiple workloads", "Teams"]);
    invariant(a);
    assert.deepEqual(a.totals, core(records).totals);
});

test("synthetic: time charts include zero gaps and unknown dates without invented activity", () => {
    const s = scenario([work("a", "/me/messages", { startedAt: "2026-10-01T23:00:00Z" }), work("b", "/me/messages", { startedAt: "2026-10-03T01:00:00Z" }), work("c", "/me/messages", { startedAt: null })]);
    const a = buildActivityAnalytics([s]);
    assert.deepEqual(a.timeSeries.points.map((p) => p.total), [1, 0, 1]);
    assert.equal(a.timeSeries.undatedCount, 1);
    assert.equal(getActivityDrilldown(a, "2026-10-01").length, 1);
    invariant(a);
    assert.equal(buildActivityAnalytics([s], { bucket: "week" }).timeSeries.points[0].date, "2026-09-28");
    assert.equal(buildActivityAnalytics([s], { bucket: "month" }).timeSeries.points[0].date, "2026-10-01");
});

test("synthetic: scope/result/workload/date/project filters and Other preserve denominator", () => {
    const records = [scenario([work("a", "/me/messages"), work("b", "/me/events", { toolSucceeded: false })]), scenario([work("c", "/me/messages")], { scenarioId: "legacy", isLegacy: true })];
    for (const options of [{ limit: 1 }, { filters: { workloads: ["Mail"] } }, { filters: { services: ["Calendar"], outcomes: ["failure"] } }, { filters: { from: "2026-10-01", projectIds: [source.projectId] } }]) invariant(buildActivityAnalytics(records, options));
    assert.equal(buildActivityAnalytics(records).totals.count, 2);
    assert.equal(buildActivityAnalytics(records, { filters: { scope: "all" } }).totals.count, 3);
    assert.equal(buildActivityAnalytics(records, { filters: { workloads: ["Mail"] } }).totals.count, 1);
    for (const options of [{ bucket: "year" }, { filters: { activityTypes: ["bad"] } }, { filters: { scope: "bad" } }, { filters: { from: "bad" } }]) assert.throws(() => buildActivityAnalytics([], options), TypeError);
});

test("synthetic: Graph direct/status subsets and code-reference are separate; metadata hidden by default", () => {
    const s = graphScenario();
    const code = graphScenario("git diff # https://graph.microsoft.com/v1.0/me/messages");
    const metadata = graphScenario("curl 'https://graph.microsoft.com/v1.0/$metadata'");
    code.scenarioId = "code";
    code.graphActivities[0].activityId += "-code";
    metadata.scenarioId = "metadata";
    metadata.graphActivities[0].activityId += "-meta";
    for (const layer of ["direct-request", "recorded-http"]) {
        const a = buildActivityAnalytics([s, code, metadata], { layer });
        assert.equal(a.totals.count, 1);
        assert.equal(a.totals.success, 1);
        assert.equal(a.exclusions.metadataExcluded, 1);
        invariant(a);
    }
    assert.equal(buildActivityAnalytics([s, code], { layer: "code-reference" }).totals.count, 1);
    assert.equal(buildActivityAnalytics([metadata], { layer: "direct-request", filters: { includeMetadata: true } }).totals.count, 1);
    assert.equal(buildActivityAnalytics([s], { layer: "http" }).totals.count, 0);
});

test("synthetic: API known-result coverage survives workload slicing; durations not copied", () => {
    const records = [scenario([
        work("a", "/me/messages", { durationMs: 100, apiResults: [{ index: 0, statusCode: 200 }] }),
        work("b", "/me/messages"), work("c", "/me/calendarView", { apiResults: [{ index: 0, statusCode: 403 }] }),
    ])];
    const a = buildActivityAnalytics(records, { layer: "reported-api", filters: { workloads: ["Mail"] } });
    assert.equal(a.totals.count, 1);
    assert.equal(a.totals.duration.sampleCount, 0);
    assert.equal(a.apiCoverage.eligibleToolCalls, 2);
    assert.equal(a.apiCoverage.callsWithoutNumericStatus, 1);
    invariant(a);
});

test("synthetic: journeys carry source refs and keep causality unproven", () => {
    const events = [prompt(), start(1, "", "workiq-fetch"), finish(1, "", false), start(2, "curl 'https://graph.microsoft.com/v1.0/me/messages'")];
    const a = buildActivityAnalytics(extract(events).scenarios, { layer: "direct-request" });
    assert.equal(a.journeys[0].association, "same-prompt-after-failure");
    assert.equal(a.journeys[0].causeProven, false);
    assert.equal(getActivityDrilldown(a, a.journeys[0].id).length, 1);
});

test("synthetic: scanner uses only explicit source paths; no historical command runs; partial-source merge preserves other data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workiq-graph-test-"));
    try {
        const folder = path.join(root, source.sessionId);
        await mkdir(folder);
        const events = [{ id: "startup", type: "session.start", data: { sessionId: source.sessionId } }, prompt(), start(1, "curl 'https://graph.microsoft.com/v1.0/me/messages'"), finish(1, "HTTP/2 200")];
        await writeFile(path.join(folder, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
        const scan = await scanRecordedGraphHistory({ sources: [source], sessionRoot: root, since: "2026-10-01", until: "2026-10-02" });
        assert.equal(scan.coverage.requestedDirectSites, 1);
        assert.equal(scan.coverage.outputVisibleStatuses, 1);
        assert.equal(scan.coverage.sourcesScanned, 1);
        const existing = [{ scenarioId: "retained", sourceSessionId: "elsewhere", graphActivities: ["retain"] }];
        assert.deepEqual(mergeGraphScenarios(existing, scan.scenarios)[0].graphActivities, ["retain"]);
        await assert.rejects(scanRecordedGraphHistory({ sources: [{ ...source, eligible: false }], sessionRoot: root, since: "2026-10-01", until: "2026-10-02" }), /explicit eligible/);
    } finally { await rm(path.join(root, source.sessionId, "events.jsonl")); await rmdir(path.join(root, source.sessionId)); await rmdir(root); }
});
