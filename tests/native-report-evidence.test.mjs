import test from "node:test";
import assert from "node:assert/strict";
import { projectNativeReportEvidence, validateNativeReportEvidence } from "../lib/native-report-evidence.mjs";
import { nativeReportKey as key, nativeReportFrame as frame } from "./native-report-fixtures.mjs";
import { chatSource } from "./native-chat-source-fixtures.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { retainNativeChatSourceObservations } from "../lib/native-read-model.mjs";
import { inspectSavedReportSnapshot } from "../lib/saved-report-snapshot.mjs";
import { createHash } from "node:crypto";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { fixture } from "./helpers.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { buildComparisonBundle } from "../lib/comparison-export.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { coworkFixture, envelope, recorded } from "./native-read-model-fixtures.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { renderComparisonHtml, renderComparisonMarkdown } from "../lib/report-presentation.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
function savedNative(formats = ["html"]) {
    const projected = projectNativeReportEvidence(frame(), key);
    const snapshot = { schemaVersion: 3, kind: "report", bundleId: "export-synthetic", promptMode: "masked", formats,
        preparedAt: "2026-10-05T12:00:00.000Z", timeContext: { timeZone: "UTC", locale: "en-US" },
        dateSelection: { range: "capture" }, dateRange: {}, records: projected.records, nativeEvidence: projected.nativeEvidence };
    const snapshotBytes = JSON.stringify(snapshot);
    const { records, ...manifest } = snapshot;
    Object.assign(manifest, { privacyReview: { reviewerConfirmed: true },
        nativeEvidenceHash: projected.nativeEvidenceHash, snapshotHash: hash(snapshotBytes),
        files: formats.includes("json") ? { "product-report.json": { sha256: hash(snapshotBytes), bytes: Buffer.byteLength(snapshotBytes) } } : {} });
    const manifestBytes = JSON.stringify(manifest);
    return { manifest, snapshot, manifestBytes, ...(formats.includes("json") ? { snapshotBytes } : {}),
        expectedManifestSha256: hash(manifestBytes), expectedBundleId: snapshot.bundleId };
}

test("native frozen evidence keeps distinct exact populations and pseudonymous source/variant references", () => {
    const source = frame(), before = JSON.stringify(source);
    const projected = projectNativeReportEvidence(source, key);
    const { nativeEvidence, records } = projected;
    assert.equal(validateNativeReportEvidence(nativeEvidence, records), nativeEvidence);
    assert.equal(records.length, 2);
    assert.ok(records.every(record => record.projectionVersion === 4 && record.recordKind === "native-conversation"
        && !Object.hasOwn(record, "toolCalls") && !Object.hasOwn(record, "userPrompt")));
    const counts = Object.fromEntries(nativeEvidence.populations.map(population => [population.unit, population.count]));
    assert.equal(counts["native-tool-call"], 3);
    assert.equal(counts["native-returned-result-observation"], 0);
    assert.equal(counts["message-representation-observation"], 4);
    assert.equal(counts["native-task-state-observation"], 1);
    assert.equal(nativeEvidence.conversations[0].calls.length, 0);
    assert.equal(nativeEvidence.conversations[1].measurements[0].milliseconds, 12);
    assert.equal(nativeEvidence.conversations[1].measurements[0].comparableToUserResponseLatency, false);
    assert.equal(nativeEvidence.conversations[1].resultReferences[0].cardinality, 2);
    assert.ok(nativeEvidence.conversations.flatMap(conversation => conversation.observations)
        .every(observation => observation.current && observation.captureCount === 1 && /^native-variant-/.test(observation.variantRef)));
    assert.equal(nativeEvidence.coverage.history, "selected-retained-evidence-not-complete-source-history");
    assert.doesNotMatch(JSON.stringify(nativeEvidence), /invented-(?:tenant|subject|chat-conversation|cowork-conversation|batch)|sourceDocument|sourceSessionId|sourceSnapshotRef|\/data\/|RAW_|requests/);
    assert.equal(JSON.stringify(source), before);
});

