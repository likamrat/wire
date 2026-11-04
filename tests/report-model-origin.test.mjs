import test from "node:test";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { normalizeMetricFact } from "../lib/report-metric-comparison.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { renderComparisonHtml, renderComparisonMarkdown } from "../lib/report-presentation.mjs";
import { nativeQualityHtml, nativeQualityMarkdown } from "../lib/native-report-output.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { fixture } from "./helpers.mjs";
import { makeRatio } from "./assessment-contract-fixtures.mjs";

function modelFacts(model, rubricVersion) {
    const record = fixture("model-origin"), state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: [record] };
    const facts = structuredClone(buildReportFacts(state.evidence, state).facts);
    facts.metricProjectionVersion = 2;
    const interactionRef = facts.memberships[0].interactionRef;
    const checks = { accuracy: "request-requirements-corroborated", "answer-trust": "recorded-answer-support", "action-trust": "action-intent-alignment" };
    for (const [index, [dimension, checkId]] of Object.entries(checks).entries()) {
        const base = { ...makeRatio(), basis: facts.basis, dimension, eligibleUnitRefs: [interactionRef] };
        facts.metrics.push({ ...base, metricRef: "metric-" + (900 + index).toString(16).padStart(32, "0"),
            checkId, origin: "model-assessed", evaluator: { provider: "github-copilot", model,
                rubricId: "wire-recorded-interaction-review", rubricVersion },
            status: "measured", reason: null, value: 1, numerator: 1, denominator: 1,
            coverage: { covered: 1, eligible: 1 }, counts: { pass: 1, fail: 0, unassessed: 0, evaluatorError: 0 },
            unassessedReasons: [],
            coveredUnitRefs: [interactionRef],
            evidenceRefs: ["evidence-" + "a".repeat(32)] });
    }
    return { record, facts };
}

test("historical readable report summaries show each frozen model and rubric version rather than current defaults", () => {
    for (const [model, version] of [["fixture-model-a", 1], ["archived-model-b", 7]]) {
        const { facts } = modelFacts(model, version), before = JSON.stringify(facts);
        for (const text of [nativeQualityHtml({ evaluationFacts: facts }), nativeQualityMarkdown({ evaluationFacts: facts }).join("\n")]) {
            assert.ok(text.includes(model));
            assert.ok(text.includes(`rubric wire-recorded-interaction-review v${version}`),
                "The readable summary dropped the frozen rubric ID/version.");
            assert.match(text, /1 of 1 passed.*1 of 1 assessed/);
            assert.match(text, /request matching, not permission/);
        }
        assert.equal(JSON.stringify(facts), before);
    }
});

test("historical readable formats share their recorded reading notes without changing frozen facts", () => {
    const { facts } = modelFacts("fixture-model", 1), before = JSON.stringify(facts);
    const formatter = createReportComparison();
    const a = comparisonFact({ evaluatorModel: "fixture-model", rubricId: "fixture-rules", rubricVersion: 1 });
    const comparison = compareFrozenReportFacts(report("a", a), report("b", structuredClone(a)));
    const texts = [nativeQualityHtml({ evaluationFacts: facts }), nativeQualityMarkdown({ evaluationFacts: facts }).join("\n"),
        renderComparisonHtml(comparison, snapshot(comparison)), renderComparisonMarkdown(comparison, snapshot(comparison))];
    for (const [index, text] of texts.entries()) {
        for (const note of index < 2 ? formatter.readingNotes.slice(0, 3) : formatter.readingNotes) assert.ok(text.includes(note));
    }
    for (const text of texts.slice(0, 2)) assert.equal(text.includes(formatter.readingNotes[3]), false,
        "Timing definitions belong to the native timing section, not repeated quality detail");
    assert.match(formatter.readingNotes.join(" "), /passed plus failed.*Missing results are left out/);
    assert.equal(formatter.readingNotes[0], "Answer correctness and answer support are separate reviews. Tool use vs. request asks whether the recorded tool use fit what was asked. Personal permission feedback is a different judgment.");
    assert.match(formatter.readingNotes.join(" "), /own timed-call or timed-request count/);
    assert.equal(JSON.stringify(facts), before);
});

