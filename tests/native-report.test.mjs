import test from "node:test";
import assert from "node:assert/strict";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { freezeEvaluationFacts } from "../lib/report-facts.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { assertProjectedBundle } from "../lib/privacy.mjs";
import { renderHtmlReport } from "../lib/product-report.mjs";
import { createHash } from "node:crypto";
import { matrixRecords } from "./report-evidence-matrix-fixtures.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const key = "a".repeat(64);
const preparedAt = "2026-10-11T12:00:00.000Z";
const freeze = records => buildReportFacts(records, { revision: 1, pseudonymKey: key, evidence: records }, { preparedAt }).facts;

for (const measured of [false, true]) test(`timing method narration requires samples, including measured zero: ${measured}`, async () => {
    const records = matrixRecords("timing-method", ["success", "success"], { durations: measured ? [0, 0] : [] });
    const facts = freeze(records), before = structuredClone(facts);
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["html", "markdown", "json", "pdf"] },
        undefined, undefined, facts);
    const loading = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: false });
    let pdfText = "";
    try {
        const pdf = await loading.promise;
        for (let number = 1; number <= pdf.numPages; number++) {
            pdfText += (await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str ?? "").join(" ") + "\n";
        }
    } finally { await loading.destroy(); }
    for (const text of [bundle.previewHtml, bundle.files["product-report.md"], pdfText]) {
        assert.equal(text.includes("nearest-rank timed samples"), measured, "Estimator prose must explain real samples, not absence");
        assert.match(text, /Tool latency/);
        assert.match(text, /Request to final response/);
        assert.match(text, /0 of 1 requests? timed/);
        if (measured) {
            assert.match(text, /2 of 2 calls timed/);
            assert.match(text, /0 ms/);
        } else {
            assert.match(text, /0 of 2 calls timed/);
            assert.match(text, /Not measured/);
            assert.doesNotMatch(text, /0 ms/);
        }
    }
    assert.deepEqual(facts, before);
    assert.deepEqual(JSON.parse(bundle.files["product-report.json"]).evaluationFacts, before);
    assert.equal(bundle.snapshot.evaluationFacts.metrics.find(metric => metric.definitionId === "tool-duration").value, measured ? 0 : null);
});

test("new reports lead with bounded working patterns from the exact disclosed population", async () => {
    const records = matrixRecords("working-patterns", ["success", "failure", "unknown"], { groups: 2 });
    records[1].sourceSessionId = "second-chat";
    records[0].userPrompt.text = "PRIVATE_WORK_PATTERN owner: Morgan Vale morgan@example.invalid";
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["html", "markdown", "json"] });
    for (const content of [bundle.previewHtml, bundle.files["product-report.md"]]) {
        assert.match(content, /Activity/);
        assert.match(content, /Interactions<\/dt>\s*<dd>2<\/dd>/);
        assert.match(content, /workiq-fetch.*3 of 3/);
        assert.match(content, /failed Work IQ calls.*1 of 2 selected interactions/i);
        assert.doesNotMatch(content, /PRIVATE_WORK_PATTERN|morgan@example.invalid|productivity grade|wasted effort/i);

    }
    const structured = JSON.parse(bundle.files["product-report.json"]);
    assert.deepEqual(structured.records, bundle.records);
    assert.equal(bundle.snapshot.summary.metrics[0].count, 3);
    assert.equal(bundle.snapshot.summary.metrics[0].outcomes.failure, 1);
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    assert.equal(manifest.evaluationFactsHash, createHash("sha256").update(JSON.stringify(structured.evaluationFacts)).digest("hex"));
    assert.throws(() => renderHtmlReport(bundle.records.slice(1), { snapshot: bundle.snapshot }), /exact frozen record population/);
    assert.doesNotThrow(() => assertProjectedBundle(bundle));
    const altered = structuredClone(bundle.snapshot);
    delete altered.evaluationFacts.serviceInvolvement;
    assert.throws(() => assertProjectedBundle({ ...bundle, snapshot: altered }), /integrity|facts/i);
});

test("targetless retrieval remains a tool purpose, not a recorded service target, in every readable format", async () => {
    const records = matrixRecords("targetless-summary", ["success"]);
    Object.assign(records[0].toolCalls[0], { tool: "workiq-retrieve", requestArgs: { query: "Invented search" }, requestedApiPath: null, apiResults: [] });
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["html", "markdown", "pdf", "json"] });
    const task = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    const pdf = await task.promise, pages = [];
    try {
        for (let number = 1; number <= pdf.numPages; number++) pages.push((await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str).join(" "));
    } finally { await task.destroy(); }
    for (const content of [bundle.previewHtml, bundle.files["product-report.md"], pages.join("\n")]) {
        assert.match(content, /Services/);
        assert.match(content, /Search and retrieval/);
        assert.doesNotMatch(content, /Most frequent service targets/);
        assert.doesNotMatch(content, /requested-single-target|Most frequent service targets/);
    }
    assert.equal(bundle.snapshot.evaluationFacts.serviceInvolvement.groups[0].service, "Search");
    assert.equal(bundle.snapshot.evaluationFacts.serviceInvolvement.groups[0].count, 1);
});

test("ordinary readable reports keep short prompt copies and shared methodology once without losing distinct timing", async () => {
    const records = matrixRecords("distilled-reading", ["success", "failure"], { groups: 2, durations: [800, 1400] });
    records[0].userPrompt.text = "DISTILLED_PROMPT_ONE: Find the launch decisions.";
    records[1].userPrompt.text = "DISTILLED_PROMPT_TWO: Find the review meetings.";
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "original", formats: ["html", "markdown", "json"] });
    for (const content of [bundle.previewHtml, bundle.files["product-report.md"]]) {
        for (const prompt of ["DISTILLED_PROMPT_ONE", "DISTILLED_PROMPT_TWO"]) {
            assert.equal(content.split(prompt).length - 1, 1, "A complete short copy need not recur as an excerpt, heading and appendix");
        }
        assert.match(content, /Each call counts once per service; services overlap/);
        assert.match(content, /Request to final response/);
        assert.match(content, /0 of 2 requests timed/);
        assert.match(content, /Call start to recorded completion/);
        assert.match(content, /not.*(?:permission to publish|permission to share)/);
        assert.match(content, /coverage-and-redaction-manifest.json/);
    }
    assert.deepEqual(JSON.parse(bundle.files["product-report.json"]).records, bundle.records);
    assert.equal(bundle.snapshot.evaluationFacts.metrics.filter(metric => metric.definitionId === "tool-duration")[0].value, 800);
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
    assert.match(bundle.files["product-report.md"], /2 calls with missing or partial service details/);
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
    const other = matrixRecords("attributable-service", ["success"])[0];
    const mixed = [...records, other];
    const expected = freeze([other]).recordedOutcomes.find(row => row.kind === "tool-call").memberRef;
    const mixedBundle = await buildSanitizedBundle(mixed, key, { promptMode: "none", formats: ["markdown"] }, undefined, undefined, freeze(mixed));
    assert.deepEqual(mixedBundle.snapshot.resultFacts.calls.map(call => call.ref), [expected]);
    assert.deepEqual(mixedBundle.snapshot.evaluationFacts.serviceInvolvement.memberRefs, [expected]);
    delete records[0].toolCalls[0].toolCallId;
    delete records[0].toolCalls[0].startEventId;
    const partial = freeze(records);
    assert.equal(partial.serviceInvolvement.denominator, partial.recordedOutcomes.filter(item => item.kind === "tool-call").length);
    assert.doesNotThrow(() => freezeEvaluationFacts(partial));
});