test("native evidence rejects expanded metadata, forged membership and disclosure links", () => {
    const projected = projectNativeReportEvidence(frame(), key);
    for (const alter of [
        evidence => { evidence.account = "invented-subject"; },
        evidence => { evidence.schemaVersion = 2; },
        evidence => { evidence.conversations[0].sourceUrl = "https://invented.invalid"; },
        evidence => { evidence.conversations[0].observations[0].variantRef = "original-variant"; },
        evidence => { evidence.selection.conversationRefs.pop(); },
        evidence => { evidence.populations[0].count++; },
        evidence => { evidence.disclosure.copies[0].sourceRef = evidence.conversations[1].observations[0].ref; },
        evidence => { evidence.disclosure.copies[0].text = '{"password":"EXAMPLE_ONLY"}'; },
        evidence => { evidence.conversations[1].calls[0].observationRefs = []; },
        evidence => { evidence.conversations[1].calls[0].names = ["https://invented.invalid/private"]; },
        evidence => { evidence.conversations[1].measurements[0].comparableToUserResponseLatency = true; },
        evidence => { evidence.conversations[1].resultReferences[0].shapeCounts = { url: { string: 1 } }; },
        evidence => { evidence.coverage.history = "complete"; },
    ]) {
        const evidence = structuredClone(projected.nativeEvidence);
        alter(evidence);
        assert.throws(() => validateNativeReportEvidence(evidence, projected.records), TypeError);
    }
    for (const records of [[], projected.records.slice(1), [...projected.records, projected.records[0]],
        projected.records.map(record => ({ ...record, prompts: [] }))]) {
        assert.throws(() => validateNativeReportEvidence(projected.nativeEvidence, records), TypeError);
    }
});

test("selected normalized source relationships and fields are validated before projection", () => {
    for (const alter of [
        source => { source.records[0].nativeConversation.calls = []; source.records[0].leaked = "unknown"; },
        source => { source.records[1].nativeConversation.calls[0].outcome.state = "failed"; },
        source => { source.records[0].nativeConversation.messages[0].value = {
            ...source.records[0].nativeConversation.messages[0].value, text: "Replaced without its observation" }; },
        source => { delete source.records[0].nativeConversation.observations[0].retention; },
        source => { source.records[1].nativeConversation.observations[0].fields.unrecognized = { value: "private" }; },
    ]) {
        const source = structuredClone(frame());
        alter(source);
        assert.throws(() => projectNativeReportEvidence(source, key, { promptMode: "none" }), { status: 422 });
    }
});

test("Chat source updates stay source-qualified reviewed copies with no invented task outcome", () => {
    const decoded = decodeNativeChatObservation(chatSource({
        messageId: "invented-progress", author: "bot", messageType: "Progress", text: "Checking recorded sources.",
    }));
    const source = frame(retainNativeChatSourceObservations(decoded));
    const projected = projectNativeReportEvidence(source, key, { recordedContext: true });
    assert.equal(projected.nativeEvidence.conversations[0].sourceFacts[0].kind, "provider-progress");
    assert.equal(projected.nativeEvidence.conversations[0].taskStates.length, 0);
    assert.equal(projected.nativeEvidence.disclosure.copies[0].text, "Checking recorded sources.");
    assert.equal(projected.nativeEvidence.disclosure.copies[0].author, "unknown");
    const omitted = projectNativeReportEvidence(source, key, { promptMode: "none", recordedContext: true });
    assert.equal(omitted.review.length, 0);
    assert.doesNotMatch(JSON.stringify(omitted.nativeEvidence), /Checking recorded sources/);
});

