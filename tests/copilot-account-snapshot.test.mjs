import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createCopilotAccountSnapshot } from "../lib/copilot-account-snapshot.mjs";
import { createCopilotProfileIdentity, COPILOT_ACCOUNT_LEASE_MS } from "../lib/github-profile-identity.mjs";
import { createGitHubProfile } from "../lib/github-profile.mjs";
import { privateFixture } from "./helpers.mjs";

const login = "synthetic-alice";
const status = (name = login) => ({ isAuthenticated: true, authType: "user", host: "https://github.com", login: name });
const selected = (name = login, selectionId = "synthetic-selection") => ({
    kind: "activeAccount",
    account: { active: true, kind: "githubDotCom", host: "https://github.com", login: name, selectionId },
    authInfo: { type: "user", host: "github.com", login: name },
});
function host({ get = async () => selected(), getStatus = async () => status() } = {}) {
    const calls = [];
    return {
        calls,
        session: { rpc: {
            accounts: { async get(input) { calls.push(["accounts.get", input]); return get(input); } },
            gitHubAuth: { async getStatus() { calls.push(["gitHubAuth.getStatus"]); return getStatus(); } },
        } },
    };
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X8AAAAASUVORK5CYII=", "base64");
const fetchPhoto = async url => url.startsWith("https://api.github.com/")
    ? Response.json({ type: "User", id: 12345, login, name: "Synthetic Example", avatar_url: "https://avatars.githubusercontent.com/u/12345" })
    : new Response(png, { headers: { "content-type": "image/png" } });

test("existing-host snapshot reads activeAccount around session auth, not a new SDK runtime, with a narrow projection", async () => {
    const account = selected();
    for (const target of [account, account.account, account.authInfo]) {
        for (const key of ["token", "email", "copilotUser", "envVar", "registrationId"]) {
            Object.defineProperty(target, key, { get() { assert.fail("Must not read " + key); } });
        }
    }
    const fixture = host({ get: async () => account });
    const reader = createCopilotAccountSnapshot(() => fixture.session, { now: () => 100000 });
    const result = await reader.read();
    assert.deepEqual(fixture.calls, [
        ["accounts.get", { query: { kind: "activeAccount" } }],
        ["gitHubAuth.getStatus"],
        ["accounts.get", { query: { kind: "activeAccount" } }],
    ]);
    assert.deepEqual(Object.keys(result).sort(), ["authType", "checkedAt", "expiresAt", "generation", "host", "login", "reason", "schemaVersion", "scope", "source", "state"].sort());
    assert.equal(result.state, "observed", "Observation is not an app-selected-account attestation");
    assert.equal(result.scope, "existing-host-session");
    assert.equal(result.login, login);
    assert.equal(result.host, "github.com");
    assert.equal(result.expiresAt - result.checkedAt, COPILOT_ACCOUNT_LEASE_MS);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-selection|token|email|copilotUser/);
    reader.close();
});

test("signed-out, missing/unsupported metadata and unsupported source fail without consulting another account", async () => {
    const unavailable = createCopilotAccountSnapshot(() => null);
    assert.equal((await unavailable.read()).reason, "host-snapshot-unsupported");
    const signedOut = host({ get: async () => ({ kind: "activeAccount" }), getStatus: async () => ({ isAuthenticated: false }) });
    assert.equal((await createCopilotAccountSnapshot(() => signedOut.session).read()).state, "signed-out");
    for (const value of [null, { kind: "status" }, { kind: "activeAccount", account: false, authInfo: false }, { kind: "activeAccount", account: selected().account },
        { ...selected(), account: { ...selected().account, active: false } },
        { ...selected(), account: { ...selected().account, kind: "proxima" } },
        { ...selected(), account: { ...selected().account, selectionId: "" } },
        { ...selected(), account: { ...selected().account, selectionId: "x".repeat(1025) } }]) {
        const fixture = host({ get: async () => value });
        const result = await createCopilotAccountSnapshot(() => fixture.session).read();
        assert.equal(result.state, "unavailable"); assert.equal(result.login, null);
        assert.equal(fixture.calls.length, 1);
    }
    for (const type of ["env", "gh-cli", "token", "token-provider", "hmac", "account", undefined]) {
        const fixture = host({ get: async () => ({ ...selected(), authInfo: { ...selected().authInfo, type } }) });
        assert.equal((await createCopilotAccountSnapshot(() => fixture.session).read()).reason, "active-account-source-unverified");
        assert.equal(fixture.calls.length, 1);
    }
});

