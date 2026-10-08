import test from "node:test";
import assert from "node:assert/strict";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture } from "./helpers.mjs";
import { buildExportCatalog, selectExportSnapshot } from "../lib/export-selection.mjs";
import { createReportScope } from "../web/report-scope.mjs";
import { validateAnalyticsInput } from "../lib/analytics-input.mjs";
import { BoardError } from "../lib/store.mjs";

test("known Both stays distinct from All including unverified", () => {
    assert.deepEqual(promptAuthorship.selection(), ["user", "agent", "unknown"]);
    assert.deepEqual(promptAuthorship.selection(["agent", "user"]), ["user", "agent"]);
    assert.equal(promptAuthorship.selectionLabel(["user", "agent"]), "Your and agent prompts");
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
    const current = fixture("current"), legacy = structuredClone(current);
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
    assert.equal(promptAuthorship.label(own), "Your prompt");
    assert.equal(promptAuthorship.label(own, { ownerVoice: false }), "User prompt");
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
