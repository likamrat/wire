import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chooseTheme, fixture } from "../support/helpers.mjs";
import { contrast, measureControlSurface } from "../support/color-measurements.mjs";
import { palettes } from "../../web/theme.mjs";
import { replaceEvidence, loadBoardState } from "../../lib/store.mjs";
import { createExportController } from "../../lib/export.mjs";
import { createRuntimeClient } from "../../lib/runtime-client.mjs";
import { initialSessionState, sessionStorage } from "../../lib/microsoft-session-state.mjs";
import pkg from "../../package.json" with { type: "json" };

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const handsOn = process.env.WIRE_UPDATE_BROWSER === "manual";
const sleepingGuide = process.env.WIRE_UPDATE_BROWSER === "release-sleep";
const discoveryOnly = process.env.WIRE_UPDATE_BROWSER === "release-discovery";
const launcherRollout = process.env.WIRE_UPDATE_BROWSER === "launcher-rollout";
const releaseJourney = sleepingGuide || discoveryOnly || process.env.WIRE_UPDATE_BROWSER === "release";
const adapterBridge = process.env.WIRE_UPDATE_BROWSER === "adapter-bridge";
const adapterBase = "83a6040065072acdf5e8984d8450bd3b4b8cf42e";
const rolloutBase = "4d700dbf0d5efd16f4f1a78de0d4bc6c47d893da"; // v0.1.2

