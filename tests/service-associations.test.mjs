import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildActivityAnalytics, buildRequestActivity, getActivityDrilldown } from "../lib/activity-analytics.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { serviceCategories, createServiceCategories } from "../lib/service-categories.mjs";
import { classifyWorkload } from "../lib/graph-history.mjs";
import { executeAction } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture } from "./helpers.mjs";
import { serviceEvidenceFixture } from "./service-evidence-fixtures.mjs";

test("service filtering retains one canonical call with multiple supported targets", () => {
    const record = serviceEvidenceFixture();
    record.toolCalls = [record.toolCalls[1]];
    record.toolCalls[0].requestArgs.entityUrls.push("/me/messages");
    const all = buildActivityAnalytics([record]);
    assert.equal(all.rows[0].workload, "Multiple workloads");
    for (const services of [["Files"], ["Mail"], ["Files", "Mail"]]) {
        const filtered = buildActivityAnalytics([record], { filters: { services } });
        assert.deepEqual(filtered.rows.map(row => row.id), all.rows.map(row => row.id));
        assert.equal(filtered.totals.count, 1);
    }
});

test("supported associations deduplicate targets and calls while legacy categories stay exclusive", () => {
    const record = serviceEvidenceFixture();
    record.toolCalls = [record.toolCalls[1]];
    record.toolCalls[0].requestArgs.entityUrls.push("/me/messages", "/me/messages");
    const before = structuredClone(record);
    const model = buildActivityAnalytics([record, structuredClone(record)]);
    const row = model.rows[0], involvement = model.serviceInvolvement;
    assert.deepEqual(row.serviceAssociation.services, ["Mail", "Files"]);
    assert.equal(row.serviceAssociation.status, "identified");
    assert.equal(involvement.definition.id, "wire-service-involvement");
    assert.equal(involvement.definition.version, 1);
    assert.equal(Object.isFrozen(involvement.definition), true);
    assert.equal(involvement.denominator, 1);
    assert.deepEqual(involvement.groups.map(group => [group.label, group.count, group.sharePercent]),
        [["Files", 1, 100], ["Mail", 1, 100]]);
    for (const group of involvement.groups) {
        assert.deepEqual(group.drilldownIds, [row.id]);
        assert.deepEqual(getActivityDrilldown(model, group.id), [row]);
    }
    assert.deepEqual(model.workloadGroups.map(group => [group.label, group.count]), [["Multiple workloads", 1]]);
    assert.equal(buildActivityAnalytics([record], { filters: { workloads: ["Files"] } }).totals.count, 0);
    assert.equal(buildActivityAnalytics([record], { filters: { services: ["Multiple workloads"] } }).totals.count, 1);
    assert.deepEqual(buildRequestActivity([record]).tool[0].serviceAssociation, row.serviceAssociation);
    assert.deepEqual(record, before);
});

