import test from "node:test";
import assert from "node:assert/strict";
import { currentReportPresentation, currentProductReportPresentation, hasCurrentReportPresentation, hasSupportedReportPresentation } from "../lib/report-presentation.mjs";

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
