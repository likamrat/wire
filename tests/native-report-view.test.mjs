import test from "node:test";
import assert from "node:assert/strict";
import { createExportController, takeNativeSaveRefusal, writeBundle } from "../lib/export.mjs";
import { createNativeRetainedViews } from "../lib/native-retained-views.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { committedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { fixture } from "./helpers.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readSavedArtifactFile } from "../lib/report-artifacts.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "node:path";

const query = analytics => ({
    schemaVersion: 1, revision: null, sources: ["microsoft-365-chat", "microsoft-365-cowork"],
    analytics: analytics ?? { layer: "tool", filters: { scope: "all" } },
    page: { limit: 1, after: null },
});
function servicesFor(app, views, viewId, nativeIds = []) {
    return {
        nativeReportSource: app.services.nativeReportSource,
        nativeReportAdmission: app.services.nativeReportAdmission,
        resolveNativeReportView: ({ kind, revision }) => views.resolveSelection({
            schemaVersion: 1, viewId, nativeIds, kind, revision,
        }, app.services.nativeReportAdmission),
    };
}

test("native publication accepts exact local-save intent without a fabricated disclosure review", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const page = await views.query(query(), app.services.nativeReportAdmission);
    const services = servicesFor(app, views, page.viewId), controller = createExportController(app.context);
    const preview = await controller.preview(app.owner, undefined,
        { promptMode: "masked", formats: ["html", "json"], saveMode: "local" },
        { kind: "current", revision: page.revision, scenarioIds: [] }, undefined, services);
    assert.equal(preview.privacy.reviewerConfirmed, false);
    const saved = await controller.confirm(app.owner, preview.previewId, true, undefined,
        { ...services, localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false } });
    assert.equal(saved.bundle.privacyReview.reviewerConfirmed, false);
    assert.equal(saved.bundle.savePolicy, "local-save-v1");
    assert.equal(saved.bundle.privacyReview.localSave.method, "explicit-local-save");
    assert.deepEqual(await readFile(saved.bundle.files["product-report.html"]), Buffer.from(preview.files["product-report.html"]));
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined,
        { ...services, localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false } }), /Preview not found/);
});

test("prepared native reports publish their exact original root while later captures continue", async t => {
    for (const segmented of [false, true]) {
        const envelopes = [...chatFixture(), ...coworkFixture()];
        const app = await committedNativeReportFixture(t, { segmented, envelopes });
        const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
        t.after(() => views.close());
        const page = await views.query(query(), app.services.nativeReportAdmission);
        const services = servicesFor(app, views, page.viewId), controller = createExportController(app.context);
        const preview = await controller.preview(app.owner, undefined, { promptMode: "original", recordedContext: true, formats: ["html", "json"] },
            { kind: "current", revision: page.revision, scenarioIds: [] }, undefined, services);
        const advance = async suffix => {
            const more = chatFixture();
            for (const row of more) row.scope.conversationId += suffix;
            envelopes.push(...more);
            const next = await (segmented ? app.persistence.beginSegmented : app.persistence.begin)({ operationId: randomUUID() }, app.services.nativeReportAdmission);
            await (segmented ? app.persistence.commitSegmented : app.persistence.commit)(next.ticket, envelopes);
            app.persistence.retire(next.ticket);
        };
        await advance("-after-preparation");
        const reviewed = await controller.review(app.owner, preview.previewId, true, undefined, services);
        assert.deepEqual(reviewed.snapshot, preview.snapshot);
        await advance("-after-review");
        const saved = await controller.confirm(app.owner, preview.previewId, true, undefined, services);
        assert.equal(saved.bundle.selectionScope.nativeConversations, 2);
        assert.equal((await views.query(query(), app.services.nativeReportAdmission)).aggregates.conversations, 4);
        for (const [name, contents] of Object.entries(reviewed.files)) {
            assert.deepEqual(await readFile(saved.bundle.files[name]), Buffer.from(contents));
        }
        await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, services), { status: 409 });
    }
});

