import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { privateFixture, fixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { readSavedReportView } from "../lib/report-artifacts.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";

async function pdfText(value) {
    const task = getDocument({ data: new Uint8Array(Buffer.from(value.data, "base64")), useSystemFonts: true });
    try {
        const document = await task.promise, pages = [];
        for (let n = 1; n <= document.numPages; n++) {
            const page = await document.getPage(n), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1);
            }
            pages.push(content.items.map(item => item.str ?? "").join(" "));
        }
        return pages.join("\n").replace(/\s+/g, " ");
    } finally { await task.destroy(); }
}

test("all four report formats freeze identical author-filtered interactions and denominators", { timeout: 120000 }, async t => {
    const app = await authorFilterFixture(t), original = structuredClone(app.state.evidence);
    let originalBundle, originalFiles;
    for (const [authors, groups, calls, success, failure] of [
        [undefined, 7, 8, 6, 2], [["user"], 2, 3, 2, 1], [["agent"], 3, 3, 2, 1],
        [["user", "agent"], 5, 6, 4, 2], [["unknown"], 2, 2, 2, 0],
    ]) {
        const state = await loadBoardState(app.context);
        const preview = await app.exports.preview("author-proof", undefined,
            { promptMode: "original", formats: ["html", "pdf", "json", "markdown"] },
            { kind: "all", revision: state.revision, ...(authors ? { promptAuthors: authors } : {}) });
        const snapshot = preview.snapshot, facts = snapshot.evaluationFacts;
        assert.equal(snapshot.selectionScope.baseRequestGroups, 7);
        assert.equal(snapshot.selectionScope.requestGroups, groups);
        assert.equal(snapshot.selectionScope.authorExcludedRequestGroups, 7 - groups);
        assert.equal(snapshot.selectionScope.workIqActions, calls);
        assert.equal(snapshot.records.length, groups);
        assert.equal(snapshot.records.flatMap(record => record.toolCalls).length, calls);
        assert.ok(snapshot.records.every(record => (authors ?? ["user", "agent", "unknown"])
            .includes(record.prompts.find(prompt => prompt.kind === "origin").authorship.actor)));
        const toolOutcomes = facts.recordedOutcomes.filter(outcome => outcome.kind === "tool-call");
        assert.equal(toolOutcomes.length, calls);
        assert.equal(toolOutcomes.filter(outcome => outcome.outcome === "success").length, success);
        assert.equal(toolOutcomes.filter(outcome => outcome.outcome === "failure").length, failure);
        const duration = facts.metrics.find(metric => metric.definitionId === "tool-duration");
        assert.equal(duration.coverage.eligible, calls);
        assert.equal(duration.samples.length, calls);
        assert.ok(facts.metrics.filter(metric => ["accuracy", "answer-trust", "action-trust", "cost"].includes(metric.dimension))
            .every(metric => metric.value === null), "Synthetic author proof does not invent semantic or cost measurements");
        const json = JSON.parse(preview.files["product-report.json"]);
        assert.deepEqual(json.records, snapshot.records);
        assert.deepEqual(json.evaluationFacts, facts);
        assert.deepEqual(json.selectionScope, snapshot.selectionScope);
        const scope = `${groups} of 7 interactions included`;
        for (const contents of [preview.previewHtml, preview.files["product-report.md"], await pdfText(preview.files["product-report.pdf"])]) {
            assert.ok(contents.includes(scope));
        }
        await app.exports.review("author-proof", preview.previewId, true);
        const saved = (await app.exports.confirm("author-proof", preview.previewId, true)).bundle;
        if (!originalBundle) {
            originalBundle = saved;
            originalFiles = await Promise.all(Object.values(saved.files).map(file => readFile(file)));
        } else assert.deepEqual(await Promise.all(Object.values(originalBundle.files).map(file => readFile(file))), originalFiles, "Later author choices never rewrite a saved report");
    }
    assert.deepEqual((await loadBoardState(app.context)).evidence, original);
});

test("Current view author membership still includes the full matching originating interaction", async t => {
    const app = await authorFilterFixture(t);
    const view = buildActivityAnalytics(app.state.evidence, { filters: { scope: "all", promptAuthors: ["user"], outcomes: ["failure"] } });
    assert.equal(view.rows.length, 1);
    const preview = await app.exports.preview("current-author", undefined, { promptMode: "none", formats: ["json"] },
        { kind: "current", revision: app.state.revision, scenarioIds: [...new Set(view.rows.map(row => row.scenarioId))], promptAuthors: ["user"] });
    assert.equal(preview.records.length, 1);
    assert.equal(preview.records[0].toolCalls.length, 2, "One failed matching call includes its successful sibling in the same human-origin group");
    assert.equal(preview.snapshot.selectionScope.workIqActions, 2);
});

async function reportApi(app) {
    const origin = new URL(app.runtime.url).origin;
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" };
    const post = async (route, body, status = 200) => {
        const response = await fetch(origin + route, { method: "POST", headers, body: JSON.stringify(body) });
        const result = await response.json();
        assert.equal(response.status, status, result.error);
        return result;
    };
    headers["X-Board-Capability"] = (await post("/api/session", {})).capability;
    return post;
}

