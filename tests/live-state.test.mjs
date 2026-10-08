import test from "node:test";
import assert from "node:assert/strict";
import { createLiveState } from "../web/live-state.mjs";

test("incoming revisions defer during review/editing and never own report selection", () => {
    const live = createLiveState();
    assert.equal(live.observe(1, 1), "unchanged");
    assert.equal(live.observe(0, 1), "unchanged");
    assert.equal(live.observe(2, 1, { reviewing: true }), "defer");
    assert.equal(live.observe(2, 1, { editing: true }), "defer");
    assert.equal(live.observe(2, 1), "refresh");
    assert.equal(live.observe(2, 2), "unchanged");
    assert.equal(live.observe(3, 2, { loading: true }), "defer");
});
