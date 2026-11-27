import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUpdateSource } from "../../lib/update-source.mjs";

test("main offers each exact commit; public offers require a published tag on main; edited installs refuse", async t => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "wire-update-source-"));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const origin = path.join(tmp, "origin"), root = path.join(tmp, "user clone");
    await mkdir(origin);
    const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgSign=false", ...args], { cwd, stdio: ["ignore","pipe","pipe"] }).toString().trim();
    git(origin, "init", "-b", "main");
    async function commit(name, text) {
        const file = path.join(origin, name);
        await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text);
        git(origin, "add", "--", name); git(origin, "commit", "-m", "Fixture change");
        return git(origin, "rev-parse", "HEAD");
    }
    const installed = await commit("lib/example.mjs", "export const version=1;");
    git(tmp, "clone", origin, root);
    const source = createUpdateSource({ fixtureRemote: origin, channel:"main" });
    // The branch is still refs/heads/main even when Git abbreviates it as heads/main.
    git(root, "tag", "main", installed);
    assert.equal((await source.inspectInstallation(root)).installed, installed);
    await commit("docs/manual.md", "Read the updated manual.");
    await commit("CHANGELOG.md", "Documentation outside the docs directory.");
    await commit("web/frontend/README.md", "Contributor instructions beside code.");
    await commit("web/frontend/demo.test.ts", "// fixture test");
    await commit(".github/workflows/check.yml", "name: test");
    assert.equal((await source.checkMain(root, installed)).candidate, git(origin,"rev-parse","HEAD"));
    await commit("lib/example.mjs", "export const version=2;");
    const tip = await commit("README.md", "A later docs commit.");
    const result = await source.checkMain(root, installed);
    assert.equal(result.candidate, tip);
    const later = await commit("docs/notes.md", "No app change.");
    assert.notEqual((await source.checkMain(root, installed)).fingerprint, result.fingerprint);
    await commit("lib/example.mjs", "export const version=1;");
    assert.equal((await source.checkMain(root, installed)).candidate, git(origin,"rev-parse","HEAD"));
    await commit("docs/in-app-help.md", "First bundled help");
    const helpBase = await commit("lib/update-runtime-docs.json", '["docs/in-app-help.md"]');
    const helpTip = await commit("docs/in-app-help.md", "Changed bundled help");
    assert.equal((await source.checkMain(root, helpBase)).candidate, helpTip);
    const depsTip = await commit("package-lock.json", '{"lockfileVersion":3}');
    assert.equal((await source.checkMain(root, helpTip)).candidate, depsTip);
    const startTip = await commit("scripts/start.mjs", "// changed launcher");
    assert.equal((await source.checkMain(root, depsTip)).candidate, startTip);
    const tag = "v1.0.2";
    let record = null, validator;
    const published = createUpdateSource({ fixtureRemote:origin, channel:"release", fetcher:async (_url, { headers }) => {
        validator = headers["If-None-Match"];
        return validator === '"stable"' ? new Response(null, { status: 304 }) : record
            ? Response.json(record, { headers: { etag: '"stable"' } }) : new Response(null, { status: 404 });
    } });
    git(origin,"tag",tag,later);
    assert.equal((await published.checkMain(root,installed)).candidate,null,"a tag alone is not a release");
    record = {tag_name:tag,draft:false,prerelease:false,published_at:"2026-11-25T12:00:00Z",body:"## What's new in v1.0.2\n\nUpdated guides.",html_url:`https://github.com/likamrat/wire/releases/tag/${tag}`};
    for (const flag of ["draft","prerelease"]) {
        record[flag] = true;
        await assert.rejects(published.checkMain(root,installed),/stable version/);
        record[flag] = false;
    }
    assert.equal((await published.checkMain(root,startTip)).candidate,null,"never downgrade an ahead build");
    const offer = await published.checkMain(root,installed);
    assert.equal(offer.candidate,later);
    assert.equal(offer.release.notes,record.body);
    await commit("docs/unreleased.md", "Not published.");
    assert.deepEqual(await published.checkMain(root, installed, { automatic: true }), offer);
    assert.equal(validator, '"stable"');
    assert.equal(git(root, "rev-parse", "refs/wire-updates/main"), startTip, "unchanged publication did not fetch main");
    git(origin,"tag","-f",tag,tip);
    await assert.rejects(published.checkMain(root,installed),/tag changed/);
    assert.equal(validator, undefined, "a manual check revalidates the release and tag");
    git(root, "remote", "set-url", "origin", "https://github.com/likamrat/wire.git/");
    assert.equal((await createUpdateSource().inspectInstallation(root)).installed, installed);
    git(root, "remote", "set-url", "origin", "https://github.com/another-owner/wire.git/");
    await assert.rejects(source.inspectInstallation(root), /official WIRE repository/);
    git(root, "remote", "set-url", "origin", origin);
    await writeFile(path.join(root, "lib", "example.mjs"), "// user edit");
    await assert.rejects(source.checkMain(root, installed), /local changes/i);
    assert.equal(git(root, "rev-parse", "HEAD"), installed);
    assert.notEqual(later, tip);
});
