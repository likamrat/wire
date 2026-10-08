import test from "node:test";
import assert from "node:assert/strict";
import { createDisclosureState } from "../web/disclosure-state.mjs";

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