test("author-filtered collected preparation keeps its frozen origin through a later correction and explicit Save", async t => {
    const app = await authorFilterFixture(t);
    const post = await reportApi(app);
    const preview = await post("/api/preview", {
        options: { promptMode: "original", formats: ["json"], saveMode: "local" },
        selection: { kind: "all", revision: app.state.revision, promptAuthors: ["user"] },
    });
    assert.equal(preview.collectedSourceFrozen, true);
    assert.equal(preview.snapshot.selectionScope.requestGroups, 2);
    assert.equal(preview.snapshot.selectionScope.workIqActions, 3);
    assert.ok(preview.records.every(record => record.prompts.find(prompt => prompt.kind === "origin").authorship.actor === "user"));
    const changed = structuredClone(app.state.evidence);
    changed.find(record => record.scenarioId === app.cases.ownMail.scenarioId).userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    await replaceEvidence(app.context, () => ({ records: changed, importCoverage: app.state.importCoverage }));
    const current = await loadBoardState(app.context);
    assert.equal(buildActivityAnalytics(current.evidence, { filters: { scope: "all", promptAuthors: ["user"] } }).rows.length, 1);
    await post("/api/export", { previewId: preview.previewId, confirmed: true,
        localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false } }, 428);
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
    const saved = await post("/api/export", { previewId: preview.previewId, confirmed: true,
        localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: true } });
    const after = await loadBoardState(app.context);
    assert.deepEqual(after.evidence, changed, "Saving cannot roll back the later source correction.");
    assert.equal(after.exports.length, 1);
    assert.equal(saved.bundle.privacyReview.reviewerConfirmed, false);
    assert.equal(saved.bundle.privacyReview.localSave.method, "explicit-local-save");
    const bytes = await readFile(saved.bundle.files["product-report.json"], "utf8");
    assert.equal(bytes, preview.files["product-report.json"]);
    assert.deepEqual(JSON.parse(bytes), preview.snapshot);
    const view = await readSavedReportView(app.context, after, saved.bundle.bundleId);
    assert.match(view.text, /User prompt/);
    const next = await post("/api/preview", {
        options: { promptMode: "none", formats: ["json"], saveMode: "local" },
        selection: { kind: "all", revision: after.revision, promptAuthors: ["user"] },
    });
    assert.equal(next.snapshot.selectionScope.requestGroups, 1);
    assert.equal(next.snapshot.selectionScope.workIqActions, 1);
});

test("an unpinned author-filtered preparation still refuses changed originating-author evidence", async t => {
    const record = fixture("unpinned-author");
    record.userPrompt.authorship = { actor: "user", basis: "source-user" };
    const { context } = await privateFixture(t, [record]), controller = createExportController(context);
    const before = await loadBoardState(context);
    const preview = await controller.preview("unpinned", undefined, { promptMode: "none", formats: ["json"], saveMode: "local" },
        { kind: "all", revision: before.revision, promptAuthors: ["user"] });
    assert.equal(preview.collectedSourceFrozen, undefined);
    const changed = structuredClone(before.evidence);
    changed[0].userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    await replaceEvidence(context, () => ({ records: changed, importCoverage: before.importCoverage }));
    await assert.rejects(controller.confirm("unpinned", preview.previewId, true, undefined, {
        localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false },
    }), /Selected evidence changed/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

for (const authority of ["source", "consent"]) test(`a frozen author-filtered preparation refuses ${authority} changes before explicit Save`, async t => {
    const app = await authorFilterFixture(t), post = await reportApi(app);
    if (authority === "consent") {
        const source = app.runtime.collector.assessmentSource(await loadBoardState(app.context));
        await updateBoardState(app.context, state => {
            const personal = defaultPersonalEvaluation();
            personal.source = source;
            personal.consent = { ...personal.consent, state: "enabled", revision: 1, categories: ["answer"],
                sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision,
                grantedAt: new Date().toISOString(), grantOrigin: "explicit-in-app-setup" };
            state.personalEvaluation = personal;
        });
    }
    const before = await loadBoardState(app.context);
    const preview = await post("/api/preview", {
        options: { promptMode: "original", formats: ["json"], saveMode: "local" },
        selection: { kind: "all", revision: before.revision, promptAuthors: ["user"] },
    });
    assert.equal(preview.collectedSourceFrozen, true);
    if (authority === "source") await app.runtime.collector.configure({ ...app.config, windowDays: 7 });
    else await updateBoardState(app.context, state => {
        state.personalEvaluation.consent = { ...state.personalEvaluation.consent, state: "revoked",
            revision: state.personalEvaluation.consent.revision + 1, categories: [], revokedAt: new Date().toISOString() };
    });
    const refused = await post("/api/export", { previewId: preview.previewId, confirmed: true,
        localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: true } }, 409);
    assert.match(refused.error, /permission or deletion authority changed/);
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});
