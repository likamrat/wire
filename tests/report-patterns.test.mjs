import test from "node:test";
import assert from "node:assert/strict";
import { fixture, privateFixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { validateReportPatterns } from "../lib/report-patterns.mjs";
import { normalizeReportOptions } from "../lib/prompt-projection.mjs";
import { projectReportResultText } from "../lib/report-result-text.mjs";
import { projectReportResults } from "../lib/report-result-projection.mjs";

test("normalized patterns retain every selected interaction and keep authored notes in HTML, Markdown and JSON", async t => {
    const source = Array.from({ length: 6 }, (_, index) => {
        const record = fixture(`pattern-${index}`);
        record.userPrompt.text = `SYNTHETIC_PATTERN_PROMPT_${index}`;
        record.followUpPrompts = [];
        record.capturedAt = "2026-11-04T20:00:00Z";
        record.toolCalls[0].startedAt = record.capturedAt;
        record.toolCalls[0].toolSucceeded = false;
        record.toolCalls[0].reportedOutcome = "failed";
        record.toolCalls[0].apiResults = [{ index: 0, statusCode: 403 }, { index: 1, statusCode: 403 }];
        return record;
    });
    const { context } = await privateFixture(t, source), state = await loadBoardState(context);
    const controller = createExportController(context), selection = { kind: "all", revision: state.revision };
    const options = { saveMode: "local", formats: ["html", "json", "markdown"],
        reportFocus: { version: 1, preset: "errors", outcome: "errors", services: [] } };
    const first = await controller.preview("owner", undefined, options, selection);
    const preview = await controller.preview("owner", undefined, { ...options,
        reportNotes: [{ scenarioId: first.records[5].scenarioId, text: "The mailbox remained unreadable after the request." }],
    }, selection);
    const errors = preview.snapshot.reportPatterns.groups.filter(group => group.kind === "errors");
    assert.equal(errors.length, 1, "Identical returned statuses within a call do not duplicate that call's pattern");
    assert.equal(errors[0].callRefs.length, 6);
    assert.equal(errors[0].interactionRefs.length, 6);
    assert.deepEqual(errors[0].authors, { user: 0, agent: 0, unknown: 6 });
    for (let index = 0; index < 6; index++) {
        assert.ok(preview.previewHtml.includes(`SYNTHETIC_PATTERN_PROMPT_${index}`));
        assert.ok(preview.files["product-report.md"].includes(`SYNTHETIC_PATTERN_PROMPT_${index}`));
    }
    assert.equal((preview.previewHtml.match(/data-report-scenario=/g) ?? []).length, 6);
    for (const body of [preview.previewHtml, preview.files["product-report.md"]]) {
        assert.match(body, /6 of 6 interactions had recorded errors/);
        assert.match(body, /The mailbox remained unreadable after the request/);
        assert.match(body, /Status 403/);
        assert.doesNotMatch(body, /Reviewed copies are/);
    }
    const json = JSON.parse(preview.files["product-report.json"]);
    assert.deepEqual(json.reportPatterns, preview.snapshot.reportPatterns);
    const altered = structuredClone(json.reportPatterns);
    altered.groups.find(group => group.kind === "errors").callRefs.pop();
    assert.throws(() => validateReportPatterns(altered, { facts: json.evaluationFacts, results: json.resultFacts, records: json.records }), /patterns/);
});

test("error-message selection does not also disclose retained source descriptions", () => {
    const record = fixture("diagnostic-selection");
    record.toolCalls[0].resultEvidence = {
        version: 1, source: "sdk-result", applicationError: true, statusCode: 403, resultCount: null,
        contentStatus: "body-excluded", description: { version: 1, status: "recorded", text: "SOURCE_DESCRIPTION_NOT_CHOSEN" },
    };
    const projection = projectReportResults([record], "a".repeat(64));
    const errors = projectReportResultText(projection, "a".repeat(64), normalizeReportOptions({ resultText: true, resultTextKind: "errors" }));
    assert.equal(errors.frozen.copies.some(copy => copy.kind === "source-description"), false);
    const all = projectReportResultText(projection, "a".repeat(64), normalizeReportOptions({ resultText: true }));
    assert.equal(all.frozen.copies.some(copy => copy.kind === "source-description"), true);
});
