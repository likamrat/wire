import test from "node:test";
import assert from "node:assert/strict";
import { createCopilotAccountBridge } from "../lib/copilot-account-snapshot.mjs";
import { createGitHubProfile } from "../lib/github-profile.mjs";
import { createGitHubProfileRoutes } from "../lib/github-profile-http.mjs";
import { privateFixture } from "./helpers.mjs";

const sessionId = "synthetic-host";
const invocation = { sessionId };
const selected = (login = "synthetic-alice", selectionId = "synthetic-selection") => ({
    kind: "activeAccount",
    account: { active: true, kind: "githubDotCom", host: "github.com", login, selectionId },
    authInfo: { type: "user", host: "github.com", login },
});
function fixture() {
    const state = { account: selected(), status: { isAuthenticated: true, authType: "user", host: "github.com", login: "synthetic-alice" }, calls: [] };
    const forbidden = () => assert.fail("No model, credential, account mutation or secondary session operation is allowed");
    state.session = { sessionId, send: forbidden, rpc: {
        accounts: {
            get: async input => { state.calls.push(input); return state.account; },
            enumerate: forbidden, set: forbidden, login: { begin: forbidden },
        },
        gitHubAuth: { getStatus: async () => { state.calls.push("status"); return state.status; }, setCredentials: forbidden },
        send: forbidden, model: { getCurrent: forbidden }, providers: { getCatalog: forbidden },
    } };
    return state;
}
const parsed = result => JSON.parse(result.textResultForLlm);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X8AAAAASUVORK5CYII=", "base64");

test("bridge registers the existing metadata reader without startup work or implicit app qualification", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("Metadata must not contact WIRE or a public service"));
    t.mock.method(globalThis, "setInterval", () => assert.fail("Metadata must not poll"));
    const state = fixture();
    const bridge = createCopilotAccountBridge(() => state.session);
    t.after(() => bridge.close());
    assert.equal(state.calls.length, 0);
    assert.equal(bridge.copilot.binding, undefined);
    assert.equal(bridge.tool.name, "wire_github_account_snapshot");
    assert.deepEqual(bridge.tool.parameters, { type: "object", additionalProperties: false, properties: {}, required: [] });
    const result = await bridge.tool.handler({}, invocation);
    assert.equal(result.resultType, "success");
    assert.equal(parsed(result).state, "observed");
    assert.equal(parsed(result).login, "synthetic-alice");
    assert.equal(state.calls.length, 3);
    assert.doesNotMatch(result.textResultForLlm, /synthetic-host|synthetic-selection/);
});

test("empty input and invocation binding are checked before any metadata read", async t => {
    const state = fixture();
    const bridge = createCopilotAccountBridge(() => state.session, { expectedSessionId: sessionId });
    t.after(() => bridge.close());
    for (const input of [undefined, null, [], "", { login: "synthetic-bob" }, { sessionId }, { binding: "copilot-app" }]) {
        assert.equal((await bridge.tool.handler(input, invocation)).resultType, "rejected");
    }
    for (const value of [undefined, {}, { sessionId: "wrong-host" }]) {
        assert.equal((await bridge.tool.handler({}, value)).resultType, "rejected");
    }
    state.session.sessionId = "wrong-host";
    assert.equal((await bridge.tool.handler({}, { sessionId: "wrong-host" })).resultType, "rejected");
    assert.equal(state.calls.length, 0);
});

test("post-await host replacement, ID changes and wrong invocation fence pending observations", async t => {
    for (const change of ["replace", "id", "invocation", "throw"]) {
        const state = fixture();
        let release, broken = false;
        state.session.rpc.accounts.get = () => new Promise(resolve => { release = resolve; });
        const bridge = createCopilotAccountBridge(() => {
            if (broken) throw new Error("PRIVATE HOST ERROR");
            return state.session;
        }, { expectedSessionId: sessionId });
        t.after(() => bridge.close());
        const pending = bridge.tool.handler({}, invocation);
        if (change === "replace") state.session = fixture().session;
        if (change === "id") state.session.sessionId = "wrong-host";
        if (change === "invocation") assert.equal((await bridge.tool.handler({}, { sessionId: "wrong-host" })).resultType, "rejected");
        if (change === "throw") broken = true;
        release(selected());
        const result = await pending;
        if (change === "invocation") assert.equal(parsed(result).state, "unavailable");
        else assert.equal(result.resultType, "rejected");
        assert.doesNotMatch(result.textResultForLlm, /synthetic-alice|PRIVATE HOST ERROR/);
        assert.equal(state.calls.length, 0, "No status or second account read after retirement");
    }
});