test("per-session override, auth disagreement, and inconsistent active-account login are explicit conflicts", async () => {
    for (const current of [status("different-session-user"), { ...status(), authType: "env" },
        { ...status(), authType: "token-provider" }, { isAuthenticated: false }]) {
        const fixture = host({ getStatus: async () => current });
        assert.equal((await createCopilotAccountSnapshot(() => fixture.session).read()).reason, "session-account-conflict");
        assert.equal(fixture.calls.length, 3);
    }
    const mismatch = host({ get: async () => ({ ...selected(), authInfo: { ...selected().authInfo, login: "different-auth-user" } }) });
    assert.equal((await createCopilotAccountSnapshot(() => mismatch.session).read()).reason, "active-account-conflict");
    const missingAccount = host({ get: async () => ({ kind: "activeAccount" }) });
    assert.equal((await createCopilotAccountSnapshot(() => missingAccount.session).read()).reason, "session-account-conflict");
});

test("double-snapshot fencing rejects an account or selection change during a read", async () => {
    for (const next of [selected("synthetic-bob"), selected(login, "reselected-account")]) {
        let reads = 0;
        const fixture = host({ get: async () => ++reads === 1 ? selected() : next });
        const result = await createCopilotAccountSnapshot(() => fixture.session).read();
        assert.equal(result.reason, "active-account-changed");
        assert.equal(result.login, null);
    }
});

test("on-read revalidation owns its generation without any host events or background polling", async () => {
    let value = selected(), currentStatus = status(), clock = 100000;
    const fixture = host({ get: async () => value, getStatus: async () => currentStatus });
    const reader = createCopilotAccountSnapshot(() => fixture.session, { now: () => clock });
    const first = await reader.read();
    clock++;
    const second = await reader.read();
    assert.equal(second.generation, first.generation);
    assert.equal(second.checkedAt, clock);
    value = selected(login, "new-selection");
    const reselected = await reader.read();
    assert.notEqual(reselected.generation, first.generation);
    value = selected("synthetic-bob"); currentStatus = status("synthetic-bob");
    const changed = await reader.read();
    assert.notEqual(changed.generation, reselected.generation); assert.equal(changed.login, "synthetic-bob");
    value = { kind: "activeAccount" }; currentStatus = { isAuthenticated: false };
    const out = await reader.read();
    assert.equal(out.state, "signed-out"); assert.notEqual(out.generation, changed.generation);
    value = selected(); currentStatus = status();
    const returned = await reader.read();
    assert.notEqual(returned.generation, first.generation);
    const count = fixture.calls.length;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.calls.length, count, "No idle polling");
    reader.close();
});

test("hung existing-host metadata has one bounded outstanding read and cannot publish a late result", async () => {
    let resolve;
    const fixture = host({ get: () => new Promise(done => { resolve = done; }) });
    const reader = createCopilotAccountSnapshot(() => fixture.session, { timeoutMs: 5 });
    const values = await Promise.all(Array.from({ length: 20 }, () => reader.read()));
    assert.ok(values.every(value => value.reason === "host-snapshot-timeout"));
    assert.equal(fixture.calls.length, 1);
    assert.equal((await reader.read()).reason, "host-snapshot-timeout");
    resolve(selected());
    await new Promise(done => setImmediate(done));
    assert.equal(fixture.calls.length, 1, "Late resolution must not start status/recheck work");
    const next = reader.read();
    reader.close(); resolve(selected());
    assert.equal((await next).reason, "host-snapshot-invalidated");
    assert.equal((await reader.read()).reason, "host-reader-closed");
});

test("invalidation and joined-handle or ID replacement fence in-flight snapshots without a host event", async () => {
    for (const change of ["invalidate", "replace", "id"]) {
        let release, entered;
        const started = new Promise(resolve => { entered = resolve; });
        const fixture = host({ get: () => new Promise(resolve => { release = resolve; entered(); }) });
        fixture.session.sessionId = "synthetic-existing-session";
        let session = fixture.session;
        const reader = createCopilotAccountSnapshot(() => session);
        const operation = reader.read(); await started;
        if (change === "invalidate") reader.invalidate();
        else if (change === "replace") session = host().session;
        else session.sessionId = "synthetic-other-session";
        release(selected());
        assert.equal((await operation).reason, "host-snapshot-invalidated");
        assert.equal(fixture.calls.length, 1);
        reader.close();
    }
});

