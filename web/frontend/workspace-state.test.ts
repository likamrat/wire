import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceState } from "./workspace-state.ts";

test("pending and failed reads retain the accepted evidence and filter scope", () => {
    const authority = {};
    const state = createWorkspaceState({ isCurrent: token => token === authority });
    const first = state.beginRead(authority);
    assert.ok(first !== null);
    const evidence = { revision: 1 }, scope = { tool: "fetch" }, analytics = { count: 8 };
    assert.equal(state.acceptRead(first, authority, { evidence, scope, analytics, route: { view: "analyze" } }), true);
    const pending = state.beginRead(authority);
    assert.ok(pending !== null);
    assert.equal(state.loading, true);
    assert.equal(state.evidence, evidence);
    assert.equal(state.scope, scope);
    assert.equal(state.failRead(pending, authority), true);
    assert.equal(state.loading, false);
    assert.equal(state.stale, true);
    assert.equal(state.evidence, evidence);
    assert.equal(state.scope, scope);
});

test("the React subscription publishes readiness without copying private evidence into render props", () => {
    const state = createWorkspaceState({ isCurrent: () => true }), authority = {}, seen: string[] = [];
    const unsubscribe = state.subscribe(() => seen.push(JSON.stringify(state.getSnapshot())));
    const read = state.beginRead(authority);
    assert.ok(read !== null);
    state.acceptRead(read, authority, {
        evidence: { prompt: "PRIVATE_PROMPT" }, scope: { query: "PRIVATE_QUERY" }, analytics: { count: 8 },
        route: { view: "analyze", session: "PRIVATE_SESSION" },
    });
    state.withdrawAccess();
    assert.ok(seen.some(value => value.includes('"phase":"ready"')));
    assert.equal(state.getSnapshot().phase, "unavailable");
    assert.deepEqual(state.route, { view: "analyze" });
    assert.ok(seen.every(value => !value.includes("PRIVATE_")));
    unsubscribe();
});

test("a reentrant authority check cannot admit a read after withdrawal", () => {
    let retire = false;
    const state = createWorkspaceState({ isCurrent: () => {
        if (retire) { retire = false; state.withdrawAccess(); }
        return true;
    } });
    retire = true;
    assert.equal(state.beginRead({}), null);
});

test("later navigation or reading intent rejects a delayed return without cancelling the new intent", () => {
    const authority = {}, state = createWorkspaceState({ isCurrent: token => token === authority });
    const navigation = state.captureIntent(authority);
    state.beginNavigation();
    assert.equal(state.intentCurrent(navigation), false);
    const reading = state.captureIntent(authority);
    state.noteReading();
    assert.equal(state.intentCurrent(reading), false);
    assert.equal(state.intentCurrent(state.captureIntent(authority)), true);
});

test("withdrawal retires held reads and reading positions before fresh re-entry", () => {
    let authority = {};
    const state = createWorkspaceState({
        isCurrent: token => token === authority,
        releaseReading: saved => { for (const key of Object.keys(saved)) delete saved[key]; },
    });
    const oldAuthority = authority, first = state.beginRead(authority);
    assert.ok(first !== null);
    const reading = { text: "retained private prompt" };
    state.positions.set("origin", reading);
    state.withdrawAccess();
    assert.deepEqual(reading, {});
    assert.equal(state.positions.size, 0);
    assert.equal(state.acceptRead(first, oldAuthority, {
        evidence: { revision: 1 }, scope: {}, analytics: {}, route: { view: "analyze" },
    }), false);
    assert.equal(state.evidence, undefined);
    authority = {};
    const next = state.beginRead(authority);
    assert.ok(next !== null);
    assert.equal(state.acceptRead(next, authority, {
        evidence: { revision: 2 }, scope: {}, analytics: {}, route: { view: "analyze" },
    }), true);
});