test("trusted callback requires an explicit qualified host pin and remains disabled by default", async t => {
    const state = fixture();
    assert.throws(() => createCopilotAccountBridge(() => state.session, { binding: "copilot-app" }), TypeError);
    assert.throws(() => createCopilotAccountBridge(() => state.session, { expectedSessionId: "", binding: "copilot-app" }), TypeError);
    const { context } = await privateFixture(t);
    const bridge = createCopilotAccountBridge(() => state.session, { expectedSessionId: sessionId });
    const profile = createGitHubProfile(context, { copilot: bridge.copilot, fetch: () => assert.fail("Unqualified source must not fetch") });
    t.after(async () => { bridge.close(); await profile.close(); });
    assert.equal((await profile.read()).identity.reason, "account-match-unavailable");
    assert.equal(state.calls.length, 0);
});

test("qualified bridge feeds the unchanged profile/image routes and rejects stale, conflicting or retired hosts", async t => {
    const { context } = await privateFixture(t);
    const state = fixture();
    const originalSession = state.session;
    let clock = 100000, publicCalls = 0;
    const bridge = createCopilotAccountBridge(() => state.session, { expectedSessionId: sessionId, binding: "copilot-app", now: () => clock });
    const profile = createGitHubProfile(context, {
        copilot: bridge.copilot, now: () => clock,
        fetch: async url => {
            publicCalls++;
            return url.startsWith("https://api.github.com/")
                ? Response.json({ type: "User", id: 12345, login: state.account.account.login, name: null, avatar_url: "https://avatars.githubusercontent.com/u/12345" })
                : new Response(png, { headers: { "content-type": "image/png" } });
        },
    });
    const routes = createGitHubProfileRoutes(profile, { now: () => clock, ownerActive: () => true });
    t.after(async () => { routes.close(); bridge.close(); await profile.close(); });
    const first = await routes.read("synthetic-panel");
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.identity.state, "verified");
    assert.deepEqual(first.fallback, { kind: "initials", text: "S", source: "verified-login" });
    assert.match(first.avatar.url, /^\/api\/profile\/github\/avatar\/[a-f0-9]{64}$/);
    const image = (url, response = { writeHead() {}, end(bytes) { assert.deepEqual(bytes, png); } }) =>
        routes.image({ method: "GET", url, headers: { "sec-fetch-site": "same-origin" } }, response);
    await image(first.avatar.url);
    assert.equal(publicCalls, 2);
    state.account = selected("synthetic-alice", "reselected");
    await assert.rejects(image(first.avatar.url), { status: 404 });
    const second = await routes.read("synthetic-panel");
    assert.notEqual(second.generation, first.generation);
    const imageRevision = (await profile.read()).avatar.revision;
    assert.equal(second.identity.expiresAt - second.identity.checkedAt, 15000);
    clock = second.identity.expiresAt - 1;
    profile.assertImageCurrent(imageRevision);
    clock = second.identity.expiresAt;
    assert.throws(() => profile.assertImageCurrent(imageRevision), { status: 404 });
    state.status.login = "synthetic-override";
    const conflict = await routes.read("synthetic-panel");
    assert.equal(conflict.identity.state, "unavailable");
    assert.equal(conflict.avatar.url, null);
    assert.equal(conflict.fallback.kind, "neutral");
    await assert.rejects(image(second.avatar.url), { status: 404 });
    const before = publicCalls;
    state.session = { ...fixture().session, sessionId: "unqualified-host" };
    assert.equal((await routes.read("synthetic-panel")).identity.state, "unavailable");
    assert.equal(publicCalls, before);
    state.session = originalSession;
    state.status.login = "synthetic-alice";
    const restored = await routes.read("synthetic-panel");
    assert.equal(restored.identity.state, "verified");
    assert.notEqual(restored.generation, first.generation);
    state.account = { kind: "activeAccount" };
    state.status = { isAuthenticated: false };
    assert.equal((await routes.read("synthetic-panel")).identity.state, "signed-out");
    await assert.rejects(image(restored.avatar.url), { status: 404 });
    bridge.close();
    assert.equal((await routes.read("synthetic-panel")).identity.state, "unavailable");
    await assert.rejects(image(restored.avatar.url), { status: 404 });
});