async function pdfText(bytes) {
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
        const document = await task.promise, pages = [];
        for (let index = 1; index <= document.numPages; index++) {
            const page = await document.getPage(index), viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1);
            }
            pages.push(content.items.map(item => item.str ?? "").join(" "));
        }
        return pages.join(" ").replace(/\s+/g, " ");
    } finally { await task.destroy(); }
}
for (const [model, version] of [["fixture-model-a", 1], ["archived-model-b", 7]]) {
    test(`new formats omit historical ${model}/rubric v${version} without changing the supplied frozen facts`, { timeout: 30000 }, async () => {
        const { record, facts } = modelFacts(model, version), original = JSON.stringify(facts);
        const bundle = await buildSanitizedBundle([record], "a".repeat(64),
            { promptMode: "none", formats: ["html", "pdf", "json", "markdown"] }, undefined, undefined, facts);
        const before = Object.fromEntries(Object.entries(bundle.files).map(([name, bytes]) => [name, Buffer.from(bytes)]));
        const texts = { html: bundle.files["product-report.html"], markdown: bundle.files["product-report.md"], pdf: await pdfText(bundle.files["product-report.pdf"]) };
        for (const [format, text] of Object.entries(texts)) {
            // PDF layout can wrap an identifier at its hyphens.
            const compact = text.replace(/\s+/g, "");
            assert.equal(compact.includes(model), false, `${format}: retired model leaked into a new report`);
            assert.equal(compact.includes(`rubricwire-recorded-interaction-reviewv${version}`), false);
            assert.doesNotMatch(text, /1 of 1 passed|1 of 1 assessed|request matching, not permission/);
        }
        const json = JSON.parse(bundle.files["product-report.json"]), manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
        assert.deepEqual(json.evaluationFacts, manifest.evaluationFacts);
        assert.equal(json.evaluationFacts.metricProjectionVersion, 4);
        assert.equal(json.evaluationFacts.metrics.some(metric => metric.origin === "model-assessed"), false);
        const different = modelFacts("another-model", version + 1);
        nativeQualityHtml({ evaluationFacts: different.facts });
        nativeQualityMarkdown({ evaluationFacts: different.facts });
        assert.equal(JSON.stringify(facts), original);
        for (const [name, bytes] of Object.entries(bundle.files)) assert.deepEqual(Buffer.from(bytes), before[name], "Later formatting never rewrites an existing frozen copy.");
    });
}

const comparisonFact = qualifiers => ({
    metric: "accuracy", kind: "pass-rate", definitionId: "check-pass-share", definitionVersion: 1,
    unit: "percent", basis: "model-assessment", aggregation: "pass-rate", boundary: "one-rule-per-eligible-unit",
    state: "available", coverage: { count: 1, eligible: 1 }, numerator: 1, denominator: 1,
    counts: { pass: 1, fail: 0, unassessed: 0, evaluatorError: 0 }, qualifiers,
});
const report = (id, fact) => ({
    schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true,
    patternVersion: 1, metrics: [fact], toolRows: [{ id: `${id}-call`, patternId: "read", outcome: "success" }],
    scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "fixture", callTimesAvailable: false, historyComplete: false },
});
const snapshot = comparison => ({ bundleId: "export-origin-fixture", preparedAtDisplay: "Synthetic origin proof",
    sourceReports: [comparison.baseline, comparison.later] });

test("new comparison HTML, PDF and Markdown show each side's own frozen model/rubric without changing compatibility", { timeout: 30000 }, async () => {
    const a = comparisonFact({ evaluatorModel: "archived-model-a", rubricId: "archived-rubric-alpha", rubricVersion: 3 });
    const b = comparisonFact({ evaluatorModel: "different-model-b", rubricId: "different-rubric-beta", rubricVersion: 12 });
    const original = JSON.stringify([a, b]), comparison = compareFrozenReportFacts(report("a", a), report("b", b));
    const metric = comparison.metrics.find(metric => metric.metric === "accuracy");
    assert.equal(metric.status, "incompatible");
    assert.equal(metric.delta, null);
    const html = renderComparisonHtml(comparison, snapshot(comparison)), markdown = renderComparisonMarkdown(comparison, snapshot(comparison));
    for (const text of [html, markdown, await pdfText(await renderPdf(html))]) {
        const compact = text.replace(/\s+/g, "");
        for (const fact of [a, b]) {
            assert.ok(compact.includes(fact.qualifiers.evaluatorModel));
            assert.ok(compact.includes(`rubric${fact.qualifiers.rubricId}v${fact.qualifiers.rubricVersion}`));
        }
        assert.match(text, /1 of 1 passed/);
        assert.match(text, /1 of 1 assessed/);
    }
    const same = compareFrozenReportFacts(report("a", a), report("b", structuredClone(a)));
    assert.equal(same.metrics.find(metric => metric.metric === "accuracy").delta.value, 0);
    assert.equal(JSON.stringify([a, b]), original);
});

