import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const project = fileURLToPath(new URL("../", import.meta.url));
const activationTest = process.platform === "win32" || process.platform === "linux" && /microsoft/i.test(release()) ? test : test.skip;
async function eventually(read, predicate, max = 30000) {
    let last;
    for (const until = Date.now() + max; Date.now() < until;) {
        try { last = await read(); if (predicate(last)) return last; } catch (e) { last = e.message; }
        await delay(40);
    }
    assert.fail("Fixture condition timed out: " + JSON.stringify(last));
}

// Actual npm script, launcher, stageMain, direct child entry, receipt DB and IPC
// bridge. Only the repository origin, application payload and store are synthetic.
const fixtureServer = `
import { createServer } from "node:http";
import { writeFile, readFile, appendFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createUpdateBridge } from "./update-bridge.mjs";
export async function startServer({dataDir}, controller, options) {
    const build = process.env.WIRE_UPDATE_BUILD, runtimeId = randomUUID();
    const file = name => path.join(dataDir,name);
    const clientEntry = "/assets/client/main-" + (build || "00000000").slice(0,8) + ".js";
    const behavior = (await readFile(new URL("./behavior.txt",import.meta.url),"utf8")).trim();
    const log = event => appendFile(file("events"),JSON.stringify({event,build,runtimeId})+"\\n");
    if (behavior === "partial-init") { await log("touched-store"); throw Error("startup failed after store access"); }
    let fenced = false;
    const bridge = createUpdateBridge({quiesce() {
        if (existsSync(file("busy"))) throw Error("fixture is busy"); fenced = true;
    }, resume() { fenced = false; }});
    const server = createServer(async (req,res) => {
        try {
            if (req.url === "/health") return res.end(JSON.stringify({service:"workiq-evidence",protocol:1,build,runtimeId,clientEntry}));
            if (req.url === "/fixture-store") return res.end(JSON.stringify({dataDir, pinned:process.env.WORKIQ_EVIDENCE_DATA_DIR}));
            if (req.url === clientEntry) {
                if (behavior === "hold") { await log("health-pending"); return; }
                res.writeHead(behavior === "bad" ? 503 : 200,{"Content-Type":"text/javascript"});return res.end("export {};");
            }
            if (req.url === "/crash") { res.end("bye"); setImmediate(()=>process.exit(7)); return; }
            if (req.url !== "/api/app-update" || fenced) {res.writeHead(409); return res.end("{}");}
            let text = ""; for await(const chunk of req) text += chunk;
            res.end(JSON.stringify(await bridge.request(JSON.parse(text))));
        } catch(e) {res.writeHead(409);res.end(JSON.stringify({error:e.message}));}
    });
    await new Promise((resolve,reject)=>server.once("error",reject).listen(options.port,"127.0.0.1",resolve));
    await mkdir(dataDir,{recursive:true});
    await writeFile(file("single-writer"),runtimeId,{flag:"wx"});
    await log("start");
    return {server,runtimeId,clientEntry,url:"http://127.0.0.1:"+server.address().port+"/",close:async()=>{
        bridge.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
        if(await readFile(file("single-writer"),"utf8")!==runtimeId) throw Error("fixture lost its writer");
        await unlink(file("single-writer"));await log("close");
    }};
}`;

