import test from "node:test";
import assert from "node:assert/strict";
import { createExportController } from "../lib/export.mjs";
import { executeAction } from "../lib/server.mjs";
import { createNativeRetainedViews } from "../lib/native-retained-views.mjs";
import { committedNativeReportFixture, preserveReportProof } from "./native-report-controller-fixture.mjs";
import { coworkFixture } from "./native-read-model-fixtures.mjs";
import { readSavedArtifactFile } from "../lib/report-artifacts.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nativePeriodSummary } from "../lib/period-comparison-math.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { projectRetainedNativeRecords } from "../lib/retained-population.mjs";
import { retainNativeChatSourceObservations } from "../lib/native-read-model.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { chatSource } from "./native-chat-source-fixtures.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { fixture } from "./helpers.mjs";
import { replaceEvidence, updateBoardState, loadBoardState } from "../lib/store.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { randomUUID } from "node:crypto";
import { renderPdf } from "../lib/pdf.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";

function datedCowork() {
    const records = coworkFixture();
    for (const [index, row] of records.filter(row => row.record.event === "ts").entries()) {
        const instant = index ? "2026-02-02T10:00:00.000Z" : "2026-02-01T10:00:00.000Z";
        row.record.data.ts = instant;
        row.qualifiedFields.observationTime = { availability: "recorded", scope: "observation",
            unit: "iso8601", basis: "cowork.data.ts", value: instant };
        row.evidenceReferences.observationTime = { sourceDocument: "invented-native-response",
            pointer: `/events/${row.ordering.recordOrdinal}/data/ts`, nativeEventId: row.record.id };
    }
    return records;
}

for (const mixed of [false, true]) test(`original bounded ${mixed ? "mixed" : "Microsoft"} period view reaches comparison, reviewed report and frozen files`, async t => {
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: datedCowork() });
    if (mixed) {
        const record = fixture("period-github");
        record.toolCalls[0].startedAt = "2026-02-01T10:00:00.000Z";
        await replaceEvidence(app.context, () => ({ records: [record], importCoverage: {} }));
    }
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const page = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-cowork"],
        analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const services = { nativeReportSource: app.services.nativeReportSource, nativeReportAdmission: app.services.nativeReportAdmission,
        sourceAware: true, nativeReportViewResolver: ({ viewId, nativeIds }) => ({ kind, revision }) =>
            views.resolveSelection({ schemaVersion: 1, viewId, nativeIds, kind, revision }, app.services.nativeReportAdmission) };
    const controller = createExportController(app.context);
    const input = { schemaVersion: 1, expectedRevision: page.revision, nativeViewId: page.allViewId,
        options: { layer: "tool", filters: { scope: "all", sources: mixed ? ["github-copilot", "microsoft-365-cowork"] : ["microsoft-365-cowork"] }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-02-01", to: "2026-02-01" }, later: { from: "2026-02-02", to: "2026-02-02" } },
        scenarioIds: mixed ? ["period-github"] : [], withinServices: [] };
    const compared = await executeAction(app.context, controller, app.owner, "get_period_comparison", input, services);
    await assert.rejects(executeAction(app.context, controller, app.owner, "get_period_comparison", input, {
        ...services, nativeReportViewResolver: binding => async scope => ({
            ...await services.nativeReportViewResolver(binding)(scope), frame: null,
        }),
    }), { status: 503 });
    assert.equal(compared.periods.baseline.rowIds.length, mixed ? 1 : 0, "Native calls are not pooled into GitHub counts.");
    assert.deepEqual(compared.nativePeriods.summary.map(item => [item.baseline.count, item.later.count, item.undated]), [[1, 1, 1]]);
    assert.doesNotMatch(JSON.stringify(compared.nativePeriods), /invented-tenant|invented-subject|nativeCallId|sourceScope/);
    const forged = structuredClone(compared);
    forged.nativePeriods.rows[0].startedAt = "2026-02-02T10:00:00.000Z";
    forged.nativePeriods.summary = nativePeriodSummary(forged.nativePeriods.rows,
        { baseline: forged.periods.baseline.dateRange, later: forged.periods.later.dateRange });
    await assert.rejects(controller.preview(app.owner, undefined, { promptMode: "none" }, undefined, forged, services), /differs from the accepted/);
    const { nativeViewId, ...missingView } = input;
    await assert.rejects(executeAction(app.context, controller, app.owner, "get_period_comparison",
        { ...missingView, options: { ...input.options, filters: { scope: "all" } } }, services),
    { code: "NATIVE_PERIOD_COMPARISON_UNAVAILABLE" });
    const preview = await controller.preview(app.owner, undefined,
        { promptMode: "original", formats: ["html", "json", "markdown", "pdf"], timeContext: input.options.timeContext },
        undefined, compared, services);
    assert.equal(preview.snapshot.periodComparison.schemaVersion, 2);
    assert.match(preview.previewHtml, /Microsoft activity/);
    assert.match(preview.files["product-report.md"], /Undated/);
    assert.deepEqual(preview.snapshot.periodComparison.nativePeriods, compared.nativePeriods);
    for (const output of [preview.previewHtml, preview.files["product-report.md"]]) {
        assert.equal(output.split(createReportComparison().resultBoundary).length - 1, 1, "The result qualification appears once across both period sections");
        assert.doesNotMatch(output, /1 additional calls|changed typed result facts|structured result facts/);
    }
    assert.doesNotMatch(JSON.stringify(preview.snapshot), new RegExp(input.nativeViewId));
    if (!mixed) await preserveReportProof("native-period-report", preview);
    await controller.review(app.owner, preview.previewId, true, input.options.timeContext, services);
    const saved = (await controller.confirm(app.owner, preview.previewId, true, input.options.timeContext, services)).bundle;
    assert.equal(saved.reportType, "period-comparison");
    await services.nativeReportSource.readSaved({ bundleIds: [saved.bundleId] }, services.nativeReportAdmission, async state => {
        const json = await readSavedArtifactFile(app.context, state, saved.bundleId, "report", "json");
        assert.deepEqual(JSON.parse(json.bytes).periodComparison.nativePeriods, compared.nativePeriods);
    });

});

