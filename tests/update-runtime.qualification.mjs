import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./helpers.mjs";
import { replaceEvidence, loadBoardState } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { createRuntimeClient } from "../lib/runtime-client.mjs";
import pkg from "../package.json" with { type: "json" };

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const handsOn = process.env.WIRE_UPDATE_BROWSER === "manual";
// Slow by design: install locked dependencies and build two full copies of WIRE,
// not a replacement server or mock health endpoint. Use only a synthetic source.
test("full WIRE clone updates on the original address and reopens the same saved report", { timeout: handsOn ? 25 * 60000 : 300000 }, async t => {
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
    let app, ended, independent, independentExit, stderr = "", stdout = "";
    t.after(async () => {
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
    // Only committed source is an eligible integration input. No ignored assets,
    // working directories, Git credentials, node_modules, or private data.
    const tracked = (await git(project, "ls-files", "-z", "--cached")).split("\0").filter(Boolean);
    for (const name of tracked.filter(name => /^(?:lib|scripts|assets|web)\//.test(name)
        || [".gitignore","package.json","package-lock.json","vite.config.mjs","tsconfig.json","extension.mjs"].includes(name))) {
        const target = path.join(origin, name);
        await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(project, name), target);
    }
    await git(origin, "init", "-qb", "main"); await git(origin, "add", "."); await git(origin, "commit", "-qm", "Fixture baseline");
    const base = await git(origin, "rev-parse", "HEAD");
    await git(temp, "clone", "--quiet", origin, root);
    const npm = process.env.npm_execpath;
    assert.ok(npm && path.isAbsolute(npm), "Run via npm run test:update-runtime");
    await exec(process.execPath, [npm, "ci", "--include=dev"], { cwd: root, env });
    await exec(process.execPath, [npm, "run", "build"], { cwd: root, env });

    const context = { dataDir: store };
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
        const seam = `import {createUpdateSource} from ${JSON.stringify(sourceURL)};
        export const {inspectInstallation,checkMain,stageMain}=createUpdateSource({fixtureRemote:${JSON.stringify(origin)}});`;
        const hook = path.join(temp, name);
        await writeFile(hook, `import{registerHooks}from'node:module';registerHooks({resolve(s,c,next){
        if(c.parentURL===${JSON.stringify(pathToFileURL(path.join(installation, "lib", "update-launch.mjs")).href)}&&s==="./update-source.mjs")
        return {url:${JSON.stringify("data:text/javascript," + encodeURIComponent(seam))},shortCircuit:true};return next(s,c)}});`);
        return pathToFileURL(hook).href;
    }
    app = fork(path.join(root, "scripts/launch.mjs"), ["--port","0"], {
        cwd: root, env: { ...env, NODE_OPTIONS: "--import=" + await originHook(root, "fixture-origin.mjs") }, execArgv: [], stdio: ["ignore","pipe","pipe","ipc"] });
    app.stdout.on("data", data => { stdout += data; }); app.stderr.on("data", data => { stderr += data; });
    ended = new Promise(resolve => app.once("exit", resolve));
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
    await writeFile(path.join(origin, "lib", "update-proof-marker.mjs"), "export const marker = 'updated';\n");
    await git(origin, "add", "."); await git(origin, "commit", "-qm", "Fixture app change");
    async function verifyPreserved() {
        for (const [file, digest] of reportHashes) assert.equal(hash(await readFile(file)), digest);
        assert.deepEqual(await readFile(cfgPath), configBytes);
        assert.equal(await git(root, "rev-parse", "HEAD"), base);
    }
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
            await other.locator('#settingsCategoryNav [data-category="source-access"]').click();
            await other.locator("#reviewSource,#editSource").filter({ visible: true }).first().click();
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
            await expect(page.locator("#appUpdateHeading")).toHaveText("WIRE updated", { timeout: 120000 });
            await expect(other.locator("#appUpdateHeading")).toHaveText("WIRE updated", { timeout: 120000 });
            await expect(other.locator("#appUpdateCheck")).toBeEnabled();
            assert.equal(await other.locator("html").getAttribute("data-wire-fixture-build"), "updated");
            await expect(page.locator("#appUpdateDetail")).toHaveText(`WIRE v${pkg.version} is running.`);
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
