import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";

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
        const scope = `${groups} of 7 request groups in the base scope included`;
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

test("changed originating-author evidence invalidates an already reviewed report", async t => {
    const app = await authorFilterFixture(t);
    const preview = await app.exports.preview("stale-author", undefined, { promptMode: "none", formats: ["json"] },
        { kind: "selected", revision: app.state.revision, scenarioIds: [app.cases.ownMail.scenarioId], promptAuthors: ["user"] });
    await app.exports.review("stale-author", preview.previewId, true);
    const changed = structuredClone(app.state.evidence);
    changed.find(record => record.scenarioId === app.cases.ownMail.scenarioId).userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    await replaceEvidence(app.context, () => ({ records: changed, importCoverage: app.state.importCoverage }));
    await assert.rejects(app.exports.confirm("stale-author", preview.previewId, true), /changed|fresh/i);
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});