// An oversized binary attachment is not a missing model round. The new journal
// collector counts the two receipts; the old collector withheld the whole total.
async function seedAdapterJournal({ appDbPath, sessionRoot }) {
    const { DatabaseSync } = await import("node:sqlite");
    const id = randomUUID(), dbDir = path.dirname(appDbPath);
    await mkdir(dbDir, { recursive: true });
    const db = new DatabaseSync(appDbPath);
    try {
        db.exec(`PRAGMA user_version=156;
            CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
            CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
            CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
        db.prepare("INSERT INTO sessions VALUES(?, 'Fixture', 'chat', NULL, 'local')").run(id);
    } finally { db.close(); }
    const model = "gpt-4.1", interactionId = "fixture-run", messageId = "fixture-prompt", toolCallId = "fixture-tool";
    const receipt = apiCallId => ["session.usage_record", { usage: { apiCallId, model, interactionId, inputTokens: 2000, outputTokens: 200 } }];
    const events = [
        ["session.start", { sessionId: id, version: 1 }], ["user.message", { messageId, interactionId, content: "Read this fixture.", delivery: "idle" }],
        ["session.binary_asset", { mimeType: "image/png", data: "x".repeat(1100 * 1024) }],
        ["assistant.message", { apiCallId: "one", model, turnId: "first", originatingMessageId: messageId, toolRequests: [{ toolCallId }] }],
        ["tool.execution_start", { toolCallId, turnId: "first", toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", arguments: {entityUrls:["/me/messages"]} }],
        ["tool.execution_complete", { toolCallId, success: true, result: { content: "Fixture evidence." } }], receipt("one"),
        ["assistant.turn_start", { turnId: "last" }],
        ["assistant.message", { apiCallId: "two", model, turnId: "last", originatingMessageId: messageId, phase: "final_answer", content: "Fixture answer.", toolRequests: [] }],
        receipt("two"), ["assistant.turn_end", { turnId: "last" }],
    ];
    await mkdir(path.join(sessionRoot, id), { recursive: true });
    await writeFile(path.join(sessionRoot, id, "events.jsonl"), events.map(([type, data], i) =>
        JSON.stringify({ id: randomUUID(), type, data, timestamp: new Date(Date.now() - 20000 + i * 100).toISOString() }) + "\n").join(""));
    return id;
}
// Slow by design: install locked dependencies and build two full copies of WIRE,
// not a replacement server or mock health endpoint. Use only a synthetic source.
test(discoveryOnly ? "open WIRE tabs discover a stable release published after their first automatic check"
    : launcherRollout ? "a clean v0.1.2 installation starts its verified updated launcher without losing Automatic Off"
    : "full WIRE clone updates on the original address and reopens the same saved report", { timeout: handsOn ? 25 * 60000 : discoveryOnly ? 8 * 60000 : 300000 }, async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wire-full-update-"));
    const origin = path.join(temp, "origin"), store = path.join(temp, "store");
    // A nested Windows install puts Git's pack-<hash>.keep beyond MAX_PATH in the stage.
    const installName = process.platform === "win32" ? "installed".padEnd(159 - path.join(temp, ".git", "wire-updates").length - 1, "-") : "installed";
    const root = path.join(temp, installName);
    const env = { ...process.env, COPILOT_HOME: path.join(temp, "empty-source"), GH_CONFIG_DIR: path.join(temp, "empty-gh"),
        WORKIQ_EVIDENCE_DATA_DIR: store, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(temp, "no-git-config"),
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", npm_config_audit: "false", npm_config_fund: "false" };
    for (const key of Object.keys(env)) if (/^(?:GH|GITHUB|COPILOT).*TOKEN$/.test(key) || key === "NODE_OPTIONS") delete env[key];
    const git = async (cwd, ...args) => (await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgSign=false", ...args], { cwd, env, maxBuffer: 4 * 1024 * 1024 })).stdout.trimEnd();
    let app, ended, independent, independentExit, closeNativeBrowser, stderr = "", stdout = "";
    t.after(async () => {
        if (closeNativeBrowser) await closeNativeBrowser();
        if (independent?.connected) independent.disconnect();
        if (independentExit) await independentExit;
        if (app?.connected) app.disconnect();
        if (ended) {
            const timer = setTimeout(() => app.kill(), 12000);
            try { await ended; } finally { clearTimeout(timer); }
        }
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await mkdir(origin);
    const guideText = title => `# Fixture guide\n\n## Reading updates\n\n${title}\n\n![Release illustration](images/example.svg)\n`;
    const guideImage = width => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="16"><rect width="${width}" height="16" fill="teal"/></svg>`;
    if (releaseJourney) {
        await mkdir(path.join(origin,"docs","images"),{recursive:true});
        await writeFile(path.join(origin,"docs","README.md"),guideText("Installed guide before update."));
        await writeFile(path.join(origin,"docs","images","example.svg"),guideImage(32));
    }
    // Only committed source is an eligible integration input. No ignored assets,
    // working directories, Git credentials, node_modules, or private data.
    const targetCommit = (adapterBridge || launcherRollout) && await git(project, "rev-parse", "HEAD^{commit}");
    if (adapterBridge || launcherRollout) {
        // Transfer only the candidate ancestry into the private origin. No live remote or branch is changed.
        await git(origin, "init", "-qb", "main");
        await git(origin, "fetch", "--quiet", "--no-tags", project, targetCommit);
        const from = launcherRollout ? rolloutBase : adapterBase;
        await git(origin, "merge-base", "--is-ancestor", from, targetCommit);
        await git(origin, "merge", "--ff-only", from);
    } else {
        const tracked = (await git(project, "ls-files", "-z", "--cached")).split("\0").filter(Boolean);
        for (const name of tracked.filter(name => /^(?:lib|scripts|assets|web|copilot-bridge)\//.test(name)
            || [".gitignore","package.json","package-lock.json","vite.config.mjs","tsconfig.json","extension.mjs"].includes(name))) {
            const target = path.join(origin, name);
            await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(project, name), target);
        }
        await git(origin, "init", "-qb", "main"); await git(origin, "add", "."); await git(origin, "commit", "-qm", "Fixture baseline");
    }
    const base = await git(origin, "rev-parse", "HEAD");
    await git(temp, "clone", "--quiet", origin, root);
    const npm = process.env.npm_execpath;
    assert.ok(npm && path.isAbsolute(npm), "Run via npm run test:update-runtime");
    await exec(process.execPath, [npm, "ci", "--include=dev"], { cwd: root, env });
    await exec(process.execPath, [npm, "run", "build"], { cwd: root, env });

    const context = { dataDir: store };
    if (launcherRollout) {
        Object.assign(env, { HOME: temp, USERPROFILE: temp, LOCALAPPDATA: temp, APPDATA: temp, GIT_ALLOW_PROTOCOL: "file" });
        await sessionStorage(context).write({ ...initialSessionState(), wire: "signed-in" });
    }
    await replaceEvidence(context, () => ({ records: [fixture("invented-update-report")], importCoverage: null }));
    const cfg = { schemaVersion: 1, approved: true, enabled: false, windowDays: 30, pollSeconds: 60,
        appDbPath: path.join(temp, "empty-source", "data.db"), sessionRoot: path.join(temp, "empty-source", "session-state") };
    await mkdir(path.join(store, "collector"), { recursive: true });
    const cfgPath = path.join(store, "collector", "config.json");
    await writeFile(cfgPath, JSON.stringify(cfg));
    const controller = createExportController(context);
    const preview = await controller.preview("fixture", undefined, { formats: ["html","json"], promptMode: "masked" },
        { kind: "all", revision: (await loadBoardState(context)).revision });
    await controller.review("fixture", preview.previewId, true);
    const result = await controller.confirm("fixture", preview.previewId, true);
    const bundle = (await loadBoardState(context)).exports.find(entry => entry.bundleId === result.bundle.bundleId);
    assert.ok(bundle && Object.keys(bundle.files).length);
    const reportHashes = await Promise.all(Object.values(bundle.files).map(async file => [file, hash(await readFile(file))]));
    const configBytes = await readFile(cfgPath);
    // The injection substitutes only the repository address for this local qualification.
    async function originHook(installation, name) {
        const sourceURL = pathToFileURL(path.join(installation, "lib", "update-source.mjs")).href;
        const feed = path.join(temp,"release.json");
        const seam = `import {createUpdateSource} from ${JSON.stringify(sourceURL)};
        import {readFile,appendFile} from 'node:fs/promises';
        export const {inspectInstallation,checkMain,stageMain,channel}=createUpdateSource({fixtureRemote:${JSON.stringify(origin)},channel:${JSON.stringify(releaseJourney||launcherRollout?"release":"main")},
        fetcher:async()=>{${discoveryOnly || launcherRollout ? `await appendFile(${JSON.stringify(path.join(temp, "feed-reads"))},${JSON.stringify(discoveryOnly ? "read\n" : installation + "\n")});` : ""}
        try{return Response.json(JSON.parse(await readFile(${JSON.stringify(feed)},'utf8')))}catch(e){if(e.code!=='ENOENT') throw e;return new Response(null,{status:404})}}});`;
        const hook = path.join(temp, name);
        await writeFile(hook, `import{registerHooks}from'node:module';registerHooks({resolve(s,c,next){
        if(c.parentURL===${JSON.stringify(pathToFileURL(path.join(installation, "lib", "update-launch.mjs")).href)}&&s==="./update-source.mjs")
        return {url:${JSON.stringify("data:text/javascript," + encodeURIComponent(seam))},shortCircuit:true};return next(s,c)}});`);
        return pathToFileURL(hook).href;
    }
    const hook = await originHook(root, "fixture-origin.mjs");
    function launch(port, entry = root, args = [], imports = "--import=" + hook) {
        stdout = ""; stderr = "";
        app = fork(path.join(entry, "scripts/launch.mjs"), [...args, "--port", port], {
            cwd: root, env: { ...env, NODE_OPTIONS: imports }, execArgv: [], stdio: ["ignore","pipe","pipe","ipc"] });
        app.stdout.on("data", data => { stdout += data; }); app.stderr.on("data", data => { stderr += data; });
        ended = new Promise(resolve => app.once("exit", resolve));
    }
    launch("0");
    async function until(work, timeout = 90000, interval = 120) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            assert.equal(app.exitCode, null, stderr);
            const value = await work(); if (value) return value;
            await delay(interval);
        }
        throw Error("Fixture timed out waiting for the expected running version: " + stderr);
    }
    const url = await until(() => stdout.match(/ready at (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1]);
    const getPage = async () => {
        const html = await (await fetch(url + "settings")).text();
        return JSON.parse(html.match(/id="wireBootstrap"[^>]*>([^<]+)<\/script>/)[1]).capability;
    };
    const health = async () => (await fetch(url + "health", { signal: AbortSignal.timeout(4500) })).json();
    let cap = await getPage();
    const post = async (route, data) => {
        const r = await fetch(url + route, { method: "POST", headers: { Origin: new URL(url).origin, "Content-Type": "application/json",
            "X-Board-Capability": cap }, body: JSON.stringify(data), signal: AbortSignal.timeout(30000) });
        const value = await r.json(); assert.equal(r.status, 200, value.error); return value;
    };
    const update = (action, fields) => post("api/app-update", { action, ...fields });
    const original = await health();
    assert.equal(original.build, base);
    async function verifyPreserved() {
        for (const [file, digest] of reportHashes) assert.equal(hash(await readFile(file)), digest);
        assert.deepEqual(await readFile(cfgPath), configBytes);
        assert.equal(await git(root, "rev-parse", "HEAD"), base);
    }
    if (launcherRollout) {
        await git(origin, "merge", "--ff-only", targetCommit);
        const tag = "v1.1.0", port = new URL(url).port;
        await git(origin, "tag", tag);
        await writeFile(path.join(temp, "release.json"), JSON.stringify({ tag_name: tag, draft: false, prerelease: false,
            published_at: new Date().toISOString(), body: "Fixture launcher update.", html_url: `https://github.com/likamrat/wire/releases/tag/${tag}` }));
        await update("preferences", { enabled: false });
        const old = await applyTip();
        assert.equal(old.automatic, false); assert.equal(old.nextAutoCheckAt, undefined);
        const installed = await health();
        assert.equal(installed.build, targetCommit);
        app.disconnect(); assert.equal(await ended, 0, stderr);
        const slots = path.join(root, ".git", "wire-updates");
        const dirs = (await readdir(slots, { withFileTypes: true })).filter(e => e.isDirectory());
        assert.equal(dirs.length, 1);
        const stage = path.join(slots, dirs[0].name);
        assert.equal(await git(stage, "rev-parse", "HEAD"), targetCommit);
        const selector = await originHook(project, "selector.mjs"), selected = await originHook(stage, "selected.mjs");
        const imports = `--import=${selector} --import=${selected}`, args = ["--start-installed", root];
        launch(port === "4001" ? "4002" : "4001", project, args, imports);
        assert.equal(await ended, 1); assert.match(stderr, /clean stop on this store and port/);
        launch(port, project, args, imports);
        await until(() => stdout.includes("ready at " + url));
        const after = await health(); cap = await getPage();
        assert.equal(after.build, targetCommit); assert.equal(after.clientEntry, installed.clientEntry);
        const preserved = await update("status");
        assert.equal(preserved.automatic, false); assert.equal(preserved.lastChecked, old.lastChecked);
        assert.equal(preserved.nextAutoCheckAt, 0);
        await assert.rejects(exec(process.execPath, [path.join(root, "scripts/launch.mjs"), "--port", port],
            { cwd: root, env: { ...env, NODE_OPTIONS: "--import=" + hook }, timeout: 10000 }), e => /already has a launcher/.test(e.stderr));
        const { chromium, expect } = await import("@playwright/test");
        const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
        try {
            const page = await browser.newPage(), actions = [];
            page.on("request", r => { if (r.url() === url + "api/app-update") actions.push(r.postDataJSON().action); });
            await page.goto(url + "settings"); await expect(page.locator("#appUpdateCheck")).toBeEnabled();
            await expect(page.locator("#appUpdateAuto")).not.toBeChecked();
            assert.ok(await page.evaluate(entry => performance.getEntriesByName(location.origin + entry).length > 0, after.clientEntry));
            const start = Date.now(), response = page.waitForResponse(r => r.url() === url + "api/app-update" && r.request().postDataJSON().action === "check");
            await page.locator("#appUpdateCheck").click();
            const checked = await (await response).json();
            assert.equal(checked.phase, "current", checked.message); assert.equal(checked.automatic, false);
            assert.ok(checked.nextAutoCheckAt >= start + 300000 && checked.nextAutoCheckAt <= Date.now() + 300000);
            assert.equal((await readFile(path.join(temp, "feed-reads"), "utf8")).trimEnd().split("\n").at(-1), stage,
                "release verification executed in the original installation's active slot, not the selector or base");
            await page.goto(url + "reports?bundle=" + bundle.bundleId);
            await expect(page.locator("#savedReportReader h1")).toBeVisible();
            assert.ok(!actions.includes("auto-check"));
            await verifyPreserved();
            assert.equal((await sessionStorage(context).read()).wire, "signed-in");
            t.diagnostic(JSON.stringify({ fixtureOnly: true, base, launcher: targetCommit, child: after.build, client: after.clientEntry,
                port, automatic: checked.automatic, manualCheckAdvertisedIntervalMs: 300000, automaticRequests: 0,
                competingLauncherRefused: true, wrongPortRefused: true, storeAndConfigPreserved: true, signedIn: true, reportReopened: true,
                reportHashes: Object.fromEntries(reportHashes.map(([file, digest]) => [path.basename(file), digest])) }));
        } finally { await browser.close(); }
        return;
    }
    if (adapterBridge) {
        assert.equal(base, adapterBase);
        await git(origin, "merge", "--ff-only", targetCommit);
        await applyTip();
        const after = await health();
        assert.equal(after.build, targetCommit); assert.notEqual(after.runtimeId, original.runtimeId);
        assert.ok(await post("api/report/open", { bundleId: bundle.bundleId }));
        await verifyPreserved();
        const slots = path.join(root, ".git", "wire-updates");
        const installed = (await readdir(slots, { withFileTypes: true })).filter(item => item.isDirectory());
        assert.equal(installed.length, 1);
        const stage = path.join(slots, installed[0].name);
        assert.equal(await git(stage, "rev-parse", "HEAD"), targetCommit);
        const id = await seedAdapterJournal(cfg);
        await post("api/collection/now", {});
        // Existing shims still import root; a new installation uses the candidate entry.
        // Only the SDK registration transport is substituted, not the callbacks or protocol.
        for (const source of [root, stage]) {
            const key = "wireCanvas" + randomUUID(), entry = pathToFileURL(path.join(source, "extension.mjs")).href;
            const sdk = `export const createCanvas=c=>c,joinSession=async s=>{globalThis[${JSON.stringify(key)}]=s.canvases[0];return {}};
                export class CanvasError extends Error{}`;
            const hooks = registerHooks({ resolve(spec, context, next) {
                return spec === "@github/copilot-sdk/extension" && context.parentURL === entry
                    ? { url: "data:text/javascript," + encodeURIComponent(sdk), shortCircuit: true } : next(spec, context);
            } });
            let canvas;
            try { await import(entry); canvas = globalThis[key]; }
            finally { hooks.deregister(); delete globalThis[key]; }
            const instanceId = "bridge-" + randomUUID();
            assert.equal((await canvas.open({ instanceId, input: { boardId: "workiq-evidence-board-v1", runtimePort: Number(new URL(url).port) } })).url, url);
            try {
                const state = await canvas.actions.find(a => a.name === "get_state").handler({ instanceId, actionName: "get_state", input: {} });
                assert.equal(state.scenarios.find(s => s.sourceSessionId === id)?.usage?.total, 4400);
            } finally { await canvas.onClose({ instanceId }); }
        }
        t.diagnostic(`${base} -> ${after.build} on ${url}; original report preserved and both native adapters read 4,400 tokens from the new collector.`);
        return;
    }
    if (releaseJourney) {
        const {chromium,expect} = await import("@playwright/test");
        const publish = async (tag,commit,body) => {
            await git(origin,"tag",tag,commit);
            await writeFile(path.join(temp,"release.json"),JSON.stringify({tag_name:tag,html_url:`https://github.com/likamrat/wire/releases/tag/${tag}`,
                body,published_at:new Date().toISOString(),prerelease:false,draft:false}));
        };
        if (discoveryOnly) {
            await publish("v1.0.0", base, "Installed fixture release.");
            const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
            try {
                const settings = await browser.newPage(), peer = await browser.newPage();
                const actions = [], navigations = [];
                for (const page of [settings, peer]) page.on("request", r => {
                    if (r.url() === url + "api/app-update") actions.push(r.postDataJSON().action);
                    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigations.push(r.url());
                });
                await Promise.all([settings.goto(url + "settings"), peer.goto(url + "settings")]);
                for (const page of [settings, peer]) {
                    await expect(page.locator("#appUpdateVersion")).toHaveText("WIRE v1.0.0");
                    await expect(page.locator("#appUpdateStatus")).toContainText("Up to date. Last checked");
                    await expect(page.locator("#appUpdateNotice")).toBeHidden();
                }
                assert.ok(actions.includes("auto-check"));
                await writeFile(path.join(origin, "docs", "README.md"), guideText("Next stable guide."));
                await git(origin, "commit", "-qam", "Fixture guide change");
                await publish("v1.0.1", await git(origin, "rev-parse", "HEAD"), "Revised release guidance.");
                const published = performance.now();
                await expect(settings.locator("#appUpdateNotice")).toBeVisible({ timeout: 310000 });
                for (const page of [settings, peer]) {
                    await expect(page.locator("#appUpdateHeading")).toHaveText("WIRE v1.0.1 is available");
                    await expect(page.locator("#appUpdateStatus")).toHaveText("WIRE v1.0.1 is available.");
                    await expect(page.locator("#settingsAppUpdate")).toBeEnabled();
                }
                assert.ok(actions.every(action => action === "status" || action === "auto-check"));
                assert.equal(navigations.length, 2);
                assert.equal(await readFile(path.join(temp, "feed-reads"), "utf8"), "read\nread\n", "tabs share one feed read per check");
                assert.equal((await health()).runtimeId, original.runtimeId);
                t.diagnostic(`Published after both tabs showed current; both showed the new release without input or navigation after ${Math.round(performance.now() - published)} ms.`);
            } finally { await browser.close(); }
            return;
        }
        await writeFile(path.join(origin,"lib","fixture-release.mjs"),"export const version = 1;\n");
        await git(origin,"add","."); await git(origin,"commit","-qm","Fixture starter update");
        const starter = await git(origin,"rev-parse","HEAD");
        await publish("v1.1.0",starter,"### Changed\n- Starter version.");
        await update("preferences",{enabled:false}); await applyTip();
        const prior = await health();
        assert.equal((await update("status")).installedRelease.tag,"v1.1.0");
        await post("api/app-update/release-panel",{});
        const secondRoot = path.join(temp,"second"), secondStore = path.join(temp,"second-store");
        await git(temp,"clone","--quiet",origin,secondRoot);
        await exec(process.execPath,[npm,"ci","--include=dev"],{cwd:secondRoot,env});
        await exec(process.execPath,[npm,"run","build"],{cwd:secondRoot,env});
        independent = fork(path.join(secondRoot,"scripts/launch.mjs"),["--port","0"],{cwd:secondRoot,env:{...env,WORKIQ_EVIDENCE_DATA_DIR:secondStore,
            NODE_OPTIONS:"--import="+await originHook(secondRoot,"second-origin.mjs")},execArgv:[],stdio:["ignore","pipe","pipe","ipc"]});
        independentExit = new Promise(resolve=>independent.once("exit",resolve));
        let output=""; independent.stdout.on("data",bytes=>output+=bytes);
        const otherUrl=await until(()=>output.match(/ready at (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1]);
        const secondHealth=()=>fetch(otherUrl+"health").then(r=>r.json()), beforeSecond=await secondHealth();
        const edge=await chromium.launch({channel:"msedge"});t.after(()=>edge.close());
        let peer;
        if (sleepingGuide) {
            // Playwright normally forces every target to be focused. A background target
            // in the native default context can actually freeze instead.
            const profile=path.join(temp,"sleeping-browser");
            const proc=spawn(chromium.executablePath(),["--remote-debugging-port=0","--remote-debugging-address=127.0.0.1",
                `--user-data-dir=${profile}`,"--headless=new","--disable-background-networking","--no-first-run","about:blank"],{stdio:"ignore"});
            const exited=new Promise(resolve=>proc.once("exit",resolve));
            let chrome;
            closeNativeBrowser=async()=>{
                if (chrome?.isConnected()) {
                    const cdp=await chrome.newBrowserCDPSession();
                    await cdp.send("Browser.close").catch(()=>{});await chrome.close();
                }
                if(proc.exitCode===null)proc.kill();
                await exited;
            };
            const port=await until(async()=>readFile(path.join(profile,"DevToolsActivePort"),"utf8").then(s=>s.split("\n")[0],
                e=>{if(e.code!=="ENOENT")throw e;return null}),10000);
            chrome=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});peer=chrome.contexts()[0];
        } else {
            const chrome=await chromium.launch();t.after(()=>chrome.close());peer=await chrome.newContext();
        }
        const first=await edge.newContext();
        for(const c of [first,peer]) await c.route("**/*",r=>[new URL(url).origin,new URL(otherUrl).origin].includes(new URL(r.request().url()).origin)?r.continue():r.abort());
        const settings=await first.newPage(), guide=await (sleepingGuide?peer:first).newPage(), reports=await peer.newPage(), separate=await peer.newPage();
        await Promise.all([settings.goto(url+"settings"),guide.goto(url+"documentation#reading-updates"),
            reports.goto(url+"reports?bundle="+bundle.bundleId),separate.goto(otherUrl+"settings")]);
        const participants=[settings,guide,reports];
        for(const p of [...participants,separate]) await expect(p.locator("#appUpdateAuto")).toBeEnabled();
        await expect(guide.locator(".docs-article")).toContainText("Installed guide before update.");
        await expect(reports.locator("#savedReportReader h1")).toBeVisible();
        const reportTitle=await reports.locator("#savedReportReader h1").textContent();
        const lifecycle = sleepingGuide && await guide.context().newCDPSession(guide);
        async function freezeGuide() {
            await reports.bringToFront();
            await expect.poll(()=>guide.evaluate(()=>document.visibilityState)).toBe("hidden");
            const frozen=guide.waitForEvent("console",{predicate:m=>m.text()==="fixture: trusted freeze",timeout:5000});
            await guide.evaluate(()=>document.addEventListener("freeze",e=>{
                if(e.isTrusted) console.log("fixture: trusted freeze");
            },{once:true}));
            await lifecycle.send("Page.setWebLifecycleState",{state:"frozen"});
            await frozen;
        }
        await writeFile(path.join(origin,"docs","README.md"),guideText("Revised release guidance."));
        await writeFile(path.join(origin,"docs","images","example.svg"),guideImage(64));
        await git(origin,"commit","-qam","Guide and illustration only");
        const tip=await git(origin,"rev-parse","HEAD");
        const check=settings.getByRole("button",{name:"Check for updates",exact:true});
        await check.click(); await expect(settings.locator("#appUpdateStatus")).toContainText("Up to date.");
        await publish("v1.1.1",tip,"## What's new in v1.1.1\n\n### Changed\n- Revised release guidance.");
        await writeFile(path.join(origin,"docs","README.md"),guideText("Not released yet."));
        await git(origin,"commit","-qam","Unreleased next edit");
        await check.click(); await expect(settings.locator("#appUpdateHeading")).toHaveText("WIRE v1.1.1 is available");
        await settings.locator("#noticeReleaseNotes").click();
        await expect(settings.locator("#releaseNotesBody")).toContainText("Revised release guidance.");
        await expect(settings.locator("#releaseReaderGitHub")).toHaveAttribute("href","https://github.com/likamrat/wire/releases/tag/v1.1.1");
        await settings.goBack(); await settings.locator("#appUpdateDismiss").click();
        await expect(settings.locator("#appUpdateNotice")).toBeHidden();
        const destinations=participants.map(p=>p.url()), starts=stdout.match(/WIRE ready at /g).length;
        const awake = sleepingGuide ? [settings,reports] : participants;
        let wakeNavigation;
        if (lifecycle) {
            // Observe the new document response; WIRE consumes and removes its bootstrap element.
            guide.on("response",response=>{
                if (response.request().isNavigationRequest() && response.request().frame()===guide.mainFrame()) wakeNavigation=response;
            });
            await freezeGuide();
        }
        const applied = settings.waitForResponse(r=>r.url()===url+"api/app-update" && r.request().postDataJSON()?.action==="apply");
        await settings.locator("#settingsAppUpdate").click();
        await Promise.all(awake.map(p=>expect(p.getByRole("dialog",{name:"WIRE is updating"})).toBeVisible()));
        await expect(separate.locator("#appUpdateFence")).toBeHidden();
        try {
            const decision=await applied;
            assert.equal(decision.status(),200,await decision.text());
            await Promise.all(awake.map(p=>expect(p.locator("#appUpdateHeading")).toHaveText("WIRE updated to v1.1.1",{timeout:120000})));
        } finally {
            if (lifecycle) {
                await lifecycle.send("Page.setWebLifecycleState",{state:"active"});
                await guide.bringToFront();
            }
        }
        const after=await health();
        if (lifecycle) {
            await expect(guide.locator("#appUpdateVersion")).toHaveText("WIRE v1.1.1");
            assert.ok(wakeNavigation,"the frozen view loaded a fresh document on wake");
            const bootstrap = JSON.parse((await wakeNavigation.text()).match(/id="wireBootstrap"[^>]*>([^<]+)<\/script>/)[1]);
            assert.equal(bootstrap.accessBootstrap.runtimeId,after.runtimeId);
            await expect(guide.locator("#appUpdateNotice")).toBeHidden();
        }
        assert.deepEqual(participants.map(p=>p.url()),destinations);
        assert.equal(after.build,tip); assert.notEqual(after.runtimeId,prior.runtimeId);
        assert.equal(after.clientEntry,prior.clientEntry,"docs-only update can reuse the identical browser bundle");
        assert.equal(stdout.match(/WIRE ready at /g).length,starts+1);
        assert.deepEqual(await secondHealth(),beforeSecond);
        await expect(guide.locator(".docs-article")).toContainText("Revised release guidance.");
        await expect.poll(()=>guide.locator('.docs-article img').evaluate(n=>n.naturalWidth)).toBe(64);
        await expect(reports.locator("#savedReportReader h1")).toHaveText(reportTitle);
        await expect(settings.locator("#appUpdateVersion")).toHaveText("WIRE v1.1.1");
        await verifyPreserved();
        if (sleepingGuide) {
            await publish("v1.1.2",await git(origin,"rev-parse","HEAD"),"### Changed\n- Another guide change.");
            await guide.bringToFront();
            await guide.goto(url+"settings?section=connection");
            await expect(guide.locator("#workspace")).toHaveAttribute("aria-busy","false");
            await guide.locator("#collectionWindow-control").click();
            await guide.locator('.select-popup [role=option][data-value="7"]').click();
            await expect(guide.locator("#cancelSource")).toBeVisible();
            await check.click();await expect(settings.locator("#appUpdateStatus")).toContainText("v1.1.2");
            await freezeGuide();
            try {
                const refused=settings.waitForResponse(r=>r.url()===url+"api/app-update" && r.request().postDataJSON()?.action==="apply");
                await settings.locator("#settingsAppUpdate").click();
                const response=await refused;
                assert.equal(response.status(),409);
                assert.match((await response.json()).error,/did not answer/);
                assert.deepEqual(await health(),after);
            } finally { await lifecycle.send("Page.setWebLifecycleState",{state:"active"}); }
            await guide.bringToFront();
            await expect(guide.locator("#collectionWindow")).toHaveValue("7");
            await expect(guide.locator("#cancelSource")).toBeVisible();
            await verifyPreserved();
        }
        t.diagnostic(`Edge and Chromium: one docs-only release restart across three pages${sleepingGuide ? ", including a natively frozen Guide verified after wake" : ""}, same browser bundle, unchanged second instance and saved report.`);
        return;
    }
    if (process.env.WIRE_UPDATE_BROWSER === "reloaded") {
        const { chromium, expect } = await import("@playwright/test");
        await update("status");
        await post("api/app-update/release-panel", {});
        const windows = process.platform === "win32";
        const browser = await chromium.launch({ channel: windows ? "msedge" : undefined, headless: false });
        try {
            const context = await browser.newContext();
            await context.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
            const settings = await context.newPage();
            const devtools = await context.newCDPSession(settings);
            const { targetInfo } = await devtools.send("Target.getTargetInfo");
            const nextPage = context.waitForEvent("page");
            const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank", newWindow: true, browserContextId: targetInfo.browserContextId });
            const analyze = await nextPage;
            assert.notEqual((await devtools.send("Browser.getWindowForTarget")).windowId,
                (await devtools.send("Browser.getWindowForTarget", { targetId })).windowId);
            await Promise.all([settings.goto(url + "settings?section=general"), analyze.goto(url + "?range=14&from=2026-09-24&to=2026-10-07")]);
            await expect(settings.locator("#appUpdateCheck")).toBeEnabled();
            await expect(analyze.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            app.disconnect(); await ended;
            launch(new URL(url).port);
            await until(() => stdout.includes("ready at " + url));
            const starter = await health();
            assert.notEqual(starter.runtimeId, original.runtimeId);
            // Delay delivery of a real snapshot while the starter's Analyze document reloads.
            const snapshot = Promise.withResolvers(), depart = Promise.withResolvers();
            await analyze.route("**/api/snapshot", async route => {
                try { await route.fetch(); snapshot.resolve(); } catch (error) { snapshot.reject(error); }
                await depart.promise;
                await route.abort().catch(() => {}); // The document has left.
            }, { times: 1 });
            try {
                await Promise.all([settings.reload(), analyze.reload({ waitUntil: "commit" }), snapshot.promise]);
                await expect(analyze.locator("#workspace")).toHaveAttribute("aria-busy", "true");
                await expect(analyze.locator("#appUpdateAuto")).toBeEnabled();
                await analyze.reload();
            } finally { depart.resolve(); }
            await expect(analyze.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            const check = settings.getByRole("button", { name: "Check for updates" });
            await expect(check).toBeEnabled();
            // The server registered this document, but it leaves before its first update status arrives.
            const joining = await context.newPage(), registered = Promise.withResolvers(), resume = Promise.withResolvers();
            await joining.route("**/api/app-update", async route => {
                try {
                    const response = await route.fetch();
                    registered.resolve(response.status()); await resume.promise;
                    await route.fulfill({ response }).catch(() => {}); // Its document may have left.
                } catch (error) { registered.reject(error); }
            }, { times: 1 });
            try {
                await joining.goto(url + "settings");
                assert.equal(await registered.promise, 200);
                await joining.reload();
            } finally { resume.resolve(); }
            await expect(joining.locator("#appUpdateAuto")).toBeEnabled();
            await joining.close({ runBeforeUnload: true });
            await appendFile(path.join(origin, "web", "browser-entry.mjs"), '\ndocument.documentElement.dataset.wireFixtureBuild = "updated";\n');
            await git(origin, "commit", "-qam", "Fixture update for reloaded windows");
            await check.click();
            const install = settings.locator("#settingsAppUpdate");
            await expect(install).toBeEnabled({ timeout: 12000 });
            const tip = await git(origin, "rev-parse", "HEAD");
            const destinations = [settings.url(), analyze.url()];
            assert.equal(new URL(destinations[0]).pathname, "/settings");
            assert.equal(new URL(destinations[1]).pathname, "/");
            await expect(analyze.locator("#workspace")).toBeVisible();
            await expect(analyze).toHaveTitle("Analyze | WIRE");
            assert.equal((await health()).runtimeId, starter.runtimeId);
            await expect(analyze.getByRole("dialog", { name: "WIRE is updating" })).toHaveCount(0);
            const applyResponse = () => settings.waitForResponse(r => r.url() === url + "api/app-update" && r.request().postDataJSON()?.action === "apply");
            // The peer received the offer, but the server did not receive its acknowledgment.
            await analyze.route("**/api/app-update/readiness", route => route.abort(), { times: 1 });
            const refused = applyResponse();
            await install.click();
            for (const page of [settings, analyze]) {
                await expect(page.getByRole("dialog", { name: "WIRE is updating" })).toBeVisible();
                await expect(page.locator("#appUpdateHint")).toHaveText("This tab reloads automatically.");
            }
            const refusal = await refused;
            assert.equal(refusal.status(), 409);
            const { error } = await refusal.json();
            assert.match(error, /did not confirm it was ready/);
            await expect(settings.locator("#appUpdateStatus")).toContainText(error);
            await expect(analyze.locator("#appUpdateNotice")).toBeVisible({ timeout: 12000 });
            await expect(analyze.locator("#appUpdateDetail")).toHaveText(error);
            assert.equal((await health()).runtimeId, starter.runtimeId);
            const applied = applyResponse();
            await install.click();
            const response = await applied;
            assert.equal(response.status(), 200, (await response.json()).error);
            const updated = `WIRE updated to v${pkg.version}`;
            for (const page of [settings, analyze]) {
                const notice = page.getByRole("complementary", { name: updated });
                await expect(notice.getByRole("status")).toHaveText(updated, { timeout: 120000 });
                await expect(notice.locator('[data-icon-role="result-success"]')).toBeVisible();
                await expect(notice.getByRole("button")).toHaveCount(1);
            }
            assert.deepEqual([settings.url(), analyze.url()], destinations);
            await expect(settings.locator('[data-settings-section="general"]')).toBeVisible();
            await expect(analyze).toHaveTitle("Analyze | WIRE");
            await expect(analyze.locator("#workspace")).toBeVisible();
            const after = await health();
            assert.equal(after.build, tip); assert.notEqual(after.runtimeId, starter.runtimeId);
            assert.notEqual(after.clientEntry, starter.clientEntry);
            for (const page of [settings, analyze]) await expect(page.locator("html")).toHaveAttribute("data-wire-fixture-build", "updated");
            await expect(settings.locator("#appUpdateAuto")).toBeChecked();
            assert.equal(stdout.match(/WIRE ready at /g).length, 2, "starter and exactly one activation");
            await settings.getByRole("link", { name: "Change theme" }).click();
            const notice = settings.locator("#appUpdateNotice"), dismiss = notice.getByRole("button", { name: "Dismiss" });
            const proof = process.env.WIRE_APP_UPDATE_PROOFS;
            for (const palette of Object.keys(palettes)) {
                await settings.locator(`label:has(#palette-${palette})`).click();
                for (const theme of ["light", "dark"]) {
                    await chooseTheme(settings, theme);
                    const surface = await notice.evaluate(n => getComputedStyle(n).backgroundColor);
                    const rail = await settings.locator("#sidebar").evaluate(n => getComputedStyle(n).backgroundColor);
                    const text = await notice.getByRole("status").evaluate(n => getComputedStyle(n).color);
                    const button = await dismiss.evaluate(measureControlSurface);
                    const label = contrast(text, surface), close = contrast(button.ink, button.face), boundary = contrast(surface, rail);
                    assert.ok(label >= 4.5 && close >= 4.5 && boundary >= 3, `${palette} ${theme}: text ${label}, dismiss ${close}, rail ${boundary}`);
                    if (proof) t.diagnostic(`${palette} ${theme}: text ${label.toFixed(2)}, dismiss ${close.toFixed(2)}, rail ${boundary.toFixed(2)}.`);
                }
            }
            await settings.getByRole("button", { name: "Back to General" }).click();
            if (proof) {
                await mkdir(proof, { recursive: true });
                await settings.screenshot({ path: path.join(proof, "updated-settings-desktop.png") });
                await analyze.screenshot({ path: path.join(proof, "updated-analyze-desktop.png") });
                await chooseTheme(settings, "light");
                await settings.screenshot({ path: path.join(proof, "updated-settings-light.png") });
                await chooseTheme(settings, "dark");
            }
            await settings.setViewportSize({ width: 390, height: 844 });
            await notice.scrollIntoViewIfNeeded();
            assert.ok(await dismiss.evaluate(n => n.getBoundingClientRect().right <= innerWidth));
            if (proof) await settings.screenshot({ path: path.join(proof, "updated-settings-narrow.png") });
            for (const page of [settings, analyze]) {
                const close = page.locator("#appUpdateDismiss");
                await close.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
                await expect(close).toBeFocused();
                await page.keyboard.press("Enter");
                await expect(page.locator("#appUpdateNotice")).toBeHidden();
                await expect(page.locator(page === settings ? "#appUpdateCheck" : "#pageTitle")).toBeFocused();
                await page.reload(); await expect(page.locator("#appUpdateAuto")).toBeEnabled();
                await expect(page.locator("#appUpdateNotice")).toBeHidden();
            }
            cap = await getPage();
            assert.ok(await post("api/report/open", { bundleId: bundle.bundleId }));
            await verifyPreserved();
            t.diagnostic(`${windows ? "Microsoft Edge Stable" : "Chromium"} ${browser.version()}, two windows at ${url}: one refusal, one restart; both destinations and the original store preserved.`);
        } finally { await browser.close(); }
        return;
    }
    await writeFile(path.join(origin, "lib", "update-proof-marker.mjs"), "export const marker = 'updated';\n");
    await git(origin, "add", "."); await git(origin, "commit", "-qm", "Fixture app change");
    if (handsOn) {
        const target = await git(origin, "rev-parse", "HEAD");
        assert.ok((await update("status")).supported, "Use Windows or WSL for the hands-on update simulation.");
        await update("preferences", { enabled: false });
        await post("api/app-update/release-panel", {});
        console.log(`Disposable update simulation: ${url}settings\nOpen this address in one tab. Choose Check for updates, then Update and restart. `
            + `You can dismiss the notice first. Expect build ${target.slice(0, 8)} at the same address. This copy waits 20 minutes.`);
        await until(async () => {
            let h; try { h = await health(); } catch { return false; }
            return h.build === target && h.runtimeId !== original.runtimeId;
        }, 20 * 60000, 1000);
        cap = await getPage();
        const state = await until(async () => {
            const current = await update("status");
            return current.phase === "current" && current.installed === target && current;
        });
        assert.equal(state.clientEntry, (await health()).clientEntry);
        assert.ok(await post("api/report/open", { bundleId: bundle.bundleId }));
        await verifyPreserved();
        console.log(`Running build ${target.slice(0, 8)}. Saved report verified; files and paused source settings unchanged. `
            + "You have two minutes to inspect Reports before this disposable copy closes.");
        await delay(120000);
        return;
    }
    async function applyTip() {
        const before = await health(), next = await git(origin, "rev-parse", "HEAD");
        assert.equal((await update("check")).candidate, next);
        assert.equal((await update("apply", { candidate: next })).phase, "preparing");
        await until(async () => {
            let h; try { h = await health(); } catch { return false; }
            if (h.build === next) return h.runtimeId !== before.runtimeId;
            let s; try { s = await update("status"); } catch { return false; }
            if (s.phase === "error") throw Error(s.message); return false;
        });
        cap = await getPage();
        return until(async () => {
            try { const s = await update("status"); return s.phase === "current" && s.installed === next && s; }
            catch { return false; }
        });
    }
    await applyTip();
    await writeFile(path.join(origin, "lib", "update-proof-marker.mjs"), "export const marker = 'second update';\n");
    await git(origin, "commit", "-qam", "Fixture second application change");
    const current = await applyTip();
    assert.equal(current.clientEntry, (await health()).clientEntry);
    const asset = await fetch(new URL(current.clientEntry, url)); assert.equal(asset.status, 200); await asset.arrayBuffer();
    const opened = await post("api/report/open", { bundleId: bundle.bundleId });
    assert.ok(opened);
    if (process.env.WIRE_UPDATE_BROWSER === "1") {
        await post("api/app-update/release-panel", {});
        const { chromium, expect } = await import("@playwright/test");
        const slots = async directory => (await readdir(path.join(directory, ".git", "wire-updates"), { withFileTypes: true }))
            .filter(entry => entry.isDirectory()).length;
        const windows = process.platform === "win32";
        const browser = await chromium.launch(windows ? { channel: "msedge", headless: false } : {});
        t.diagnostic(`${windows ? "Microsoft Edge Stable" : "Chromium"} ${browser.version()}`);
        try {
            const browsing = await browser.newContext(), page = await browsing.newPage();
            const applyAttempts = [];
            const recordApply = request => {
                if (request.url() === url + "api/app-update" && request.postDataJSON()?.action === "apply") applyAttempts.push(request);
            };
            page.on("request", recordApply);
            const independentRoot = path.join(temp, "independent"), independentStore = path.join(temp, "independent-store");
            await git(temp, "clone", "-q", origin, independentRoot);
            await exec(process.execPath, [npm, "ci", "--include=dev"], { cwd: independentRoot, env });
            await exec(process.execPath, [npm, "run", "build"], { cwd: independentRoot, env });
            independent = fork(path.join(independentRoot, "scripts/launch.mjs"), ["--port", "0"], {
                cwd: independentRoot, env: { ...env, WORKIQ_EVIDENCE_DATA_DIR: independentStore,
                    NODE_OPTIONS: "--import=" + await originHook(independentRoot, "other-origin.mjs") }, execArgv: [], stdio: ["ignore","pipe","pipe","ipc"] });
            independentExit = new Promise(resolve => independent.once("exit", resolve));
            let announcement = "";
            independent.stdout.on("data", bytes => { announcement += bytes; });
            const otherUrl = await until(() => announcement.match(/ready at (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1]);
            const separate = await browsing.newPage(), independentHealth = () => fetch(otherUrl + "health").then(r => r.json());
            await separate.goto(otherUrl + "settings");
            await expect(separate.locator("#appUpdateAuto")).toBeEnabled();
            const independentBefore = await independentHealth();
            assert.notEqual(otherUrl, url); assert.notEqual(independentBefore.runtimeId, original.runtimeId);
            page.on("requestfailed", req => {
                if (req.resourceType() === "script") t.diagnostic(`Script request failed: ${new URL(req.url()).pathname} (${req.failure()?.errorText})`);
            });
            const alias = new URL(url); alias.hostname = "localhost";
            await browsing.route("**/*", route => (new URL(route.request().url()).origin === new URL(url).origin
                || route.request().isNavigationRequest() && route.request().url() === alias.href)
                ? route.continue() : route.abort());
            // A clean Settings page can reload even while a manual read-only check is in flight.
            let firstCheck = true;
            const readStarted = Promise.withResolvers(), finishRead = Promise.withResolvers();
            const slowOpeningCheck = async route => {
                if (!firstCheck || route.request().postDataJSON()?.action !== "check") return route.fallback();
                firstCheck = false;
                const response = await route.fetch();
                readStarted.resolve(); await finishRead.promise;
                await route.fulfill({ response }).catch(() => {}); // The original document left.
            };
            await page.route("**/api/app-update", slowOpeningCheck);
            await page.goto(url + "settings?section=general");
            await expect(page.locator("#settingsView")).toBeVisible();
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await page.getByRole("button", { name: "Check for updates" }).click();
            await readStarted.promise;
            try { await page.reload(); } finally { finishRead.resolve(); }
            await page.unroute("**/api/app-update", slowOpeningCheck);
            const check = page.getByRole("button", { name: "Check for updates" });
            await expect(check).toBeEnabled({ timeout: 30000 });
            const heading = page.locator("#appUpdateVersion"), status = page.locator("#appUpdateStatus");
            const before = await health();
            await expect(heading).toHaveText(`WIRE v${pkg.version}`);
            await expect(page.getByRole("switch", { name: "Automatically check for updates" })).toBeChecked();
            const peerContext = await browser.newContext();
            await peerContext.route("**/*", r => new URL(r.request().url()).origin === new URL(url).origin ? r.continue() : r.abort());
            const other = await peerContext.newPage();
            other.on("request", recordApply);
            await other.goto(url + "settings");
            const otherCheck = other.getByRole("button", { name: "Check for updates" });
            await expect(other.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await other.route("**/api/app-update", async route => {
                if (route.request().postDataJSON()?.action !== "check") return route.fallback();
                const response = await route.fetch();
                await delay(4000);
                await route.fulfill({ response });
            });
            const completed = other.waitForResponse(r => r.url() === url + "api/app-update" && r.request().postDataJSON()?.action === "check");
            await otherCheck.click();
            await other.emulateMedia({ reducedMotion: "reduce" });
            await expect(other.locator("#appUpdateCheck .update-spinner")).toHaveCSS("animation-name", "none");
            assert.equal((await (await completed).json()).phase, "current");
            await expect(otherCheck).toBeEnabled({ timeout: 2000 });
            await other.unroute("**/api/app-update");
            await page.bringToFront();
            await appendFile(path.join(origin, "web", "browser-entry.mjs"), '\ndocument.documentElement.dataset.wireFixtureBuild = "updated";\n');
            await git(origin, "commit", "-qam", "Fixture update from browser");
            const tip = await git(origin, "rev-parse", "HEAD");
            const checked = page.waitForResponse(response => response.url() === url + "api/app-update"
                && response.request().postDataJSON().action === "check");
            const checkBox = await check.boundingBox();
            const checkStarted = performance.now();
            await check.click();
            await expect(status).toHaveText("Checking for updates");
            const pending = page.getByRole("button", { name: "Checking", exact: true });
            await expect(pending.locator(".update-spinner")).toBeVisible();
            const rotation = () => pending.locator(".update-spinner").evaluate(n => getComputedStyle(n).transform);
            await expect.poll(rotation).not.toBe(await rotation());
            assert.deepEqual(await pending.boundingBox(), checkBox);
            const offer = await (await checked).json();
            assert.equal(offer.installed, before.build); assert.equal(offer.candidate, tip);
            await expect(status).toHaveText("Update available.");
            assert.ok(performance.now() - checkStarted >= 3000);
            const action = { name: "Update and restart", exact: true };
            await expect(page.locator("#appUpdateNotice").getByRole("button", action)).toBeVisible();
            await expect(check).toBeHidden();
            const adapter = createRuntimeClient(new URL(url).origin, { requireEnforced: true });
            await adapter.open("fixture-adapter");
            const extra = await browsing.newPage();
            await extra.goto(alias.href);
            assert.equal(new URL(extra.url()).origin, new URL(url).origin);
            await expect(extra.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await expect(extra.locator("#appUpdateCheck")).toBeEnabled();
            await extra.goto(url + "settings");
            await expect(extra.locator("#appUpdateAuto")).toBeEnabled();
            await expect(extra.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await extra.close({ runBeforeUnload: true });
            await fetch(url + "settings").then(r => r.text()); // A document fetched but never mounted.
            await other.locator('#settingsCategoryNav [data-category="connection"]').click();
            // An actual unsaved source edit is the Settings work that blocks the update.
            const otherSessions = other.locator("#sourceSessions");
            await otherSessions.fill(await otherSessions.inputValue() + "-unsaved");
            if (process.env.WIRE_APP_UPDATE_PROOFS) {
                await mkdir(process.env.WIRE_APP_UPDATE_PROOFS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.WIRE_APP_UPDATE_PROOFS, "windows-settings-offer.png"), animations: "disabled" });
            }
            const refused = page.waitForResponse(r => r.url() === url + "api/app-update" && r.request().postDataJSON()?.action === "apply");
            await page.locator("#appUpdateNotice").getByRole("button", action).click();
            const refusal = await refused;
            assert.equal(refusal.status(), 409);
            const { error, code } = await refusal.json();
            assert.equal(code, "wire_update_blocked");
            assert.match(error, /Settings edit/);
            await expect(status).toContainText(error);
            await expect(other.locator("#appUpdateDetail")).toHaveText(error);
            await expect(other.locator("#cancelSource")).toBeVisible();
            await expect(page.locator("#appUpdateNotice")).toBeHidden();
            assert.equal((await health()).build, before.build);
            await other.locator("#cancelSource").click();
            await other.locator('#settingsCategoryNav [data-category="general"]').click();
            await otherCheck.click();
            const peerInstall = other.locator(".app-version-card").getByRole("button", action);
            await expect(peerInstall).toBeEnabled({ timeout: 30000 });
            const activationsBefore = stdout.match(/WIRE ready at /g).length;
            const slotsBefore = await slots(root);
            const applied = page.waitForRequest(request => request.url() === url + "api/app-update" && request.postDataJSON().action === "apply");
            // Dispatch gestures in the same turn across separate browser contexts.
            await Promise.all([page.locator(".app-version-card").getByRole("button", action), peerInstall]
                .map(button => button.evaluate(node => node.click())));
            assert.equal((await applied).postDataJSON().candidate, tip);
            await expect(page.locator("#appUpdateFence")).toBeVisible();
            await expect(page.locator("#appUpdateNotice")).toBeHidden();
            await expect(other.locator("#appUpdateFence")).toBeVisible();
            await until(async () => {
                const text = await status.innerText().catch(() => "");
                if (text.startsWith("Update not installed")) throw Error(text);
                return (await health().catch(() => null))?.build === tip;
            });
            for (const window of [page, other]) await expect(window.locator("#appUpdateNotice").getByRole("status"))
                .toHaveText(`WIRE updated to v${pkg.version}`, { timeout: 120000 });
            await expect(other.locator("#appUpdateCheck")).toBeEnabled();
            assert.equal(await other.locator("html").getAttribute("data-wire-fixture-build"), "updated");
            const after = await health();
            assert.equal(after.build, tip); assert.notEqual(after.runtimeId, before.runtimeId);
            assert.notEqual(after.clientEntry, before.clientEntry);
            await expect(heading).toHaveText(`WIRE v${pkg.version}`);
            await expect(status).toContainText("Up to date. Last checked");
            await expect(check).toBeEnabled();
            await expect(page.getByRole("button", action)).toHaveCount(0);
            assert.equal(await page.locator("html").getAttribute("data-wire-fixture-build"), "updated");
            assert.equal(new URL(page.url()).origin, new URL(url).origin);
            assert.equal(new URL(other.url()).origin, new URL(url).origin);
            assert.equal(stdout.match(/WIRE ready at /g).length, activationsBefore + 1);
            assert.equal(await slots(root), slotsBefore + 1);
            assert.equal(applyAttempts.length, 3, "one refused gesture, then two gestures for one activation");
            assert.equal((await independentHealth()).runtimeId, independentBefore.runtimeId);
            await expect(separate.locator("#appUpdateFence")).toBeHidden();
            await expect(separate.locator("#appUpdateCheck")).toBeEnabled();
            assert.equal(await slots(independentRoot), 0);
            await assert.rejects(adapter.action("fixture-adapter", "get_summary", {}), { code: "WIRE_CANVAS_BINDING_CHANGED" });
            t.diagnostic(`Two Edge views, one restart at ${new URL(url).origin}: ${before.build} → ${after.build}. Independent ${new URL(otherUrl).origin} stayed on ${independentBefore.build}.`);
        } finally { await browser.close(); }
        cap = await getPage();
        assert.ok(await post("api/report/open", { bundleId: bundle.bundleId }));
    }
    await verifyPreserved();
});