test("native frozen manifest reading works without optional JSON and never accepts a legacy fact shortcut", () => {
    for (const formats of [["html"], ["json"]]) {
        const saved = savedNative(formats);
        const read = inspectSavedReportSnapshot(saved);
        assert.equal(read.status, "supported");
        assert.deepEqual(read.nativeEvidence, saved.manifest.nativeEvidence);
        assert.equal(Boolean(read.snapshot), formats.includes("json"));
        for (const field of ["evaluationFacts", "evaluationFactsHash"]) {
            const manifest = { ...saved.manifest, [field]: null };
            const manifestBytes = JSON.stringify(manifest);
            assert.throws(() => inspectSavedReportSnapshot({ ...saved, manifestBytes, expectedManifestSha256: hash(manifestBytes) }), TypeError);
        }
    }
});

test("native and mixed formats use one frozen projection without legacy top-level facts", async () => {
    for (const github of [[], [fixture()]]) {
        const bundle = await buildSanitizedBundle(github, key,
            { formats: ["html", "json", "markdown"], recordedContext: github.length === 0 }, undefined,
            undefined, undefined, undefined, undefined, frame());
        const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
        assert.ok(bundle.snapshot.nativeEvidence);
        for (const value of [bundle.snapshot, manifest]) {
            assert.equal(Object.hasOwn(value, "evaluationFacts"), false);
            assert.equal(Object.hasOwn(value, "evaluationFactsHash"), false);
        }
        assert.equal(Boolean(bundle.snapshot.nativeEvidence.githubEvaluationFacts), github.length > 0);
        assert.deepEqual(manifest.nativeEvidence, bundle.snapshot.nativeEvidence);
        assert.match(bundle.files["product-report.html"], /Microsoft 365 Chat/);
        assert.match(bundle.files["product-report.md"], /Microsoft 365 Cowork/);
        assert.match(bundle.files["product-report.html"], /Read the invented records/);
        assert.match(bundle.files["product-report.md"], /An invented question/);
        assert.doesNotMatch(bundle.files["product-report.html"], /invented-tenant|invented-subject|RAW_|No qualifying Work IQ scenarios/);
        assert.equal(bundle.nativeReview.length, github.length ? 2 : 4);
        const read = inspectSavedReportSnapshot({
            manifestBytes: JSON.stringify({ ...manifest, privacyReview: { ...manifest.privacyReview, reviewerConfirmed: true } }),
            snapshotBytes: bundle.files["product-report.json"],
        });
        assert.deepEqual(read.nativeEvidence, bundle.snapshot.nativeEvidence);
    }
});

test("frozen native comparison keeps source-qualified populations separate and requires current export definitions", async () => {
    const evidence = projectNativeReportEvidence(frame(), key).nativeEvidence;
    const first = { schemaVersion: 2, bundleId: "export-first", snapshotHash: "1".repeat(64), disclosureReviewed: true, nativeEvidence: evidence };
    const second = { ...first, bundleId: "export-second", snapshotHash: "2".repeat(64) };
    const comparison = compareFrozenReportFacts(first, second);
    assert.equal(comparison.nativeComparison.status, "available");
    const coworkCalls = comparison.nativeComparison.units.find(item => item.sourceId === "microsoft-365-cowork" && item.unit === "native-tool-call");
    assert.deepEqual([coworkCalls.baselineCount, coworkCalls.laterCount, coworkCalls.delta, coworkCalls.overlappingReferences], [3, 3, 0, 3]);
    assert.equal(comparison.toolComparison, null);
    assert.equal(comparison.status, "ready", "Separate Microsoft rows are readable without a pooled result.");
    assert.deepEqual(comparison.metrics, []);
    await assert.rejects(buildComparisonBundle({ comparison, sourceFacts: [{ legacyFacts: first }, { legacyFacts: second }] }, {}),
        { status: 422 });
});

test("native PDF derives from the same frozen disclosure and extracts without raw source identities", async () => {
    const bundle = await buildSanitizedBundle([], key, { formats: ["html", "pdf", "json", "markdown"], recordedContext: true },
        undefined, undefined, undefined, undefined, undefined, frame());
    assert.equal(bundle.files["product-report.pdf"].subarray(0, 5).toString(), "%PDF-");
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    const extracted = await extractReportFile({ format: "pdf", bytes: bundle.files["product-report.pdf"], manifest });
    assert.match(extracted.content, /Microsoft 365 Cowork/);
    assert.match(extracted.content, /Read the invented records/);
    assert.match(extracted.content, /12 ms/);
    assert.doesNotMatch(extracted.content, /invented-tenant|invented-subject|RAW_/);
    assert.equal(extracted.coverage.nativeEvidence, "frozen-manifest-v1");
});

