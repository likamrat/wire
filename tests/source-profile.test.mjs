import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readSourceProfileProjection, unavailableSourceProfile } from "../lib/source-profile.mjs";
import { readSourceMetadata } from "../lib/source-reader.mjs";
import { metadataReadVersion, SOURCE_METADATA_READER_VERSION } from "../lib/source-metadata.mjs";
import { createGitHubProfile } from "../lib/github-profile.mjs";
import { createProfileSource, profilePNG } from "./source-profile-fixture.mjs";
import { privateFixture } from "./helpers.mjs";

async function fixture(t) {
    const cleanups = [], { root, context } = await privateFixture({ after: work => cleanups.push(work) });
    const source = await createProfileSource(root);
    t.after(async () => { source.db.close(); for (const cleanup of cleanups.reverse()) await cleanup(); });
    return { ...source, root, context };
}

test("desktop profile selection follows the recorded workspace, then GitHub default, then creation order", async t => {
    const app = await fixture(t);
    let profile = readSourceProfileProjection(app.appDbPath);
    assert.equal(profile.selection, "workspace");
    assert.equal(profile.account.login, "synthetic-morgan");
    app.db.exec("UPDATE accounts SET is_default=(id='workspace')");
    assert.equal(readSourceProfileProjection(app.appDbPath).revision, profile.revision, "Unrelated default changes do not replace the workspace profile.");
    app.db.exec("UPDATE accounts SET is_default=(id='default')");
    app.db.exec("DELETE FROM app_state WHERE key='activeWorkspaceId'");
    profile = readSourceProfileProjection(app.appDbPath);
    assert.equal(profile.selection, "default");
    assert.equal(profile.account.login, "riley_managed");
    app.db.exec("UPDATE accounts SET is_default=0");
    profile = readSourceProfileProjection(app.appDbPath);
    assert.equal(profile.selection, "first-github");
    assert.equal(profile.account.login, "riley_managed", "An older Microsoft account never supplies the GitHub avatar.");
    assert.doesNotMatch(JSON.stringify(profile), /DO-NOT|Invented workspace|Invented project|access_token|privateUnrelated/);
    app.db.exec("DELETE FROM accounts WHERE kind='github'");
    assert.equal(readSourceProfileProjection(app.appDbPath).reason, "app-profile-signed-out");
});

test("an offline app avatar keeps only its matching age-bounded cache and still shows missing-image names", async t => {
    const app = await fixture(t);
    let clock = 1000000000000, offline = false;
    const profile = createGitHubProfile(app.context, { now: () => clock,
        readAppProfile: () => readSourceProfileProjection(app.appDbPath),
        fetch: async () => {
            if (offline) throw new Error("Invented offline network");
            return new Response(profilePNG, { headers: { "content-type": "image/png" } });
        } });
    t.after(() => profile.close());
    assert.equal((await profile.read()).avatar.state, "current");
    offline = true; clock += 7 * 60 * 60 * 1000;
    const cached = await profile.read();
    assert.equal(cached.avatar.state, "cached");
    assert.deepEqual(cached.issues, ["avatar-offline"]);
    clock += 8 * 24 * 60 * 60 * 1000;
    assert.equal((await profile.read()).avatar.state, "unavailable");
    app.db.exec("UPDATE accounts SET settings_json='{}' WHERE id='workspace'");
    const missing = await profile.read();
    assert.equal(missing.displayName.value, "Morgan Rivera");
    assert.equal(missing.avatar.reason, "avatar-missing");
    assert.equal(missing.fallback.kind, "initials");
});

test("missing links, conflicting defaults, unsupported schema and malformed profile facts stay unavailable", async t => {
    const app = await fixture(t);
    app.db.exec("DELETE FROM accounts WHERE id='workspace'");
    assert.equal(readSourceProfileProjection(app.appDbPath).reason, "app-account-relink-required");
    app.db.exec("UPDATE projects SET github_account_id=NULL; INSERT INTO project_account_hints VALUES('00000000-0000-4000-8000-000000000082','old','github.com')");
    assert.equal(readSourceProfileProjection(app.appDbPath).reason, "app-account-relink-required");
    app.db.exec("DELETE FROM app_state; UPDATE accounts SET kind='github',is_default=1");
    assert.equal(readSourceProfileProjection(app.appDbPath).reason, "app-profile-selection-ambiguous");
    app.db.exec("DELETE FROM accounts WHERE id='microsoft'; UPDATE accounts SET login='../invalid'");
    assert.throws(() => readSourceProfileProjection(app.appDbPath), { code: "source_metadata_invalid" });
    app.db.exec("PRAGMA user_version=174");
    assert.equal(readSourceProfileProjection(app.appDbPath).reason, "app-profile-schema-unsupported");
});

