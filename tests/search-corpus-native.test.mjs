import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { privateFixture } from "./helpers.mjs";
import { matrixRecords } from "./report-evidence-matrix-fixtures.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedReportFile, reportHash } from "../lib/report-artifacts.mjs";
import { freezeEvaluationFacts } from "../lib/report-facts.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { createSearchCorpus } from "../lib/search-corpus.mjs";

function nativeRecords() {
    const records = matrixRecords("native-corpus", ["success", "failure", "unknown", "success"]);
    const calls = records[0].toolCalls;
    Object.assign(calls[0], { requestedApiPath: null, requestArgs: { entityUrls: ["/me/drive/root/children", "/me/messages"] } });
    Object.assign(calls[1], { requestedApiPath: null, requestArgs: { entityUrls: ["/me/drive/root/children", "/unrecognized/root"] },
        failureEvidence: { version: 1, reason: "error-code-recorded", messageStatus: "text-excluded",
            messageSignal: "workiq-sign-in-required", privateMessage: "NATIVE_PRIVATE_PAYLOAD" } });
    Object.assign(calls[2], { tool: "workiq-ask", requestedApiPath: null, requestArgs: { question: "NATIVE_PRIVATE_QUERY" } });
    Object.assign(calls[3], { tool: "workiq-get_schema", requestedApiPath: null, requestArgs: { path: "/me/messages" } });
    return records;
}

async function save(context, options = { promptMode: "none", formats: ["json"] }, scenarioId) {
    const state = await loadBoardState(context), controller = createExportController(context);
    const selection = scenarioId ? { kind: "selected", revision: state.revision, scenarioIds: [scenarioId] }
        : { kind: "all", revision: state.revision };
    const preview = await controller.preview("native-corpus", undefined, options, selection);
    await controller.review("native-corpus", preview.previewId, true);
    return (await controller.confirm("native-corpus", preview.previewId, true)).bundle;
}

async function indexedReport(corpus, bundleId) {
    let report;
    const status = await corpus.index(items => items.find(item => item.target.bundleId === bundleId),
        value => { report = value; });
    return { report, status };
}

// Corrupt/legacy inputs are sealed only inside this test's owned ephemeral artifact.
async function reseal(context, artifact, original, change, { copyFacts = true } = {}) {
    const snapshot = structuredClone(original.snapshot), manifest = structuredClone(original.manifest);
    change(snapshot, manifest);
    if (copyFacts) {
        manifest.evaluationFacts = structuredClone(snapshot.evaluationFacts);
        manifest.evaluationFactsHash = reportHash(JSON.stringify(snapshot.evaluationFacts));
    }
    const bytes = JSON.stringify(snapshot);
    manifest.snapshotHash = reportHash(JSON.stringify(snapshot));
    manifest.files["product-report.json"] = { sha256: reportHash(bytes), bytes: Buffer.byteLength(bytes) };
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(artifact.files["product-report.json"], bytes);
    await writeFile(artifact.files["coverage-and-redaction-manifest.json"], manifestBytes);
    await updateBoardState(context, state => {
        Object.assign(state.exports.find(entry => entry.bundleId === artifact.bundleId), {
            snapshotHash: manifest.snapshotHash, manifestHash: reportHash(manifestBytes), evaluationFactsHash: manifest.evaluationFactsHash,
        });
    });
}

