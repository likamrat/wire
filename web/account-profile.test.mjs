import test from "node:test";
import assert from "node:assert/strict";
import { createAccountProfile } from "./account-profile.mjs";

function fixture(provider = "github") {
    let token = Object.freeze({});
    const state = { readable: true, mode: "enforced", visible: true, calls: [], deliveries: [] };
    const api = async path => {
        state.calls.push(path);
        return state.read ? state.read(path) : { identity: { state: "unavailable" } };
    };
    api.accessState = () => ({ mode: state.mode, readable: state.readable, collectionMode: state.collectionMode,
        state: { microsoft: state.microsoft } });
    api.publicationToken = () => token;
    api.isCurrent = value => state.readable && value === token;
    state.replace = () => { token = Object.freeze({}); };
    state.api = api;
    state.profile = createAccountProfile({
        api, provider, visible: () => state.visible,
        present: (github, owner) => { state.deliveries.push({ github, owner }); return true; },
    });
    return state;
}

test("profile reads use the original shared publication and do not follow access heartbeats", async () => {
    const state = fixture();
    try {
        const owner = state.api.publicationToken();
        await state.profile.receiveAccess();
        await state.profile.receiveAccess();
        await state.profile.receiveAccess();
        assert.deepEqual(state.calls, ["/api/profile/github"]);
        assert.deepEqual(state.deliveries.map(value => value.github.phase), ["loading", "ready"]);
        assert.ok(state.deliveries.every(value => value.owner === owner));
    } finally { state.profile.dispose(); }
});

test("verified presentation revalidates by its shorter lease and stops while hidden", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
    const state = fixture();
    state.read = () => ({ identity: { state: "verified", expiresAt: Date.now() + 15000 },
        avatar: { expiresAt: Date.now() + 1000 } });
    try {
        await state.profile.receiveAccess();
        t.mock.timers.tick(1000);
        await state.profile.receiveAccess();
        assert.equal(state.calls.length, 2);
        state.visible = false;
        t.mock.timers.tick(1000);
        await state.profile.receiveAccess();
        assert.equal(state.calls.length, 2);
        state.visible = true;
        await state.profile.receiveAccess();
        assert.equal(state.calls.length, 3);
    } finally { state.profile.dispose(); }
});

test("withdrawal fences pending profiles and coalesces a fresh replacement read", async () => {
    const state = fixture(), old = Promise.withResolvers();
    state.read = () => old.promise;
    try {
        const first = state.profile.receiveAccess();
        const duplicate = state.profile.refresh();
        state.profile.withdrawAccess();
        state.replace();
        state.read = () => ({ identity: { state: "unavailable" } });
        const next = state.profile.receiveAccess();
        old.resolve({ identity: { state: "verified", login: "retired-profile" } });
        await Promise.all([first, duplicate, next]);
        await state.profile.receiveAccess();
        assert.equal(state.calls.length, 2);
        assert.deepEqual(state.deliveries.map(value => value.github.phase), ["loading", "loading", "ready"]);
        assert.equal(state.deliveries.some(value => value.github.profile?.identity.login === "retired-profile"), false);
    } finally { old.resolve(null); state.profile.dispose(); }
});

test("unbound, unavailable, asynchronous and truthy grants cannot read or publish a profile", async () => {
    for (const kind of ["unbound", "unreadable", "hidden", "null", "async-token", "truthy", "async-check"]) {
        const state = fixture();
        if (kind === "unbound") state.mode = "unbound";
        if (kind === "unreadable") state.readable = false;
        if (kind === "hidden") state.visible = false;
        if (kind === "null") state.api.publicationToken = () => null;
        if (kind === "async-token") state.api.publicationToken = () => Promise.resolve({});
        if (kind === "truthy") state.api.isCurrent = () => ({});
        if (kind === "async-check") state.api.isCurrent = () => Promise.resolve(true);
        try {
            await state.profile.receiveAccess();
            await state.profile.refresh();
            assert.deepEqual(state.calls, [], kind);
            assert.deepEqual(state.deliveries, [], kind);
        } finally { state.profile.dispose(); }
    }
});

test("read failures have a safe retry state and no automatic retry or raw error publication", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
    const state = fixture();
    state.read = () => { throw new Error("PRIVATE FAILURE"); };
    try {
        await state.profile.receiveAccess();
        assert.deepEqual(state.deliveries.map(value => value.github.phase), ["loading", "error"]);
        t.mock.timers.tick(60000);
        await state.profile.receiveAccess();
        assert.equal(state.calls.length, 1);
        assert.doesNotMatch(JSON.stringify(state.deliveries), /PRIVATE/);
        state.read = () => ({ identity: { state: "unavailable" } });
        await state.profile.refresh();
        assert.equal(state.calls.length, 2);
        state.profile.dispose();
        await state.profile.refresh();
        assert.equal(state.calls.length, 2);
    } finally { state.profile.dispose(); }
});

test("the footer keeps the GitHub route independently of Microsoft connection readiness", async () => {
    const state = fixture();
    state.collectionMode = "source-aware"; state.microsoft = { state: "signing-in" };
    try {
        await state.profile.receiveAccess();
        state.microsoft = { state: "connected" };
        await state.profile.receiveAccess();
        await state.profile.receiveAccess();
        assert.deepEqual(state.calls, ["/api/profile/github"]);
    } finally { state.profile.dispose(); }
});

test("the separate Microsoft reader revalidates connection changes without changing the footer route", async () => {
    const state = fixture("microsoft");
    state.collectionMode = "source-aware"; state.microsoft = { state: "signing-in" };
    try {
        await state.profile.receiveAccess();
        state.microsoft = { state: "connected" };
        await state.profile.receiveAccess();
        await state.profile.receiveAccess();
        assert.deepEqual(state.calls, ["/api/profile/microsoft", "/api/profile/microsoft"]);
    } finally { state.profile.dispose(); }
});

test("the Microsoft reader stays inactive outside the source-aware experience", async () => {
    const state = fixture("microsoft");
    try {
        await state.profile.receiveAccess();
        await state.profile.refresh();
        assert.deepEqual(state.calls, []);
        assert.deepEqual(state.deliveries, []);
    } finally { state.profile.dispose(); }
    assert.throws(() => createAccountProfile({ api: state.api, present() {}, provider: "unknown" }), TypeError);
});

test("a connection change fences a late Microsoft profile without needing a new publication token", async () => {
    const state = fixture("microsoft"), old = Promise.withResolvers();
    state.collectionMode = "source-aware"; state.microsoft = { state: "connected" };
    state.read = () => old.promise;
    try {
        const first = state.profile.receiveAccess();
        state.microsoft = { state: "reconnect-required" };
        state.read = () => ({ identity: { state: "unavailable" } });
        const next = state.profile.receiveAccess();
        old.resolve({ identity: { state: "verified" }, email: { value: "retired@example.invalid" } });
        await Promise.all([first, next]);
        await state.profile.receiveAccess();
        assert.deepEqual(state.calls, ["/api/profile/microsoft", "/api/profile/microsoft"]);
        assert.equal(state.deliveries.some(value => value.github.profile?.email?.value === "retired@example.invalid"), false);
    } finally { old.resolve(null); state.profile.dispose(); }
});
