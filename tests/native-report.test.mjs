import test from "node:test";
import assert from "node:assert/strict";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { freezeEvaluationFacts, adaptEvaluationReport } from "../lib/report-facts.mjs";
import { assertProjectedBundle } from "../lib/privacy.mjs";
import { createHash } from "node:crypto";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { renderHtmlReport, renderMarkdownReport } from "../lib/product-report.mjs";
import { matrixRecords } from "./report-evidence-matrix-fixtures.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";

const key = "a".repeat(64);
const preparedAt = "2026-10-11T12:00:00.000Z";
const freeze = records => buildReportFacts(records, { revision: 1, pseudonymKey: key, evidence: records }, { preparedAt }).facts;

test("new frozen review statuses bind closed, content-free reasons to exact selected tool memberships", () => {
    const records = matrixRecords("frozen-reasons", ["failure", "failure", "success"], { groups: 3 });
    records[0].toolCalls[0].failureEvidence = {
        version: 1, reason: "error-code-recorded", messageStatus: "text-excluded",
        messageSignal: "workiq-sign-in-required", privateMessage: "PRIVATE_ERROR_MUST_NOT_ESCAPE",
    };
    delete records[0].toolCalls[0].completionEventId;
    const before = structuredClone(records), facts = freeze(records);
    assert.equal(facts.reviewStatuses.length, 3);
    assert.deepEqual(facts.reviewStatuses.map(item => item.interactionRef), facts.memberships.map(item => item.interactionRef));
    assert.match(JSON.stringify(facts.reviewStatuses), /workiq-sign-in-required/);
    assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_ERROR_MUST_NOT_ESCAPE/);
    assert.equal(facts.metrics.find(metric => metric.checkId === "recorded-tool-success").counts.unassessed, 1);
    assert.deepEqual(records, before);
    const legacy = structuredClone(facts);
    delete legacy.reviewStatuses;
    delete legacy.serviceInvolvement;
    assert.doesNotThrow(() => freezeEvaluationFacts(legacy));
    const identity = { bundleId: "export-frozen-fixture", snapshotHash: "b".repeat(64), disclosureReviewed: true };
    assert.deepEqual(adaptEvaluationReport(facts, identity), adaptEvaluationReport(legacy, identity),
        "New content-free display facts must not change existing factual comparisons");
    for (const change of [
        value => value.reviewStatuses.push(value.reviewStatuses[0]),
        value => { value.reviewStatuses[0].interactionRef = "interaction-" + "f".repeat(32); },
        value => { value.reviewStatuses[0].reviewStatus.execution.privateText = "not permitted"; },
        value => { value.reviewStatuses[0].reviewStatus.execution.causes[0].cause = "guessed-document-missing"; },
        value => { value.reviewStatuses[0].reviewStatus.execution = { calls: 1, succeeded: 1, failed: 0, other: 0, causes: [] }; },
    ]) {
        const invalid = structuredClone(facts);
        change(invalid);
        assert.throws(() => freezeEvaluationFacts(invalid));
    }
});

test("partial saved reason coverage is bounded and explicit; snapshot/manifest hashes include new facts", async () => {
    const records = matrixRecords("partial-status", ["failure", "success"], { groups: 2 });
    const facts = structuredClone(freeze(records));
    facts.reviewStatuses = facts.reviewStatuses.slice(0, 1);
    assert.doesNotThrow(() => freezeEvaluationFacts(facts));
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["json", "markdown"] },
        undefined, undefined, facts);
    assert.match(bundle.files["product-report.md"], /context covers 1 of 2 requests and 1 of 2 calls/);
    const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    assert.equal(manifest.evaluationFactsHash, hash(bundle.snapshot.evaluationFacts));
    assert.deepEqual(manifest.evaluationFacts.reviewStatuses, facts.reviewStatuses);
    assert.deepEqual(manifest.evaluationFacts.serviceInvolvement, facts.serviceInvolvement);
    const removed = structuredClone(bundle.snapshot.evaluationFacts);
    delete removed.reviewStatuses;
    delete removed.serviceInvolvement;
    assert.notEqual(hash(removed), manifest.evaluationFactsHash);
    assert.doesNotThrow(() => assertProjectedBundle(bundle));
    bundle.snapshot.evaluationFacts = removed;
    assert.throws(() => assertProjectedBundle(bundle), /integrity|facts/i);
});

