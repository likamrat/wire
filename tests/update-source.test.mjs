import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUpdateSource } from "../lib/update-source.mjs";

test("a skipped app change among docs and tests qualifies once; edited installs refuse", async t => {
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
    const source = createUpdateSource({ fixtureRemote: origin });
    assert.equal((await source.inspectInstallation(root)).installed, installed);
    await commit("docs/manual.md", "Read the updated manual.");
    await commit("web/frontend/demo.test.ts", "// fixture test");
    await commit(".github/workflows/check.yml", "name: test");
    assert.equal((await source.checkMain(root, installed)).candidate, null);
    await commit("lib/example.mjs", "export const version=2;");
    const tip = await commit("README.md", "A later docs commit.");
    const result = await source.checkMain(root, installed);
    assert.equal(result.candidate, tip);
    const later = await commit("docs/notes.md", "No app change.");
    assert.equal((await source.checkMain(root, installed)).fingerprint, result.fingerprint);
    await commit("lib/example.mjs", "export const version=1;");
    assert.equal((await source.checkMain(root, installed)).candidate, null);
    await commit("docs/in-app-help.md", "First bundled help");
    const helpBase = await commit("lib/update-runtime-docs.json", '["docs/in-app-help.md"]');
    const helpTip = await commit("docs/in-app-help.md", "Changed bundled help");
    assert.equal((await source.checkMain(root, helpBase)).candidate, helpTip);
    const depsTip = await commit("package-lock.json", '{"lockfileVersion":3}');
    assert.equal((await source.checkMain(root, helpTip)).candidate, depsTip);
    const startTip = await commit("scripts/start.mjs", "// changed launcher");
    assert.equal((await source.checkMain(root, depsTip)).candidate, startTip);
    await writeFile(path.join(root, "lib", "example.mjs"), "// user edit");
    await assert.rejects(source.checkMain(root, installed), /local changes/i);
    assert.equal(git(root, "rev-parse", "HEAD"), installed);
    assert.notEqual(later, tip);
});