async function fixture(t, host) {
    const base = await mkdtemp(path.join(tmpdir(), "wire-lch-"));
    const origin = path.join(base, "origin"), root = path.join(base, "user clone"), store = path.join(base, "store");
    const children = new Set();
    t.after(async () => {
        try { for (const app of children) { if (app.child.connected) app.child.disconnect(); await app.done; } }
        finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    });
    await Promise.all([mkdir(path.join(origin, "lib"), { recursive: true }), mkdir(path.join(origin, "scripts"), { recursive: true }),
        mkdir(store, { recursive: true })]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|OS|WINDIR|SystemRoot|ComSpec|SystemDrive|NUMBER_OF_PROCESSORS)$/i.test(key)));
    Object.assign(env, { USERPROFILE: base, HOME: base, LOCALAPPDATA: base, APPDATA: base, TMP: base, TEMP: base, TMPDIR: base,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(base, "no-git-config"), npm_config_offline: "true",
        npm_config_cache: path.join(base, "cache"), WORKIQ_EVIDENCE_DATA_DIR: store });
    const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgSign=false", ...args], { env, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    for (const file of ["scripts/start.mjs", "scripts/launch.mjs", "lib/update-launch.mjs", "lib/update-launch-artifact.mjs",
        "lib/update-launch-child.mjs", "lib/update-launch-state.mjs", "lib/update-source.mjs", "lib/update-compatibility.json",
        "lib/update-bridge.mjs", "lib/paths.mjs", "lib/search-model-assets.mjs", "lib/search-linguistics-assets.mjs", "lib/runtime-endpoint.mjs"]) {
        await copyFile(path.join(project, file), path.join(origin, file));
    }
    const scripts = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")).scripts;
    for (const [file, text] of Object.entries({
        "package.json": JSON.stringify({ name: "wire-fixture", version: "1.0.0", scripts: { start: scripts.start, build: "node -e \"process.exit(0)\"" } }),
        "package-lock.json": '{"name":"wire-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"wire-fixture","version":"1.0.0"}}}',
        ".gitignore": "node_modules/\ndist/\n",
        "extension.mjs": "export {}; // fixture has no registered tools",
        "lib/behavior.txt": "original",
        "lib/store.mjs": "export class BoardError extends Error {}",
        "lib/branding.mjs": "export const PRODUCT_NAME='WIRE';",
        "lib/server.mjs": fixtureServer,
        "lib/runtime-access.mjs": "export function createCopilotRuntimeAccess(){ throw Error('fixture must not query sources'); }",
        "lib/export.mjs": "export const createExportController=()=>({});",
    })) await writeFile(path.join(origin, file), text);
    git(origin, "init", "-qb", "main"); git(origin, "add", "."); git(origin, "commit", "-qm", "Invented base");
    const original = git(origin, "rev-parse", "HEAD");
    git(base, "clone", "--quiet", origin, root);
    await mkdir(path.join(root, "node_modules"));
    await symlink(path.join(project, "node_modules", "esbuild"), path.join(root, "node_modules", "esbuild"),
        process.platform === "win32" ? "junction" : "dir");
    const sourceURL = pathToFileURL(path.join(root, "lib", "update-source.mjs")).href;
    const stageLog = path.join(base, "stage-operations");
    const source = `import {createUpdateSource} from ${JSON.stringify(sourceURL)};
        import {appendFile} from "node:fs/promises";
        const implementation=createUpdateSource({fixtureRemote:${JSON.stringify(origin)}});
        export const {checkMain,inspectInstallation}=implementation;
        export async function stageMain(...args) {
            const record=event=>appendFile(${JSON.stringify(stageLog)},event+"\\n");
            await record("stageMain: fetching, verifying, installing and building");
            try {const staged=await implementation.stageMain(...args); await record("stageMain: built "+staged.commit); return staged;}
            catch(error) {await record("stageMain: "+error.message);throw error;}
        }`;
    const hook = path.join(base, "fixture-origin.mjs");
    const hostModule = host && "export * from 'node:os'; export const platform=()=>" + JSON.stringify(host[0])
        + ",release=()=>" + JSON.stringify(host[1]) + ";";
    await writeFile(hook, `import {registerHooks} from "node:module";registerHooks({resolve(s,c,next){
      if(${Boolean(host)} && c.parentURL===${JSON.stringify(pathToFileURL(path.join(root,"lib","update-launch.mjs")).href)} && s==="node:os")
        return {url:${JSON.stringify("data:text/javascript," + encodeURIComponent(hostModule || ""))},shortCircuit:true};
      if(c.parentURL===${JSON.stringify(pathToFileURL(path.join(root,"lib","update-launch.mjs")).href)} && s==="./update-source.mjs")
        return {url:${JSON.stringify("data:text/javascript," + encodeURIComponent(source))},shortCircuit:true};return next(s,c);}});`);
    env.NODE_OPTIONS = "--import=" + pathToFileURL(hook).href;
    await writeFile(path.join(store, "evidence"), "invented preserved bytes");
    function launch({ dataDir = store, npm = false, args = [] } = {}) {
        const entry = npm ? [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
            path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find(file => file && existsSync(file))
            : path.join(root, "scripts", "launch.mjs");
        const childEnv = { ...env, WORKIQ_EVIDENCE_DATA_DIR: dataDir };
        if (dataDir === null) delete childEnv.WORKIQ_EVIDENCE_DATA_DIR;
        const child = fork(entry, [...(npm ? ["start", "--"] : []), "--port", "0", ...args], { cwd: root, execArgv: [],
            stdio: ["ignore", "pipe", "pipe", "ipc"], env: childEnv });
        const app = { child, stdout: "", stderr: "", exit: null };
        child.stdout.on("data", chunk => { app.stdout += chunk; });
        child.stderr.on("data", chunk => { app.stderr += chunk; });
        app.done = new Promise(resolve => child.once("exit", (code, signal) => {
            app.exit = { code, signal }; children.delete(app); resolve(app.exit);
        }));
        children.add(app);
        app.ready = async () => {
            await eventually(() => ({ exit: app.exit, stdout: app.stdout, stderr: app.stderr }), v => v.exit || /ready at/.test(v.stdout));
            assert.equal(app.exit, null, app.stderr);
            const url = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(app.stdout)[1];
            await eventually(() => request(url, "status"), data => typeof data.supported === "boolean");
            return url;
        };
        return app;
    }
    async function commit(behavior, incompatible = false) {
        await writeFile(path.join(origin, "lib", "behavior.txt"), behavior);
        if (incompatible) await writeFile(path.join(origin, "lib", "update-compatibility.json"),
            '{"launcherProtocol":1,"storeReadWriteProtocol":1,"canvasAdapterProtocol":1}\n');
        git(origin, "commit", "-qam", "Invented next build");
        return git(origin, "rev-parse", "HEAD");
    }
    const events = async () => (await readFile(path.join(store, "events"), "utf8")).trim().split("\n").map(JSON.parse);
    return { original, root, store, origin, commit, launch, events, git, stageLog };
}
async function request(url, action, args) {
    // Status polling can abandon one read. A real check/apply may be waiting on
    // the local Git/IPC operation: its original result belongs to the enclosing lifecycle test.
    const response = await fetch(url + "api/app-update", { method: "POST", body: JSON.stringify({ action, ...args }),
        ...(action === "status" ? { signal: AbortSignal.timeout(2000) } : {}) });
    return response.json();
}
const phase = (url, expected) => eventually(() => request(url, "status"), state => state.phase === expected);
const stop = async app => { app.child.disconnect(); assert.equal((await app.done).code, 0, app.stderr); };

