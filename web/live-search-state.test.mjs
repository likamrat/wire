import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSearchState } from "./live-search-state.mjs";

test("a new query immediately clears old hits and refuses older responses", () => {
    const state = createLiveSearchState();
    state.receive({ event: "connected", panelId: "panel", epoch: 0 });
    state.query(1);
    state.receive({ event: "results", panelId: "panel", epoch: 0, hits: [{ id: "first" }],
        receipt: { panelId: "panel", epoch: 0, requestId: 1 } });
    assert.equal(state.snapshot().hits.length, 1);
    state.query(2);
    assert.deepEqual(state.snapshot().hits, []);
    state.receive({ event: "results", panelId: "panel", epoch: 0, hits: [{ id: "late" }],
        receipt: { panelId: "panel", epoch: 0, requestId: 1 } });
    assert.deepEqual(state.snapshot().hits, []);
});

test("only current status updates apply and unavailable status cannot retain targets", () => {
    const state = createLiveSearchState();
    state.receive({ event: "connected", panelId: "panel", epoch: 0 });
    state.query(2);
    state.receive({ event: "status", panelId: "panel", epoch: 0, requestId: 1, state: "no-match" });
    assert.equal(state.snapshot().state, "queued");
    state.receive({ event: "status", panelId: "panel", epoch: 0, requestId: 2, state: "building" });
    assert.equal(state.snapshot().state, "building");
    state.receive({ event: "results", panelId: "panel", epoch: 0, hits: [{ id: "first" }],
        receipt: { panelId: "panel", epoch: 0, requestId: 2 } });
    state.receive({ event: "status", panelId: "panel", epoch: 0, requestId: 2, state: "unavailable" });
    assert.deepEqual(state.snapshot().hits, []);
    assert.equal(state.snapshot().receipt, null);
});

test("observed fences and disconnects erase hits and prevent resurrection across reconnect", () => {
    const state = createLiveSearchState();
    state.receive({ event: "connected", panelId: "old", epoch: 0 });
    state.query(1);
    state.receive({ event: "results", panelId: "old", epoch: 0, hits: [{ id: "private" }],
        receipt: { panelId: "old", epoch: 0, requestId: 1 } });
    state.receive({ event: "fence", panelId: "old", epoch: 1, reason: "changed" });
    assert.deepEqual(state.snapshot().hits, []);
    state.receive({ event: "results", panelId: "old", epoch: 0, hits: [{ id: "late" }],
        receipt: { panelId: "old", epoch: 0, requestId: 1 } });
    assert.deepEqual(state.snapshot().hits, []);
    state.disconnect();
    state.receive({ event: "connected", panelId: "new", epoch: 0 });
    state.receive({ event: "results", panelId: "old", epoch: 1, hits: [{ id: "late" }],
        receipt: { panelId: "old", epoch: 1, requestId: 1 } });
    assert.deepEqual(state.snapshot().hits, []);
    assert.equal(state.snapshot().receipt, null);
});
