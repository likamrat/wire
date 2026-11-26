import test from "node:test";
import assert from "node:assert/strict";
import { fixture, privateFixture } from "../support/helpers.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { validateReportPatterns, projectReportPatterns, reportPatternError } from "../../lib/report-patterns.mjs";
import { normalizeReportOptions } from "../../lib/prompt-projection.mjs";
import { projectReportResultText } from "../../lib/report-result-text.mjs";
import { projectReportResults } from "../../lib/report-result-projection.mjs";
import { buildReportFacts } from "../../lib/assessment-read-model.mjs";
import { reportObservationHasError } from "../../lib/report-result-contract.mjs";

test("qualified reasons distinguish repeated failures of the same operation without grouping by message prose", () => {
    const key = "a".repeat(64);
    const records = ["sign-in-required", "sign-in-required", "unexplained"].map((type, i) => {
        const record = fixture(`same-operation-${i}`), call = record.toolCalls[0];
        Object.assign(call, { toolSucceeded: false, reportedOutcome: "failed", apiResults: [],
            failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded",
                ...(type === "sign-in-required" ? { messageSignal: "workiq-sign-in-required" } : {}) } });
        return record;
    });
    const facts = buildReportFacts(records, { revision: 1, pseudonymKey: key }).facts;
    const results = projectReportResults(records, key).facts, patterns = projectReportPatterns(records, facts, results, key);
    const groups = patterns.groups.filter(g => g.kind === "errors");
    assert.deepEqual(groups.map(g => g.callRefs.length), [2, 1]);
    assert.match(reportPatternError(groups[0]), /Call: Sign-in was required at the time/);
    assert.doesNotMatch(reportPatternError(groups[1]), /sign-in|timeout/i);
});
test("returned diagnostic evidence is grouped without publishing its source code or changing earlier observations", async t => {
    const record = fixture("entry-diagnostic"), call = record.toolCalls[0];
    call.startedAt = record.capturedAt;
    const message = "Supply the required title.", code = "InventedTitleRequired";
    call.apiResults = [{ index: 0, statusCode: 200 }, { index: 1, errorCode: code,
        errorDiagnostic: { version: 1, source: "result-error", status: "recorded", message, code } }];
    const { context } = await privateFixture(t, [record]), state = await loadBoardState(context);
    const preview = await createExportController(context).preview("owner", undefined, {
        saveMode: "local", formats: ["html", "json", "markdown"], reportFocus: { version: 1, preset: "errors", outcome: "errors", services: [] },
    }, { kind: "all", revision: state.revision });
    const { resultFacts, reportPatterns, evaluationFacts } = preview.snapshot;
    const fact = resultFacts.calls[0], obs = fact.observations[0];
    assert.ok(preview.previewHtml.includes(`href="#${fact.ref}">Report call 1</a>`));
    assert.ok(preview.previewHtml.includes(`id="${fact.ref}"`));
    assert.equal(fact.completion, "succeeded"); assert.equal(reportObservationHasError(obs), true);
    assert.equal(obs.returnedEntries[1].errorCode, null);
    assert.equal(reportPatterns.groups.filter(group => group.kind === "errors").length, 1);
    for (const body of [preview.previewHtml, preview.files["product-report.md"]]) {
        assert.match(body, /A returned entry reported an error/);
        assert.doesNotMatch(body, /Supply the required title|InventedTitleRequired/);
    }
    const oldObs = structuredClone(obs); delete oldObs.errorDetailVersion;
    assert.equal(reportObservationHasError(oldObs), false);
    const oldPatterns = { ...reportPatterns, version: 2, definition: "wire-report-patterns-v2", groups: reportPatterns.groups.filter(g => g.kind !== "errors") };
    assert.doesNotThrow(() => validateReportPatterns(oldPatterns, { facts: evaluationFacts, results: resultFacts }));
});

test("error patterns retain both conflicting status sources only when error evidence exists", () => {
    const key = "a".repeat(64);
    const records = [500, 201].map((diagnostic, index) => {
        const record = fixture(`conflicting-pattern-${index}`);
        record.toolCalls[0].apiResults = [{ index: 0, statusCode: 200,
            errorDiagnostic: { version: 1, source: "result-error", status: "recorded", statusCode: diagnostic } }];
        return record;
    });
    const before = structuredClone(records), facts = buildReportFacts(records, { revision: 1, pseudonymKey: key }).facts;
    const results = projectReportResults(records, key).facts, patterns = projectReportPatterns(records, facts, results, key);
    const groups = patterns.groups.filter(group => group.kind === "errors");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].callRefs.length, 1);
    assert.match(reportPatternError(groups[0]), /Conflicting returned-entry statuses/);
    assert.match(reportPatternError(groups[0]), /reported: 200/);
    assert.match(reportPatternError(groups[0]), /diagnostic: 500/);
    assert.equal(patterns.version, 3);
    assert.doesNotThrow(() => validateReportPatterns({ ...patterns, version: 2, definition: "wire-report-patterns-v2" }, { facts, results }));
    const legacy = { ...structuredClone(patterns), version: 1, definition: "wire-report-patterns-v1",
        groups: patterns.groups.filter(group => group.kind === "operation") };
    const bytes = JSON.stringify(legacy);
    assert.doesNotThrow(() => validateReportPatterns(legacy, { facts, results }));
    assert.equal(JSON.stringify(legacy), bytes, "Version 1 patterns retain their frozen interpretation of the same result facts.");
    const changed = structuredClone(patterns); changed.groups = changed.groups.filter(group => group.kind !== "errors");
    assert.throws(() => validateReportPatterns(changed, { facts, results }), /patterns/);
    assert.deepEqual(records, before);
});

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

test("a singleton operation remains included without claiming repetition", async t => {
    const record = fixture("singleton-operation");
    record.followUpPrompts = [];
    const { context } = await privateFixture(t, [record]), state = await loadBoardState(context);
    const preview = await createExportController(context).preview("owner", undefined, {
        saveMode: "local", formats: ["html", "json", "markdown"],
        reportFocus: { version: 1, preset: "all", outcome: "all", services: [] },
    }, { kind: "all", revision: state.revision });
    const groups = preview.snapshot.reportPatterns.groups.filter(group => group.kind === "operation");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].callRefs.length, 1);
    assert.equal(groups[0].interactionRefs.length, 1);
    assert.equal(preview.records.length, 1);
    assert.match(preview.previewHtml, /<h2>Recorded operations<\/h2>/);
    assert.match(preview.files["product-report.md"], /### Recorded operations/);
    for (const body of [preview.previewHtml, preview.files["product-report.md"]]) assert.doesNotMatch(body, /Repeated operations/);
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