test("prepared reports keep their original source after its collection receipt is archived", { timeout: 120000 }, async t => {
    const envelopes = [...chatFixture(), ...coworkFixture()];
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes });
    const originalState = await loadBoardState(app.context);
    const operationId = originalState.nativeRetention.partitions[0].lastOperationId;
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const page = await views.query(query(), app.services.nativeReportAdmission);
    const services = servicesFor(app, views, page.viewId), controller = createExportController(app.context);
    const preview = await controller.preview(app.owner, undefined,
        { promptMode: "original", recordedContext: true, formats: ["html", "json"] },
        { kind: "current", revision: page.revision, scenarioIds: [] }, undefined, services);
    const reviewed = await controller.review(app.owner, preview.previewId, true, undefined, services);
    const added = chatFixture();
    for (const row of added) row.scope.conversationId += "-after-prepared-archive-proof";
    for (let cycle = 0; cycle < 129; cycle++) {
        const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.services.nativeReportAdmission);
        const receipt = await app.persistence.commitSegmented(begun.ticket, cycle === 0 ? [...envelopes, ...added] : []);
        assert.equal(receipt.status, "committed");
        await app.persistence.retire(begun.ticket);
    }
    const current = await loadBoardState(app.context);
    assert.ok(current.nativeRetention.receiptArchive);
    assert.equal(current.nativeRetention.receipts.some(receipt => receipt.operationId === operationId), false);
    assert.equal((await app.persistence.status({ operationId }, app.services.nativeReportAdmission)).receipt.status, "committed");
    const saved = await controller.confirm(app.owner, preview.previewId, true, undefined, services);
    assert.equal(saved.bundle.selectionScope.nativeConversations, 2);
    assert.equal((await views.query(query(), app.services.nativeReportAdmission)).aggregates.conversations, 3);
    for (const [name, contents] of Object.entries(reviewed.files)) {
        assert.deepEqual(await readFile(saved.bundle.files[name]), Buffer.from(contents));
    }
});

test("native save refusal is original-owner proof only before entering the publication writer", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const prepare = async controller => {
        const page = await views.query(query(), app.services.nativeReportAdmission);
        const services = servicesFor(app, views, page.viewId);
        const preview = await controller.preview(app.owner, undefined, { promptMode: "none", formats: ["json"] },
            { kind: "current", revision: page.revision, scenarioIds: [] }, undefined, services);
        await controller.review(app.owner, preview.previewId, true, undefined, services);
        return { preview, services };
    };
    const controller = createExportController(app.context, () => assert.fail("A refused original source must not enter the writer"));
    const { preview, services } = await prepare(controller);
    const status = await app.persistence.status({}, app.services.nativeReportAdmission);
    await app.persistence.configure({ expectedRevision: status.configuration.configurationRevision,
        surfaces: ["chat", "cowork"], windowDays: 7 }, app.services.nativeReportAdmission);
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, services), error => {
        assert.equal(takeNativeSaveRefusal(error, controller, app.context, "foreign-owner", preview.previewId), null);
        assert.equal(takeNativeSaveRefusal(error, controller, app.context, app.owner, "foreign-preview"), null);
        assert.deepEqual(takeNativeSaveRefusal(error, controller, app.context, app.owner, preview.previewId),
            { outcome: "not-published", kind: "report", previewId: preview.previewId, bundleId: preview.bundleId });
        assert.equal(takeNativeSaveRefusal(error, controller, app.context, app.owner, preview.previewId), null);
        return true;
    });
    const uncertain = createExportController(app.context, async (...args) => {
        await writeBundle(...args);
        throw Object.assign(new Error("Fixture writer reply failed after file effects."), { status: 403 });
    });
    const next = await prepare(uncertain);
    await assert.rejects(uncertain.confirm(app.owner, next.preview.previewId, true, undefined, next.services), error => {
        assert.equal(error.code, "NATIVE_REPORT_SAVE_UNCONFIRMED");
        assert.equal(takeNativeSaveRefusal(error, uncertain, app.context, app.owner, next.preview.previewId), null);
        return true;
    });
});

