import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { reportHash } from "../lib/report-artifacts.mjs";
import { privateFixture } from "./helpers.mjs";
import { reportMatrixCases } from "./report-evidence-matrix-fixtures.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

for (const scenario of reportMatrixCases()) test(`report evidence matrix: ${scenario.name}`, { timeout: 60000 }, async t => {
    const { context } = await privateFixture(t, scenario.records);
    const before = await loadBoardState(context);
    const controller = createExportController(context);
    const formats = scenario.pdf ? ["html", "pdf", "json", "markdown"] : ["html", "json", "markdown"];
    const preview = await controller.preview("matrix", undefined, { promptMode: "none", formats }, { kind: "all", revision: before.revision });
    const facts = preview.snapshot.evaluationFacts, expected = scenario.expected;
    const tools = preview.snapshot.summary.metrics.find(metric => metric.layer === "tool");
    assert.equal(tools.count, expected.calls);
    for (const outcome of ["success", "failure", "partial", "unknown"]) assert.equal(tools.outcomes[outcome], expected[outcome], `${outcome} count`);
    assert.equal(preview.snapshot.summary.metrics.find(metric => metric.layer === "reported-api").count, expected.api);
    assert.equal(facts.recordedOutcomes.filter(outcome => outcome.kind === "tool-call").length, expected.calls);
    assert.equal(facts.recordedOutcomes.filter(outcome => outcome.kind === "returned-api-entry").length, expected.api);
    if (expected.graph) {
        const graph = facts.recordedOutcomes.filter(outcome => outcome.kind === "graph-request-site");
        assert.equal(graph.length, expected.graph);
        assert.deepEqual(graph.map(outcome => outcome.outcome).sort(), ["failure", "success", "unknown"]);
    }
    const timing = facts.metrics.find(metric => metric.definitionId === "tool-duration");
    if (expected.calls) {
        assert.equal(timing.coverage.covered, expected.timed);
        assert.equal(timing.coverage.eligible, expected.calls);
        assert.equal(timing.value, expected.median, "Median is pooled from timed calls, not an average of interaction medians");
        assert.equal(timing.samples.length, expected.timed);
        assert.equal(timing.boundary, "tool-start-to-completion");
        assert.equal(timing.observedTime.state === "available", false, "Raw source times must not be disclosed in the snapshot");
    }
    assert.equal(facts.metricProjectionVersion, 4);
    assert.deepEqual(facts.assessments, []);
    assert.ok(facts.metrics.every(metric => metric.dimension === "speed" && metric.origin === "automatic-local"),
        "Current output never infers judgments or cost from recorded completion.");
    assert.equal(facts.metrics.some(metric => metric.definitionId === "interaction-latency"), false,
        "Parallel call durations must not become summed task latency or an unavailable review placeholder.");
    if (scenario.name === "successful-wrapper-failed-api") {
        assert.equal(facts.recordedOutcomes.filter(outcome => outcome.kind === "returned-api-entry" && outcome.outcome === "failure").length, 6);
    }
    if (expected.calls && expected.success + expected.failure === 0) assert.doesNotMatch(preview.previewHtml, /aria-label="Recorded tool success"/);
    for (const contents of [preview.files["product-report.json"], preview.files["product-report.md"], preview.previewHtml]) {
        assert.doesNotMatch(contents, /PRIVATE_MATRIX_|SYNTHETIC_PRIVATE|email@example|SYNTHETIC_LITERAL/);
        assert.doesNotMatch(contents, /"dimension":"accuracy"|Answer correctness|Not checked automatically/);
    }
    const reviewed = await controller.review("matrix", preview.previewId, true);
    const saved = (await controller.confirm("matrix", preview.previewId, true)).bundle;
    for (const [name, content] of Object.entries(reviewed.files)) {
        const expectedBytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content.data, "base64");
        assert.deepEqual(await readFile(saved.files[name]), expectedBytes, `${name} saved bytes equal reviewed bytes`);
    }
    const manifest = JSON.parse(await readFile(saved.files["coverage-and-redaction-manifest.json"], "utf8"));
    assert.equal(manifest.evaluationFactsHash, reportHash(JSON.stringify(facts)));
    assert.deepEqual(manifest.evaluationFacts, facts);
    assert.deepEqual(JSON.parse(await readFile(saved.files["product-report.json"], "utf8")).evaluationFacts, facts);
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
    if (scenario.pdf) {
        const pdf = await readFile(saved.files["product-report.pdf"]);
        const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
        try {
            const document = await task.promise, pages = [];
            for (let n = 1; n <= document.numPages; n++) {
                const page = await document.getPage(n), viewport = page.getViewport({ scale: 1 });
                const content = await page.getTextContent();
                for (const item of content.items.filter(item => item.str?.trim())) {
                    assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, `PDF page ${n} stays within horizontal bounds`);
                    assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, `PDF page ${n} stays within vertical bounds`);
                }
                pages.push(content.items.map(item => item.str ?? "").join(""));
            }
            assert.doesNotMatch(pages.join("\n"), /Answer correctness|Not checked automatically/);
            assert.match(pages.join("\n"), /Not measured/);
            const compact = pages.join("").replace(/\s+/g, "");
            if (expected.calls && expected.success + expected.failure > 0) {
                if (expected.success) assert.ok(compact.includes(`${expected.success}succeeded`), "The PDF includes the actual successful-call count");
                if (expected.failure) assert.ok(compact.includes(`${expected.failure}failed`), "The PDF includes the actual failed-call count");
            }
            if (expected.median !== null) {
                assert.ok(compact.includes(`${expected.median.toLocaleString("en-US")}ms`), "The PDF keeps the exact independently calculated timing value");
            }
        } finally { await task.destroy(); }
    }
});
