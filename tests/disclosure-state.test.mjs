import test from "node:test";
import assert from "node:assert/strict";
import { createDisclosureState } from "../web/disclosure-state.mjs";

test("withdrawal forgets transient disclosure, page and identity ordering without a replacement snapshot", () => {
    const state = createDisclosureState();
    state.setOpen("private-key", true);
    state.setPage("private-key", 3);
    state.ordered("private-key", ["private-first", "private-second"], value => value);
    state.withdrawAccess();
    state.withdrawAccess();
    assert.equal(state.isOpen("private-key"), false);
    assert.equal(state.page("private-key", 50, 5), 0);
    assert.deepEqual(state.ordered("private-key", ["private-second", "private-first"], value => value), ["private-second", "private-first"]);
});

test("disclosure state uses stable IDs, explicit defaults, independent bounded pages and panel lifetime", () => {
    const state = createDisclosureState();
    assert.equal(state.isOpen("session:a"), false);
    assert.equal(state.isOpen("session:b", true), true);
    state.setOpen("session:b", false);
    state.setOpen("session:a", true);
    assert.equal(state.isOpen("session:b", true), false);
    assert.equal(state.isOpen("session:a"), true);
    state.setPage("requests:a", 4);
    assert.equal(state.page("requests:a", 29, 6), 4);
    assert.equal(state.page("requests:b", 29, 6), 0);
    assert.equal(state.page("requests:a", 12, 6), 1);
    assert.equal(state.page("requests:a", 0, 6), 0);
    assert.equal(createDisclosureState().isOpen("session:a"), false);
});

test("live arrival keeps existing identity order without omissions or duplicate rows", () => {
    const state = createDisclosureState(), id = value => value.id;
    const first = [{ id: "a", count: 1 }, { id: "b", count: 2 }];
    assert.deepEqual(state.ordered("scope", first, id), first);
    const next = [{ id: "c", count: 3 }, { id: "b", count: 9 }, { id: "a", count: 4 }];
    assert.deepEqual(state.ordered("scope", next, id), [next[2], next[1], next[0]]);
    assert.deepEqual(state.ordered("different-filter", next, id), next);
    assert.deepEqual(state.ordered("scope", [next[0]], id), [next[0]]);
});

test("section availability derives from present owners without a separate bulk visibility state", () => {
    const state = createDisclosureState(), keys = ["text:request:a", "reader:a:activity", "reader:a:source"];
    assert.deepEqual(state.openSummary(keys, true), { total: 3, open: 3, canExpand: false, canCollapse: true });
    state.setOpen(keys[0], false);
    assert.deepEqual(state.openSummary(keys, true), { total: 3, open: 2, canExpand: true, canCollapse: true });
    for (const key of keys) state.setOpen(key, false);
    assert.deepEqual(state.openSummary(keys, true), { total: 3, open: 0, canExpand: true, canCollapse: false });
    assert.deepEqual(state.openSummary([], true), { total: 0, open: 0, canExpand: false, canCollapse: false });
    assert.deepEqual(state.openSummary(["reader:b:activity"], true), { total: 1, open: 1, canExpand: false, canCollapse: true });
    state.forget(keys[0]);
    assert.deepEqual(state.openSummary(keys, true), { total: 3, open: 1, canExpand: true, canCollapse: true });
});