for (const segmented of [false, true]) test(`v${segmented ? 2 : 1} controller resolves complete native All/Current membership independently of page and GitHub IDs`, async t => {
    const app = await committedNativeReportFixture(t, { segmented, envelopes: [...chatFixture(), ...coworkFixture()] });
    await replaceEvidence(app.context, () => ({ records: [fixture("github-one"), fixture("github-two")], importCoverage: {} }));
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const page = await views.query(query(), app.services.nativeReportAdmission);
    assert.equal(page.page.items.length, 1);
    assert.equal(page.aggregates.conversations, 2);
    const before = await loadBoardState(app.context);
    app.services.nativeReportAdmission.dispatched = () => {
        throw Object.assign(new Error("Source route retains its native Save gate."), { status: 503, code: "NATIVE_REPORT_SAVE_UNAVAILABLE" });
    };
    const controller = createExportController(app.context, () => assert.fail("View receipts cannot authorize a native save"));
    for (const kind of ["current", "all"]) {
        const services = servicesFor(app, views, kind === "all" ? page.allViewId : page.viewId);
        const selection = { kind, revision: page.revision, ...(kind === "current" ? { scenarioIds: ["github-one"] } : {}) };
        const preview = await controller.preview(app.owner, undefined, { promptMode: "none", formats: ["json"] },
            selection, undefined, services);
        assert.equal(preview.snapshot.selectionScope.kind, kind);
        assert.equal(preview.snapshot.selectionScope.nativeConversations, 2);
        assert.equal(preview.snapshot.selectionScope.requestGroups, kind === "all" ? 2 : 1);
        assert.equal(preview.snapshot.nativeEvidence.conversations.length, 2);
        assert.equal(preview.snapshot.records.filter(record => record.recordKind !== "native-conversation").length, kind === "all" ? 2 : 1);
        assert.equal(Object.hasOwn(preview.snapshot, "evaluationFacts"), false);
        assert.doesNotMatch(JSON.stringify(preview), /originalViewExpectations|nativeSourceBinding|rootHash|selectionRef/);
        assert.equal(JSON.stringify(preview).includes(page.viewId), false);
        assert.equal(JSON.stringify(preview).includes(page.allViewId), false);
        assert.equal(JSON.stringify(preview).includes(page.sourceRevision), false);
        await controller.review(app.owner, preview.previewId, true, undefined, services);
        await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, services),
            { status: 503, code: "NATIVE_REPORT_SAVE_UNAVAILABLE" });
    }
    assert.deepEqual(await loadBoardState(app.context), before);
});