async function awaitCandidateEvent(f, app, url, candidate, event) {
    const evidence = await eventually(async () => {
        const events = await f.events();
        const reached = events.some(row => row.build === candidate && row.event === event);
        if (reached || app.exit) return { reached, events };
        const status = await request(url, "status").catch(() => null);
        return { reached, events, status };
    }, e => e.reached || app.exit || e.status?.phase === "error").catch(error => ({ error: error.message }));
    if (evidence.reached) return;
    const staging = await readFile(f.stageLog, "utf8").catch(() => "stageMain not reached");
    assert.fail(`Candidate ${candidate} did not reach ${event}; evidence: ${JSON.stringify(evidence)}; `
        + `staging: ${staging.trim()}; launcher exit: ${JSON.stringify(app.exit)}; stderr: ${app.stderr.slice(-1500)}`);
}

async function assertRefused(app, reason) {
    await eventually(() => ({ exit: app.exit, stdout: app.stdout }), v => v.exit || /ready at/.test(v.stdout));
    assert.equal(app.exit?.code, 1, app.stdout + app.stderr);
    assert.match(app.stderr, reason);
}

activationTest("special modes cannot bypass an active slot or an unresolved original child", { timeout: 90000 }, async t => {
    const args = ["--verified-record-recovery"];
    for (const transition of ["crash", "update"]) {
        const f = await fixture(t), app = f.launch(), url = await app.ready();
        if (transition === "crash") {
            await fetch(url + "crash").catch(() => {}); await app.done;
        } else {
            const candidate = await f.commit("next");
            assert.equal((await request(url, "check")).candidate, candidate);
            await request(url, "apply", { candidate }); await phase(url, "current"); await stop(app);
        }
        const dataDir = f.store + "-special"; await mkdir(dataDir);
        await assertRefused(f.launch({ args, dataDir }), transition === "crash" ? /clean close/ : /active build|active slot/);
        assert.equal(existsSync(path.join(dataDir, "events")), false);
    }
});

