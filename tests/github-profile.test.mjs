import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { createCopilotProfileIdentity } from "../lib/github-profile-identity.mjs";
import { createGitHubProfile } from "../lib/github-profile.mjs";
import { createProfileCache, fetchPublicAvatar, fetchPublicProfile, AVATAR_MAX_BYTES, PROFILE_MAX_BYTES, validateAvatar } from "../lib/github-profile-public.mjs";
import { privateFixture } from "./helpers.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X8AAAAASUVORK5CYII=", "base64");
const auth = (login = "synthetic-alice") => ({ isAuthenticated: true, authType: "user", host: "https://github.com", login });
const identity = { state: "verified", reason: null, host: "github.com", login: "synthetic-alice" };
const publicUser = (login = identity.login, id = 12345) => ({ id, login, name: "Synthetic Example", type: "User", avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`, email: "NEVER_RETAIN@example.invalid" });
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const photo = () => new Response(png, { headers: { "content-type": "image/png" } });
const copilot = getAuthStatus => ({ binding: "copilot-app", getAuthStatus });
const cacheFile = context => path.join(context.dataDir, "github-profile", "profile.json");
function fakeFetch(calls = []) {
    return async (url, options) => {
        calls.push({ url, options });
        return url.startsWith("https://api.github.com/") ? json(publicUser(decodeURIComponent(url.split("/").at(-1)))) : photo();
    };
}

test("default identity never imports/starts a CLI, selects environment credentials, or calls an unbound provider", async t => {
    const { context } = await privateFixture(t);
    let calls = 0;
    const profile = createGitHubProfile(context, { copilot: { getAuthStatus: () => { calls++; return auth(); } }, fetch: () => { throw new Error("Must not fetch"); } });
    t.after(() => profile.close());
    const result = await profile.read();
    assert.equal(calls, 0);
    assert.equal(result.identity.reason, "account-match-unavailable");
    assert.equal(result.displayName.value, null);
    assert.deepEqual(result.fallback, { kind: "neutral", text: null, source: "unavailable" });
    await assert.rejects(readFile(cacheFile(context)), { code: "ENOENT" });
});

test("auth metadata projection rejects unverified sources, missing fields and non-public hosts without exposing raw messages", async () => {
    for (const authType of ["env", "gh-cli", "token", "hmac", "api-key", undefined]) {
        const source = createCopilotProfileIdentity(copilot(() => ({ ...auth(), authType, statusMessage: "SECRET" })));
        assert.equal((await source.read()).reason, "auth-source-unverified");
        assert.doesNotMatch(JSON.stringify(await source.read()), /SECRET/);
    }
    for (const status of [null, {}, { ...auth(), login: "../someone" }, { ...auth(), login: "a--b" }, { ...auth(), host: "https://github.com.attacker.invalid" }]) {
        assert.equal((await createCopilotProfileIdentity(copilot(() => status)).read()).state, "unavailable");
    }
    assert.equal((await createCopilotProfileIdentity(copilot(() => ({ isAuthenticated: false }))).read()).state, "signed-out");
    assert.deepEqual(await createCopilotProfileIdentity(copilot(() => auth())).read(), identity);
});

test("hung auth is bounded and shares one outstanding metadata request rather than leaking repeated work", async () => {
    let calls = 0, complete;
    const source = createCopilotProfileIdentity({ ...copilot(() => { calls++; return new Promise(resolve => { complete = resolve; }); }), timeoutMs: 5 });
    const values = await Promise.all(Array.from({ length: 10 }, () => source.read()));
    assert.ok(values.every(value => value.reason === "auth-status-timeout"));
    assert.equal((await source.read()).reason, "auth-status-timeout");
    assert.equal(calls, 1);
    complete(auth());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await source.read()).reason, "auth-status-timeout");
    complete(auth());
});

test("qualified metadata fetches only bounded public fields and same-provider image without any credential", async t => {
    const { context } = await privateFixture(t), calls = [];
    const profile = createGitHubProfile(context, { copilot: copilot(() => auth()), fetch: fakeFetch(calls) });
    t.after(() => profile.close());
    const results = await Promise.all([profile.read(), profile.read()]);
    const result = results[0];
    assert.ok(results.every(value => value === result));
    assert.equal(result.identity.state, "verified");
    assert.equal(result.displayName.value, "Synthetic Example");
    assert.equal(result.avatar.state, "current");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://api.github.com/users/synthetic-alice");
    assert.equal(calls[1].url, "https://avatars.githubusercontent.com/u/12345?v=4&s=96");
    for (const { options } of calls) {
        assert.equal(options.method, "GET"); assert.equal(options.redirect, "manual"); assert.equal(options.credentials, "omit");
        assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined);
    }
    assert.deepEqual((await profile.image(result.avatar.revision)).bytes, png);
    for (let i = 0; i < 2; i++) await profile.read();
    assert.equal(calls.length, 2, "No repeated public lookup on reads or collection ticks");
    const persisted = await readFile(cacheFile(context), "utf8");
    assert.doesNotMatch(persisted, /NEVER_RETAIN|avatar_url|https:|statusMessage/);
    assert.deepEqual(await readdir(path.dirname(cacheFile(context))), ["profile.json"]);
});

test("restart cache requires newly verified matching identity, expires, and never invents a display name", async t => {
    const { context } = await privateFixture(t);
    let clock = 1000000000000;
    const options = { copilot: copilot(() => auth()), now: () => clock };
    const first = createGitHubProfile(context, { ...options, fetch: fakeFetch() });
    const initial = await first.read(); await first.close();
    let calls = 0;
    const offline = async () => { calls++; throw new Error("PRIVATE NETWORK ERROR"); };
    const restarted = createGitHubProfile(context, { ...options, fetch: offline });
    t.after(() => restarted.close());
    assert.equal((await restarted.read()).displayName.value, initial.displayName.value);
    assert.equal(calls, 0);
    clock += 7 * 60 * 60 * 1000;
    const stale = await restarted.read();
    assert.equal(stale.avatar.state, "cached"); assert.deepEqual(stale.issues, ["profile-offline"]);
    assert.doesNotMatch(JSON.stringify(stale), /PRIVATE NETWORK/);
    clock += 8 * 24 * 60 * 60 * 1000;
    assert.equal((await restarted.read()).avatar.state, "unavailable");
    const unavailable = createGitHubProfile(context, { fetch: offline });
    assert.equal((await unavailable.read()).displayName.value, null);
    await unavailable.close();
});

test("account changes, sign-out and unavailable auth invalidate previous images and account-keyed cache", async t => {
    const { context } = await privateFixture(t);
    let status = auth();
    const profile = createGitHubProfile(context, { copilot: copilot(() => status), fetch: fakeFetch() });
    t.after(() => profile.close());
    const alice = await profile.read();
    status = auth("synthetic-bob");
    const bob = await profile.read();
    assert.equal(bob.identity.login, "synthetic-bob"); assert.notEqual(bob.generation, alice.generation);
    await assert.rejects(profile.image(alice.avatar.revision), { status: 404 });
    assert.doesNotMatch(await readFile(cacheFile(context), "utf8"), /synthetic-alice/);
    status = { isAuthenticated: false };
    const signedOut = await profile.read();
    assert.equal(signedOut.identity.state, "signed-out"); assert.equal(signedOut.displayName.value, null);
    await assert.rejects(profile.image(bob.avatar.revision), { status: 404 });
    await assert.rejects(readFile(cacheFile(context)), { code: "ENOENT" });
    status = auth();
    await profile.read();
    status = { ...auth(), authType: "env" };
    assert.equal((await profile.read()).identity.reason, "auth-source-unverified");
    await assert.rejects(readFile(cacheFile(context)), { code: "ENOENT" });
});

test("account swap during public fetch cannot publish or persist previous-account data", async t => {
    const { context } = await privateFixture(t);
    let status = auth(), resume, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const profile = createGitHubProfile(context, { copilot: copilot(() => status), fetch: async url => {
        if (url.startsWith("https://api.github.com/")) {
            entered(); await new Promise(resolve => { resume = resolve; }); return json(publicUser());
        }
        return photo();
    } });
    t.after(() => profile.close());
    const operation = profile.read(); await started; status = auth("synthetic-bob"); resume();
    const result = await operation;
    assert.equal(result.identity.login, "synthetic-bob"); assert.equal(result.displayName.value, null);
    await assert.rejects(readFile(cacheFile(context)), { code: "ENOENT" });
});

test("explicit invalidation fences late metadata and late public reads", async t => {
    const { context } = await privateFixture(t);
    let resume, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const profile = createGitHubProfile(context, { copilot: copilot(() => new Promise(resolve => { resume = resolve; entered(); })), fetch: fakeFetch() });
    const operation = profile.read(); await started; profile.invalidate(); resume(auth());
    assert.equal((await operation).identity.state, "unavailable");
    await profile.close();
    assert.equal((await profile.read()).identity.state, "unavailable");
});

test("missing photo/name leaves verified handle and initials, not a fabricated profile", async t => {
    const { context } = await privateFixture(t);
    const profile = createGitHubProfile(context, { copilot: copilot(() => auth()), fetch: async () => json({ ...publicUser(), name: null, avatar_url: null }) });
    t.after(() => profile.close());
    const result = await profile.read();
    assert.equal(result.identity.login, "synthetic-alice");
    assert.deepEqual(result.displayName, { value: null, source: "unavailable", freshness: "current" });
    assert.equal(result.avatar.reason, "avatar-missing"); assert.equal(result.fallback.source, "verified-login");
});

test("public profile cannot redirect or substitute another account and has a strict body bound", async () => {
    const signal = AbortSignal.timeout(1000);
    for (const user of [{ ...publicUser(), login: "wrong-account" }, { ...publicUser(), type: "Organization" }, { ...publicUser(), id: -1 }]) {
        await assert.rejects(fetchPublicProfile(identity, { signal, fetch: async () => json(user) }), { code: "profile-account-mismatch" });
    }
    await assert.rejects(fetchPublicProfile(identity, { signal, fetch: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }) }), { code: "profile-redirect-denied" });
    await assert.rejects(fetchPublicProfile(identity, { signal, fetch: async () => new Response("x".repeat(PROFILE_MAX_BYTES + 1), { headers: { "content-type": "application/json" } }) }), { code: "profile-too-large" });
});

test("avatar trust rejects arbitrary hosts, ports, account IDs, userinfo and paths before making a request", async () => {
    const signal = AbortSignal.timeout(1000);
    for (const source of [
        "http://avatars.githubusercontent.com/u/12345", "https://avatars.githubusercontent.com.attacker.invalid/u/12345",
        "https://avatars.githubusercontent.com:444/u/12345", "https://secret@avatars.githubusercontent.com/u/12345",
        "https://avatars.githubusercontent.com/u/12346", "https://avatars.githubusercontent.com/u/12345?url=http://127.0.0.1",
        "https://127.0.0.1/u/12345", "file:///private", "https://avatars.githubusercontent.com/u/12345#fragment",
    ]) {
        await assert.rejects(fetchPublicAvatar(source, 12345, { signal, fetch: () => assert.fail("Untrusted request") }), { code: "avatar-source-untrusted" });
    }
});

test("redirects are capped and every hop stays on the exact avatar account and host", async () => {
    const signal = AbortSignal.timeout(1000), source = "https://avatars.githubusercontent.com/u/12345?v=4";
    let calls = 0;
    await assert.rejects(fetchPublicAvatar(source, 12345, { signal, fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://example.invalid/private" } }); } }), { code: "avatar-source-untrusted" });
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(fetchPublicAvatar(source, 12345, { signal, fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: source } }); } }), { code: "avatar-redirect-limit" });
    assert.equal(calls, 3);
    calls = 0;
    const result = await fetchPublicAvatar(source, 12345, { signal, fetch: async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: "/u/12345?v=5" } }) : photo() });
    assert.deepEqual(result.bytes, png);
});

test("photo formats, signatures, dimensions and streamed/content-length size are bounded", async () => {
    const source = "https://avatars.githubusercontent.com/u/12345", signal = AbortSignal.timeout(1000);
    for (const type of ["image/svg+xml", "text/html", "image/gif"]) {
        await assert.rejects(fetchPublicAvatar(source, 12345, { signal, fetch: async () => new Response("<svg/>", { headers: { "content-type": type } }) }), { code: "avatar-type-unsupported" });
    }
    await assert.rejects(fetchPublicAvatar(source, 12345, { signal, fetch: async () => new Response("<html/>", { headers: { "content-type": "image/png" } }) }), { code: "avatar-invalid" });
    const giant = Buffer.from(png); giant.writeUInt32BE(10000, 16);
    assert.throws(() => validateAvatar(giant, "image/png"), { code: "avatar-invalid" });
    for (const response of [new Response(Buffer.alloc(AVATAR_MAX_BYTES + 1), { headers: { "content-type": "image/png" } }),
        new Response(png, { headers: { "content-type": "image/png", "content-length": String(AVATAR_MAX_BYTES + 1) } })]) {
        await assert.rejects(fetchPublicAvatar(source, 12345, { signal, fetch: async () => response }), { code: "avatar-too-large" });
    }
});

test("cache rejects corruption, oversize files and account mismatch; storage errors are explicit but isolated", async t => {
    const { context } = await privateFixture(t), cache = createProfileCache(context);
    await mkdir(path.dirname(cacheFile(context)), { recursive: true });
    await writeFile(cacheFile(context), "not JSON");
    await assert.rejects(cache.read(identity, Date.now(), 1000), { code: "cache-read-failed" });
    await writeFile(cacheFile(context), "x".repeat(AVATAR_MAX_BYTES * 2 + 1));
    await assert.rejects(cache.read(identity, Date.now(), 1000), { code: "cache-read-failed" });
    const profile = createGitHubProfile(context, { copilot: copilot(() => auth()), fetch: async () => { throw new Error("offline"); } });
    t.after(() => profile.close());
    const result = await profile.read();
    assert.deepEqual(result.issues, ["cache-read-failed", "profile-offline"]);
    assert.equal(result.identity.state, "verified");
});

test("rate limits and offline errors are backed off without disabling verified identity", async t => {
    const { context } = await privateFixture(t);
    let calls = 0, clock = 1000000000000;
    const profile = createGitHubProfile(context, {
        copilot: copilot(() => auth()), now: () => clock,
        fetch: async () => { calls++; return new Response(null, { status: 429 }); },
    });
    t.after(() => profile.close());
    const first = await profile.read();
    assert.equal(first.identity.state, "verified"); assert.deepEqual(first.issues, ["profile-rate-limited"]);
    for (let n = 0; n < 2; n++) await profile.read();
    assert.equal(calls, 1);
    clock += 15 * 60 * 1000;
    assert.deepEqual((await profile.read()).issues, ["profile-rate-limited"]);
    assert.equal(calls, 2);
});

test("invalid provider identity discards formerly cached data instead of presenting it as an offline success", async t => {
    const { context } = await privateFixture(t);
    let clock = 1000000000000, mismatch = false;
    const profile = createGitHubProfile(context, {
        copilot: copilot(() => auth()), now: () => clock,
        fetch: (url, options) => mismatch ? Promise.resolve(json(publicUser("wrong-account"))) : fakeFetch()(url, options),
    });
    t.after(() => profile.close());
    const first = await profile.read();
    mismatch = true; clock += 7 * 60 * 60 * 1000;
    const result = await profile.read();
    assert.equal(result.displayName.value, null); assert.equal(result.avatar.state, "unavailable");
    assert.deepEqual(result.issues, ["profile-account-mismatch"]);
    await assert.rejects(profile.image(first.avatar.revision), { status: 404 });
    await assert.rejects(readFile(cacheFile(context)), { code: "ENOENT" });
});

test("stalled network/header and body reads time out, cancel streams, and leave no retry loop", async t => {
    const { context } = await privateFixture(t);
    let calls = 0, cancelled = 0;
    // AbortSignal.timeout is intentionally unref'ed in Node; keep this bounded test alive.
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const stalled = createGitHubProfile(context, {
        copilot: copilot(() => auth()), requestTimeoutMs: 10,
        fetch: () => { calls++; return new Promise(() => {}); },
    });
    t.after(() => stalled.close());
    assert.deepEqual((await stalled.read()).issues, ["profile-timeout"]);
    await stalled.read(); assert.equal(calls, 1);
    const stream = new ReadableStream({ cancel() { cancelled++; } });
    const body = createGitHubProfile(context, {
        copilot: copilot(() => auth()), requestTimeoutMs: 10,
        fetch: async () => new Response(stream, { headers: { "content-type": "application/json" } }),
    });
    t.after(() => body.close());
    assert.deepEqual((await body.read()).issues, ["profile-timeout"]);
    assert.equal(cancelled, 1);
});

test("close aborts outstanding profile work without creating a cache or leaking account fields", async t => {
    const { context } = await privateFixture(t);
    let started, cancelled = 0;
    const entered = new Promise(resolve => { started = resolve; });
    const profile = createGitHubProfile(context, {
        copilot: copilot(() => auth()),
        fetch: async () => {
            started();
            return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-type": "application/json" } });
        },
    });
    const pending = profile.read();
    await entered; await profile.close();
    const result = await pending;
    assert.equal(result.identity.state, "unavailable"); assert.equal(result.displayName.value, null);
    assert.equal(cancelled, 1);
    await assert.rejects(readFile(cacheFile(context)), { code: "ENOENT" });
});

test("cache writes fail visibly but a verified in-memory public photo remains usable", async t => {
    const { context } = await privateFixture(t);
    await writeFile(path.join(context.dataDir, "github-profile"), "SYNTHETIC PATH OBSTRUCTION");
    const profile = createGitHubProfile(context, { copilot: copilot(() => auth()), fetch: fakeFetch() });
    t.after(() => profile.close());
    const result = await profile.read();
    assert.equal(result.avatar.state, "current"); assert.deepEqual(result.issues, ["cache-write-failed"]);
    assert.deepEqual((await profile.image(result.avatar.revision)).bytes, png);
});

test("failed photo lookup never persists a false missing-photo success across restart", async t => {
    const { context } = await privateFixture(t);
    let clock = 1000000000000, failPhoto = false;
    const profile = createGitHubProfile(context, {
        copilot: copilot(() => auth()), now: () => clock,
        fetch: async url => url.startsWith("https://api.github.com/") ? json(publicUser())
            : failPhoto ? new Response(null, { status: 503 }) : photo(),
    });
    t.after(() => profile.close());
    await profile.read(); failPhoto = true; clock += 7 * 60 * 60 * 1000;
    const result = await profile.read();
    assert.equal(result.displayName.value, "Synthetic Example");
    assert.equal(result.avatar.reason, "avatar-http-error");
    await assert.rejects(readFile(cacheFile(context)), { code: "ENOENT" });
});