test("native-only Current and explicit Selected views need no fake GitHub IDs or canonical page records", async t => {
    const app = await committedNativeReportFixture(t, { envelopes: [...chatFixture(), ...coworkFixture()] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const page = await views.query(query(), app.services.nativeReportAdmission);
    const controller = createExportController(app.context);
    for (const kind of ["current", "selected"]) {
        const services = servicesFor(app, views, page.viewId, kind === "selected" ? [page.page.items[0].id] : []);
        const preview = await controller.preview(app.owner, undefined, { promptMode: "none" },
            { kind, revision: page.revision, scenarioIds: [] }, undefined, services);
        assert.equal(preview.snapshot.selectionScope.requestGroups, 0);
        assert.equal(preview.snapshot.selectionScope.nativeConversations, kind === "selected" ? 1 : 2);
        assert.equal(preview.snapshot.nativeEvidence.conversations.length, kind === "selected" ? 1 : 2);
        assert.equal(Object.hasOwn(preview.snapshot.nativeEvidence, "githubEvaluationFacts"), false);
    }
    const services = servicesFor(app, views, page.viewId);
    await assert.rejects(controller.preview(app.owner, undefined, {}, { kind: "current", revision: page.revision, scenarioIds: [] },
        undefined, { ...services, nativeRecords: page.page.items }), { status: 422 });
    await assert.rejects(controller.preview(app.owner, undefined, {}, { kind: "current", revision: page.revision, scenarioIds: ["unknown-github-id"] },
        undefined, services), { status: 422 });
});

test("original filtered Current cannot be relabeled All and empty native membership keeps its source dependency", async t => {
    const app = await committedNativeReportFixture(t);
    await replaceEvidence(app.context, () => ({ records: [fixture("github-one")], importCoverage: {} }));
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const page = await views.query(query({ layer: "tool", filters: { from: "2026-01-01", to: "2026-12-31" } }),
        app.services.nativeReportAdmission);
    assert.equal(page.aggregates.conversations, 0);
    const services = servicesFor(app, views, page.viewId), controller = createExportController(app.context);
    const selection = { kind: "current", revision: page.revision, scenarioIds: ["github-one"] };
    const preview = await controller.preview(app.owner, undefined, { promptMode: "none" }, selection, undefined, services);
    assert.equal(preview.snapshot.nativeEvidence.schemaVersion, 2);
    assert.deepEqual(preview.snapshot.nativeEvidence.conversations, []);
    assert.equal(preview.snapshot.nativeEvidence.githubEvaluationFacts.metricProjectionVersion, 4);
    assert.equal(preview.snapshot.selectionScope.kind, "current");
    assert.equal(preview.snapshot.selectionScope.requestGroups, 1);
    await assert.rejects(controller.preview(app.owner, undefined, {}, { kind: "all", revision: page.revision }, undefined, services),
        { code: "NATIVE_VIEW_SELECTION_STALE" });
    const all = await controller.preview(app.owner, undefined, { promptMode: "none" },
        { kind: "all", revision: page.revision }, undefined, servicesFor(app, views, page.allViewId));
    assert.equal(all.snapshot.nativeEvidence.conversations.length, 1);
    const empty = await controller.preview(app.owner, undefined, { promptMode: "none", formats: ["json"] }, selection, undefined, services);
    await controller.review(app.owner, empty.previewId, true, undefined, services);
    const saved = await controller.confirm(app.owner, empty.previewId, true, undefined, services);
    assert.equal(typeof saved.bundle.nativeEvidenceHash, "string");
    assert.equal(Object.hasOwn(saved.bundle, "evaluationFactsHash"), false);
    assert.equal(saved.bundle.selectionScope.kind, "current");
    const state = await loadBoardState(app.context);
    assert.ok(state.exports[0].nativeSourceBinding);
    await assert.rejects(readSavedArtifactFile(app.context, state, saved.bundle.bundleId, "report", "json"), { status: 403 });
    await services.nativeReportSource.readSaved({ bundleIds: [saved.bundle.bundleId] }, services.nativeReportAdmission, async visible => {
        const file = await readSavedArtifactFile(app.context, visible, saved.bundle.bundleId, "report", "json");
        assert.deepEqual(JSON.parse(file.bytes).nativeEvidence, empty.snapshot.nativeEvidence);
    });
});

for (const kind of ["all", "current"]) for (const segmented of [false, true]) {
    test(`empty ${kind} v${segmented ? 2 : 1} source membership cannot lose authority before review or Save`, async t => {
        const app = await committedNativeReportFixture(t, { segmented });
        await replaceEvidence(app.context, () => ({ records: [fixture("github-one")], importCoverage: {} }));
        const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
        t.after(() => views.close());
        const page = await views.query({ ...query(), sources: ["microsoft-365-chat"] }, app.services.nativeReportAdmission);
        assert.equal(page.aggregates.conversations, 0);
        const services = servicesFor(app, views, kind === "all" ? page.allViewId : page.viewId);
        const selection = { kind, revision: page.revision, ...(kind === "current" ? { scenarioIds: ["github-one"] } : {}) };
        const controller = createExportController(app.context, () => assert.fail("Revoked empty membership must not enter the writer."));
        const options = { promptMode: "none", formats: ["json"] };
        await assert.rejects(controller.preview(app.owner, undefined, options, selection, undefined, {
            ...services, resolveNativeReportView: async scope => ({ ...await services.resolveNativeReportView(scope), frame: null }),
        }), { status: 503 });
        const preview = await controller.preview(app.owner, undefined, options, selection, undefined, services);
        assert.equal(preview.snapshot.nativeEvidence.schemaVersion, 2);
        assert.deepEqual(preview.snapshot.nativeEvidence.selection.conversationRefs, []);
        if (segmented) await controller.review(app.owner, preview.previewId, true, undefined, services);
        const status = await app.persistence.status({}, app.services.nativeReportAdmission);
        await app.persistence.configure({ expectedRevision: status.configuration.configurationRevision,
            surfaces: ["cowork"], windowDays: 7 }, app.services.nativeReportAdmission);
        const action = segmented ? "confirm" : "review";
        await assert.rejects(controller[action](app.owner, preview.previewId, true, undefined, services),
            { code: "NATIVE_REPORT_SOURCE_STALE" });
        assert.equal((await loadBoardState(app.context)).exports.length, 0);
    });
}

test("explicit GitHub-only Selected does not acquire an empty native report dependency", async t => {
    const app = await committedNativeReportFixture(t);
    await replaceEvidence(app.context, () => ({ records: [fixture("github-one")], importCoverage: {} }));
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const page = await views.query(query(), app.services.nativeReportAdmission);
    const services = servicesFor(app, views, page.viewId), controller = createExportController(app.context);
    const preview = await controller.preview(app.owner, undefined, { promptMode: "none", formats: ["json"] },
        { kind: "selected", revision: page.revision, scenarioIds: ["github-one"] }, undefined, services);
    assert.equal(Object.hasOwn(preview.snapshot, "nativeEvidence"), false);
    await controller.review(app.owner, preview.previewId, true, undefined, services);
    const saved = await controller.confirm(app.owner, preview.previewId, true, undefined, services);
    assert.equal(typeof saved.bundle.evaluationFactsHash, "string");
    assert.equal((await loadBoardState(app.context)).exports[0].nativeSourceBinding, undefined);
});

test("empty source scope stays frozen through collection, actual saved formats and account-bound Compare", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true });
    await replaceEvidence(app.context, () => ({ records: [fixture("github-one")], importCoverage: {} }));
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const controller = createExportController(app.context), formats = ["html", "json", "markdown", "pdf"];
    const options = { promptMode: "none", formats };
    const prepare = async title => {
        const page = await views.query({ ...query(), sources: ["microsoft-365-chat"] }, app.services.nativeReportAdmission);
        const services = servicesFor(app, views, page.allViewId);
        const preview = await controller.preview(app.owner, undefined, { ...options, title },
            { kind: "all", revision: page.revision }, undefined, services);
        return { preview, services };
    };
    const empty = await prepare("Invented empty Microsoft selection");
    assert.deepEqual(empty.preview.snapshot.nativeEvidence.conversations, []);
    assert.ok(empty.preview.snapshot.nativeEvidence.populations.every(population => population.count === 0));
    await assert.rejects(controller.confirm(app.owner, empty.preview.previewId, true, undefined, empty.services), /disclosure review/);
    assert.equal((await loadBoardState(app.context)).exports.length, 0);

    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.services.nativeReportAdmission);
    await app.persistence.commitSegmented(begun.ticket, [...coworkFixture(), ...chatFixture()]);
    app.persistence.retire(begun.ticket);
    const reviewed = await controller.review(app.owner, empty.preview.previewId, true, undefined, empty.services);
    assert.deepEqual(reviewed.snapshot, empty.preview.snapshot, "Later collection cannot fill an already prepared empty scope.");
    const savedEmpty = (await controller.confirm(app.owner, empty.preview.previewId, true, undefined, empty.services)).bundle;
    const later = await prepare("Invented later Microsoft selection");
    assert.equal(later.preview.snapshot.nativeEvidence.conversations.length, 1);
    const laterReviewed = await controller.review(app.owner, later.preview.previewId, true, undefined, later.services);
    const savedLater = (await controller.confirm(app.owner, later.preview.previewId, true, undefined, later.services)).bundle;
    const comparison = await controller.previewComparison(app.owner, savedEmpty.bundleId, savedLater.bundleId,
        { title: "Invented source-bound comparison", formats }, app.services);
    assert.equal(comparison.comparison.status, "ready");
    const chat = comparison.comparison.nativeComparison.units.filter(unit => unit.sourceId === "microsoft-365-chat");
    assert.ok(chat.length > 0);
    assert.ok(chat.every(unit => unit.baselineCount === null && unit.delta === null && unit.baselineState === "source-not-present"),
        "No native cohort in the earlier report cannot manufacture an improvement from zero.");
    const comparisonReviewed = await controller.reviewComparison(app.owner, comparison.previewId, true, undefined, app.services);
    const savedComparison = (await controller.confirmComparison(app.owner, comparison.previewId, true, undefined, app.services)).bundle;
    const cases = [
        [savedEmpty, reviewed, "report", "empty-native-report"],
        [savedLater, laterReviewed, "report", "later-native-report"],
        [savedComparison, comparisonReviewed, "comparison", "native-comparison"],
    ];
    const state = await loadBoardState(app.context);
    assert.ok(state.exports.every(entry => entry.nativeSourceBinding));
    const emptyNote = "No Microsoft conversations matched the selected report scope.";
    for (const [saved, expected, kind, prefix] of cases) {
        await assert.rejects(readSavedArtifactFile(app.context, state, saved.bundleId, kind, "json"), { status: 403 });
        await app.services.nativeReportSource.readSaved({ bundleIds: [saved.bundleId] }, app.services.nativeReportAdmission, async visible => {
            for (const format of [...formats, "manifest"]) {
                const file = await readSavedArtifactFile(app.context, visible, saved.bundleId, kind, format);
                const original = expected.files[file.name];
                assert.deepEqual(file.bytes, typeof original === "string" ? Buffer.from(original) : Buffer.from(original.data, "base64"));
                if (saved === savedEmpty && ["html", "markdown"].includes(format)) assert.ok(file.bytes.toString().includes(emptyNote));
                if (saved === savedEmpty && format === "pdf") {
                    const task = getDocument({ data: new Uint8Array(file.bytes) });
                    try {
                        const pdf = await task.promise, text = [];
                        for (let page = 1; page <= pdf.numPages; page++) text.push((await (await pdf.getPage(page)).getTextContent()).items.map(item => item.str ?? "").join(" "));
                        assert.ok(text.join(" ").replace(/\s+/g, " ").includes(emptyNote));
                    } finally { await task.destroy(); }
                }
                if (process.env.WIRE_REPORT_PROOFS) {
                    const folder = path.join(process.env.WIRE_REPORT_PROOFS, prefix);
                    await mkdir(folder, { recursive: true });
                    await writeFile(path.join(folder, file.name), file.bytes);
                }
            }
        });
    }
    await app.lifecycle.command(app.owner, { action: "wire-sign-out", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation }, () => true);
    for (const [saved] of cases) await assert.rejects(app.services.nativeReportSource.readSaved(
        { bundleIds: [saved.bundleId] }, app.services.nativeReportAdmission, () => assert.fail("Withdrawn account cannot open saved copies.")));
    for (const [saved, expected] of cases) for (const [name, original] of Object.entries(expected.files)) {
        assert.deepEqual(await readFile(saved.files[name]), typeof original === "string" ? Buffer.from(original) : Buffer.from(original.data, "base64"),
            "Withdrawal hides saved evidence without rewriting its files.");
    }
});

