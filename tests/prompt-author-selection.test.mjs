import test from "node:test";
import assert from "node:assert/strict";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { buildExportCatalog, selectExportSnapshot } from "../lib/export-selection.mjs";
import { createReportScope } from "../web/report-scope.mjs";
import { validateAnalyticsInput } from "../lib/analytics-input.mjs";
import { BoardError } from "../lib/store.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createAnalysisSlice } from "../web/client.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";

test("known Both stays distinct from All including unverified", () => {
    assert.deepEqual(promptAuthorship.selection(), ["user", "agent", "unknown"]);
    assert.deepEqual(promptAuthorship.selection(["agent", "user"]), ["user", "agent"]);
    assert.equal(promptAuthorship.selectionLabel(["user", "agent"]), "My and agent prompts");
    assert.equal(promptAuthorship.selectionLabel(), "All prompts (including unverified)");
    assert.equal(promptAuthorship.filterValue(["unknown", "agent", "user"]), undefined);
    assert.equal(promptAuthorship.filterValue(["agent", "user"]), "user,agent");
});

test("author filtering keeps complete human-origin calls, not the actor executing each call", () => {
    const own = fixture("own"), agent = fixture("agent"), unknown = fixture("unverified");
    own.userPrompt.authorship = { actor: "user", basis: "source-user" };
    agent.userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    own.toolCalls.push({ ...own.toolCalls[0], toolCallId: "own-second", startEventId: "own-second-start",
        parentToolCallId: "invented-agent-task", reportedOutcome: "failed", toolSucceeded: false });
    const records = [own, agent, unknown], before = structuredClone(records);
    const view = promptAuthors => buildActivityAnalytics(records, { layer: "tool", filters: { scope: "all", promptAuthors } });
    assert.deepEqual(view(["user"]).rows.map(row => row.toolCallId).sort(), ["own-second", "test-call-own"]);
    assert.equal(view(["agent"]).totals.count, 1);
    assert.equal(view(["user", "agent"]).totals.count, 3);
    assert.equal(view(["unknown"]).totals.count, 1, "An old human-authored string is not normalized author evidence");
    assert.equal(view(["user", "unknown"]).totals.count, 3);
    assert.equal(view(["agent", "unknown"]).totals.count, 2);
    assert.equal(view(undefined).totals.count, 4);
    assert.deepEqual(records, before);
});

test("invalid author criteria fail explicitly and canonical full-history ownership still wins aliases", () => {
    const current = fixture("current");
    current.userPrompt.sourceEventId = "shared-current-origin";
    const legacy = structuredClone(current);
    current.userPrompt.authorship = { actor: "user", basis: "source-user" };
    legacy.scenarioId = "legacy-alias"; legacy.isLegacy = true;
    const records = [legacy, current], catalog = buildExportCatalog(records);
    for (const promptAuthors of [[], ["human"], ["user", "user"], "user", null]) {
        assert.throws(() => validateAnalyticsInput({ filters: { promptAuthors } }), BoardError);
        assert.throws(() => selectExportSnapshot(records, { kind: "all", revision: 1, promptAuthors }, 1), BoardError);
    }
    const analytics = buildActivityAnalytics(records, { filters: { scope: "all", promptAuthors: ["user"] } });
    assert.equal(analytics.rows.length, 1);
    assert.equal(analytics.rows[0].scenarioId, "current");
    assert.equal(catalog.requests.length, 1);
    assert.deepEqual(catalog.requests[0].aliases.sort(), ["current", "legacy-alias"]);
    assert.equal(selectExportSnapshot(records, { kind: "selected", revision: 1, scenarioIds: ["legacy-alias"], promptAuthors: ["user"] }, 1).records.length, 1);
});

test("owner wording and chat-origin wording do not change author classification", () => {
    const own = { authorship: { actor: "user", basis: "source-user" } };
    const unknown = { text: "Agent-looking words", sourceEventId: "invented-message" };
    const chat = { sourceHost: "copilot-app", sourceSessionId: "invented-chat", userPrompt: unknown };
    assert.equal(promptAuthorship.label(own), "My prompt");
    assert.equal(promptAuthorship.label(own, { ownerVoice: false }), "User prompt");
    assert.equal(promptAuthorship.selectionLabel(["user"]), "My prompts");
    assert.equal(promptAuthorship.selectionLabel(["user", "unknown"]), "My and unverified prompts");
    assert.equal(promptAuthorship.selectionLabel(["user"], { ownerVoice: false }), "User prompts");
    assert.equal(promptAuthorship.selectionLabel(["user", "agent"], { ownerVoice: false }), "User and agent prompts");
    assert.equal(promptAuthorship.selectionLabel(["user", "unknown"], { ownerVoice: false }), "User and unverified prompts");
    assert.equal(promptAuthorship.label(unknown, { originKind: promptAuthorship.originKind(chat) }), "Copilot chat prompt");
    assert.equal(promptAuthorship.read(unknown).actor, "unknown");
    assert.equal(promptAuthorship.label(unknown, { originKind: promptAuthorship.originKind({ ...chat, sourceHost: "unverified" }) }), "Prompt");
});