test("malformed and throwing host APIs expose fixed failure codes only", async () => {
    const fixture = host({ get: async () => { throw new Error("PRIVATE AUTH DETAILS"); } });
    const result = await createCopilotAccountSnapshot(() => fixture.session).read();
    assert.equal(result.reason, "host-snapshot-unavailable");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE AUTH/);
    assert.equal((await createCopilotAccountSnapshot(() => { throw new Error("PRIVATE HANDLE FAILURE"); }).read()).reason, "host-snapshot-unavailable");
});

test("replacing the existing joined handle rotates the local generation even for the same account", async () => {
    let session = host().session;
    const reader = createCopilotAccountSnapshot(() => session);
    const first = await reader.read();
    session = host().session;
    const second = await reader.read();
    assert.equal(second.state, "observed");
    assert.equal(second.login, first.login);
    assert.notEqual(second.generation, first.generation);
    reader.close();
});

test("a slow/clock-invalid observation cannot obtain a fresh lease merely by returning late", async () => {
    for (const shift of [COPILOT_ACCOUNT_LEASE_MS, -1]) {
        let clock = 100000;
        const fixture = host({ getStatus: async () => { clock += shift; return status(); } });
        const result = await createCopilotAccountSnapshot(() => fixture.session, { now: () => clock }).read();
        assert.equal(result.reason, "host-snapshot-expired");
        assert.equal(result.expiresAt, result.checkedAt);
    }
});

test("snapshot lease validity is independent of host events and unqualified observations never enable identity", async () => {
    let clock = 100000;
    const fixture = host(), reader = createCopilotAccountSnapshot(() => fixture.session, { now: () => clock });
    const snapshot = await reader.read();
    let calls = 0;
    const unqualified = createCopilotProfileIdentity({ readSnapshot: async () => { calls++; return snapshot; } });
    assert.equal((await unqualified.read()).reason, "account-match-unavailable");
    assert.equal(calls, 0);
    const qualified = createCopilotProfileIdentity({ binding: "copilot-app", readSnapshot: async () => snapshot, now: () => clock });
    assert.equal((await qualified.read()).state, "verified");
    clock = snapshot.expiresAt;
    assert.equal((await qualified.read()).reason, "account-snapshot-expired");
    clock = snapshot.checkedAt + 1;
    assert.equal((await qualified.read()).state, "verified");
    for (const [patch, reason] of [
        [{ source: "arbitrary-cli" }, "account-snapshot-invalid"],
        [{ scope: "new-session" }, "account-snapshot-invalid"],
        [{ generation: "invalid" }, "account-snapshot-invalid"],
        [{ checkedAt: clock + 100 }, "account-snapshot-expired"],
        [{ expiresAt: clock + COPILOT_ACCOUNT_LEASE_MS * 2 }, "account-snapshot-expired"],
        [{ state: "verified" }, "account-snapshot-invalid"],
    ]) {
        const invalid = createCopilotProfileIdentity({ binding: "copilot-app", readSnapshot: async () => ({ ...snapshot, ...patch }), now: () => clock });
        const result = await invalid.read();
        assert.equal(result.state, "unavailable");
        assert.equal(result.reason, reason, JSON.stringify(patch));
        invalid.close();
    }
    reader.close();
});

test("identity-source invalidation rejects an old pending metadata value even when a new read is requested", async () => {
    let release, entered, calls = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const source = createCopilotProfileIdentity({
        binding: "copilot-app",
        getAuthStatus: () => { calls++; entered(); return new Promise(resolve => { release = resolve; }); },
    });
    const first = source.read(); await started; source.invalidate();
    assert.equal((await source.read()).reason, "identity-source-invalidated");
    assert.equal(calls, 1);
    release(status());
    assert.equal((await first).reason, "identity-source-invalidated");
    source.close();
});

test("an identity read that already timed out cannot later reuse its old metadata response", async () => {
    let release, calls = 0;
    const source = createCopilotProfileIdentity({
        binding: "copilot-app", timeoutMs: 5,
        getAuthStatus: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    });
    assert.equal((await source.read()).reason, "auth-status-timeout");
    const again = source.read();
    release(status());
    assert.equal((await again).reason, "auth-status-timeout");
    assert.equal(calls, 1);
    await new Promise(resolve => setImmediate(resolve));
    source.close();
});

