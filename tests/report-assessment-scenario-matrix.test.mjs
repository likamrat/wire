import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { privateFixture } from "./helpers.mjs";
import { reportMatrixCases, matrixRecords } from "./report-evidence-matrix-fixtures.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildAssessmentModel, assessmentOverview, finalizePersonalEvaluationCleanup } from "../lib/assessment-read-model.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { createExportController } from "../lib/export.mjs";
import { inspectComparisonPair } from "../lib/comparison-export.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { selectPersonalEvaluationCleanup } from "../lib/personal-evaluation.mjs";

async function saveSelection(controller, context, owner, ids) {
    const state = await loadBoardState(context);
    const preview = await controller.preview(owner, undefined, { promptMode: "none", formats: ["html", "json", "markdown"] },
        { kind: "selected", revision: state.revision, scenarioIds: ids });
    const reviewed = await controller.review(owner, preview.previewId, true);
    return { preview: reviewed, saved: (await controller.confirm(owner, preview.previewId, true)).bundle };
}

test("personal assessment matrix separates accuracy, answer trust, action trust, unassessed coverage and revisions", async t => {
    const scenario = reportMatrixCases().find(item => item.name === "mixed-parallel-batches");
    scenario.records.forEach((record, index) => {
        const start = `2026-10-0${index + 1}T12:00:00.000Z`;
        record.capturedAt = start;
        record.userPrompt.sourceTimestamp = start;
        for (const call of record.toolCalls) {
            call.startedAt = start;
            call.completedAt = call.durationMs === null ? null : new Date(Date.parse(start) + call.durationMs).toISOString();
        }
    });
    const alias = { ...structuredClone(scenario.records[0]), scenarioId: "matrix-legacy-copy", isLegacy: true };
    const { context } = await privateFixture(t, [...scenario.records, alias]);
    const controller = createExportController(context);
    const recordIds = scenario.records.map(record => record.scenarioId);
    async function feedback(index, checkId, verdict, withdraw = false) {
        const current = await loadBoardState(context), model = buildAssessmentModel(current);
        assert.equal(model.overview.interactionRefs.length, 3, "Duplicate source-group aliases do not inflate personal eligibility");
        const ref = model.catalog.find(entry => entry.scenarioId === recordIds[index]).interactionRef;
        await executeAssessmentAction(context, "matrix", "set_personal_assessment", {
            schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef: ref,
            expectedBasis: model.basis, checkId, verdict, withdraw,
        });
    }
    await feedback(0, "semantic-answer-correctness", "pass");
    await feedback(1, "semantic-answer-correctness", "fail");
    await feedback(0, "answer-support-validity", "fail");
    await feedback(1, "answer-support-validity", "pass");
    await feedback(0, "action-authorization-compliance", "pass");
    const explicitFeedback = (await loadBoardState(context)).personalEvaluation.feedback.records.length;
    assert.equal(explicitFeedback, 5);
    const baseline = await saveSelection(controller, context, "baseline", recordIds);
    const metrics = baseline.preview.snapshot.evaluationFacts.metrics;
    const metric = (dimension, origin) => metrics.find(item => item.dimension === dimension && item.origin === origin);
    for (const dimension of ["accuracy", "answer-trust"]) {
        assert.equal(metric(dimension, "user-personal").value, 0.5);
        assert.deepEqual(metric(dimension, "user-personal").counts, { pass: 1, fail: 1, unassessed: 1, evaluatorError: 0 });
        assert.deepEqual(metric(dimension, "user-personal").coverage, { covered: 2, eligible: 3 });
        assert.equal(metric(dimension, "automatic-local").coverage.eligible, 3);
        assert.equal(metric(dimension, "automatic-local").value, null);
    }
    assert.equal(metric("action-trust", "user-personal").value, 1);
    assert.deepEqual(metric("action-trust", "user-personal").coverage, { covered: 1, eligible: 3 });
    assert.equal(metric("action-trust", "automatic-local").coverage.eligible, 3);
    for (const content of [baseline.preview.previewHtml, baseline.preview.files["product-report.md"]]) {
        assert.match(content, /Your feedback/);
        assert.match(content, /1 of 2 passed · 2 of 3 assessed · 1 not assessed/);
        assert.match(content, /1 of 1 passed · 1 of 3 assessed · 2 not assessed/);
    }
    assert.equal(metrics.find(item => item.definitionId === "tool-duration").value, 200);
    assert.equal(metrics.some(item => item.dimension === "cost"), false);
    assert.equal(baseline.preview.snapshot.summary.metrics.find(item => item.layer === "tool").outcomes.success, 6, "Personal ratings never rewrite tool outcomes");
    assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, explicitFeedback, "Coverage never creates personal assessment records");
    const frozen = await readFile(baseline.saved.files["product-report.json"]);
    await feedback(0, "semantic-answer-correctness", "fail");
    const later = await saveSelection(controller, context, "later", recordIds);
    const pair = await inspectComparisonPair(context, await loadBoardState(context), baseline.saved.bundleId, later.saved.bundleId);
    const accuracy = pair.comparison.metrics.find(item => item.metric === "accuracy" && item.baseline?.basis === "user-assessment");
    assert.equal(accuracy.baseline.value, 50);
    assert.equal(accuracy.later.value, 0);
    assert.equal(accuracy.delta.value, -50);
    assert.equal(pair.comparison.toolComparison.overlap.sharedCount, 12);
    assert.equal(pair.comparison.narrative.tone, "neutral", "Same calls with revised judgments are not fresh activity improvement");
    assert.deepEqual(await readFile(baseline.saved.files["product-report.json"]), frozen);
    await feedback(0, "semantic-answer-correctness", "unassessed", true);
    const withdrawn = await saveSelection(controller, context, "withdrawn", recordIds);
    const after = withdrawn.preview.snapshot.evaluationFacts.metrics.filter(item => item.dimension === "accuracy");
    assert.equal(after.find(item => item.origin === "user-personal").coverage.covered, 1);
    assert.equal(after.find(item => item.origin === "user-personal").coverage.eligible, 3);
    assert.equal(after.find(item => item.origin === "automatic-local").coverage.eligible, 3);
    assert.equal(after.find(item => item.origin === "automatic-local").value, null);
    assert.deepEqual(await readFile(baseline.saved.files["product-report.json"]), frozen);
    const current = await loadBoardState(context), model = buildAssessmentModel(current);
    const refs = recordIds.map(id => model.catalog.find(item => item.scenarioId === id).interactionRef);
    const subset = assessmentOverview(current, model, [refs[1], refs[2]]);
    assert.deepEqual(subset.metrics.find(item => item.dimension === "accuracy" && item.origin === "user-personal").coverage, { covered: 1, eligible: 2 });
    const allUnrated = assessmentOverview(current, model, [refs[0], refs[2]]);
    assert.ok(allUnrated.metrics.filter(item => item.dimension === "accuracy").every(item => item.value === null && item.coverage.covered === 0));
    assert.equal(allUnrated.metrics.some(item => item.dimension === "accuracy" && item.origin === "user-personal"), false, "No personal records are manufactured for unrated selections");
    const deletion = createDeletionController(context, {
        selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup,
        onSeal: () => controller.invalidateDerived(),
    });
    const deletePreview = await deletion.preview("range", { scope: "range", from: "2026-10-03", to: "2026-10-03", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("range", { operationId: deletePreview.operationId, confirmed: true });
    const afterDelete = await loadBoardState(context), remaining = buildAssessmentModel(afterDelete);
    assert.equal(remaining.overview.interactionRefs.length, 2);
    const retainedPersonal = remaining.overview.metrics.find(item => item.dimension === "accuracy" && item.origin === "user-personal");
    assert.ok(retainedPersonal, "Deleting an unrated interaction must not hide a still-valid personal verdict on an untouched interaction");
    assert.deepEqual(retainedPersonal.coverage, { covered: 1, eligible: 2 });
    const remainingTiming = remaining.overview.metrics.find(item => item.definitionId === "tool-duration");
    assert.deepEqual(remainingTiming.coverage, { covered: 6, eligible: 8 });
    assert.equal(remainingTiming.value, 100);
    assert.deepEqual(afterDelete.personalEvaluation.feedback.records, current.personalEvaluation.feedback.records, "Unrelated range deletion does not rewrite personal assessment history");
    assert.deepEqual(await readFile(baseline.saved.files["product-report.json"]), frozen);
});

test("actual saved-report traffic-mix matrix refuses a false improvement narrative", async t => {
    function pattern(name, total, success, endpoint) {
        return matrixRecords(name, Array.from({ length: total }, (_, index) => index < success ? "success" : "failure")).map(record => ({
            ...record, toolCalls: record.toolCalls.map(call => ({ ...call, requestedApiPath: endpoint, requestArgs: { entityUrls: [endpoint] } })),
        }));
    }
    const baseline = [...pattern("before-easy", 10, 9, "/me/messages"), ...pattern("before-hard", 10, 5, "/me/calendarView")];
    const later = [...pattern("after-easy", 90, 81, "/me/messages"), ...pattern("after-hard", 10, 5, "/me/calendarView")];
    const { context } = await privateFixture(t, [...baseline, ...later]);
    const controller = createExportController(context);
    const a = await saveSelection(controller, context, "a", baseline.map(record => record.scenarioId));
    const b = await saveSelection(controller, context, "b", later.map(record => record.scenarioId));
    const pair = await controller.inspectComparison("matrix", a.saved.bundleId, b.saved.bundleId);
    assert.equal(pair.comparison.toolComparison.raw.baseline.successRate.percent, 70);
    assert.equal(pair.comparison.toolComparison.raw.later.successRate.percent, 86);
    assert.ok(pair.comparison.toolComparison.patterns.every(item => item.change.success === 0));
    assert.equal(pair.comparison.toolComparison.matched.fixedBaselineMix.change.success, 0);
    assert.match(pair.comparison.narrative.heading, /pattern rates did not/);
    assert.equal(pair.comparison.narrative.tone, "neutral");
    const comparison = await controller.previewComparison("matrix", a.saved.bundleId, b.saved.bundleId, { formats: ["html", "json", "markdown"] });
    for (const name of ["comparison-report.html", "comparison-report.md"]) {
        assert.match(comparison.files[name], /pattern rates did not/);
        assert.doesNotMatch(comparison.files[name], /team improved|fix caused|quality improved/);
    }
});
