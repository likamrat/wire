import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const command = fileURLToPath(new URL("../../scripts/prepare-release.mjs", import.meta.url));

test("the first public version belongs to the chosen snapshot, not the old package or moving main", async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wire-first-cut-"));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
    const repo = path.join(dir, "history"), hook = path.join(dir, "release-feed.mjs");
    await mkdir(repo);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" };
    const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgSign=false", ...args], { cwd: repo, env, encoding: "utf8" }).trim();
    git("init", "-qb", "main");
    git("config", "--global", `url.${repo.replaceAll("\\", "/")}.insteadOf`, "https://github.com/likamrat/wire.git");
    async function snapshot(version, lockVersion, rootVersion, summary) {
        await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "wire-fixture", version }));
        await writeFile(path.join(repo, "package-lock.json"), JSON.stringify({ name: "wire-fixture", version: lockVersion,
            lockfileVersion: 3, packages: { "": { name: "wire-fixture", version: rootVersion } } }));
        git("add", "."); git("commit", "-qm", summary); return git("rev-parse", "HEAD");
    }
    const base = await snapshot("1.0.1", "1.0.1", "1.0.1", "Prior unnumbered development build");
    const wrongPackage = await snapshot("1.0.1", "0.1.0", "0.1.0", "Wrong package version");
    const wrongRoot = await snapshot("0.1.0", "0.1.0", "1.0.1", "Incomplete metadata");
    const wrongLock = await snapshot("0.1.0", "1.0.1", "0.1.0", "Still incomplete");
    const target = await snapshot("0.1.0", "0.1.0", "0.1.0", "Synthetic freeze candidate");
    const next = await snapshot("0.1.1", "0.1.1", "0.1.1", "Change after the freeze");
    await writeFile(hook, `import cp from "node:child_process";
        import {syncBuiltinESMExports} from "node:module";
        const exec = cp.execFileSync;
        cp.execFileSync = (command,args,...rest) => {
            // A recorded Git tag advertisement, not an actual tag or a public release.
            if (command === "git" && args[0] === "ls-remote" && args[2] === "refs/tags/v0.1.0") {
                return ${JSON.stringify(target + "\trefs/tags/v0.1.0\n")};
            }
            return exec(command,args,...rest);
        };
        syncBuiltinESMExports();
        globalThis.fetch = url => {
        if (String(url) !== "https://api.github.com/repos/likamrat/wire/releases/latest") throw Error("Unexpected URL");
        return Promise.resolve(process.env.WIRE_FIXTURE_PUBLISHED ? Response.json({
            tag_name:"v0.1.0",html_url:"https://github.com/likamrat/wire/releases/tag/v0.1.0",
            published_at:"2026-01-01T00:00:00Z",body:"Synthetic release.",draft:false,prerelease:false
        }) : new Response(null,{status:404}));
    };`);
    const prepare = (args, published = false) => spawnSync(process.execPath,
        ["--import", pathToFileURL(hook).href, command, ...args], { cwd:repo, encoding:"utf8",
            env:{ ...env, WIRE_FIXTURE_PUBLISHED:published ? "1" : "" } });
    const first = (commit, ...extra) => prepare(["--commit", commit, "--baseline", base, ...extra]);
    const good = first(target, "--version", "v0.1.0");
    assert.equal(good.status, 0, good.stderr);
    assert.ok(good.stdout.startsWith(`v0.1.0 · ${target}`));
    assert.match(good.stdout, /## What's new in v0\.1\.0/);
    assert.doesNotMatch(good.stdout, /Change after the freeze/);
    assert.match(first(target).stderr, /first release.*--version/i);
    for (const commit of [wrongPackage, wrongRoot, wrongLock, next]) {
        const refused = first(commit, "--version","v0.1.0");
        assert.notEqual(refused.status, 0); assert.match(refused.stderr, /package.*lock/i);
    }
    for (const v of ["v0.0.9","v0.1.0"]) {
        const refused = prepare(["--commit", next, "--version", v], true);
        assert.notEqual(refused.status, 0); assert.match(refused.stderr, /newer than v0\.1\.0/);
    }
    const forward = prepare(["--commit", next], true);
    assert.equal(forward.status, 0, forward.stderr);
    assert.ok(forward.stdout.startsWith(`v0.1.1 · ${next}\nChanges after ${target}`));
    assert.match(forward.stdout, /Change after the freeze/);
    const empty = prepare(["--commit", target], true);
    assert.notEqual(empty.status, 0); assert.match(empty.stderr, /no new changes/);
    assert.equal(git("tag","--list"), "");
    assert.equal(git("status","--porcelain"), "");
});