test("a fixed snapshot expiring during public lookup is not published as fresh account data", async t => {
    const { context } = await privateFixture(t);
    let clock = 100000;
    const fixture = host(), reader = createCopilotAccountSnapshot(() => fixture.session, { now: () => clock });
    const snapshot = await reader.read();
    const profile = createGitHubProfile(context, {
        now: () => clock, copilot: { binding: "copilot-app", readSnapshot: async () => snapshot },
        fetch: async url => { const value = await fetchPhoto(url); clock = snapshot.expiresAt; return value; },
    });
    t.after(() => profile.close());
    const result = await profile.read();
    assert.equal(result.identity.reason, "account-snapshot-expired");
    assert.equal(result.avatar.revision, null);
    assert.equal(result.displayName.value, null);
    reader.close();
});

test("qualified snapshot adapter fences account reselection, expiry and generation changes during avatar fetch", async t => {
    const { context } = await privateFixture(t);
    let clock = 100000, selectionId = "one";
    const fixture = host({ get: async () => selected(login, selectionId) });
    const reader = createCopilotAccountSnapshot(() => fixture.session, { now: () => clock });
    const profile = createGitHubProfile(context, {
        now: () => clock, copilot: { binding: "copilot-app", readSnapshot: () => reader.read() }, fetch: fetchPhoto,
    });
    t.after(() => profile.close());
    const first = await profile.read();
    assert.equal(first.identity.state, "verified");
    assert.equal(first.identity.expiresAt, clock + COPILOT_ACCOUNT_LEASE_MS);
    selectionId = "two";
    const second = await profile.read();
    assert.notEqual(second.generation, first.generation);
    await assert.rejects(profile.image(first.avatar.revision), { status: 404 });
    clock += COPILOT_ACCOUNT_LEASE_MS;
    assert.throws(() => profile.assertImageCurrent(second.avatar.revision), { status: 404 });
    await profile.close();
    let changed = false;
    const duringFetch = createGitHubProfile(context, {
        now: () => clock, copilot: { binding: "copilot-app", readSnapshot: () => reader.read() },
        fetch: async url => { if (!changed) { changed = true; selectionId = "three"; } return fetchPhoto(url); },
    });
    t.after(() => duringFetch.close());
    // Force a refresh beyond the stored public profile freshness window.
    clock += 7 * 60 * 60 * 1000;
    const result = await duringFetch.read();
    assert.equal(result.avatar.state, "unavailable", "Pre-reselection photo is never committed");
    reader.close();
});

test("repository extension retains one existing joined handle and exposes an empty-input tool without opening WIRE", async t => {
    const fixture = host();
    fixture.session.sessionId = "synthetic-existing-session";
    const invocation = { sessionId: fixture.session.sessionId };
    let config, joins = 0;
    const key = "__wireSyntheticSnapshotSdk";
    globalThis[key] = {
        joinSession: async value => { config = value; joins++; return fixture.session; },
        createCanvas: value => value,
        CanvasError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    };
    const module = `const sdk = globalThis.${key}; export const joinSession = sdk.joinSession, createCanvas = sdk.createCanvas, CanvasError = sdk.CanvasError;`;
    const hooks = registerHooks({ resolve(specifier, context, next) {
        if (specifier === "@github/copilot-sdk/extension") return { url: `data:text/javascript,${encodeURIComponent(module)}`, shortCircuit: true };
        return next(specifier, context);
    } });
    t.after(() => { hooks.deregister(); delete globalThis[key]; });
    await import("../extension.mjs?snapshot-test");
    assert.equal(joins, 1);
    assert.equal(config.requestedEnvironmentVariables, undefined);
    assert.equal(fixture.calls.length, 0, "No metadata read merely from extension initialization");
    const actions = config.canvases[0].actions;
    assert.equal(config.tools.length, 1);
    const tool = config.tools.find(value => value.name === "wire_github_account_snapshot");
    assert.ok(tool);
    assert.equal(actions.some(value => value.name === "get_state"), true);
    assert.deepEqual(tool.parameters.properties, {});
    for (const value of [undefined, {}, { sessionId: "synthetic-wrong-session" }]) {
        assert.equal((await tool.handler({}, value)).resultType, "rejected");
    }
    assert.equal(fixture.calls.length, 0);
    const result = await tool.handler({}, invocation);
    assert.equal(result.resultType, "success");
    assert.equal(JSON.parse(result.textResultForLlm).state, "observed");
    const calls = fixture.calls.length;
    for (const input of [null, undefined, { sessionId: "different" }, { login: "arbitrary" }, { url: "http://127.0.0.1" }, [], "bad"]) {
        assert.equal((await tool.handler(input, invocation)).resultType, "rejected");
    }
    assert.equal(fixture.calls.length, calls);
});
