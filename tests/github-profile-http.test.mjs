import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createGitHubProfileRoutes } from "../lib/github-profile-http.mjs";
import { createBoardTransport } from "../lib/client-transport.mjs";
import { privateFixture } from "./helpers.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X8AAAAASUVORK5CYII=", "base64");
async function fixture(t, githubProfile) {
    const { context } = await privateFixture(t);
    const runtime = await startServer(context, createExportController(context), { port: 0, githubProfile });
    t.after(() => runtime.close());
    const origin = runtime.url.slice(0, -1);
    const post = (route, body, capability) => fetch(origin + route, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}) },
        body: JSON.stringify(body),
    });
    const { capability, accessBootstrap } = await (await post("/api/session", {})).json();
    const get = (route, extra = {}) => fetch(origin + route, { headers: { "X-Board-Capability": capability, ...extra } });
    const image = (url, extra = {}) => fetch(origin + url, { headers: { "Sec-Fetch-Site": "same-origin", ...extra } });
    return { context, runtime, post, get, image, origin, capability, accessBootstrap };
}

test("default profile is capability-protected and unavailable without changing existing local evidence", async t => {
    const { context, get, origin, runtime, post, capability } = await fixture(t);
    const before = await loadBoardState(context);
    assert.equal((await fetch(origin + "/api/profile/github")).status, 403);
    assert.equal((await get("/api/profile/github", { Origin: "https://foreign.invalid" })).status, 403);
    const response = await get("/api/profile/github");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const profile = await response.json();
    assert.equal(profile.identity.reason, "account-match-unavailable");
    assert.equal(profile.avatar.url, null);
    assert.equal(profile.avatar.revision, undefined);
    assert.equal((await post("/api/profile/github", { login: "arbitrary-account", url: "https://example.invalid" }, capability)).status, 405);
    assert.equal((await get("/api/state")).status, 200);
    assert.deepEqual(await loadBoardState(context), before);
    assert.equal(runtime.githubProfile !== undefined, true);
});

test("profile read renews an expired panel capability once through the existing browser transport", async t => {
    const { post, capability, accessBootstrap, origin } = await fixture(t);
    await post("/api/session/release", {}, capability);
    const nativeFetch = globalThis.fetch, calls = [];
    t.mock.method(globalThis, "fetch", (url, options) => {
        calls.push(url);
        return nativeFetch(origin + url, { ...options, headers: { ...options.headers, Origin: origin } });
    });
    const result = await createBoardTransport(capability, undefined, accessBootstrap)("/api/profile/github");
    assert.equal(result.identity.reason, "account-match-unavailable");
    assert.deepEqual(calls, ["/api/profile/github", "/api/session", "/api/profile/github"]);
    t.mock.restoreAll();
});

