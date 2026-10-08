import test from "node:test";
import assert from "node:assert/strict";
import { createReportJourney } from "../web/report-journey.mjs";

const preview = { previewId: "synthetic-preview", privacy: { allSelectedFieldsScanned: true } };
function chosen(journey, count = 2) {
    journey.update({ requestCount: count, scopeReady: true, formats: ["html", "pdf", "json", "markdown"] });
}

test("state notifications track prepared, revisited, cancelled and completed report guards without side effects", () => {
    const states = [];
    const journey = createReportJourney({ onStateChange: () => states.push(journey.snapshot()) });
    chosen(journey);
    journey.beginScan();
    journey.previewReady(preview);
    assert.equal(states.at(-1).hasPreview, true);
    journey.go(2);
    assert.equal(states.at(-1).hasPreview, true, "Back to Contents preserves the prepared report.");
    journey.invalidate();
    assert.equal(states.at(-1).hasPreview, false);
    journey.beginScan();
    journey.go(2);
    assert.equal(states.at(-1).phase, "draft");
    journey.beginScan();
    journey.previewReady(preview);
    journey.reviewed();
    assert.equal(states.at(-1).phase, "reviewed");
    journey.writing(true);
    assert.equal(states.at(-1).phase, "writing");
    journey.saved({ bundleId: "invented-no-files-written", files: { "report.html": "invented-path" } });
    assert.equal(states.at(-1).phase, "saved");
    assert.equal(states.at(-1).hasPreview, false);
});

test("report starts empty and stages require scope, scan and explicit review in that order", () => {
    const journey = createReportJourney();
    assert.equal(journey.snapshot().step, 1);
    assert.equal(journey.snapshot().scope, "selected");
    assert.equal(journey.go(2), false);
    assert.match(journey.reason(2), /Choose at least one readable request/);
    chosen(journey);
    assert.equal(journey.go(2), true);
    assert.equal(journey.go(3), false);
    assert.equal(journey.reviewed(), false);
    journey.beginScan();
    assert.equal(journey.snapshot().phase, "scanning");
    assert.equal(journey.previewReady({ ...preview, privacy: {} }), false);
    assert.equal(journey.previewReady(preview), true);
    assert.equal(journey.go(4), false);
    assert.equal(journey.reviewed(), true);
    assert.equal(journey.snapshot().step, 4);
});

test("revisiting unchanged choices keeps one snapshot, while invalidation removes presentation approval", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.beginScan();
    journey.previewReady(preview);
    journey.reviewed();
    assert.equal(journey.go(1), true);
    assert.equal(journey.go(3), true);
    assert.equal(journey.go(4), true);
    journey.invalidate("The timezone changed.");
    assert.equal(journey.snapshot().hasPreview, false);
    assert.equal(journey.go(4), false);
    assert.equal(journey.reviewed(), false);
});

test("Back during scan cancels once and late preview cannot revive it", () => {
    let cancelled = 0;
    const journey = createReportJourney({ cancelReview: () => { cancelled++; } });
    chosen(journey);
    journey.beginScan();
    assert.equal(journey.go(2), true);
    assert.equal(cancelled, 1);
    assert.equal(journey.previewReady(preview), false);
    assert.equal(journey.snapshot().phase, "draft");
});

test("write cannot be cancelled or double-entered; uncertain response cannot become a saved result", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.beginScan();
    journey.previewReady(preview);
    journey.reviewed();
    journey.writing(true);
    assert.equal(journey.go(1), false);
    assert.equal(journey.clear(), false);
    assert.equal(journey.beginScan(), null);
    journey.writing(false);
    assert.equal(journey.snapshot().phase, "blocked");
    assert.equal(journey.snapshot().completed, false);
    journey.failed("Save response is uncertain. Read saved reports before continuing.");
    assert.equal(journey.go(4), false);
    assert.throws(() => journey.saved({ bundleId: "empty", files: {} }), /links are unavailable/);
});

test("clear removes only this journey's scope, copies and completion; options remain panel-local", () => {
    const journey = createReportJourney();
    chosen(journey, 84);
    journey.update({ entry: { sessionId: "s", sessionName: "Synthetic session" }, promptMode: "original" });
    journey.beginScan();
    journey.previewReady(preview);
    journey.reviewed();
    journey.saved({ bundleId: "saved", files: { "product-report.html": "private-file" } });
    assert.equal(journey.snapshot().completed, true);
    journey.clear();
    assert.equal(journey.snapshot().step, 1);
    assert.equal(journey.snapshot().requestCount, 0);
    assert.equal(journey.snapshot().entry, null);
    assert.equal(journey.snapshot().promptMode, "original");
    assert.equal(createReportJourney().snapshot().promptMode, "masked");
});

test("factory is self-contained for serialization and missing formats block scan", () => {
    const factory = (0, eval)(`(${createReportJourney.toString()})`);
    const journey = factory();
    chosen(journey);
    journey.update({ formats: [] });
    assert.equal(journey.beginScan(), null);
    assert.match(journey.reason(3), /Choose at least one format/);
    assert.equal(journey.go(2), true);
});

test("revisiting contents after a completed save starts a draft, not a success-shaped next report", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.beginScan();
    journey.previewReady(preview);
    journey.reviewed();
    journey.saved({ bundleId: "saved", files: { "product-report.html": "private-file" } });
    assert.equal(journey.go(2), true);
    assert.equal(journey.snapshot().phase, "draft");
    assert.equal(journey.snapshot().completed, false);
    assert.equal(journey.snapshot().requestCount, 2);
    assert.equal(journey.go(4), false);
});