test("legacy missing/partial rubric metadata stays honest and local/personal wording stays separate", () => {
    const formatter = createReportComparison();
    const missingIdentity = " · Check ID not recorded · Check version not recorded";
    const unknownMeaning = "The saved definition does not identify what this review checked.";
    for (const [qualifiers, expected] of [
        [{}, "Model assessment"],
        [{ evaluatorModel: "legacy-model" }, "Model assessment · legacy-model"],
        [{ rubricId: "legacy-rubric" }, "Model assessment · rubric legacy-rubric (version not saved)"],
        [{ rubricVersion: 7 }, "Model assessment · rubric ID not saved v7"],
        [{ rubricId: "version-zero", rubricVersion: 0 }, "Model assessment · rubric version-zero v0"],
    ]) {
        const fact = normalizeMetricFact(comparisonFact(qualifiers));
        assert.equal(formatter.definitionLabel({ baseline: fact }), expected + missingIdentity);
        assert.equal(formatter.metricLabel(fact), "Saved review (type not recorded)");
        assert.deepEqual(formatter.metricPresentation(fact, "accuracy"), {
            value: "100%", tone: "performance-teal",
            note: `${expected} · 1 of 1 passed · 1 of 1 assessed · 0 not assessed · ${unknownMeaning}`,
        });
        const missing = normalizeMetricFact({ ...comparisonFact(qualifiers), state: "unavailable", reason: "missing-evidence",
            numerator: undefined, denominator: undefined, coverage: { count: 0, eligible: 1 },
            counts: { pass: 0, fail: 0, unassessed: 1, evaluatorError: 0 } });
        assert.deepEqual(formatter.metricPresentation(missing, "accuracy"), {
            value: "Not enough saved evidence", tone: "",
            note: `${expected} · Not enough saved evidence · 0 of 1 assessed · ${unknownMeaning}`,
        });
        assert.equal(Object.hasOwn(fact.qualifiers, "checkId"), false);
        assert.equal(Object.hasOwn(fact.qualifiers, "checkVersion"), false);
        assert.equal(Object.hasOwn(missing.qualifiers, "checkId"), false);
        assert.equal(Object.hasOwn(missing.qualifiers, "checkVersion"), false);
    }
    assert.equal(formatter.definitionLabel({ baseline: { ...comparisonFact({}), basis: "user-assessment" } }), "Your feedback" + missingIdentity);
    assert.equal(formatter.definitionLabel({ baseline: { ...comparisonFact({}), basis: "automatic-assessment" } }), "Automatic local checks" + missingIdentity);
    assert.equal(formatter.definitionLabel({ baseline: { ...comparisonFact({}), basis: "automatic-assessment", reason: "unsupported-check" } }),
        "Local observation (not a model assessment)" + missingIdentity);
});

test("stored comparison rubric text is escaped as data in HTML and Markdown table cells", () => {
    const fact = comparisonFact({ evaluatorModel: "fixture-model", rubricId: 'audit|<script>"&', rubricVersion: 4 });
    const comparison = compareFrozenReportFacts(report("a", fact), report("b", structuredClone(fact)));
    for (const text of [renderComparisonHtml(comparison, snapshot(comparison)), renderComparisonMarkdown(comparison, snapshot(comparison))]) {
        assert.ok(text.includes("audit&#124;&lt;script&gt;&quot;&amp;"));
        assert.doesNotMatch(text, /audit\|<script>/);
    }
    assert.equal(fact.qualifiers.rubricId, 'audit|<script>"&');
});