test("frozen native facts reject duplicated variants, unrelated result-call links and duplicate task observations", () => {
    const envelopes = coworkFixture();
    envelopes[5].outcomes.nestedApi.availability = "recorded";
    envelopes[5].outcomes.nestedApi.observed = [{
        index: 0, indexKind: "response-array-position", statusCode: 503, errorCode: null,
        paginationPresent: null, evidenceLevel: "intermediary-reported",
    }];
    const projected = projectNativeReportEvidence(frame(envelopes), key);
    const original = projected.nativeEvidence.conversations[0];
    assert.equal(original.results[0].statusCode, 503);
    assert.equal(original.calls[0].outcome, "succeeded", "Returned result failure is not borrowed as the call's outcome.");
    for (const alter of [
        value => {
            value.conversations[0].observations[1].sourceRef = value.conversations[0].observations[0].sourceRef;
            value.conversations[0].observations[1].variantRef = value.conversations[0].observations[0].variantRef;
        },
        value => { value.conversations[0].results[0].callRefs = [value.conversations[0].calls[1].ref]; },
        value => {
            const task = { ...value.conversations[0].taskStates[0], ref: "native-task-state-" + "0".repeat(16) };
            value.conversations[0].taskStates.push(task);
            const population = value.populations.find(item => item.unit === "native-task-state-observation");
            population.refs.push(task.ref); population.count++;
        },
    ]) {
        const value = structuredClone(projected.nativeEvidence);
        alter(value);
        assert.throws(() => validateNativeReportEvidence(value, projected.records), TypeError);
    }
});

test("native multipart text cannot be relabeled as a user prompt to bypass contextual disclosure", () => {
    const part = envelope("cowork", { id: "invented-part-event", event: "rc", data: {} });
    part.messageParts = [{ message: recorded({ author: "unknown", representation: "reply-fragment", text: "Recorded multipart fragment." }),
        evidence: { sourceDocument: "invented-parts", pointer: "/data/content/0", nativeEventId: "invented-part-event" } }];
    const projected = projectNativeReportEvidence(frame([part]), key);
    assert.equal(projected.nativeEvidence.conversations[0].messages[0].unit, "message-representation-part");
    const altered = structuredClone(projected.nativeEvidence), copy = altered.disclosure.copies[0];
    Object.assign(copy, { author: "user", purpose: "prompt", exclusion: null, omitted: false,
        text: "Recorded multipart fragment.", representation: "masked-copy" });
    Object.assign(altered.disclosure.coverage, { included: 1, omitted: 0, contextExcluded: 0 });
    assert.throws(() => validateNativeReportEvidence(altered, projected.records), TypeError);
});

test("retained repeat captures do not add native calls or duplicate current source variants", () => {
    const first = coworkFixture(), later = structuredClone(first);
    for (const row of later) row.capture.captureId = "invented-later-capture";
    const repeated = projectNativeReportEvidence(frame([...first, ...later]), key);
    const conversation = repeated.nativeEvidence.conversations[0];
    assert.equal(conversation.calls.length, 3);
    assert.equal(conversation.observations.length, first.length);
    assert.ok(conversation.observations.every(observation => observation.captureCount === 2 && observation.current));
    assert.equal(validateNativeReportEvidence(repeated.nativeEvidence, repeated.records), repeated.nativeEvidence);
});

