import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { privateFixture } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport, validatePeriodReport, periodReportComparison, PERIOD_POPULATION } from "../lib/period-report.mjs";
import { renderPeriodReportHtml, renderPeriodReportMarkdown, periodReportDisplay } from "../lib/period-report-output.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState, replaceEvidence } from "../lib/store.mjs";
import { reportContextFixture } from "./report-context-fixture.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { buildAssessmentModel, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { readSavedReportFile } from "../lib/report-artifacts.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { makeRatio } from "./assessment-contract-fixtures.mjs";
import { metricSlotKey } from "../lib/assessment-contract.mjs";

async function setup(t) {
    const fixture = periodFixture();
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const assessed = qualityDisplayFixture({ records: fixture.records, judgments: ["pass", "fail", "pass", "unassessed", "error"], finalDuration: null }).state;
    const app = await privateFixture(t, fixture.records);
    await updateBoardState(app.context, state => { state.pseudonymKey = assessed.pseudonymKey; state.personalEvaluation = assessed.personalEvaluation; });
    const state = await loadBoardState(app.context), input = { ...fixture.input, expectedRevision: state.revision };
    const value = buildPeriodComparison(state, input);
    return { ...app, state, value, options: { formats: ["html", "json", "markdown"], promptMode: "masked", timeContext: value.timeContext } };
}

test("Tool latency period output qualifies aggregates and only labels exact tool rows", () => {
    const { state, input } = periodFixture();
    for (const layer of ["tool", "reported-api"]) {
        const value = buildPeriodComparison(state, { ...input, options: { ...input.options, layer } });
        const frozen = freezePeriodReport(state, acceptPeriodReport(state, value), "2026-10-11T10:00:00.000Z").frozen;
        const before = JSON.stringify(frozen);
        const records = [...new Set(Object.values(frozen.periods).flatMap(side => side.scenarioRefs))]
            .map(scenarioId => ({ scenarioId, toolCalls: [], graphActivities: [], httpRecords: [], prompts: [] }));
        const snapshot = { periodComparison: frozen, records, preparedAtDisplay: "Oct 11, 2026" };
        const html = renderPeriodReportHtml(snapshot), markdown = renderPeriodReportMarkdown(snapshot);
        if (layer === "tool") {
            assert.deepEqual(periodReportDisplay(frozen).timing.map(row => row[0]), ["Median tool latency", "P95 tool latency"]);
            for (const output of [html, markdown]) {
                assert.match(output, /Matching tool latency/);
                assert.match(output, /Median tool latency/);
                assert.match(output, /P95 tool latency/);
                assert.doesNotMatch(output, /call duration|tool-call duration/i);
            }
            assert.match(html, /1,000 ms/);
            assert.match(markdown, /1000 ms/);
            assert.match(html, /Tool latency: call start to recorded completion/);
            assert.match(markdown, /\| Record \/ interaction \| Tool \| Services \| Outcome \| Tool latency \|/);
        } else {
            assert.deepEqual(periodReportDisplay(frozen).timing, []);
            assert.match(html, /Recorded duration for this evidence layer/);
            assert.doesNotMatch(html, /<th scope="col">Tool latency<\/th>/);
            assert.match(markdown, /\| Record \/ interaction \| Tool \| Services \| Outcome \| Recorded duration \|/);
        }
        assert.equal(JSON.stringify(frozen), before);
    }
});