test("explicit report author choice narrows the base scope without discarding hidden selections", () => {
    const own = fixture("own"), agent = fixture("agent"), unknown = fixture("unverified");
    own.userPrompt.authorship = { actor: "user", basis: "source-user" };
    agent.userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    const records = [own, agent, unknown], selected = records.map(record => record.scenarioId);
    const catalog = buildExportCatalog(records), scopes = createReportScope(promptAuthorship);
    const choice = scopes.resolve(catalog, "selected", ["own"], selected, ["user"]);
    assert.deepEqual(choice.requests.map(request => request.scenarioId), ["own"]);
    assert.deepEqual(choice.ids, selected, "The report keeps its full explicit base selection");
    assert.equal(choice.authorExcludedRequestGroups, 2);
    const snapshot = selectExportSnapshot(records, choice.selection(7), 7);
    assert.deepEqual(snapshot.records.map(record => record.scenarioId), ["own"]);
    assert.equal(snapshot.scope.workIqActions, 1);
    assert.equal(snapshot.scope.baseRequestGroups, 3);
    assert.deepEqual(snapshot.scope.promptAuthors, ["user"]);
    assert.equal(snapshot.scope.authorExcludedRequestGroups, 2);
    assert.equal(scopes.resolve(catalog, "selected", [], selected).requests.length, 3, "Returning to All restores the same selected groups");
});

test("one originating author is resolved before filters and shared by cards, counts and new reports", async t => {
    const user = fixture("origin-user"), agent = fixture("origin-agent");
    for (const [record, actor] of [[user, "user"], [agent, "agent"]]) {
        record.userPrompt = { ...record.userPrompt, sourceEventId: "shared-origin",
            sourceTimestamp: record.capturedAt, authorship: { actor, basis: `source-${actor}` } };
    }
    agent.toolCalls[0].toolSucceeded = false;
    agent.toolCalls[0].reportedOutcome = "failed";
    const records = [user, agent], before = structuredClone(records);
    const { context } = await privateFixture(t, records);
    const charts = createPercentageCharts({ authorship: promptAuthorship });
    const slice = createAnalysisSlice(null, null);
    for (const filters of [{}, { promptAuthors: ["unknown"] }, { outcomes: ["failure"] },
        { tools: ["workiq-fetch"], promptAuthors: ["unknown"] }]) {
        const options = { layer: "tool", filters: { scope: "all", ...filters } };
        const snapshot = await currentStatePayload(context, undefined, options);
        const accepted = slice(snapshot, options);
        assert.equal(accepted.rows.length, filters.outcomes ? 1 : 2);
        assert.ok(accepted.rows.every(row => row.promptAuthor === "unknown"));
        assert.ok(accepted.scenarios.every(record => record.userPrompt.authorship.actor === "unknown"),
            "The same accepted facts feed card and reader headings.");
        assert.deepEqual(charts.authorUsage(accepted.scenarios).rows.map(row => row.count), [0, 0, 1]);
    }
    for (const promptAuthors of [["user"], ["agent"]]) {
        assert.equal(buildActivityAnalytics(records, { filters: { scope: "all", promptAuthors } }).rows.length, 0);
    }
    const catalog = buildExportCatalog(records);
    assert.ok(catalog.requests.every(request => request.promptAuthor === "unknown"));
    const selected = selectExportSnapshot(records, { kind: "all", revision: 1, promptAuthors: ["unknown"] }, 1);
    assert.equal(selected.records.flatMap(record => record.toolCalls).length, 2);
    for (const input of [records, [...records].reverse()]) {
        const model = buildAssessmentModel({ revision: 1, pseudonymKey: "a".repeat(64), evidence: input });
        assert.deepEqual([...model.details.values()].map(detail => detail.interaction.message.authorship),
            [{ actor: "unknown", basis: "conflicting-source" }]);
    }
    const bundle = await buildSanitizedBundle(records, "a".repeat(64), {
        promptMode: "original", formats: ["html", "markdown", "json"],
    });
    assert.ok(bundle.snapshot.records.every(record =>
        record.prompts.find(prompt => prompt.kind === "origin").authorship.actor === "unknown"));
    assert.match(bundle.files["product-report.html"], /Author not verified/);
    assert.match(bundle.files["product-report.md"], /Author not verified/);
    assert.deepEqual(records, before);
});