test("native frozen interpretation binds actual selected parser and source-schema definitions", () => {
    const envelopes = coworkFixture(), changed = structuredClone(envelopes);
    for (const row of changed) row.capture.parserVersion = "invented-changed-parser";
    const first = projectNativeReportEvidence(frame(envelopes), key).nativeEvidence;
    const second = projectNativeReportEvidence(frame(changed), key).nativeEvidence;
    assert.notEqual(first.definition.interpretationRef, second.definition.interpretationRef);
    const report = (nativeEvidence, id, snapshotHash) => ({
        schemaVersion: 2, bundleId: id, snapshotHash, disclosureReviewed: true, nativeEvidence,
    });
    const comparison = compareFrozenReportFacts(report(first, "export-first", "1".repeat(64)),
        report(second, "export-second", "2".repeat(64)));
    assert.equal(comparison.status, "ready");
    assert.equal(comparison.nativeComparison.reason, "native-definition-or-source-population-differs");
    assert.ok(comparison.nativeComparison.units.every(item => item.delta === null && item.overlappingReferences === null));
});

for (const cohort of ["non-overlapping", "later-additions"]) test(`native ${cohort} distinguishes unavailable cohorts from absent sources in every shared display`, () => {
    const changed = coworkFixture();
    for (const row of changed) row.capture.parserVersion = "changed-comparison-parser";
    const report = (evidence, identity) => ({ schemaVersion: 2, bundleId: `export-${identity}`,
        snapshotHash: identity.repeat(64), disclosureReviewed: true, nativeEvidence: evidence });
    const first = report(projectNativeReportEvidence(frame(), key).nativeEvidence, "1");
    const second = report(projectNativeReportEvidence(frame(changed), key).nativeEvidence, "2");
    const comparison = compareFrozenReportFacts(first, second, { cohort, metricProjectionVersion: 4 });
    const cowork = comparison.nativeComparison.units.filter(row => row.sourceId === "microsoft-365-cowork");
    assert.ok(cowork.every(row => row.baselineCount === null && row.laterCount === null && row.delta === null
        && row.overlappingReferences === null), "Incompatible definitions cannot establish overlap or either requested cohort.");
    const rows = createReportComparison().nativeRows(comparison);
    const present = rows.filter(row => row.source === "Microsoft 365 Cowork");
    assert.ok(present.length > 0);
    assert.ok(present.every(row => row.earlier === "Cohort unavailable" && row.later === "Cohort unavailable"),
        "Existing Microsoft populations must not be described as absent when the cohort is unavailable.");
    const absent = rows.filter(row => row.source === "Microsoft 365 Chat");
    assert.ok(absent.length > 0);
    assert.ok(absent.every(row => row.earlier === "Cohort unavailable" && row.later === "Not present"),
        "A genuinely absent source must remain distinct from a present source whose cohort is unavailable.");
    const snapshot = { title: "Native cohort availability", bundleId: "export-comparison",
        preparedAtDisplay: "2026-10-27", sourceReports: [first, second], presentation: { schemaVersion: 3 } };
    for (const output of [renderComparisonHtml(comparison, snapshot), renderComparisonMarkdown(comparison, snapshot)]) {
        assert.match(output, /Cohort unavailable/);
        assert.match(output, /Not present/);
    }
    const legacy = structuredClone(comparison);
    for (const row of [...legacy.nativeComparison.units, ...legacy.nativeComparison.outcomes]) {
        delete row.baselineState;
        delete row.laterState;
    }
    assert.ok(createReportComparison().nativeRows(legacy).every(row => row.earlier === "Unavailable" && row.later === "Unavailable"),
        "Old ambiguous null counts cannot establish source absence.");
    const compatible = compareFrozenReportFacts(first, { ...first, bundleId: "export-3", snapshotHash: "3".repeat(64) },
        { cohort, metricProjectionVersion: 4 });
    const calls = createReportComparison().nativeRows(compatible).find(row => row.source === "Microsoft 365 Cowork" && row.label === "Tool calls");
    assert.ok(calls, "The source-qualified tool-call population must remain visible.");
    assert.equal(calls.earlier, cohort === "non-overlapping" ? "0" : "3");
    assert.equal(calls.later, "0", "A verified empty cohort remains numeric zero, not unavailable.");
});