test("a paired report keeps its title across human output and verified files without changing either cohort", async t => {
    const { context, value, options } = await setup(t), controller = createExportController(context);
    const title = "Calendar period comparison";
    const preview = await controller.preview("period-title", undefined, { ...options, title, formats: ["html", "pdf", "json", "markdown"] }, undefined, value);
    assert.equal(preview.title, title);
    assert.equal(preview.snapshot.title, title);
    assert.deepEqual(preview.snapshot.periodComparison.comparison, value.comparison);
    assert.ok(preview.previewHtml.includes(`<title>WIRE - ${title}</title>`));
    assert.ok(preview.previewHtml.includes(title + "</h1>"));
    assert.ok(preview.files["product-report.md"].startsWith("# " + title + "\n"));
    await controller.review("period-title", preview.previewId, true, value.timeContext);
    const saved = (await controller.confirm("period-title", preview.previewId, true, value.timeContext)).bundle;
    const state = await loadBoardState(context);
    for (const format of ["html", "pdf", "json", "markdown"]) {
        const file = await readSavedReportFile(context, state, saved.bundleId, format);
        assert.equal(file.canonicalTitle, title);
        if (format === "json") assert.equal(JSON.parse(file.bytes.toString("utf8")).title, title);
        else assert.ok((await extractReportFile(file)).content.includes(title), `${format}: the human output includes its title`);
    }
});

test("authoritative paired admission rejects numeric, membership, scope and stale tampering", () => {
    const { state, input } = periodFixture(), value = buildPeriodComparison(state, input);
    for (const mutate of [
        copy => { copy.comparison.outcomes.change.failure = 0; },
        copy => { copy.periods.baseline.rowIds.reverse(); },
        copy => { copy.periods.later.interactionCoverage[0].coveredUnitRefs.pop(); },
        copy => { copy.options.filters.services = ["Mail"]; },
        copy => { copy.revision--; },
        copy => { copy.authorPolicy = "fake"; },
        copy => { copy.periods.baseline.assessment.metrics[0].observedTime.undatedUnits++; },
        copy => { copy.periods.baseline.assessment.metrics[0].createdAt = "not-an-instant"; },
    ]) {
        const copy = structuredClone(value); mutate(copy);
        assert.throws(() => acceptPeriodReport(state, copy));
    }
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value), "2026-10-11T10:00:00.000Z").frozen;
    assert.deepEqual(frozen.comparison, value.comparison);
    assert.equal(frozen.definitions.metricProjectionVersion, 4);
    assert.ok(frozen.comparison.metrics.every(item => (item.baseline ?? item.later).basis === "observed"));
    assert.equal(frozen.periods.baseline.rows.length, 3);
    assert.equal(frozen.periods.baseline.facts.metrics[0].coverage.eligible, 4, "full interaction checks are separate from 3 matching calls");
    for (const mutate of [
        copy => { copy.periods.baseline.totals.count++; },
        copy => { copy.periods.later.rows[0].scenarioRef = "raw-private-id"; },
        copy => { copy.periods.baseline.facts.metrics[0].samples[0].value++; },
        copy => { copy.periods.baseline.range.to = "2026-03-09"; },
        copy => { copy.selection.promptAuthors = ["user"]; },
        copy => { copy.source.path = "private"; },
        copy => { copy.comparison.metrics[0].result = null; },
        copy => { copy.periods.baseline.facts.metricProjectionVersion = 2; },
        copy => { copy.periods.baseline.facts.metricProjectionVersion = 3; },
    ]) {
        const copy = structuredClone(frozen); mutate(copy);
        assert.throws(() => validatePeriodReport(copy));
    }
});

test("successive authoritative builds differ only in valid pooled preparation instants and remain admissible", async () => {
    const { state, input } = periodFixture(), first = buildPeriodComparison(state, input);
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = buildPeriodComparison(state, input);
    assert.notEqual(first.periods.baseline.assessment.metrics[0].createdAt, second.periods.baseline.assessment.metrics[0].createdAt);
    assert.doesNotThrow(() => acceptPeriodReport(state, first));
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, first), new Date().toISOString()).frozen;
    assert.equal(frozen.periods.baseline.facts.metrics[0].createdAt, first.periods.baseline.assessment.metrics[0].createdAt);
});