test("Chat source message dates compare observations without manufacturing call clocks or GitHub denominators", () => {
        const source = chatSource({ messageId: "dated-report-chat", storageMessageId: "dated-report-storage",
            author: "user", messageType: "Chat", text: "A retained message." });
        const [row] = retainNativeChatSourceObservations(decodeNativeChatObservation(source));
        row.record.createdAt = "2026-02-01T23:30:00-08:00";
        row.qualifiedFields.messageCreatedAt = { scope: "message", availability: "recorded", value: row.record.createdAt };
        row.evidenceReferences.messageCreatedAt = { sourceDocument: row.chatSource.source.sourceDocument,
            pointer: `${row.chatSource.source.pointer}/createdAt`, nativeEventId: row.record.messageId };
        const nativeRecords = projectRetainedNativeRecords([row]).records, state = qualityDisplayFixture().state;
        const input = { schemaVersion: 1, expectedRevision: state.revision, nativeViewId: "a".repeat(64), scenarioIds: [],
            options: { layer: "tool", filters: { scope: "all", sources: ["microsoft-365-chat"] }, timeContext: { timeZone: "UTC", locale: "en-US" } },
            periods: { baseline: { from: "2026-02-01", to: "2026-02-01" }, later: { from: "2026-02-02", to: "2026-02-02" } }, withinServices: [] };
        const value = buildPeriodComparison(state, input, { nativeRecords });
        assert.equal(value.nativePeriods.rows[0].startedAt, "2026-02-02T07:30:00.000Z");
        assert.deepEqual(value.nativePeriods.summary.map(item => [item.unit, item.baseline.count, item.later.count, item.undated]),
            [["message-representation-observation", 0, 1, 0]]);
        assert.equal(value.comparison.outcomes.baseline.count, 0);
        assert.equal(value.comparison.outcomes.later.count, 0);
});

