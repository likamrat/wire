import test from "node:test";
import assert from "node:assert/strict";
import { createReportJourney } from "../web/report-journey.mjs";

const report = id => ({ bundleId: id, files: { "product-report.html": "synthetic-only" } });
const ready = () => {
    const journey = createReportJourney();
    journey.update({ requestCount: 1, scopeReady: true, formats: ["html"] });
    return journey;
};
test("a saved target becomes unavailable without erasing the draft selection or options", () => {
    const journey = ready();
    journey.saved(report("current"));
    assert.equal(journey.invalidateSavedReport("other"), false);
    assert.equal(journey.snapshot().completed, true);
    assert.equal(journey.invalidateSavedReport("current"), true);
    assert.equal(journey.snapshot().completed, false);
    assert.equal(journey.snapshot().phase, "unavailable");
    assert.equal(journey.snapshot().requestCount, 1);
    assert.deepEqual(journey.snapshot().formats, ["html"]);
    assert.equal(journey.go(1), true);
    assert.equal(journey.snapshot().phase, "draft");
    assert.equal(journey.go(3), false);
});
test("late target receipts do not clear a saved successor or its unfinished preview", () => {
    const journey = ready();
    journey.saved(report("first"));
    journey.saved(report("successor"));
    assert.equal(journey.invalidateSavedReport("first"), false);
    assert.equal(journey.snapshot().completed, true);
    journey.go(1);
    journey.beginScan();
    journey.previewReady({ previewId: "new-preview", privacy: { allSelectedFieldsScanned: true } });
    assert.equal(journey.invalidateSavedReport("successor"), false);
    assert.equal(journey.snapshot().hasPreview, true);
});
test("presence refresh clears only a missing currently displayed saved artifact", () => {
    const journey = ready();
    journey.saved(report("current"));
    journey.syncPresence([report("current")]);
    assert.equal(journey.snapshot().completed, true);
    journey.syncPresence([report("other")]);
    assert.equal(journey.snapshot().phase, "unavailable");
    journey.syncPresence([report("current")]);
    assert.equal(journey.snapshot().completed, false, "Presence alone cannot resurrect a receipt or approval");
});
test("a late successful save receipt with known absence never exposes ready downloads", () => {
    const journey = ready();
    journey.saved(report("gone"), { available: false });
    assert.equal(journey.snapshot().phase, "unavailable");
    assert.equal(journey.snapshot().completed, false);
    assert.equal(journey.go(3), false);
});