test("legacy period definitions remain readable but cannot generate a new bundle through the imported builder", async t => {
    const { state, value } = await setup(t);
    const accepted = acceptPeriodReport(state, value);
    const current = freezePeriodReport(state, accepted, "2026-10-11T10:00:00.000Z").frozen;
    const selected = [...new Set(Object.values(value.periods).flatMap(side => side.interactionRefs))]
        .map(ref => accepted.model.internals.get(ref).record);
    for (const version of [2, 3]) {
        const legacy = structuredClone(current);
        legacy.definitions.metricProjectionVersion = version;
        for (const side of Object.values(legacy.periods)) {
            side.facts.metricProjectionVersion = version;
            const interactionRef = side.facts.memberships[0].interactionRef;
            const rating = {
                ...makeRatio(1), metricRef: "metric-" + String(version).repeat(32), basis: { ...side.facts.basis },
                dimension: "accuracy", checkId: "semantic-answer-correctness", origin: "user-personal",
                eligibleUnitRefs: [interactionRef], coveredUnitRefs: [interactionRef],
            };
            side.facts.metrics.push(rating);
            side.interactionCoverage.push({ metricRef: rating.metricRef, slot: metricSlotKey(rating),
                eligibleUnitRefs: [interactionRef], coveredUnitRefs: [interactionRef] });
        }
        legacy.scope.population = PERIOD_POPULATION;
        legacy.scope.findings = "Full retained interactions selected by matching records; calls outside the period or filters can remain in these interaction findings and metrics.";
        legacy.scope.interpretation = "Observed differences only. Unequal periods, shared records, different activity and assessment coverage do not establish causal improvement.";
        legacy.comparison = periodReportComparison(legacy);
        const before = JSON.stringify(legacy);
        validatePeriodReport(legacy);
        const records = [...new Set(Object.values(legacy.periods).flatMap(side => side.scenarioRefs))]
            .map(scenarioId => ({ scenarioId, toolCalls: [], graphActivities: [], httpRecords: [], prompts: [] }));
        const html = renderPeriodReportHtml({ periodComparison: legacy, records, preparedAtDisplay: "Oct 11, 2026" });
        assert.match(html, /Assessment coverage/);
        assert.match(html, version === 2 ? /Full-interaction checks and timing/ : /Personal feedback and recorded timing/);
        assert.equal(JSON.stringify(legacy), before);
        const mislabeled = structuredClone(legacy);
        mislabeled.definitions.metricProjectionVersion = 4;
        assert.throws(() => validatePeriodReport(mislabeled), /unsupported population meaning/);
        await assert.rejects(buildSanitizedBundle(selected, state.pseudonymKey,
            { promptMode: "none", formats: ["json"], timeContext: value.timeContext },
            undefined, undefined, undefined, undefined, legacy),
        error => error.status === 422 && /current metric projection/.test(error.message));
        assert.equal(JSON.stringify(legacy), before, "Rejecting generation cannot normalize historical facts.");
        assert.equal(renderPeriodReportHtml({ periodComparison: legacy, records, preparedAtDisplay: "Oct 11, 2026" }), html);
    }
});

test("imported period generation requires current outer and both inner projections plus valid frozen contents", async t => {
    const { state, value, options } = await setup(t), accepted = acceptPeriodReport(state, value);
    const current = freezePeriodReport(state, accepted, "2026-10-11T10:00:00.000Z").frozen;
    const selected = [...new Set(Object.values(value.periods).flatMap(side => side.interactionRefs))]
        .map(ref => accepted.model.internals.get(ref).record);
    const build = comparison => buildSanitizedBundle(selected, state.pseudonymKey,
        { ...options, promptMode: "none", formats: ["json"] }, undefined, undefined, undefined, undefined, comparison);
    const before = JSON.stringify(current), bundle = await build(current);
    assert.equal(bundle.snapshot.schemaVersion, 3);
    assert.deepEqual(bundle.snapshot.periodComparison, current);
    assert.doesNotMatch(bundle.files["product-report.json"], /user-personal|model-assessed|assessmentAttempts|reviewStatuses/);
    const absent = structuredClone(current);
    delete absent.definitions.metricProjectionVersion;
    await assert.rejects(build(absent), error => error.status === 422 && /current metric projection/.test(error.message));
    for (const side of ["baseline", "later"]) for (const version of [undefined, 2, 3]) {
        const mixed = structuredClone(current);
        if (version === undefined) delete mixed.periods[side].facts.metricProjectionVersion;
        else mixed.periods[side].facts.metricProjectionVersion = version;
        await assert.rejects(build(mixed), error => error.status === 422 && /current metric projection/.test(error.message));
    }
    const malformed = structuredClone(current);
    malformed.periods.baseline.totals.count++;
    await assert.rejects(build(malformed), error => error.status === 422 && /canonical totals differ/.test(error.message));
    assert.equal(JSON.stringify(current), before);
});