test("refined period resolver retains exact Search rows across explicitly replaced date windows", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: datedCowork() });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const options = { layer: "tool", groupBy: "tool", filters: { scope: "all", sources: ["microsoft-365-cowork"] },
        timeContext: { timeZone: "UTC", locale: "en-US" } };
    const base = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-cowork"],
        analytics: { ...options, filters: { ...options.filters, from: "2026-02-01", to: "2026-02-01" } },
        page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const searched = await views.analyze({ schemaVersion: 1, revision: base.revision, viewId: base.viewId,
        query: "CallGraph", types: ["action"], page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    assert.equal(searched.aggregates.selectedRows, 1);
    const input = { schemaVersion: 1, viewId: searched.viewId, revision: searched.revision, options,
        datePolicy: "replace-original-dates",
        periods: { baseline: { from: "2026-02-01", to: "2026-02-01" }, later: { from: "2026-02-02", to: "2026-02-02" } } };
    const resolved = await views.resolvePeriods(input, app.services.nativeReportAdmission);
    assert.equal(resolved.kind, "periods");
    assert.equal(resolved.membership.rowIds.baseline.length, 1);
    assert.equal(resolved.membership.rowIds.later.length, 0);
    assert.equal(resolved.membership.rowIds.undated.length, 0);
    assert.equal(resolved.frame.originalViewExpectations.length, 1, "The complete parent frame is context, not three matching calls.");
    await assert.rejects(views.resolvePeriods({ ...input, options: { ...options, filters: { ...options.filters, tools: ["different"] } } },
        app.services.nativeReportAdmission), { code: "NATIVE_VIEW_PERIOD_SCOPE_CHANGED" });
    const services = { nativeReportSource: app.services.nativeReportSource, nativeReportAdmission: app.services.nativeReportAdmission,
        sourceAware: true, nativeReportViewResolver: ({ viewId, nativeIds }) => scope => scope.kind === "periods"
            ? views.resolvePeriods({ schemaVersion: 1, viewId, revision: scope.revision, options: scope.options,
                periods: scope.periods, datePolicy: scope.datePolicy }, app.services.nativeReportAdmission)
            : views.resolveSelection({ schemaVersion: 1, viewId, nativeIds, kind: scope.kind, revision: scope.revision }, app.services.nativeReportAdmission) };
    const controller = createExportController(app.context);
    const compared = await executeAction(app.context, controller, app.owner, "get_period_comparison",
        { schemaVersion: 1, expectedRevision: input.revision, nativeViewId: input.viewId, nativeViewKind: "current",
            options, periods: input.periods, scenarioIds: [], withinServices: [] }, services);
    assert.equal(compared.nativePeriods.schemaVersion, 2);
    assert.deepEqual(compared.nativePeriods.summary.map(item => [item.baseline.count, item.later.count, item.undated]), [[1, 0, 0]]);
    const altered = structuredClone(compared);
    altered.nativePeriods.refinement.predicateRef = "native-predicate-" + "0".repeat(16);
    await assert.rejects(controller.preview(app.owner, undefined, { promptMode: "none", timeContext: options.timeContext },
        undefined, altered, services), /differs from the accepted/);
    const prepared = await controller.preview(app.owner, undefined,
        { promptMode: "none", formats: ["html", "json", "markdown", "pdf"], timeContext: options.timeContext }, undefined, compared, services);
    assert.equal(prepared.snapshot.nativeEvidence.conversations[0].calls.length, 3);
    assert.equal(prepared.snapshot.periodComparison.nativePeriods.rows.length, 1);
    const document = getDocument({ data: new Uint8Array(Buffer.from(prepared.files["product-report.pdf"].data, "base64")) });
    try {
        const pdf = await document.promise, pages = [];
        for (let index = 1; index <= pdf.numPages; index++) pages.push((await (await pdf.getPage(index)).getTextContent()).items.map(item => item.str ?? "").join(" "));
        assert.match(pages.join(" "), /the original Search, group and other source filters are preserved/);
    } finally { await document.destroy(); }
    await preserveReportProof("native-refined-period-report", prepared);
    await controller.review(app.owner, prepared.previewId, true, options.timeContext, services);
    const saved = (await controller.confirm(app.owner, prepared.previewId, true, options.timeContext, services)).bundle;
    await services.nativeReportSource.readSaved({ bundleIds: [saved.bundleId] }, services.nativeReportAdmission, async state => {
        const json = await readSavedArtifactFile(app.context, state, saved.bundleId, "report", "json");
        assert.deepEqual(JSON.parse(json.bytes).periodComparison.nativePeriods, compared.nativePeriods);
    });
});