test("mixed known, unsupported and unrecognized targets retain precise gaps without invented associations", () => {
    const record = serviceEvidenceFixture();
    record.toolCalls = [record.toolCalls[1]];
    record.toolCalls[0].requestArgs.entityUrls.push("/unsupported/resource", "https://untrusted.invalid/me/messages", null);
    const model = buildActivityAnalytics([record]), row = model.rows[0];
    assert.deepEqual(row.serviceAssociation.services, ["Files"]);
    assert.equal(row.serviceAssociation.status, "partial");
    assert.deepEqual(row.serviceAssociation.gaps.map(gap => gap.reason), ["unrecognized-path", "unsupported-target"]);
    assert.deepEqual(serviceCategories.evidenceGroups(model.rows).map(group => [group.evidence.reason, group.count]),
        [["unrecognized-path", 1]], "legacy reason groups count each row once; the association retains every gap");
    assert.equal(model.serviceInvolvement.missingDetailCount, 1, "gap reasons never inflate missing-call counts");
    assert.equal(buildActivityAnalytics([record], { filters: { services: ["Files"] } }).totals.count, 1);
    assert.equal(buildActivityAnalytics([record], { filters: { services: ["Files"], includeMissingService: true } }).totals.count, 1);
    assert.equal(buildActivityAnalytics([record], { filters: { services: ["Mail"] } }).totals.count, 0);
    assert.match(serviceCategories.explainRows(model.rows), /path was recorded/);
    assert.match(serviceCategories.explainRows(model.rows), /not a supported relative path/);
    assert.doesNotMatch(JSON.stringify(row.serviceAssociation), /untrusted|SHARING-TOKEN/);
    const browser = Function(`return (${createServiceCategories.toString()})()`)();
    assert.deepEqual(browser.associate(row, "tool", classifyWorkload), row.serviceAssociation);
    assert.deepEqual(browser.evidenceGroups(model.rows), serviceCategories.evidenceGroups(model.rows));
    record.toolCalls[0].requestArgs.entityUrls.shift();
    const unknown = buildActivityAnalytics([record]);
    assert.equal(unknown.rows[0].workload, "Unknown");
    assert.equal(unknown.rows[0].serviceAssociation.gaps.length, 2);
    assert.equal(serviceCategories.evidenceGroups(unknown.rows).reduce((sum, group) => sum + group.count, 0), 1);
});

test("missing-service context is explicit, removable, deduplicated and respects other filters", () => {
    const record = serviceEvidenceFixture();
    const strict = buildActivityAnalytics([record], { filters: { services: ["Files"] } });
    assert.deepEqual(strict.rows.map(row => row.toolCallId), ["service-evidence-call-1", "service-evidence-call-2"]);
    const context = buildActivityAnalytics([record], { filters: { services: ["Files"], includeMissingService: true } });
    assert.equal(context.totals.count, 5);
    assert.deepEqual(context.serviceInvolvement.selection, {
        services: ["Files"], includeMissingService: true,
        knownMatchIds: strict.rows.map(row => row.id),
        contextOnlyIds: context.rows.filter(row => !strict.rows.some(match => match.id === row.id)).map(row => row.id),
    });
    assert.equal(context.serviceInvolvement.groups.find(group => group.label === "Files").count, 2);
    assert.equal(context.serviceInvolvement.groups.find(group => group.label === "Files").sharePercent, 40);
    assert.equal(context.rows.some(row => row.tool === "workiq-get_schema"), false, "preparation is not missing-service context");
    assert.equal(buildActivityAnalytics([record], { filters: { services: ["Files"], includeMissingService: false } }).totals.count, 2);
    const failed = buildActivityAnalytics([record], { filters: { services: ["Files"], includeMissingService: true, outcomes: ["failure"] } });
    assert.equal(failed.totals.count, 1);
    assert.equal(failed.resultFacet.totals.count, 5);
    for (const filters of [{ tools: ["workiq-get_schema"] }, { projectIds: ["not-this-project"] },
        { from: "2026-10-02" }, { promptAuthors: ["agent"] }]) {
        assert.equal(buildActivityAnalytics([record], { filters: { ...filters, services: ["Files"], includeMissingService: true } }).totals.count, 0);
    }
    assert.throws(() => buildActivityAnalytics([record], { filters: { includeMissingService: "yes" } }), /includeMissingService must be boolean/);
    assert.equal(buildActivityAnalytics([record], { filters: { includeMissingService: true } }).totals.count, 6);
    assert.deepEqual(buildActivityAnalytics([]).serviceInvolvement.groups, []);
    assert.equal(buildActivityAnalytics([]).serviceInvolvement.denominator, 0);
});