test("current-source qualification preserves source guards without reviving historical model lanes", () => {
    const { state, input } = periodFixture(), source = structuredClone(state.personalEvaluation.source);
    state.personalEvaluation.source = { available: false, sourceConfigRef: null, sourceConfigRevision: 0 };
    const value = buildPeriodComparison(state, input, { model: buildAssessmentModel(state, { source }) });
    assert.ok(value.comparison.metrics.every(item => (item.baseline ?? item.later).basis !== "model-assessment"));
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value, { source }), "2026-10-11T10:00:00.000Z").frozen;
    assert.deepEqual(frozen.comparison, value.comparison);
    assert.throws(() => acceptPeriodReport(state, value), /differs from the accepted/);
    const options = { preparedAt: "2026-10-11T10:00:00.000Z" };
    assert.deepEqual(buildReportFacts(state.evidence, state, options),
        buildReportFacts(state.evidence, state, { ...options, source: state.personalEvaluation.source }));
});

test("one paired report uses existing actual disclosure and separate local save", async t => {
    const { context, value, options } = await setup(t), controller = createExportController(context);
    const preview = await controller.preview("owner", undefined, options, undefined, value);
    const frozen = preview.snapshot.periodComparison;
    assert.deepEqual(frozen.comparison, value.comparison);
    assert.equal(preview.snapshot.evaluationFacts, undefined);
    assert.equal(preview.snapshot.selectionScope, undefined);
    assert.ok(preview.records.every(record => record.toolCalls.length === 0), "copies are not a third analytical population");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await assert.rejects(controller.confirm("owner", preview.previewId, true, value.timeContext), /disclosure review/);
    const reviewed = await controller.review("owner", preview.previewId, true, value.timeContext);
    assert.equal(reviewed.privacy.reviewerConfirmed, true);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    const saved = await controller.confirm("owner", preview.previewId, true, value.timeContext);
    assert.equal(saved.state.exports.length, 1);
    const snapshot = JSON.parse(await readFile(saved.bundle.files["product-report.json"], "utf8"));
    assert.deepEqual(snapshot.periodComparison, frozen);
    assert.equal(saved.bundle.reportType, "period-comparison");
    const document = await readSavedReportFile(context, saved.state, saved.bundle.bundleId, "json");
    const searchable = await extractReportFile(document);
    assert.match(searchable.content, /Period|period/);
    for (const reviewStatuses of [null, []]) {
        const malformed = structuredClone(document);
        malformed.snapshot.periodComparison.periods.baseline.facts.reviewStatuses = reviewStatuses;
        await assert.rejects(extractReportFile(malformed), error => error.code === "report-period-invalid");
    }
    const wrongHash = structuredClone(document);
    wrongHash.manifest.periodComparisonHash = "0".repeat(64);
    await assert.rejects(extractReportFile(wrongHash), error => error.code === "report-period-integrity");
    assert.ok(preview.previewHtml.includes(`<h1>${preview.title}</h1>`));
    assert.match(preview.previewHtml, /<h2>Recorded outcomes<\/h2>/);
    assert.match(preview.files["product-report.md"], /No calls|Full-interaction|full retained/);
    await assert.rejects(controller.confirm("owner", preview.previewId, true, value.timeContext), /Preview not found/);
});