test("frozen Services preserves overlapping, partially attributed and inapplicable canonical call sets", async () => {
    const records = matrixRecords("services", ["success", "failure", "unknown", "success"]);
    const calls = records[0].toolCalls;
    Object.assign(calls[0], { requestedApiPath: null, requestArgs: { entityUrls: ["/me/drive/root/children", "/me/messages"] } });
    Object.assign(calls[1], { requestedApiPath: null, requestArgs: { entityUrls: ["/me/drive/root/children", "/unrecognized/root"] } });
    Object.assign(calls[2], { tool: "workiq-ask", requestedApiPath: null, requestArgs: { question: "Invented routing question" } });
    Object.assign(calls[3], { tool: "workiq-get_schema", requestedApiPath: null, requestArgs: { path: "/me/messages" } });
    const facts = freeze(records), value = facts.serviceInvolvement;
    assert.deepEqual(value.definition, serviceCategories.involvementDefinition);
    assert.equal(value.denominator, 4);
    assert.deepEqual([...value.memberRefs].sort(), facts.recordedOutcomes.filter(item => item.kind === "tool-call").map(item => item.memberRef).sort());
    assert.equal(value.groups.find(group => group.service === "Files").count, 2);
    assert.equal(value.groups.find(group => group.service === "Mail").count, 1);
    assert.equal(value.missingDetailRefs.length, 2);
    assert.equal(value.notApplicableRefs.length, 1);
    assert.ok(value.groups.find(group => group.service === "Files").memberRefs.some(ref => value.missingDetailRefs.includes(ref)));
    const before = JSON.stringify(facts);
    for (const change of [
        item => { item.denominator--; },
        item => { item.groups[0].count++; },
        item => { item.groups[0].memberRefs.push(item.groups[0].memberRefs[0]); },
        item => { item.groups[0].service = "private-service-name"; },
        item => { item.definition.description = "PRIVATE_RAW_DIAGNOSTIC"; },
        item => { item.notApplicableRefs.push(item.groups[0].memberRefs[0]); },
        item => { item.missingDetailRefs = []; },
    ]) {
        const invalid = structuredClone(facts);
        change(invalid.serviceInvolvement);
        assert.throws(() => freezeEvaluationFacts(invalid));
    }
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["html", "json", "markdown"] },
        undefined, undefined, facts);
    assert.match(bundle.files["product-report.md"], /Files \| 2 \/ 4 \| 50%/);
    assert.match(bundle.files["product-report.md"], /Mail \| 1 \/ 4 \| 25%/);
    assert.match(bundle.files["product-report.md"], /2 calls have missing service details/);
    assert.doesNotThrow(() => assertProjectedBundle(bundle));
    assert.equal(JSON.stringify(facts), before);
    const legacy = structuredClone(facts);
    delete legacy.serviceInvolvement;
    const old = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["markdown"] }, undefined, undefined, legacy);
    assert.match(old.files["product-report.md"], /Service involvement was not saved/);
    assert.doesNotMatch(old.files["product-report.md"], /Files \| 2 \/ 4/);
});

test("conflicted and unidentifiable calls cannot narrow service membership without a coverage warning", async () => {
    const records = matrixRecords("conflicted-service", ["success", "failure"], { groups: 2 });
    records[1].toolCalls[0].startEventId = records[0].toolCalls[0].startEventId;
    const facts = freeze(records);
    assert.equal(facts.scope.membership, "partial-retained");
    assert.equal(facts.recordedOutcomes.filter(item => item.kind === "tool-call").length, 0);
    assert.equal(facts.serviceInvolvement.denominator, 0);
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["markdown"] }, undefined, undefined, facts);
    assert.equal(bundle.snapshot.summary.metrics[0].count, 1, "Existing operational analytics deduplicates the shared start identity");
    assert.match(bundle.files["product-report.md"], /Service coverage is 0 of 1 report calls/);
    assert.match(bundle.files["product-report.md"], /Only some recorded actions can be linked/);
    delete records[0].toolCalls[0].toolCallId;
    delete records[0].toolCalls[0].startEventId;
    const partial = freeze(records);
    assert.equal(partial.serviceInvolvement.denominator, partial.recordedOutcomes.filter(item => item.kind === "tool-call").length);
    assert.doesNotThrow(() => freezeEvaluationFacts(partial));
});