test("source-native profile reads use the bounded profile-only helper, verify changes and never project history", async t => {
    const app = await fixture(t), calls = [];
    const files = { databaseFile: () => app.appDbPath, windowsDatabase: "C:\\synthetic\\data.db", assertCurrent() {} };
    const run = async (command, args, options) => {
        calls.push({ command, args });
        if (command === "wslpath") return { stdout: "C:\\synthetic\\read-copilot-metadata.mjs\n" };
        assert.deepEqual(args, ["C:\\synthetic\\read-copilot-metadata.mjs", files.windowsDatabase, "--profile"]);
        assert.equal(options.maxBuffer, 16384);
        assert.ok(Object.keys(options.env).every(name => !/TOKEN|COPILOT_HOME|GH_CONFIG/.test(name)));
        return { stdout: JSON.stringify({ schemaVersion: SOURCE_METADATA_READER_VERSION, platform: "win32",
            projection: readSourceProfileProjection(app.appDbPath), readVersion: metadataReadVersion(app.appDbPath) }) };
    };
    const result = await readSourceMetadata(files, { profileOnly: true, run });
    assert.equal(result.account.login, "synthetic-morgan");
    assert.equal(result.roster, undefined);
    assert.deepEqual(calls.map(call => call.command), ["wslpath", "node.exe"]);
    await assert.rejects(readSourceMetadata(files, { profileOnly: true, run: async (...args) => {
        const result = await run(...args);
        if (args[0] === "node.exe") app.db.exec("UPDATE accounts SET name='Changed after read'");
        return result;
    } }), { code: "COLLECTION_SOURCE_CHANGED" });
});

test("app cached avatar bypasses public user lookup, preserves managed login and revokes changed selection images", async t => {
    const app = await fixture(t), requests = [];
    app.db.exec("DELETE FROM app_state");
    const profile = createGitHubProfile(app.context, { readAppProfile: () => readSourceProfileProjection(app.appDbPath),
        fetch: async url => { requests.push(url); assert.match(url, /^https:\/\/avatars\.githubusercontent\.com\/u\/7000[12]/);
            return new Response(profilePNG, { headers: { "content-type": "image/png" } }); } });
    t.after(() => profile.close());
    const first = await profile.read();
    assert.equal(first.identity.login, "riley_managed");
    assert.equal(first.identity.source, "copilot-app-profile");
    assert.equal(first.displayName.source, "copilot-app-profile");
    assert.equal(first.avatar.state, "current");
    assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(first), /avatars\.githubusercontent|DO-NOT|workspace|default"/);
    assert.deepEqual((await profile.image(first.avatar.revision)).bytes, profilePNG);
    app.db.exec("UPDATE accounts SET is_default=(id='workspace')");
    const second = await profile.read();
    assert.equal(second.identity.login, "synthetic-morgan");
    await assert.rejects(profile.image(first.avatar.revision), { status: 404 });
    app.db.exec("DELETE FROM accounts WHERE kind='github'");
    assert.equal((await profile.read()).identity.state, "unavailable");
    await assert.rejects(profile.image(second.avatar.revision), { status: 404 });
});

test("source failures, cache restart, source changes during fetch and untrusted avatar URLs remain fenced", async t => {
    const app = await fixture(t);
    const source = () => readSourceProfileProjection(app.appDbPath);
    const initial = createGitHubProfile(app.context, { readAppProfile: source,
        fetch: async () => new Response(profilePNG, { headers: { "content-type": "image/png" } }) });
    await initial.read(); await initial.close();
    const cached = createGitHubProfile(app.context, { readAppProfile: source, fetch: () => assert.fail("Fresh matching cache avoids network.") });
    assert.equal((await cached.read()).avatar.state, "current");
    await cached.close();
    const invalid = createGitHubProfile(app.context, { readAppProfile: async () => { throw Object.assign(new Error("PRIVATE SOURCE ERROR"), { code: "source_metadata_unavailable" }); },
        fetch: () => assert.fail("Unavailable source never acquires a photo.") });
    const unavailable = await invalid.read();
    assert.equal(unavailable.identity.state, "unavailable");
    assert.deepEqual(unavailable.issues, ["app-profile-read-failed"]);
    assert.ok(unavailable.refreshAt > Date.now());
    assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE SOURCE/);
    await invalid.close();
    app.db.exec(`UPDATE accounts SET settings_json='{"avatarUrl":"https://untrusted.example/avatar.png"}' WHERE id='workspace'`);
    const unsafe = createGitHubProfile(app.context, { readAppProfile: source, fetch: () => assert.fail("Untrusted avatar URL must not be fetched.") });
    assert.equal((await unsafe.read()).avatar.reason, "avatar-source-untrusted");
    await unsafe.close();
    const held = Promise.withResolvers(), entered = Promise.withResolvers();
    app.db.exec(`UPDATE accounts SET settings_json='{"avatarUrl":"https://avatars.githubusercontent.com/u/70002?v=5"}' WHERE id='workspace'`);
    let current = true;
    const pending = createGitHubProfile(app.context, { readAppProfile: () => current ? source() : unavailableSourceProfile("app-profile-source-changed"),
        fetch: async () => { entered.resolve(); await held.promise; return new Response(profilePNG, { headers: { "content-type": "image/png" } }); } });
    const reading = pending.read(); await entered.promise; current = false; held.resolve();
    assert.equal((await reading).identity.state, "unavailable");
    await pending.close();
    await assert.rejects(readFile(path.join(app.context.dataDir, "github-profile", "profile.json")), { code: "ENOENT" });
});