test("paired payload is mutually exclusive with ordinary selections", async t => {
    const { context, value, options } = await setup(t), controller = createExportController(context);
    await assert.rejects(controller.preview("owner", ["anything"], options, undefined, value), /cannot be combined/);
    await assert.rejects(controller.preview("owner", undefined, options, { kind: "all", revision: value.revision }, value), /cannot be combined/);
});

test("unrelated updates preserve reviewed pair; selected evidence and permission changes reject without writing", async t => {
    const { context, value, options } = await setup(t), controller = createExportController(context);
    const preview = await controller.preview("owner", undefined, options, undefined, value);
    await controller.review("owner", preview.previewId, true, value.timeContext);
    await updateBoardState(context, state => { state.cards["period-request-9"].workflowState = "reviewing"; });
    const saved = await controller.confirm("owner", preview.previewId, true, value.timeContext);
    assert.equal(saved.state.exports.length, 1);
    for (const mutate of [
        state => { state.personalEvaluation.overrideRevision++; },
        state => { state.personalEvaluation.consent.revision++; },
    ]) {
        const state = await loadBoardState(context);
        const fresh = buildPeriodComparison(state, { ...periodFixture().input, expectedRevision: state.revision });
        const pending = await controller.preview("owner", undefined, options, undefined, fresh);
        await controller.review("owner", pending.previewId, true, fresh.timeContext);
        await updateBoardState(context, mutate);
        await assert.rejects(controller.confirm("owner", pending.previewId, true, fresh.timeContext), /Assessment evidence changed/);
        assert.equal((await loadBoardState(context)).exports.length, 1);
    }
});