test("native corpus: verified JSON indexes only closed status and overlapping service display facts", async t => {
    const { context } = await privateFixture(t, nativeRecords()), artifact = await save(context);
    const document = await readSavedReportFile(context, await loadBoardState(context), artifact.bundleId);
    const facts = freezeEvaluationFacts(document.snapshot.evaluationFacts), involvement = facts.serviceInvolvement;
    assert.equal(document.format, "json");
    assert.equal(involvement.denominator, 4);
    assert.equal(involvement.groups.find(group => group.service === "Files").count, 2);
    assert.equal(involvement.groups.find(group => group.service === "Mail").count, 1);
    assert.equal(involvement.missingDetailRefs.length, 2);
    assert.equal(involvement.notApplicableRefs.length, 1);
    assert.ok(involvement.groups.find(group => group.service === "Files").memberRefs.some(ref => involvement.missingDetailRefs.includes(ref)));
    const before = await Promise.all(Object.values(artifact.files).map(file => readFile(file)));
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => corpus.close());
    const { report, status } = await indexedReport(corpus, artifact.bundleId);
    assert.ok(report, JSON.stringify(status));
    assert.equal(report.target.format, "json");
    assert.equal(report.target.documentHash, document.sha256);
    assert.match(report.content, /Saved review-status coverage: 1 of 1 interactions/);
    assert.match(report.content, /Recorded tool status: calls 4; succeeded 2; failed 1; other 1/);
    assert.match(report.content, /Recorded operational cause: workiq-sign-in-required; count 1/);
    assert.match(report.content, /Saved assessment status: none/);
    assert.match(report.content, /Saved service involvement v1/);
    assert.match(report.content, /Service Files: 2 of 4 tool calls/);
    assert.match(report.content, /Service Mail: 1 of 4 tool calls/);
    assert.match(report.content, /Missing service details: 2 of 4 tool calls/);
    assert.match(report.content, /Service not applicable: 1 of 4 tool calls/);
    assert.match(report.content, /Known services and missing-detail coverage can overlap; not-applicable coverage is disjoint/);
    assert.match(report.content, /Separate from exclusive activity-category v3 counts/);
    assert.doesNotMatch(report.content, /NATIVE_PRIVATE_|interactionRef|memberRefs|inAutomaticScope|personalFeedback|sourceConfigRef|receiptToken|[a-f0-9]{64}/);
    for (const group of facts.memberships) {
        assert.equal(report.content.includes(group.interactionRef), false);
        for (const member of group.members) assert.equal(report.content.includes(member.ref), false);
    }
    assert.equal(document.snapshot.records.length, 1);
    assert.deepEqual(await Promise.all(Object.values(artifact.files).map(file => readFile(file))), before);
});

test("native corpus: legacy optional absence stays absent without current-data reconstruction or changed bytes", async t => {
    const { context } = await privateFixture(t, nativeRecords()), artifact = await save(context);
    const original = await readSavedReportFile(context, await loadBoardState(context), artifact.bundleId);
    await reseal(context, artifact, original, snapshot => {
        delete snapshot.evaluationFacts.reviewStatuses;
        delete snapshot.evaluationFacts.serviceInvolvement;
    });
    const before = await Promise.all(Object.values(artifact.files).map(file => readFile(file)));
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => corpus.close());
    const { report, status } = await indexedReport(corpus, artifact.bundleId);
    assert.ok(report, JSON.stringify(status));
    assert.doesNotMatch(report.content, /Saved review-status coverage|Saved service involvement|workiq-sign-in-required|Missing service details:/);
    const read = await readSavedReportFile(context, await loadBoardState(context), artifact.bundleId);
    assert.equal(Object.hasOwn(read.snapshot.evaluationFacts, "reviewStatuses"), false);
    assert.equal(Object.hasOwn(read.snapshot.evaluationFacts, "serviceInvolvement"), false);
    assert.deepEqual(read.snapshot.summary, original.snapshot.summary);
    assert.deepEqual(read.snapshot.categoryDefinition, original.snapshot.categoryDefinition);
    assert.deepEqual(await Promise.all(Object.values(artifact.files).map(file => readFile(file))), before);
});

