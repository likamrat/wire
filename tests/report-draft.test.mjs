import test from "node:test";
import assert from "node:assert/strict";
import { createReportDraft } from "../web/report-draft.mjs";

test("every report setting change invalidates the current review token without reusable consent", () => {
    const draft = createReportDraft();
    assert.equal(draft.options().promptMode, "masked");
    for (const patch of [{ promptMode: "original" }, { formats: ["pdf"] }, { manualTerms: ["Leila"] }, { overrides: [{ key: "p", omit: true }] }]) {
        const token = draft.token();
        draft.change(patch);
        assert.equal(draft.current(token), false);
        assert.equal(Object.hasOwn(draft.options(), "reviewed"), false);
    }
});

test("selection changes discard per-prompt edits but preserve deliberate masking terms and formats", () => {
    const draft = createReportDraft();
    draft.select(["a"]);
    draft.change({ overrides: [{ key: "p", omit: true }], manualTerms: ["Leila"], formats: ["html", "json"] });
    const token = draft.token();
    draft.select(["b"]);
    assert.equal(draft.current(token), false);
    assert.deepEqual(draft.options(), { promptMode: "masked", formats: ["html", "json"], manualTerms: ["Leila"], overrides: [] });
});

test("time context or date selection changes invalidate review without discarding prompt choices", () => {
    const draft = createReportDraft();
    draft.change({ promptMode: "original", formats: ["pdf"] });
    const context = { timeZone: "America/Los_Angeles", locale: "en-GB" };
    draft.synchronizeTime(context, { range: "custom", from: "2026-03-08", to: "2026-03-08" });
    const token = draft.token();
    draft.synchronizeTime(context, { range: "custom", from: "2026-03-08", to: "2026-03-08" });
    assert.equal(draft.current(token), true);
    draft.synchronizeTime({ ...context, timeZone: "Asia/Kolkata" }, { range: "capture" });
    assert.equal(draft.current(token), false);
    assert.equal(draft.options().promptMode, "original");
    assert.deepEqual(draft.options().formats, ["pdf"]);
    assert.equal(draft.options().timeContext.timeZone, "Asia/Kolkata");
});

test("clearing always invalidates in-flight review and per-copy edits, preserving prompt/format preferences", () => {
    const draft = createReportDraft();
    draft.select(["all", "a", "b"]);
    draft.change({ promptMode: "original", formats: ["html", "pdf"], manualTerms: ["Leila"], overrides: [{ key: "p", text: "Edited copy" }] });
    const token = draft.token();
    draft.clearSelection();
    assert.equal(draft.current(token), false);
    assert.deepEqual(draft.options(), { promptMode: "original", formats: ["html", "pdf"], manualTerms: ["Leila"], overrides: [] });
    const emptyToken = draft.token();
    draft.clearSelection();
    assert.equal(draft.current(emptyToken), false, "Even an already-empty selection invalidates outstanding work");
    assert.deepEqual(createReportDraft().options(), { promptMode: "masked", formats: ["html"], manualTerms: [], overrides: [] }, "Reload starts a fresh, non-persistent draft");
});
