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
import { chooseTheme, fixture } from "./helpers.mjs";
import { contrast, measureControlSurface } from "./color-measurements.mjs";
import { palettes } from "../web/theme.mjs";
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
    const hook = await originHook(root, "fixture-origin.mjs");
    function launch(port) {
        stdout = ""; stderr = "";
        app = fork(path.join(root, "scripts/launch.mjs"), ["--port", port], {
            cwd: root, env: { ...env, NODE_OPTIONS: "--import=" + hook }, execArgv: [], stdio: ["ignore","pipe","pipe","ipc"] });
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
            const viewCheck = settings.getByRole("button", { name: "Check open views" });
            await analyze.route("**/api/app-update/readiness", route => route.abort(), { times: 1 });
            await viewCheck.click();
            await expect(settings.locator("#appUpdateViewStatus")).toContainText("1 of 2 registered views did not answer", { timeout: 15000 });
            await expect(settings.locator("#appUpdateViewStatus")).toContainText("WIRE sent the check");
            await expect(install).toBeEnabled();
            await viewCheck.click();
            await expect(settings.locator("#appUpdateViewStatus")).toContainText("Both views reported no unfinished work", { timeout: 15000 });
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