activationTest("owned replacement retains a single writer, port, settings and original checkout; unknown child close cannot restart", { timeout: 90000 }, async t => {
    const f = await fixture(t), app = f.launch(), url = await app.ready();
    const initial = await request(url, "status");
    assert.equal(initial.automatic, true);
    assert.equal(initial.lastChecked, null);
    const competing = f.launch();
    assert.equal((await competing.done).code, 1);
    assert.match(competing.stderr, /already has a launcher/);
    const candidate = await f.commit("next");
    const [a,b] = await Promise.all([request(url, "auto-check"), request(url, "auto-check")]);
    assert.equal(a.candidate, candidate); assert.equal(b.lastChecked, a.lastChecked);
    assert.equal((await request(url, "dismiss", { candidate })).dismissed, candidate);
    assert.equal((await request(url, "preferences", { enabled: false })).automatic, false);
    await writeFile(path.join(f.store, "busy"), "");
    assert.equal((await request(url, "apply", { candidate })).phase, "preparing");
    assert.match((await phase(url, "error")).message, /busy/);
    assert.equal((await f.events()).length, 1);
    await rm(path.join(f.store, "busy"));
    const rechecked = await request(url, "check");
    assert.equal(rechecked.candidate, candidate);
    // With protocol v0, the old SHA is no longer advertised after this docs-only advance.
    f.git(f.root, "config", "--global", "protocol.version", "0");
    await writeFile(path.join(f.origin, "README.md"), "Revised instructions.");
    f.git(f.origin, "add", "README.md"); f.git(f.origin, "commit", "-qm", "Docs after the offer");
    assert.equal((await request(url, "apply", { candidate })).phase, "preparing");
    const status = await phase(url, "current");
    assert.equal(status.installed, candidate);
    assert.equal(status.automatic, false);
    assert.equal(status.lastChecked, rechecked.lastChecked);
    const health = await (await fetch(url + "health")).json();
    assert.equal(health.build, candidate); assert.equal(health.clientEntry, status.clientEntry);
    assert.equal(f.git(f.root, "rev-parse", "HEAD"), f.original);
    assert.equal(f.git(f.root, "status", "--porcelain"), "");
    assert.deepEqual((await f.events()).map(e => [e.event,e.build]), [["start",f.original],["close",f.original],["start",candidate]]);
    assert.equal(await readFile(path.join(f.store, "evidence"), "utf8"), "invented preserved bytes");
    await stop(app);
    const again = f.launch({ npm: true }), againURL = await again.ready();
    assert.equal((await request(againURL, "status")).installed, candidate);
    await fetch(againURL + "crash").catch(() => {});
    assert.notEqual((await again.done).code, 0);
    const refused = f.launch();
    assert.equal((await refused.done).code, 1); assert.match(refused.stderr, /clean close/);
});

activationTest("changed app content or incompatible store protocol requires a new decision; unhealthy candidate rolls back safely", { timeout: 90000 }, async t => {
    const f = await fixture(t), app = f.launch(), url = await app.ready();
    const first = await f.commit("next");
    assert.equal((await request(url, "check")).candidate, first);
    const bad = await f.commit("bad");
    assert.equal((await request(url, "apply", { candidate: first })).phase, "preparing");
    assert.match((await phase(url, "error")).message, /changed/);
    assert.equal((await f.events()).length, 1);
    assert.equal((await request(url, "check")).candidate, bad);
    assert.equal((await request(url, "apply", { candidate: bad })).phase, "preparing");
    const rollback = await phase(url, "error");
    assert.match(rollback.message, /previous compatible build is running/);
    assert.deepEqual((await f.events()).map(e => [e.event,e.build]),
        [["start",f.original],["close",f.original],["start",bad],["close",bad],["start",f.original]]);
    const breaking = await f.commit("new protocol", true);
    assert.equal((await request(url, "check")).candidate, breaking);
    assert.equal((await request(url, "apply", { candidate: breaking })).phase, "preparing");
    assert.match((await phase(url, "error")).message, /contract|manual/);
    await assert.rejects(awaitCandidateEvent(f, app, url, breaking, "touched-store"),
        error => /did not reach touched-store/.test(error.message) && /stageMain: .*contract/.test(error.message));
    assert.equal((await f.events()).length, 5);
    await stop(app);
});

