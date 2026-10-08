import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixture, privateFixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { scanTree, scanReportMetadata } from "../lib/privacy.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { evaluationGeneratedHashes } from "../lib/report-facts.mjs";

function volumeRecords() {
    const records = Array.from({ length: 18 }, (_, session) => Array.from({ length: session === 0 ? 29 : 5 }, (_, request) => {
        const item = fixture(`scan-volume-${session}-${request}`);
        item.sourceSessionId = `synthetic-session-${session}`;
        item.userPrompt.text = `Synthetic request ${session}.${request}.`;
        item.toolCalls = Array.from({ length: session === 0 && request === 0 ? 37 : 3 }, (_, index) => ({
            ...structuredClone(item.toolCalls[0]),
            toolCallId: `call-${session}-${request}-${index}`, startEventId: `start-${session}-${request}-${index}`,
            toolSucceeded: [true, false, null][index % 3], reportedOutcome: "unknown",
        }));
        return item;
    })).flat();
    records.at(-1).userPrompt.text += " password='SYNTHETIC_LAST_FIELD_CREDENTIAL'";
    return records;
}

test("114 request groups and 376 calls retain complete scanning through all-format review/save and comparison", { timeout: 120000 }, async t => {
    const records = volumeRecords(), { context } = await privateFixture(t, records);
    const before = await loadBoardState(context), controller = createExportController(context);
    const preview = await controller.preview("volume", undefined, { promptMode: "masked", formats: ["html", "pdf", "json", "markdown"] },
        { kind: "all", revision: before.revision });
    assert.equal(preview.records.length, 114);
    assert.equal(preview.snapshot.summary.metrics.find(metric => metric.layer === "tool").count, 376);
    assert.equal(preview.snapshot.evaluationFacts.recordedOutcomes.filter(item => item.kind === "tool-call").length, 376);
    assert.equal(preview.privacy.allSelectedFieldsScanned, true);
    assert.ok(preview.privacy.categories.credential_assignments > 0, "The last selected record was not skipped");
    assert.ok(preview.snapshot.promptCoverage.mandatoryRemovals > 0);
    for (const [name, content] of Object.entries(preview.files)) if (typeof content === "string") {
        assert.doesNotMatch(content, /SYNTHETIC_LAST_FIELD_CREDENTIAL/, name);
    }
    const reviewed = await controller.review("volume", preview.previewId, true);
    const earlier = (await controller.confirm("volume", preview.previewId, true)).bundle;
    for (const [name, content] of Object.entries(reviewed.files)) {
        const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content.data, "base64");
        assert.deepEqual(await readFile(earlier.files[name]), bytes);
    }
    const next = await controller.preview("volume", undefined, { promptMode: "none", formats: ["html"] },
        { kind: "all", revision: (await loadBoardState(context)).revision });
    await controller.review("volume", next.previewId, true);
    const later = (await controller.confirm("volume", next.previewId, true)).bundle;
    const compared = await controller.previewComparison("volume", earlier.bundleId, later.bundleId, { formats: ["html", "json", "markdown"] });
    assert.equal(compared.comparison.toolComparison.raw.baseline.count, 376);
    assert.equal(compared.comparison.toolComparison.overlap.sharedCount, 376);
    assert.equal(compared.privacy.allSelectedFieldsScanned, true);
    await controller.reviewComparison("volume", compared.previewId, true);
    const comparison = (await controller.confirmComparison("volume", compared.previewId, true)).bundle;
    assert.equal(comparison.kind, "comparison");
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
});

test("closed-schema facts validate every nested field before text de-duplication", () => {
    const record = fixture("scan-adversarial");
    const { facts } = buildReportFacts([record], { revision: 0, pseudonymKey: "a".repeat(64), evidence: [record] });
    const generated = new Set(evaluationGeneratedHashes(facts));
    const before = JSON.stringify(facts);
    const scan = scanReportMetadata({ evaluationFacts: facts }, generated);
    assert.equal(scan.categories.credentials, 0);
    assert.equal(JSON.stringify(facts), before);
    for (const inject of [
        copy => { copy.assessments.at(-1).hidden = "password='SYNTHETIC_HIDDEN_CREDENTIAL'"; },
        copy => { copy.metrics.at(-1).coverage.secret = "SYNTHETIC_HIDDEN_TEXT"; },
        copy => { copy.memberships.at(-1).members.at(-1).localPath = "C:\\Synthetic\\private.json"; },
        copy => { copy.patterns[0].pattern.display.endpoints[0].pathTemplate = "/me/messages?secret=hidden"; },
    ]) {
        const tampered = structuredClone(facts);
        inject(tampered);
        assert.throws(() => scanReportMetadata({ evaluationFacts: tampered }, generated), /Projected evaluation facts are invalid/);
        assert.throws(() => scanReportMetadata({ sourceFacts: [{ evaluationFacts: tampered }] }, generated), /Projected evaluation facts are invalid/);
    }
    const sensitiveOutsideFacts = scanReportMetadata({ evaluationFacts: facts, unexpectedCaption: "password='SYNTHETIC_PRIVATE'" }, generated);
    assert.ok(sensitiveOutsideFacts.categories.credential_assignments > 0, "Non-fact metadata still receives the full scanner");
    for (const malformed of [false, 0, "", undefined]) {
        assert.throws(() => scanReportMetadata({ evaluationFacts: malformed }, generated), /Projected evaluation facts are invalid/);
        assert.throws(() => scanReportMetadata({ sourceFacts: [{ evaluationFacts: malformed }] }, generated), /Projected evaluation facts are invalid/);
    }
});

test("untrusted structural and text budgets remain bounded by the original scanner limits", () => {
    assert.throws(() => scanTree(Array(100001).fill(0)), /field limit exceeded/);
    assert.throws(() => scanReportMetadata({ untrusted: Array(100001).fill(0) }), /field limit exceeded/);
    assert.throws(() => scanReportMetadata({ untrusted: "x".repeat(4 * 1024 * 1024 + 1) }), /text limit exceeded/);
    assert.throws(() => scanReportMetadata({ untrusted: undefined }), /Unknown, circular or unscanned/);
});