test("native output leads with supported findings, keeps raw timing and quality lanes, and does not narrow a snapshot", async () => {
    const records = matrixRecords("native", ["failure", "success", "partial", "unknown", "success", "success"],
        { groups: 3, durations: [0, 20, 50, null, 500, 9000], api: [200, 403, null], batch: true });
    records[0].toolCalls[0].failureEvidence = {
        version: 1, messageStatus: "text-excluded", messageSignal: "request-timeout",
    };
    delete records[0].toolCalls[0].completionEventId;
    const { state } = qualityDisplayFixture({ records, judgments: ["fail", "pass", "unassessed"] });
    const facts = buildReportFacts(records, state, { preparedAt }).facts;
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["html", "json", "markdown"] },
        undefined, undefined, facts);
    const snapshotBefore = structuredClone(bundle.snapshot);
    const html = renderHtmlReport(bundle.records, { snapshot: bundle.snapshot, filters: { tools: ["workiq-ask"] } });
    const markdown = renderMarkdownReport(bundle.records, { snapshot: bundle.snapshot, filters: { tools: ["workiq-ask"] } });
    for (const text of [html, markdown]) {
        assert.match(text, /What the record shows/);
        assert.match(text, /reported an MCP request timeout/);
        assert.match(text, /completion event reference not retained/);
        assert.match(text, /answer not correct/);
        assert.match(text, /Specific reasons behind these saved verdicts were not retained/);
        assert.match(text, /1 of 2 passed/);
        assert.match(text, /2 of 3 assessed/);
        assert.match(text, /50 ms/);
        assert.match(text, /9000 ms/);
        assert.match(text, /5 of 6 calls timed/);
        assert.match(text, /Historical activity bins were not saved/);
        assert.match(text, /6 Work IQ tool calls/);
        assert.ok(text.indexOf("What the record shows") < text.indexOf("Recorded numbers"));
        assert.ok(text.indexOf("Recorded numbers") < text.indexOf("Operation detail"));
        assert.doesNotMatch(text, /square-root height|minimum visible sections|class="report-tool-score"/);
    }
    assert.doesNotMatch(html, /class="dimensional-report|<linearGradient id="dimensional-/);
    assert.deepEqual(bundle.snapshot, snapshotBefore);
    assert.throws(() => renderHtmlReport(bundle.records.slice(1), { snapshot: bundle.snapshot }), /exact frozen record population/);
    assert.equal(bundle.snapshot.summary.metrics[0].count, 6);
    assert.equal(bundle.snapshot.summary.metrics[1].count, 18);
    assert.equal(bundle.snapshot.evaluationFacts.metrics.find(metric => metric.definitionId === "tool-duration").value, 50);
});

test("legacy frozen facts do not acquire operational explanations or current context", async () => {
    const records = matrixRecords("legacy", ["failure"]);
    const facts = structuredClone(freeze(records));
    delete facts.reviewStatuses;
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["html", "markdown"] },
        undefined, undefined, facts);
    for (const text of [bundle.previewHtml, bundle.files["product-report.md"]]) {
        assert.match(text, /Detailed call-status context is unavailable in this saved summary/);
        assert.doesNotMatch(text, /sign-in was required|request timeout|error mentions access denial/);
    }
    assert.equal(Object.hasOwn(bundle.snapshot.evaluationFacts, "reviewStatuses"), false);
});

test("zero, missing timing, single sample and unavailable assessments stay distinct in native output", async () => {
    await assert.rejects(buildSanitizedBundle([], key), /non-empty exact selection/);
    assert.match(renderMarkdownReport([]), /0 selected interaction records; 0 Work IQ tool calls/);
    assert.match(renderHtmlReport([]), /calls failed \(Not applicable\)/);
    for (const [records, expected] of [
        [matrixRecords("single-zero", ["success"], { durations: [0] }), /0 s \(0 ms\).*Not shown for one sample/],
        [matrixRecords("single-missing", ["unknown"]), /Not measured/],
    ]) {
        const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["html", "json", "markdown"] });
        assert.match(bundle.files["product-report.md"], expected);
        const metric = bundle.snapshot.evaluationFacts.metrics.find(item => item.definitionId === "tool-duration");
        assert.equal(metric.value, records[0].toolCalls[0].durationMs ?? null);
        assert.doesNotMatch(bundle.previewHtml, /NaN|Infinity/);
    }
    const records = matrixRecords("assessment-states", ["success"]);
    for (const [judgment, expected] of [
        ["unassessed", /Insufficient recorded evidence/],
        ["error", /evaluator could not complete; this is not a failed answer/],
        ["fail", /answer not correct/],
    ]) {
        const { state } = qualityDisplayFixture({ records, judgments: [judgment] });
        const facts = buildReportFacts(records, state, { preparedAt }).facts;
        const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["markdown"] }, undefined, undefined, facts);
        assert.match(bundle.files["product-report.md"], expected);
        if (judgment !== "fail") assert.doesNotMatch(bundle.files["product-report.md"], /answer not correct/);
    }
});
