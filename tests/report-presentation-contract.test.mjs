import test from "node:test";
import assert from "node:assert/strict";
import { currentReportPresentation, currentProductReportPresentation, hasCurrentReportPresentation, hasSupportedReportPresentation } from "../lib/report-presentation.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { renderHtmlReport, renderMarkdownReport } from "../lib/product-report.mjs";
import { fixture } from "./helpers.mjs";

test("product presentation is supported only with its declared report kind and population", () => {
    const snapshot = { kind: "report", reportPopulation: { version: 1 }, presentation: currentProductReportPresentation };
    assert.equal(hasSupportedReportPresentation(snapshot), true);
    assert.equal(hasCurrentReportPresentation(snapshot), true);
    const historicalFocused = { ...snapshot, presentation: currentReportPresentation };
    assert.equal(hasCurrentReportPresentation(historicalFocused), false);
    assert.equal(hasSupportedReportPresentation(historicalFocused), true, "Existing unmarked focused reports retain their original reader");
    for (const candidate of [
        { ...snapshot, kind: "comparison" },
        { ...snapshot, kind: undefined },
        { ...snapshot, reportPopulation: undefined },
        { ...snapshot, reportPopulation: null },
        { ...snapshot, reportPopulation: { version: 2 } },
        { ...snapshot, presentation: { ...currentProductReportPresentation, productVersion: 2 } },
        { ...snapshot, presentation: { ...currentProductReportPresentation, unexpected: true } },
    ]) assert.equal(hasSupportedReportPresentation(candidate), false);
    const existing = { kind: "report", presentation: currentReportPresentation };
    assert.equal(hasCurrentReportPresentation(existing), true, "The additive reader prerequisite does not retire ordinary preparation");
    assert.equal(hasSupportedReportPresentation(existing), true);
    assert.equal(hasSupportedReportPresentation({ ...existing, presentation: { schemaVersion: 3 } }), true);
});

test("new author captions do not rewrite originals or reinterpret historical JSON reports", async () => {
    const record = fixture("author-vocabulary");
    Object.assign(record.userPrompt,{text:"Keep the literal words My prompt in this sentence.",authorship:{actor:"user",basis:"source-user"}});
    const bundle=await buildSanitizedBundle([record], "a".repeat(64), {promptMode:"original",formats:["html","markdown","json"]});
    const current=bundle.snapshot, prior=structuredClone(current);
    delete prior.presentation.iconVersion;
    const humanV1=structuredClone(prior);
    delete prior.presentation.authorLabelVersion;
    assert.equal(current.presentation.iconVersion,2);
    assert.equal(hasSupportedReportPresentation(humanV1),true);
    assert.equal(current.presentation.authorLabelVersion,1);
    assert.equal(hasSupportedReportPresentation(prior),true);
    assert.equal(hasSupportedReportPresentation({...current,presentation:{...current.presentation,authorLabelVersion:2}}),false);
    for (const [snapshot,caption] of [[current,"Human prompt"],[humanV1,"Human prompt"],[prior,"User prompt"]]) {
        const html=renderHtmlReport(snapshot.records,{snapshot});
        assert.ok(html.includes(caption)); assert.ok(html.includes(record.userPrompt.text));
        assert.ok(renderMarkdownReport(snapshot.records,{snapshot}).includes(caption));
        assert.equal(html.includes('data-lucide-icon="user-round"'),snapshot!==prior);
        assert.equal(html.includes('data-icon-role="account"'),snapshot===current);
        assert.equal(html.includes('React Icons (MIT)'),snapshot===current);
    }
});
