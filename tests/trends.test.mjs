import test from "node:test";
import assert from "node:assert/strict";
import { buildTrends } from "../lib/trends.mjs";
import { fixture } from "./helpers.mjs";
import { modelRecords } from "./model-widget-fixture.mjs";

const query = { expectedRevision: 7, from: "2026-03-01", to: "2026-03-30",
    filters: {}, timeContext: { timeZone: "America/New_York", locale: "en-US" } };
function data() {
    const first = fixture("cedar-files"), second = fixture("cedar-mail");
    for (const [index, record] of [first, second].entries()) {
        record.userPrompt.sourceEventId = `origin-${index}`;
        record.userPrompt.authorship = index ? { actor: "agent", basis: "source-agent" } : { actor: "user", basis: "source-user" };
        Object.assign(record.toolCalls[0], { startedAt: "2026-03-08T05:30:00Z", completedAt: "2026-03-08T05:30:01Z", durationMs: 1000 });
    }
    first.toolCalls[0].requestArgs.entityUrls = ["/me/drive/root", "/me/messages"];
    first.toolCalls.push({ ...structuredClone(first.toolCalls[0]), toolCallId: "late-call", startEventId: "late-start",
        startedAt: "2026-03-09T03:59:59Z", completedAt: null, durationMs: null },
    { ...structuredClone(first.toolCalls[0]), toolCallId: "next-day", startEventId: "next-start",
        startedAt: "2026-03-09T04:00:00Z", completedAt: null, durationMs: null });
    second.toolCalls[0].tool = "workiq-retrieve";
    second.toolCalls[0].requestArgs = {};
    second.toolCalls[0].requestedApiPath = null;
    second.toolCalls[0].apiResults = [{ index: 0, statusCode: 403 }];
    const undated = fixture("undated");
    const duplicate = structuredClone(first); duplicate.scenarioId = "old-copy"; duplicate.isLegacy = true;
    return [first, second, undated, duplicate];
}
const run = (records = data(), changes = {}, stateChanges = {}) => buildTrends({ revision: 7, ...stateChanges },
    { ...query, ...changes }, { records, now: "2026-04-01T00:00:00Z" });

test("daily Trends deduplicates calls and originating interactions without borrowing capture timestamps", () => {
    const result = run();
    assert.equal(result.days.length, 30);
    assert.equal(result.totals.calls, 4);
    assert.equal(result.totals.interactions, 2);
    assert.equal(result.coverage.undatedCalls, 1);
    const sunday = result.days.find(day => day.date === "2026-03-08"), monday = result.days.find(day => day.date === "2026-03-09");
    assert.equal(sunday.calls, 3);
    assert.equal(sunday.interactions, 2);
    assert.equal(monday.calls, 1);
    assert.equal(monday.interactions, 1);
    assert.equal(result.totals.timedCalls, 2);
    assert.equal(result.days[0].values.authors[0].percent, null);
});

test("call composition, interaction reach, service overlap and API errors retain separate denominators", () => {
    const day = run().days.find(day => day.date === "2026-03-08");
    const fetch = day.values.tools.find(value => value.id === "workiq-fetch");
    assert.equal(fetch.percent, 200 / 3);
    assert.equal(fetch.reach, 50);
    assert.equal(fetch.calls, 2);
    assert.equal(fetch.interactions, 1);
    assert.equal(day.values.services.find(value => value.id === "Files").count, 2);
    assert.equal(day.values.services.find(value => value.id === "Mail").count, 2);
    assert.equal(day.values.problems[0].count, 1);
    assert.equal(day.values.problems[0].failedCalls, 0);
    assert.equal(day.values.problems[0].apiErrorCalls, 1);
    assert.equal(day.values.problems[0].percent, 50);
});

test("cohort filtering retains every day and does not expand exact member identities", () => {
    const result = run(data(), { filters: { author: "user", service: "Files" } });
    assert.equal(result.days.length, 30);
    assert.equal(result.totals.calls, 3);
    assert.equal(result.totals.interactions, 1);
    assert.equal(result.days[7].values.tools.find(value => value.id === "workiq-fetch").reach, 100);
    assert.deepEqual(result.days[7].values.authors.find(value => value.id === "user").scenarioIds, ["cedar-files"]);
    assert.equal(result.days[7].values.authors.find(value => value.id === "agent").count, 0);
});

