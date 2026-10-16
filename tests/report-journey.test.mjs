import test from "node:test";
import assert from "node:assert/strict";
import { createReportJourney } from "../web/report-journey.mjs";

const preview = { previewId: "synthetic-preview", privacy: { allSelectedFieldsScanned: true } };
function chosen(journey, count = 2) {
    journey.update({ requestCount: count, scopeReady: true, formats: ["html", "pdf", "json", "markdown"] });
}

test("setup presentation notifications are idempotent and cannot reopen or approve a report", () => {
    const presentations = [];
    const journey = createReportJourney({ presentStep: value => presentations.push(value) });
    chosen(journey);
    journey.go(2);
    const before = journey.snapshot(), count = presentations.length;
    journey.setContentsPresented(true);
    journey.setContentsPresented(true);
    journey.setContentsPresented(false);
    assert.equal(presentations.length, count, "Visibility notification does not recurse through presentStep");
    assert.deepEqual(journey.snapshot(), before, "Presentation ownership does not change report authority or stage");
});

test("contextual hosting follows deliberate journey entry without granting preview or save authority", () => {
    const presentations = [];
    const journey = createReportJourney({ presentStep: value => presentations.push(value) });
    chosen(journey);
    journey.go(2);
    assert.deepEqual(presentations.at(-1), { step: 2, focus: true });
    assert.equal(journey.snapshot().phase, "draft");
    journey.update({ promptMode: "original" });
    assert.deepEqual(presentations.at(-1), { step: 2, focus: false }, "Field updates cannot reopen a closed setup");
    journey.beginScan();
    assert.deepEqual(presentations.at(-1), { step: 3, focus: true }, "Actual review releases the contextual host");
    journey.previewReady(preview);
    journey.go(2);
    assert.equal(journey.snapshot().hasPreview, true);
    assert.equal(journey.snapshot().phase, "ready", "Returning to unchanged setup is not disclosure approval");
});

test("Activity and Contents lead to Review with separate approval and save in the same stage", () => {
    const journey = createReportJourney();
    chosen(journey);
    assert.equal(journey.go(2), true, "Contents is available after deliberate activity selection");
    assert.equal(journey.go(3), false, "Contents cannot bypass preparation");
    journey.beginScan();
    assert.equal(journey.snapshot().step, 3);
    journey.previewReady(preview);
    journey.writing(true);
    assert.equal(journey.snapshot().phase, "ready", "Viewing the report cannot save it");
    journey.reviewed();
    assert.equal(journey.snapshot().step, 3);
    assert.equal(journey.snapshot().phase, "reviewed");
    assert.equal(journey.snapshot().completed, false, "Disclosure approval is not a save");
    journey.writing(true);
    assert.equal(journey.snapshot().phase, "writing", "Save is a separate transition");
    assert.equal(journey.go(4), false, "There is no fourth preliminary stage");
});

test("Contents does not claim a prepared review or defer ordinary reads", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.go(2);
    assert.equal(journey.isReviewOpen(), false);
    journey.beginScan();
    assert.equal(journey.isReviewOpen(), true);
    journey.go(2);
    assert.equal(journey.isReviewOpen(), false);
});

test("failed preparation has no review authority and permits current-state recovery", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.beginScan();
    journey.failed("Selected evidence changed. Prepare a new report.");
    assert.equal(journey.snapshot().hasPreview, false);
    assert.equal(journey.isReviewOpen(), false);
    assert.equal(journey.go(2), true);
});

test("state notifications track prepared, revisited, cancelled and completed report guards without side effects", () => {
    const states = [];
    const journey = createReportJourney({ onStateChange: () => states.push(journey.snapshot()) });
    chosen(journey);
    journey.beginScan();
    journey.previewReady(preview);
    assert.equal(states.at(-1).hasPreview, true);
    journey.go(1);
    assert.equal(states.at(-1).hasPreview, true, "Back to Setup preserves the prepared report.");
    journey.invalidate();
    assert.equal(states.at(-1).hasPreview, false);
    journey.beginScan();
    journey.go(1);
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
    assert.match(journey.reason(2), /Choose at least one readable interaction/);
    chosen(journey);
    assert.equal(journey.go(2), true);
    assert.equal(journey.go(3), false);
    assert.equal(journey.reviewed(), false);
    journey.beginScan();
    assert.equal(journey.snapshot().phase, "scanning");
    assert.equal(journey.previewReady({ ...preview, privacy: {} }), false);
    assert.equal(journey.previewReady(preview), true);
    assert.equal(journey.go(3), true, "Prepared content is readable before approval");
    assert.equal(journey.reviewed(), true);
    assert.equal(journey.snapshot().step, 3);
});