test("refined periods replace only Dates, retain undated matches, and accept an empty group window", async t => {
    const app = await committedNativeReportFixture(t, { envelopes: datedCowork() });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const options = { layer: "tool", groupBy: "tool", filters: { scope: "all", sources: ["microsoft-365-cowork"] },
        timeContext: { timeZone: "UTC", locale: "en-US" } };
    const base = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-cowork"],
        analytics: { ...options, filters: { ...options.filters, from: "2026-02-01", to: "2026-02-01" } },
        page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const broad = await views.analyze({ schemaVersion: 1, revision: base.revision, viewId: base.viewId,
        query: "mcp", types: ["action"], page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    assert.equal(broad.aggregates.selectedRows, 1);
    const input = { schemaVersion: 1, viewId: broad.viewId, revision: base.revision, options,
        datePolicy: "replace-original-dates",
        periods: { baseline: { from: "2026-02-01", to: "2026-02-01" }, later: { from: "2026-02-02", to: "2026-02-02" } } };
    const expanded = await views.resolvePeriods(input, app.services.nativeReportAdmission);
    assert.deepEqual(Object.values(expanded.membership.rowIds).map(ids => ids.length), [1, 1, 1]);
    const grouped = await views.drilldown({ schemaVersion: 1, revision: base.revision, viewId: base.viewId,
        groupId: base.grouping.groups[0].id, page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const group = await views.resolvePeriods({ ...input, viewId: grouped.viewId }, app.services.nativeReportAdmission);
    assert.deepEqual(Object.values(group.membership.rowIds).map(ids => ids.length), [1, 0, 0]);
    await assert.rejects(views.resolvePeriods({ ...input, datePolicy: "all" }, app.services.nativeReportAdmission), { code: "NATIVE_VIEW_INPUT_INVALID" });
    await assert.rejects(views.resolvePeriods(input, { ...app.services.nativeReportAdmission, owner: "foreign-period-owner" }),
        { code: "NATIVE_VIEW_SELECTION_STALE" });
    await assert.rejects(views.resolvePeriods({ ...input, viewId: base.allViewId }, app.services.nativeReportAdmission),
        { code: "NATIVE_VIEW_SELECTION_STALE" });
    await updateBoardState(app.context, state => { state.continuation = "Changed source after refined receipt"; });
    await assert.rejects(views.resolvePeriods(input, app.services.nativeReportAdmission), { code: "NATIVE_REPORT_SOURCE_STALE" });
});

test("conversation-only Search remains explicit context, not a fabricated message-date cohort", async t => {
    const [row] = retainNativeChatSourceObservations(decodeNativeChatObservation(chatSource({
        messageId: "refined-context-message", storageMessageId: "refined-context-storage",
        author: "user", messageType: "Chat", text: "Context-only search phrase.",
    })));
    row.record.createdAt = "2026-02-01T10:00:00Z";
    row.qualifiedFields.messageCreatedAt = { scope: "message", availability: "recorded", value: row.record.createdAt };
    row.evidenceReferences.messageCreatedAt = { sourceDocument: row.chatSource.source.sourceDocument,
        pointer: `${row.chatSource.source.pointer}/createdAt`, nativeEventId: row.record.messageId };
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: [row] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const options = { layer: "tool", filters: { scope: "all", sources: ["microsoft-365-chat"] },
        timeContext: { timeZone: "UTC", locale: "en-US" } };
    const base = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-chat"],
        analytics: options, page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const searched = await views.analyze({ schemaVersion: 1, revision: base.revision, viewId: base.viewId,
        query: "Context-only search phrase", types: ["interaction"], page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const services = { nativeReportSource: app.services.nativeReportSource, nativeReportAdmission: app.services.nativeReportAdmission,
        sourceAware: true, nativeReportViewResolver: ({ viewId }) => scope => views.resolvePeriods({
            schemaVersion: 1, viewId, revision: scope.revision, options: scope.options,
            periods: scope.periods, datePolicy: scope.datePolicy }, app.services.nativeReportAdmission) };
    const controller = createExportController(app.context);
    const value = await executeAction(app.context, controller, app.owner, "get_period_comparison", {
        schemaVersion: 1, expectedRevision: searched.revision, nativeViewId: searched.viewId, nativeViewKind: "current",
        options, periods: { baseline: { from: "2026-02-01", to: "2026-02-01" }, later: { from: "2026-02-02", to: "2026-02-02" } },
        scenarioIds: [], withinServices: [],
    }, services);
    assert.deepEqual(value.nativePeriods.rows, []);
    assert.equal(value.nativePeriods.refinement.contextConversationRefs.length, 1);
    const prepared = await controller.preview(app.owner, undefined,
        { promptMode: "none", formats: ["html", "json", "markdown"], timeContext: options.timeContext }, undefined, value, services);
    assert.equal(prepared.snapshot.nativeEvidence.selection.contextOnlyRefs.length, 1);
    assert.match(prepared.previewHtml, /1 matching conversation is context-only; exact message-date cohorts are not established/);
    assert.match(prepared.files["product-report.md"], /exact message-date cohorts are not established/);
    await controller.review(app.owner, prepared.previewId, true, options.timeContext, services);
    const saved = (await controller.confirm(app.owner, prepared.previewId, true, options.timeContext, services)).bundle;
    assert.ok(saved.nativeEvidenceHash);
});

test("refined returned-result periods retain only the matching result, using its own observation clock", async t => {
    const envelopes = datedCowork(), completed = envelopes.find(row => row.record.id === "seq:8");
    completed.outcomes.nestedApi = { unit: "nested-api-result", availability: "recorded", declaredRequestCount: 20,
        declaredRequestCountIsSuccessDenominator: false, observed: [200, 403].map((statusCode, index) => ({
            index, indexKind: "response-array-position", statusCode, errorCode: null, paginationPresent: null, evidenceLevel: "intermediary-reported",
        })) };
    completed.record.data.ts = "2026-02-02T10:00:00.000Z";
    completed.qualifiedFields.observationTime = { availability: "recorded", scope: "observation", unit: "iso8601",
        basis: "cowork.data.ts", value: completed.record.data.ts };
    completed.evidenceReferences.observationTime = { sourceDocument: "invented-native-response",
        pointer: `/events/${completed.ordering.recordOrdinal}/data/ts`, nativeEventId: completed.record.id };
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const options = { layer: "reported-api", filters: { scope: "all", sources: ["microsoft-365-cowork"] },
        timeContext: { timeZone: "UTC", locale: "en-US" } };
    const base = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-cowork"],
        analytics: options, page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const searched = await views.analyze({ schemaVersion: 1, revision: base.revision, viewId: base.viewId,
        query: "403", types: ["action"], page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    assert.equal(searched.aggregates.selectedRows, 1);
    const periods = { baseline: { from: "2026-02-01", to: "2026-02-01" }, later: { from: "2026-02-02", to: "2026-02-02" } };
    const resolved = await views.resolvePeriods({ schemaVersion: 1, revision: base.revision, viewId: searched.viewId,
        options, periods, datePolicy: "replace-original-dates" }, app.services.nativeReportAdmission);
    const value = buildPeriodComparison(await loadBoardState(app.context), { schemaVersion: 1, expectedRevision: base.revision,
        nativeViewId: searched.viewId, nativeViewKind: "current", options, periods, scenarioIds: [], withinServices: [] },
    { nativeRecords: app.services.nativeRecords, nativeMembership: resolved.membership });
    assert.deepEqual(value.nativePeriods.summary.map(item => [item.unit, item.baseline.count, item.later.count, item.later.failure, item.undated]),
        [["native-returned-result-observation", 0, 1, 1, 0]]);
    assert.equal(value.nativePeriods.rows.length, 1, "Neither its sibling result nor the parent call becomes a matching result.");
});

async function emptyNativeMixedPeriod(t, formats = ["html", "json", "markdown"], segmented = true) {
    const app = await committedNativeReportFixture(t, { segmented, envelopes: datedCowork() });
    const github = [fixture("empty-native-a"), fixture("empty-native-b")];
    for (const [index, record] of github.entries()) record.toolCalls[0].startedAt = `2026-02-0${index + 5}T10:00:00.000Z`;
    await replaceEvidence(app.context, () => ({ records: github, importCoverage: {} }));
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const options = { layer: "tool", filters: { scope: "all", sources: ["github-copilot", "microsoft-365-cowork"] },
        timeContext: { timeZone: "UTC", locale: "en-US" } };
    const base = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-cowork"],
        analytics: options, page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const searched = await views.analyze({ schemaVersion: 1, revision: base.revision, viewId: base.viewId,
        query: "CallGraph", types: ["action"], page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    assert.equal(searched.aggregates.selectedRows, 1, "The retained native match exists, but outside both windows.");
    const services = { nativeReportSource: app.services.nativeReportSource, nativeReportAdmission: app.services.nativeReportAdmission,
        sourceAware: true, nativeReportViewResolver: ({ viewId }) => scope => views.resolvePeriods({
            schemaVersion: 1, viewId, revision: scope.revision, options: scope.options,
            periods: scope.periods, datePolicy: scope.datePolicy }, app.services.nativeReportAdmission) };
    const controller = createExportController(app.context);
    const value = await executeAction(app.context, controller, app.owner, "get_period_comparison", {
        schemaVersion: 1, expectedRevision: base.revision, nativeViewId: searched.viewId, nativeViewKind: "current",
        options, periods: { baseline: { from: "2026-02-05", to: "2026-02-05" }, later: { from: "2026-02-06", to: "2026-02-06" } },
        scenarioIds: github.map(record => record.scenarioId), withinServices: [],
    }, services);
    assert.deepEqual(value.nativePeriods.rows, []);
    assert.deepEqual(value.nativePeriods.refinement.contextConversationRefs, []);
    assert.deepEqual(Object.values(value.periods).map(side => side.rowIds.length), [1, 1]);
    const prepared = await controller.preview(app.owner, undefined,
        { promptMode: "none", formats, timeContext: options.timeContext }, undefined, value, services);
    return { ...app, services, controller, prepared, options, value, views, base, github };
}

async function advanceNativeRoot(app) {
    const envelopes = datedCowork();
    for (const row of envelopes) row.capture.captureId = "later-empty-source-capture";
    const pending = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.services.nativeReportAdmission);
    await app.persistence.commitSegmented(pending.ticket, envelopes);
    app.persistence.retire(pending.ticket);
}

for (const segmented of [false, true]) test(`empty native v${segmented ? 2 : 1} refined membership still saves through source authority and installs an account binding`, async t => {
    const app = await emptyNativeMixedPeriod(t, undefined, segmented);
    await app.controller.review(app.owner, app.prepared.previewId, true, app.options.timeContext, app.services);
    const saved = (await app.controller.confirm(app.owner, app.prepared.previewId, true, app.options.timeContext, app.services)).bundle;
    const state = await loadBoardState(app.context), entry = state.exports.find(item => item.bundleId === saved.bundleId);
    assert.ok(entry.nativeSourceBinding, "An empty native predicate remains account-bound; it is not a GitHub-only report.");
    assert.equal(app.prepared.snapshot.nativeEvidence.schemaVersion, 2);
    assert.equal(app.prepared.snapshot.nativeEvidence.conversations.length, 0);
    assert.ok(app.prepared.snapshot.nativeEvidence.populations.every(population => population.count === 0));
    assert.ok(app.prepared.snapshot.records.every(record => record.recordKind !== "native-conversation"));
    await assert.rejects(readSavedArtifactFile(app.context, state, saved.bundleId, "report", "json"), { status: 403 });
    await app.services.nativeReportSource.readSaved({ bundleIds: [saved.bundleId] }, app.services.nativeReportAdmission, async visible => {
        const json = await readSavedArtifactFile(app.context, visible, saved.bundleId, "report", "json");
        assert.deepEqual(JSON.parse(json.bytes).nativeEvidence, app.prepared.snapshot.nativeEvidence);
    });
});

for (const phase of ["review", "commit"]) test(`empty native source dependency keeps its original bound root across collection at ${phase}`, async t => {
    const app = await emptyNativeMixedPeriod(t);
    if (phase === "commit") await app.controller.review(app.owner, app.prepared.previewId, true, app.options.timeContext, app.services);
    await advanceNativeRoot(app);
    if (phase === "review") await app.controller.review(app.owner, app.prepared.previewId, true, app.options.timeContext, app.services);
    const saved = await app.controller.confirm(app.owner, app.prepared.previewId, true, app.options.timeContext, app.services);
    const state = await loadBoardState(app.context);
    assert.ok(state.exports[0].nativeSourceBinding);
    await app.services.nativeReportSource.readSaved({ bundleIds: [saved.bundle.bundleId] }, app.services.nativeReportAdmission, async visible => {
        const json = await readSavedArtifactFile(app.context, visible, saved.bundle.bundleId, "report", "json");
        assert.deepEqual(JSON.parse(json.bytes).nativeEvidence, app.prepared.snapshot.nativeEvidence);
        assert.equal(JSON.parse(json.bytes).nativeEvidence.conversations.length, 0);
    });
});

test("empty native source dependency stays bound while collection advances during PDF preparation", async t => {
    const app = await emptyNativeMixedPeriod(t);
    const controller = createExportController(app.context, () => assert.fail("Preparation cannot write a report."), async html => {
        await advanceNativeRoot(app);
        return renderPdf(html);
    });
    const prepared = await controller.preview(app.owner, undefined,
        { promptMode: "none", formats: ["pdf"], timeContext: app.options.timeContext }, undefined, app.value, app.services);
    for (const key of ["schemaVersion", "definition", "source", "selection", "populations", "conversations", "disclosure", "coverage"]) {
        assert.deepEqual(prepared.snapshot.nativeEvidence[key], app.prepared.snapshot.nativeEvidence[key]);
    }
    assert.ok(prepared.files["product-report.pdf"]);
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});

test("empty native refinement cannot downgrade an unqualified null-frame producer to GitHub-only saving", async t => {
    const app = await emptyNativeMixedPeriod(t);
    const services = { ...app.services, nativeReportViewResolver: binding => async scope => ({
        ...await app.services.nativeReportViewResolver(binding)(scope), frame: null,
    }) };
    await assert.rejects(app.controller.preview(app.owner, undefined,
        { promptMode: "none", timeContext: app.options.timeContext }, undefined, app.value, services),
    { status: 503 });
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});

test("portable refined period output names its pseudonymous predicate commitment", async t => {
    const app = await emptyNativeMixedPeriod(t, ["html", "json", "markdown", "pdf"]);
    const predicate = app.value.nativePeriods.refinement.predicateRef;
    assert.ok(predicate);
    assert.ok(app.prepared.previewHtml.includes(predicate), "HTML must distinguish otherwise identical predicate scopes.");
    assert.ok(app.prepared.files["product-report.md"].includes(predicate), "Markdown must retain the same scope commitment.");
    const document = getDocument({ data: new Uint8Array(Buffer.from(app.prepared.files["product-report.pdf"].data, "base64")) });
    try {
        const pdf = await document.promise, pages = [];
        for (let index = 1; index <= pdf.numPages; index++) pages.push((await (await pdf.getPage(index)).getTextContent()).items.map(item => item.str ?? "").join(" "));
        assert.ok(pages.join(" ").replace(/\s/g, "").includes(predicate), "Actual PDF must preserve the same portable predicate identity.");
    } finally { await document.destroy(); }
    const other = await app.views.analyze({ schemaVersion: 1, revision: app.base.revision, viewId: app.base.viewId,
        query: "MoveMessage", types: ["action"], page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const value = await executeAction(app.context, app.controller, app.owner, "get_period_comparison", {
        schemaVersion: 1, expectedRevision: app.base.revision, nativeViewId: other.viewId, nativeViewKind: "current",
        options: app.options, periods: { baseline: app.value.periods.baseline.range, later: app.value.periods.later.range },
        scenarioIds: app.github.map(record => record.scenarioId), withinServices: [],
    }, app.services);
    assert.deepEqual(value.nativePeriods.rows, app.value.nativePeriods.rows);
    assert.deepEqual(value.nativePeriods.refinement.contextConversationRefs, app.value.nativePeriods.refinement.contextConversationRefs);
    assert.notEqual(value.nativePeriods.refinement.predicateRef, predicate);
    const next = await app.controller.preview(app.owner, undefined,
        { promptMode: "none", formats: ["html", "markdown"], timeContext: app.options.timeContext }, undefined, value, app.services);
    assert.ok(next.previewHtml.includes(value.nativePeriods.refinement.predicateRef));
    assert.ok(next.files["product-report.md"].includes(value.nativePeriods.refinement.predicateRef));
});