activationTest("a candidate that touches storage and fails before returning a runtime cannot authorize rollback", { timeout: 90000 }, async t => {
    const f = await fixture(t), app = f.launch(), url = await app.ready(), candidate = await f.commit("partial-init");
    assert.equal((await request(url, "check")).candidate, candidate);
    await request(url, "apply", { candidate });
    await awaitCandidateEvent(f, app, url, candidate, "touched-store");
    await eventually(async () => ({ exit: app.exit, events: await f.events() }), v => v.exit || v.events.length > 3);
    assert.deepEqual((await f.events()).map(e => e.event), ["start", "close", "touched-store"]);
    assert.equal((await app.done).code, 1);
    await assertRefused(f.launch(), /clean close/);
});

activationTest("a default store is pinned from the first child even when the staged build selects a different default", { timeout: 90000 }, async t => {
    const f = await fixture(t), selected = path.join(path.dirname(f.store), "WorkIQEvidence", "data");
    assert.equal(existsSync(selected), false);
    const app = f.launch({ dataDir: null }), url = await app.ready();
    const observed = () => fetch(url + "fixture-store").then(r => r.json());
    assert.deepEqual(await observed(), { dataDir: selected, pinned: selected });
    const paths = path.join(f.origin, "lib", "paths.mjs");
    await writeFile(paths, (await readFile(paths, "utf8")).replace('"WorkIQEvidence", "data"', '"other-default", "data"'));
    const candidate = await f.commit("changed-default");
    assert.equal((await request(url, "check")).candidate, candidate);
    await request(url, "apply", { candidate }); assert.equal((await phase(url, "current")).installed, candidate);
    assert.deepEqual(await observed(), { dataDir: selected, pinned: selected });
    assert.equal(existsSync(path.join(path.dirname(f.store), "other-default")), false);
    await stop(app);
});

test("standalone Linux and macOS disclose manual mode and reject Apply in the launcher, not just the browser", { timeout: 90000 }, async t => {
    for (const host of [["linux", "6.15.0-generic"], ["darwin", "24.6.0"]]) {
        const f = await fixture(t, host), app = f.launch(), url = await app.ready(), candidate = await f.commit("never-activate");
        const status = await request(url, "status");
        assert.equal(status.phase, "manual"); assert.equal(status.supported, false); assert.equal(status.automatic, false);
        assert.match(status.message, /Windows and WSL only/);
        assert.deepEqual(await request(url, "check"), status);
        assert.deepEqual(await request(url, "apply", { candidate }), status);
        assert.deepEqual((await f.events()).map(e => e.event), ["start"]);
        await stop(app);
    }
});

activationTest("opening coalesces checks; an offline check preserves the last successful result and cannot authorize apply", { timeout: 90000 }, async t => {
    const f = await fixture(t), app = f.launch(), url = await app.ready(), first = await f.commit("next");
    const checked = await request(url, "auto-check");
    assert.equal(checked.candidate, first);
    const second = await f.commit("later");
    assert.equal((await request(url, "auto-check")).candidate, first);
    await stop(app);
    const reopened = f.launch(), nextURL = await reopened.ready();
    const recent = await request(nextURL, "auto-check");
    assert.equal(recent.candidate, second); assert.ok(recent.lastChecked > checked.lastChecked);
    await rename(f.origin, f.origin + "-offline");
    const offline = await request(nextURL, "check");
    assert.equal(offline.phase, "error"); assert.equal(offline.candidate, second); assert.equal(offline.lastChecked, recent.lastChecked);
    assert.ok((await request(nextURL, "apply", { candidate: second })).error);
    await stop(reopened);
});

activationTest("interrupted activation requires the same store, recovers prior build and ephemeral port, and does not replay apply", { timeout: 90000 }, async t => {
    const f = await fixture(t), app = f.launch(), url = await app.ready();
    const candidate = await f.commit("hold");
    assert.equal((await request(url, "check")).candidate, candidate);
    assert.equal((await request(url, "apply", { candidate })).phase, "preparing");
    await awaitCandidateEvent(f, app, url, candidate, "health-pending");
    app.child.kill("SIGKILL"); await app.done;
    await eventually(f.events, rows => rows.at(-1).event === "close");
    const wrong = f.launch({ dataDir: f.store + "-other" });
    assert.equal((await wrong.done).code, 1);
    assert.match(wrong.stderr, /original port and data folder/);
    const resumed = f.launch();
    assert.equal(await resumed.ready(), url);
    const status = await request(url, "status");
    assert.equal(status.installed, f.original); assert.match(status.message, /interrupted/);
    assert.deepEqual((await f.events()).map(e => e.event), ["start","close","start","health-pending","close","start"]);
    await stop(resumed);
});