test("a long custom range pages daily values without changing full-period totals", () => {
    const first = run(data(), { from: "2025-01-01", to: "2026-03-30" });
    const later = run(data(), { from: "2025-01-01", to: "2026-03-30", offset: 360 });
    assert.equal(first.days.length, 90);
    assert.equal(later.days[0].date, "2025-12-27");
    assert.deepEqual(later.totals, first.totals);
    assert.equal(later.window.totalDays, 454);
});

test("Trends refuses stale revisions, invalid ranges, cleanup and unsupported source units", () => {
    assert.throws(() => run(data(), { expectedRevision: 6 }), /Stored activity changed/);
    assert.throws(() => run(data(), { from: "2026-03-31" }), /Start date/);
    assert.throws(() => run(data(), {}, { deletion: { pending: {} } }), /cleanup/);
    assert.throws(() => run(data(), { filters: { author: "inferred" } }), /supported/);
    const native = { recordKind: "native-conversation", sourceHost: "microsoft-365" };
    assert.equal(run([native]).totals.calls, 0);
});

test("automatic highlights require repeated comparable support and distinguish percentage points", () => {
    const records = [];
    for (let day = 1; day <= 3; day++) for (let n = 0; n < 6; n++) {
        const record = fixture(`suggestion-${day}-${n}`);
        record.userPrompt.sourceEventId = record.scenarioId;
        const agent = n < day;
        record.userPrompt.authorship = { actor: agent ? "agent" : "user", basis: agent ? "source-agent" : "source-user" };
        record.toolCalls[0].startedAt = `2026-03-0${day}T12:00:00Z`;
        records.push(record);
    }
    const result = run(records);
    const author = result.suggestions.find(value => value.family === "authors");
    assert.equal(author.unit, "percentage-points");
    assert.ok(Math.abs(Math.abs(author.difference) - 100 / 3) < 1e-10);
    assert.deepEqual(run(records.slice(0, 5)).suggestions, []);
    assert.deepEqual(run(records, {}, { importCoverage: { roster: [{ sessionId: records[0].sourceSessionId, eligible: true }] } }).suggestions, [],
        "Pending history cannot become a promoted change");
});

test("model provenance, missing names and overlapping models reuse the existing qualified projection", () => {
    const result = run(modelRecords(), { from: "2026-09-01", to: "2026-10-31" });
    assert.equal(result.totals.interactions, 9);
    assert.deepEqual(result.totals.modelCoverage, { recorded: 3, partial: 1, unavailable: 2, unverified: 2, conflicting: 1 });
    assert.ok(result.totals.values.models.some(value => value.count === 2));
    assert.equal(result.totals.missingModels, 5);
    assert.doesNotMatch(JSON.stringify(result.definitions.models), /not-an-original-model|current-default|conflicting-model/);
});

test("saved-chat coverage stays source-wide and does not invent affected dates or leak diagnostics", () => {
    const completeRows = run();
    assert.equal(completeRows.coverage.historySummary, null);
    const roster = [{ sessionId: "outside-selected-population", eligible: true, error: "PRIVATE_ERROR", errorCode: "ENOENT",
        lastAttemptAt: "2025-01-01T00:00:00Z" }];
    const result = run(data(), {}, { importCoverage: { roster } });
    assert.deepEqual(result.totals, completeRows.totals);
    assert.deepEqual(result.days, completeRows.days);
    assert.deepEqual(result.coverage.historySummary, { scope: "saved-chats", affectedDates: "unknown",
        unreadableChats: 1, limitedChats: 0, pendingChats: 0, reasons: { missing: 1 } });
    const filtered = run(data(), { filters: { author: "agent" } }, { importCoverage: { roster } });
    assert.deepEqual(filtered.coverage.historySummary, result.coverage.historySummary);
    const pending = run(data(), {}, { importCoverage: { roster: [{ sessionId: "unread", eligible: true }] } });
    assert.equal(pending.coverage.historySummary.pendingChats, 1);
    assert.equal(pending.coverage.historySummary.unreadableChats, 0);
    assert.doesNotMatch(JSON.stringify(result.coverage), /PRIVATE_ERROR|outside-selected-population/);
});