test("held PDF preparation rejects changed authority before returning any preview or writing", async t => {
    const { context, value, options } = await setup(t);
    let started, release;
    const waiting = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const controller = createExportController(context, undefined, async () => {
        started(); await gate; return Buffer.from("%PDF-invented-gate-test");
    });
    const pending = controller.preview("owner", undefined, { ...options, formats: ["pdf"] }, undefined, value);
    await waiting;
    await updateBoardState(context, state => { state.personalEvaluation.consent.revision++; });
    release();
    await assert.rejects(pending, /Assessment evidence changed/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

test("retained-source append preserves a prepared cohort, but a selected-record edit revokes it", async t => {
    const { context, value, options } = await setup(t), controller = createExportController(context);
    const preview = await controller.preview("owner", undefined, options, undefined, value);
    await controller.review("owner", preview.previewId, true, value.timeContext);
    const before = await loadBoardState(context), records = structuredClone(before.evidence);
    const unrelated = structuredClone(records.at(-1));
    unrelated.scenarioId = "unrelated-append"; unrelated.sourceSessionId = "unrelated-append-chat";
    unrelated.userPrompt.sourceEventId = "unrelated-append-prompt";
    unrelated.toolCalls[0].toolCallId = "unrelated-append-call"; unrelated.toolCalls[0].startEventId = "unrelated-append-start";
    records.push(unrelated);
    await replaceEvidence(context, () => ({ records }));
    await controller.confirm("owner", preview.previewId, true, value.timeContext);
    const current = await loadBoardState(context);
    const fresh = buildPeriodComparison(current, { ...periodFixture().input, expectedRevision: current.revision });
    const pending = await controller.preview("owner", undefined, options, undefined, fresh);
    await controller.review("owner", pending.previewId, true, value.timeContext);
    records[0].userPrompt.text += " changed recorded intent";
    await replaceEvidence(context, () => ({ records }));
    await assert.rejects(controller.confirm("owner", pending.previewId, true, value.timeContext), /Selected evidence changed/);
    assert.equal((await loadBoardState(context)).exports.length, 1);
});

test("saving a period report never rewrites previously registered ordinary report bytes", async t => {
    const { context, options } = await setup(t), controller = createExportController(context);
    let state = await loadBoardState(context);
    const old = await controller.preview("owner", undefined, options, { kind: "selected", revision: state.revision, scenarioIds: ["period-request-1"] });
    await controller.review("owner", old.previewId, true, options.timeContext);
    const saved = await controller.confirm("owner", old.previewId, true, options.timeContext);
    const bytes = new Map(await Promise.all(Object.values(saved.bundle.files).map(async file => [file, await readFile(file)])));
    state = await loadBoardState(context);
    const value = buildPeriodComparison(state, { ...periodFixture().input, expectedRevision: state.revision });
    const paired = await controller.preview("owner", undefined, options, undefined, value);
    await controller.review("owner", paired.previewId, true, options.timeContext);
    await controller.confirm("owner", paired.previewId, true, options.timeContext);
    for (const [file, expected] of bytes) assert.deepEqual(await readFile(file), expected);
    assert.equal((await loadBoardState(context)).exports.length, 2);
});

test("paired context and original/masked/none/edit/omit copies never enlarge either matching or assessment population", async t => {
    const { context, records } = await reportContextFixture(t);
    const state = await loadBoardState(context);
    const input = { schemaVersion: 1, expectedRevision: state.revision, options: {
        layer: "tool", groupBy: "workload", bucket: "day", timeContext: { timeZone: "UTC", locale: "en-US" },
        filters: { scope: "history", promptAuthors: ["user"], services: ["Files"] },
    }, periods: { baseline: { from: "2026-09-01", to: "2026-10-02" }, later: { from: "2026-09-01", to: "2026-10-02" } },
    scenarioIds: [records[1].scenarioId], withinServices: [] };
    const value = buildPeriodComparison(state, input), controller = createExportController(context);
    assert.equal(value.periods.baseline.rowIds.length, 1);
    let prior;
    for (const promptMode of ["original", "masked", "none"]) {
        const options = { promptMode, formats: ["html", "json", "markdown"], recordedContext: true, timeContext: input.options.timeContext };
        const preview = await controller.preview("owner", undefined, options, undefined, value);
        assert.deepEqual(preview.snapshot.periodComparison.comparison, value.comparison);
        assert.equal(preview.snapshot.periodComparison.periods.baseline.rows.length, 1);
        if (promptMode === "none") {
            assert.equal(preview.snapshot.recordedContext, undefined);
            assert.ok(preview.records.every(record => record.prompts.every(prompt => prompt.text === null)));
        } else {
            assert.ok(preview.snapshot.recordedContext.coverage.entries > 1);
            if (promptMode === "masked") assert.doesNotMatch(JSON.stringify(preview.snapshot), /reply@example|first@example/);
            prior = { preview, options };
        }
    }
    const reply = prior.preview.contextReview.find(copy => copy.kind === "response" && copy.original?.includes("Here are three"));
    assert.ok(reply);
    const edited = await controller.preview("owner", undefined, { ...prior.options, overrides: [{ key: reply.key, text: "Edited permitted explanation" }] }, undefined, value);
    assert.match(edited.previewHtml, /Edited permitted explanation/);
    assert.deepEqual(edited.snapshot.periodComparison.periods.baseline.rows, prior.preview.snapshot.periodComparison.periods.baseline.rows);
    assert.deepEqual(edited.snapshot.periodComparison.periods.baseline.interactionCoverage, prior.preview.snapshot.periodComparison.periods.baseline.interactionCoverage);
    assert.deepEqual(edited.snapshot.periodComparison.comparison, prior.preview.snapshot.periodComparison.comparison);
    const omitted = await controller.preview("owner", undefined, { ...prior.options, overrides: [{ key: reply.key, omit: true }] }, undefined, value);
    assert.equal(omitted.snapshot.recordedContext.entries.find(entry => entry.key === reply.key).text, null);
    assert.deepEqual(omitted.snapshot.periodComparison.comparison, value.comparison);
});
