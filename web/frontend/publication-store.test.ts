import test from "node:test";
import assert from "node:assert/strict";
import { createPublicationStore } from "./publication-store.ts";

test("withdrawal clears the published value before notifying and refuses a retired continuation", () => {
    const authority = {}, seen: string[] = [];
    let active = true;
    const store = createPublicationStore<string>(token => active && token === authority);
    store.subscribe(() => seen.push(store.getSnapshot().status));
    assert.equal(store.publish(authority, "private view"), true);
    const accepted = store.getSnapshot();
    assert.equal(store.getSnapshot(), accepted, "Unchanged subscriptions read the same snapshot.");
    active = false;
    store.withdraw();
    assert.deepEqual(store.getSnapshot(), { status: "unavailable", version: 2 });
    assert.equal(store.publish(authority, "late private view"), false);
    assert.deepEqual(seen, ["ready", "unavailable"]);
});

test("a freshness check that withdraws reentrantly cannot publish into the retired generation", () => {
    let store: ReturnType<typeof createPublicationStore<string>>;
    store = createPublicationStore<string>(() => {
        store.withdraw();
        return true;
    });

    assert.equal(store.publish({}, "retired content"), false);
    assert.equal(store.getSnapshot().status, "unavailable");
});

test("a failing subscriber clears other subscribers and closes further publication", () => {
    const store = createPublicationStore<string>(() => true), observed: string[] = [];
    store.subscribe(() => observed.push(store.getSnapshot().status));
    store.subscribe(() => {
        if (store.getSnapshot().status === "ready") throw new Error("Broken presenter");
    });
    assert.throws(() => store.publish({}, "private view"), AggregateError);
    assert.equal(store.getSnapshot().status, "unavailable");
    assert.deepEqual(observed, ["ready", "unavailable"]);
    assert.equal(store.publish({}, "retry cannot bypass failed clearance"), false);
});