test("preparation and hosted assistance keep actual purpose, outcome and target without downstream claims", () => {
    const record = serviceEvidenceFixture();
    const model = buildActivityAnalytics([record]);
    const schema = model.rows.find(row => row.tool === "workiq-get_schema");
    assert.equal(schema.serviceAssociation.status, "not-applicable");
    assert.deepEqual(schema.serviceAssociation.services, []);
    assert.deepEqual(schema.serviceAssociation.gaps, []);
    assert.match(schema.endpoint.path, /driveItem/);
    assert.equal(schema.outcome, "success");
    const ask = model.rows.find(row => row.tool === "workiq-ask");
    assert.deepEqual(ask.serviceAssociation.services, []);
    assert.equal(ask.serviceAssociation.gaps[0].reason, "hosted-routing");
    assert.equal(model.rows.find(row => row.toolCallId.endsWith("-4")).serviceAssociation.gaps[0].reason, "missing-target");
    record.toolCalls = [{ ...record.toolCalls[0], tool: "workiq-retrieve", requestArgs: { query: "mail files calendar" } }];
    const retrieval = buildActivityAnalytics([record]).rows[0];
    assert.deepEqual(retrieval.serviceAssociation.services, ["Search"]);
    assert.equal(retrieval.serviceAssociation.basis, "tool-purpose");
});

test("requested capability scope cannot change canonical service membership or frozen facts", () => {
    const record = serviceEvidenceFixture();
    record.toolCalls = [{ ...record.toolCalls[0], tool: "workiq-retrieve", requestArgs: {
        query: "Invented query", capabilities: [{ name: "TeamsMessages" }, { name: "Email" }], strategy: "grounding",
    } }];
    const original = structuredClone(record);
    const analytics = buildActivityAnalytics([record]);
    const bytes = JSON.stringify(analytics);
    const facts = () => buildReportFacts([record], { revision: 0, pseudonymKey: "d".repeat(64) },
        { preparedAt: "2026-10-01T12:30:00.000Z" }).facts;
    const frozenBytes = JSON.stringify(facts());
    assert.equal(serviceCategories.requestedSearchScope(record.toolCalls[0]).label, "Requested scope: Teams messages and email");
    assert.equal(JSON.stringify(buildActivityAnalytics([record])), bytes);
    assert.equal(JSON.stringify(facts()), frozenBytes);
    assert.equal(analytics.serviceInvolvement.definition.version, 1);
    assert.deepEqual(analytics.rows[0].serviceAssociation.services, ["Search"]);
    assert.equal(analytics.rows[0].serviceAssociation.basis, "tool-purpose");
    assert.equal(buildActivityAnalytics([record], { filters: { services: ["Search"] } }).totals.count, 1);
    for (const service of ["Teams", "Mail"]) assert.equal(buildActivityAnalytics([record], { filters: { services: [service] } }).totals.count, 0);
    assert.deepEqual(record, original);
    const conflicting = structuredClone(record);
    conflicting.toolCalls[0].requestedApiPath = "/me/drive/root";
    assert.deepEqual(serviceCategories.requestedSearchScope(conflicting.toolCalls[0]), serviceCategories.requestedSearchScope(record.toolCalls[0]));
    assert.deepEqual(buildActivityAnalytics([conflicting]).rows[0].serviceAssociation.services, ["Files"],
        "Requested capability scope neither replaces nor adds to a different recorded target");
});