test("controlled images keep CSP same-origin and revoke on panel release, account change and runtime invalidation", async t => {
    let login = "synthetic-alice", calls = 0;
    const { get, image, post, capability, origin, runtime } = await fixture(t, {
        copilot: { binding: "copilot-app", getAuthStatus: async () => ({ isAuthenticated: true, authType: "user", host: "github.com", login }) },
        fetch: async url => {
            calls++;
            return url.startsWith("https://api.github.com/") ? Response.json({ id: 12345, login, name: "Synthetic Example", type: "User", avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4" })
                : new Response(png, { headers: { "content-type": "image/png" } });
        },
    });
    const first = await (await get("/api/profile/github")).json();
    assert.match(first.avatar.url, /^\/api\/profile\/github\/avatar\/[a-f0-9]{64}$/);
    assert.doesNotMatch(first.avatar.url, /synthetic|12345/);
    assert.equal((await fetch(origin + first.avatar.url)).status, 403, "No image access without same-origin metadata");
    assert.equal((await image(first.avatar.url, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await image(first.avatar.url, { Origin: "https://foreign.invalid" })).status, 403);
    assert.equal((await image(first.avatar.url + "?url=https://example.invalid")).status, 404);
    const response = await image(first.avatar.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy"), /img-src 'self';/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.equal(calls, 2);
    login = "synthetic-bob";
    assert.equal((await image(first.avatar.url)).status, 404);
    const second = await (await get("/api/profile/github")).json();
    assert.equal(second.identity.login, login);
    assert.notEqual(second.avatar.url, first.avatar.url);
    runtime.githubProfile.invalidate();
    assert.equal((await image(second.avatar.url)).status, 404);
    const third = await (await get("/api/profile/github")).json();
    assert.equal((await post("/api/session/release", {}, capability)).status, 200);
    assert.equal((await image(third.avatar.url)).status, 404);
    assert.equal((await get("/api/profile/github")).status, 403);
});

test("image tickets expire, are bounded per owner and cannot outlive owner authorization", async () => {
    let clock = 0, active = true;
    const profile = {
        read: async () => ({ avatar: { revision: "version", state: "current" } }),
        image: async () => ({ contentType: "image/png", bytes: png }),
        assertImageCurrent() {},
    };
    const routes = createGitHubProfileRoutes(profile, { now: () => clock, ownerActive: () => active });
    const first = await routes.read("panel");
    assert.equal((await routes.read("panel")).avatar.url, first.avatar.url);
    const request = url => ({ method: "GET", url, headers: { "sec-fetch-site": "same-origin" } });
    const response = { writeHead() {}, end() {} };
    clock = 60000;
    await assert.rejects(routes.image(request(first.avatar.url), response), { status: 404 });
    const second = await routes.read("panel");
    assert.notEqual(second.avatar.url, first.avatar.url);
    for (let n = 0; n < 127; n++) await routes.read("panel-" + n);
    await assert.rejects(routes.read("excess"), { status: 429 });
    active = false;
    await assert.rejects(routes.image(request(second.avatar.url), response), { status: 404 });
    await assert.rejects(routes.read("inactive"), { status: 403 });
    routes.close();
});

test("authorized profile renewal preserves an unchanged image ticket without making it permanent", async () => {
    let clock = 0, active = true, revision = "same-image";
    const profile = {
        read: async () => ({ avatar: { revision, state: "current" } }),
        image: async () => ({ contentType: "image/png", bytes: png }),
        assertImageCurrent() {},
    };
    const routes = createGitHubProfileRoutes(profile, { now: () => clock, ownerActive: () => active });
    const first = await routes.read("panel");
    const request = url => ({ method: "GET", url, headers: { "sec-fetch-site": "same-origin" } });
    const response = { writeHead() {}, end() {} };
    for (clock = 10000; clock <= 120000; clock += 10000) {
        const renewed = await routes.read("panel");
        assert.equal(renewed.avatar.url, first.avatar.url);
        assert.equal(renewed.avatar.expiresAt, clock + 60000,
            "An authorized unchanged-profile read renews the ticket, rather than remounting its image each minute.");
        await routes.image(request(first.avatar.url), response);
    }
    clock = 180000;
    await assert.rejects(routes.image(request(first.avatar.url), response), { status: 404 },
        "Image requests alone never renew a ticket.");
    const second = await routes.read("panel");
    assert.notEqual(second.avatar.url, first.avatar.url);
    revision = "replacement-image";
    const replacement = await routes.read("panel");
    assert.notEqual(replacement.avatar.url, second.avatar.url);
    await assert.rejects(routes.image(request(second.avatar.url), response), { status: 404 });
    active = false;
    await assert.rejects(routes.image(request(replacement.avatar.url), response), { status: 404 });
    routes.close();
});

test("owner expiry while image bytes are pending is rechecked before sending", async () => {
    let active = true, release;
    const profile = {
        read: async () => ({ avatar: { revision: "version", state: "current" } }),
        image: () => new Promise(resolve => { release = () => resolve({ bytes: png, contentType: "image/png" }); }),
        assertImageCurrent() {},
    };
    const routes = createGitHubProfileRoutes(profile, { ownerActive: () => active });
    const value = await routes.read("panel");
    const operation = routes.image({ method: "GET", url: value.avatar.url, headers: { "sec-fetch-site": "same-origin" } }, { writeHead: () => assert.fail("Must not send") });
    active = false; release();
    await assert.rejects(operation, { status: 404 });
    routes.close();
});