test("revisiting unchanged choices keeps one snapshot, while invalidation removes presentation approval", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.beginScan();
    journey.previewReady(preview);
    journey.reviewed();
    assert.equal(journey.go(1), true);
    assert.equal(journey.go(2), true);
    assert.equal(journey.go(3), true);
    journey.invalidate("The timezone changed.");
    assert.equal(journey.snapshot().hasPreview, false);
    assert.equal(journey.go(3), false);
    assert.equal(journey.reviewed(), false);
});

test("an unverified read gates Save without manufacturing or discarding explicit review", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.beginScan(); journey.previewReady(preview); journey.reviewed();
    journey.go(1);
    journey.update({ scopeReady: false, scopeIssue: "Wait for a current activity snapshot." });
    assert.equal(journey.go(3), false);
    assert.equal(journey.snapshot().phase, "reviewed");
    journey.update({ scopeReady: true, scopeIssue: "" });
    assert.equal(journey.go(3), true);
    assert.equal(journey.snapshot().completed, false);
});

test("Back to Contents during preparation cancels once and a late preview cannot revive it", () => {
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
    assert.equal(journey.go(3), false);
    assert.throws(() => journey.saved({ bundleId: "empty", files: {} }), /links are unavailable/);
});

test("unconfirmed save outcome survives draft invalidation and keeps only read-only recovery available", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.beginScan(); journey.previewReady(preview); journey.reviewed(); journey.writing(true);
    journey.failed("The local write may have completed. Check save status.");
    journey.writing(false);
    journey.invalidate("A context revision changed.");
    journey.update({ scopeReady: false, scopeIssue: "Read pending" });
    assert.equal(journey.snapshot().phase, "blocked");
    assert.equal(journey.snapshot().saveUnconfirmed, true);
    assert.equal(journey.snapshot().hasPreview, false, "No disclosure approval is retained");
    assert.equal(journey.isReviewOpen(), false, "Read-only status/history recovery must not defer to a nonexistent review");
    assert.equal(journey.go(1), false);
    assert.equal(journey.beginScan(), null);
    assert.equal(journey.clear(), false, "Clearing must not bypass original-outcome recovery");
    journey.failed("History lookup failed. No save was repeated.");
    journey.invalidate("Permission changed.");
    assert.equal(journey.snapshot().saveUnconfirmed, true);
    journey.saved({ bundleId: "original-receipt", files: { "product-report.html": "invented" } });
    assert.equal(journey.snapshot().saveUnconfirmed, false);
    assert.equal(journey.snapshot().phase, "saved");
    journey.clear();
    assert.equal(journey.snapshot().phase, "draft");
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
    assert.equal(journey.reason(2), "", "Formats are chosen in Contents");
    assert.match(journey.reason(3), /Choose at least one format/);
    assert.equal(journey.go(1), true);
});

test("revisiting Setup after a completed save starts a draft, not a success-shaped next report", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.beginScan();
    journey.previewReady(preview);
    journey.reviewed();
    journey.saved({ bundleId: "saved", files: { "product-report.html": "private-file" } });
    assert.equal(journey.go(1), true);
    assert.equal(journey.snapshot().phase, "draft");
    assert.equal(journey.snapshot().completed, false);
    assert.equal(journey.snapshot().requestCount, 2);
    assert.equal(journey.go(3), false);
});

test("a previously opened setup can be restored after its last member is removed but cannot prepare", () => {
    const journey = createReportJourney();
    chosen(journey);
    journey.go(2);
    chosen(journey, 0);
    assert.equal(journey.go(2), true, "Returning from a peek must not strand the draft");
    assert.equal(journey.beginScan(), null);
});