test("controller rejects altered original view bindings, copied frames and resolver failures without a legacy fallback", async t => {
    const app = await committedNativeReportFixture(t);
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const page = await views.query(query(), app.services.nativeReportAdmission);
    const services = servicesFor(app, views, page.viewId), selection = { kind: "current", revision: page.revision, scenarioIds: [] };
    const controller = createExportController(app.context);
    for (const alter of [
        value => ({ ...value, sourceRevision: "0".repeat(64) }),
        value => ({ ...value, definitions: { ...value.definitions, ordering: "Changed original definition." } }),
        value => ({ ...value, kind: "all" }),
        value => ({ ...value, revision: value.revision + 1 }),
        value => ({ ...value, extra: true }),
    ]) {
        await assert.rejects(controller.preview(app.owner, undefined, {}, selection, undefined, {
            ...services, resolveNativeReportView: async scope => alter(await services.resolveNativeReportView(scope)),
        }), { status: 409 });
    }
    await assert.rejects(controller.preview(app.owner, undefined, {}, selection, undefined, {
        ...services, resolveNativeReportView: async scope => {
            const value = await services.resolveNativeReportView(scope);
            return { ...value, frame: { ...value.frame } };
        },
    }), { code: "NATIVE_REPORT_FRAME_INVALID" });
    views.close();
    await assert.rejects(controller.preview(app.owner, undefined, {}, selection, undefined, services), { code: "NATIVE_VIEW_SELECTION_STALE" });
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});