test("native corpus: closed shape, membership, hashes and privacy tampering fail before text is indexed", async t => {
    const { context } = await privateFixture(t, nativeRecords()), artifact = await save(context);
    const original = await readSavedReportFile(context, await loadBoardState(context), artifact.bundleId);
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => corpus.close());
    const changes = [
        facts => { facts.reviewStatuses[0].reviewStatus.execution.privateText = "PRIVATE_STATUS_PAYLOAD"; },
        facts => { facts.reviewStatuses[0].interactionRef = `interaction-${"f".repeat(32)}`; },
        facts => { facts.reviewStatuses[0].reviewStatus.execution.causes[0].cause = "invented-rationale"; },
        facts => { facts.serviceInvolvement.groups[0].service = "C:\\PRIVATE_SERVICE_PATH"; },
        facts => { facts.serviceInvolvement.groups[0].count++; },
        facts => { facts.serviceInvolvement.notApplicableRefs.push(facts.serviceInvolvement.groups[0].memberRefs[0]); },
        facts => { facts.serviceInvolvement.missingDetailRefs = []; },
    ];
    for (const change of changes) {
        await reseal(context, artifact, original, snapshot => change(snapshot.evaluationFacts));
        const file = await readSavedReportFile(context, await loadBoardState(context), artifact.bundleId);
        await assert.rejects(extractReportFile(file), { code: "report-invalid-facts" });
        const { report, status } = await indexedReport(corpus, artifact.bundleId);
        assert.equal(report, undefined);
        assert.ok(status.issues.some(issue => issue.code === "report-invalid-facts"));
        assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|invented-rationale/);
    }
    await reseal(context, artifact, original, snapshot => { snapshot.evaluationFacts.reviewStatuses = []; }, { copyFacts: false });
    const mismatched = await readSavedReportFile(context, await loadBoardState(context), artifact.bundleId);
    await assert.rejects(extractReportFile(mismatched), { code: "report-facts-integrity" });
    await reseal(context, artifact, original, (_, manifest) => { manifest.evaluationFactsHash = "0".repeat(64); }, { copyFacts: false });
    const { report, status } = await indexedReport(corpus, artifact.bundleId);
    assert.equal(report, undefined);
    assert.ok(status.issues.some(issue => issue.code === "report-facts-integrity"));
    await reseal(context, artifact, original, snapshot => { delete snapshot.evaluationFacts; }, { copyFacts: false });
    const orphaned = await readSavedReportFile(context, await loadBoardState(context), artifact.bundleId);
    await assert.rejects(extractReportFile(orphaned), { code: "report-facts-integrity" });
    await reseal(context, artifact, original, () => {});
    await writeFile(artifact.files["product-report.json"], JSON.stringify({ ...original.snapshot, evaluationFacts: null }));
    await assert.rejects(readSavedReportFile(context, await loadBoardState(context), artifact.bundleId), { status: 409 });
});

test("native corpus: contextual native PDF remains readable with masked replies and unchanged frozen output", { timeout: 30000 }, async t => {
    const records = retainedContextFixture().records.slice(0, 2);
    for (const record of records) for (const call of record.toolCalls) call.requestArgs = { entityUrls: ["/me/drive/root/children"] };
    records[1].followUpPrompts = [];
    const { context } = await privateFixture(t, records);
    await seedRetainedReply(context, inventedSource(), "CONTEXT_NATIVE_REPLY Contact native-reply@example.invalid.");
    const artifact = await save(context, { promptMode: "masked", formats: ["pdf"], recordedContext: true }, records[0].scenarioId);
    const before = await Promise.all(Object.values(artifact.files).map(file => readFile(file)));
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => corpus.close());
    const { report, status } = await indexedReport(corpus, artifact.bundleId);
    assert.ok(report, JSON.stringify(status));
    assert.equal(report.target.format, "pdf");
    assert.match(report.content, /Activity report/);
    assert.match(report.content, /At a glance/);
    assert.match(report.content, /Recorded context/);
    assert.match(report.content, /CONTEXT_NATIVE_REPLY/);
    assert.match(report.content, /finality unverified/);
    assert.doesNotMatch(report.content, /native-reply@example.invalid/);
    assert.deepEqual(await Promise.all(Object.values(artifact.files).map(file => readFile(file))), before);
});