test("returned results match only their own supported target, never parent multi-target positions or schema arguments", () => {
    const record = serviceEvidenceFixture();
    record.toolCalls = [record.toolCalls[1], record.toolCalls[5]];
    record.toolCalls[0].requestArgs.entityUrls.push("/me/messages");
    record.toolCalls[0].apiResults = [
        { index: 0, statusCode: 200, path: "/me/messages" },
        { index: 1, statusCode: 404, path: "/me/drive/root" },
        { index: 0, statusCode: 200 },
    ];
    record.toolCalls[1].apiResults = [{ index: 0, statusCode: 400 }, { index: 1, statusCode: 200, path: "/me/events" }];
    const all = buildActivityAnalytics([record], { layer: "reported-api" });
    assert.deepEqual(all.rows.map(row => row.serviceAssociation.services), [["Mail"], ["Files"], [], [], ["Calendar"]]);
    assert.equal(all.rows[2].serviceAssociation.gaps[0].reason, "unattributed-result");
    assert.equal(all.rows[3].serviceAssociation.gaps[0].reason, "missing-target");
    for (const [service, index] of [["Mail", 0], ["Files", 1], ["Calendar", 4]]) {
        const model = buildActivityAnalytics([record], { layer: "reported-api", filters: { services: [service] } });
        assert.deepEqual(model.rows.map(row => row.id), [all.rows[index].id]);
        assert.equal(model.apiCoverage.eligibleToolCalls, 1);
        assert.equal(model.apiCoverage.callsWithNumericStatus, 1);
    }
    const context = buildActivityAnalytics([record], { layer: "reported-api", filters: { services: ["Files"], includeMissingService: true } });
    assert.equal(context.totals.count, 3);
    assert.equal(context.apiCoverage.eligibleToolCalls, 2);
    assert.ok(context.apiCoverage.returnedResultUnits >= context.apiCoverage.selectedResultUnits);
    assert.equal(buildActivityAnalytics([record], { layer: "http" }).totals.count, 0);
});

test("association enrichment preserves published category-v3 frozen facts and canonical membership bytes", () => {
    const record = serviceEvidenceFixture(), original = structuredClone(record);
    record.toolCalls[1].requestArgs.entityUrls.push("/me/messages");
    const { facts } = buildReportFacts([record], { revision: 0, pseudonymKey: "d".repeat(64) }, { preparedAt: "2026-10-01T12:30:00.000Z" });
    const bytes = JSON.stringify({ memberships: facts.memberships, recordedOutcomes: facts.recordedOutcomes, patterns: facts.patterns });
    // Captured from published 1c60c5a before association enrichment, using only this invented fixture.
    assert.equal(createHash("sha256").update(bytes).digest("hex"), "66274931598155c3e063cf9bb197bd098593452f2d4ea09db5616660c1199c61");
    assert.equal(serviceCategories.definition.version, 3);
    assert.ok(facts.patterns.every(entry => entry.pattern.version === 3));
    record.toolCalls[1].requestArgs.entityUrls.pop();
    assert.deepEqual(record, original);
});

test("normal snapshot and analytics consumers receive matching association scope without rewriting stored facts", async t => {
    const record = serviceEvidenceFixture();
    record.toolCalls[1].requestArgs.entityUrls.push("/me/messages");
    const { context } = await privateFixture(t, [record]);
    const before = JSON.stringify(await loadBoardState(context));
    const strictInput = { filters: { services: ["Files"] } };
    const contextInput = { filters: { services: ["Files"], includeMissingService: true } };
    const strict = await executeAction(context, null, null, "get_snapshot", strictInput);
    const explicitStrict = await executeAction(context, null, null, "get_analytics", { filters: { services: ["Files"], includeMissingService: false } });
    const withContext = await executeAction(context, null, null, "get_snapshot", contextInput);
    const analytics = await executeAction(context, null, null, "get_analytics", contextInput);
    assert.equal(strict.analytics.totals.count, 2);
    assert.deepEqual(explicitStrict, strict.analytics);
    assert.equal(withContext.analytics.totals.count, 5);
    assert.deepEqual(analytics, withContext.analytics);
    assert.deepEqual(withContext.analytics.serviceInvolvement.selection.knownMatchIds, strict.analytics.rows.map(row => row.id));
    assert.deepEqual(withContext.requestActivity.tool.map(row => row.id), buildActivityAnalytics([record]).rows.map(row => row.id));
    assert.deepEqual(withContext.requestActivity.tool.find(row => row.toolCallId.endsWith("-1")).serviceAssociation.services, ["Mail", "Files"]);
    assert.deepEqual(strict.assessment, withContext.assessment);
    assert.deepEqual(strict.exportCatalog, withContext.exportCatalog);
    await assert.rejects(executeAction(context, null, null, "get_snapshot", { filters: { includeMissingService: "true" } }), error => error.status === 400);
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
});
