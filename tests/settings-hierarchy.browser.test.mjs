import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { navigateSettings, chooseTheme, selectActivityOption } from "./helpers.mjs";

const proofs = process.env.WIRE_SETTINGS_HIERARCHY_PROOFS;
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: true });
}
async function captureState(page, name) {
    const viewport = page.viewportSize(), currentTheme = await page.locator("html").getAttribute("data-evidence-theme");
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await capture(page, `${name}-${width}-${theme}`);
    }
    await page.setViewportSize(viewport);
    await chooseTheme(page, currentTheme);
}
async function setup(t) {
    const cleanup = [], denied = [], posts = [], errors = [];
    const f = await evaluationFixture({ after: action => cleanup.push(action) });
    await materializeEvaluationSource(f);
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false },
        search: { modelDirectory: path.join(f.context.dataDir, "model-not-provisioned") },
        evaluation: {
            evaluatorFactory: async () => { denied.push("provider"); throw new Error("Settings proof cannot run a model."); },
            readSource: async () => { denied.push("source"); throw new Error("Settings proof cannot read evaluation sources."); },
        },
    });
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined,
        ignoreDefaultArgs: ["--hide-scrollbars"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", hasTouch: true });
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/collection/configure",
            "/api/assessment/consent", "/api/evaluation/automatic/summary"];
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(`${request.method()} ${url.pathname}`);
            return route.abort("blockedbyclient");
        }
        if (request.method() === "POST") posts.push({ path: url.pathname, input: request.postDataJSON() });
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        try { await browser.close(); await runtime.close(); }
        finally { for (const action of cleanup.reverse()) await action(); }
        assert.deepEqual(errors, []);
        assert.deepEqual(denied, []);
    });
    await page.goto(runtime.url + "#settings?section=connection");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    return { ...f, runtime, page, posts };
}

test("Collection keeps automatic reads and preferences separate from approved source paths", async t => {
    const { page, context, posts } = await setup(t);
    const before = await loadBoardState(context);
    await expect(page.locator("#connectionStatus")).toHaveText("Paused");
    await expect(page.locator("#pauseCollection")).toBeVisible();
    await expect(page.getByRole("region", { name: "History and frequency" }).locator("#collectionWindow-control")).toBeVisible();
    await expect(page.locator("#approvedSourceDetails")).toBeHidden();
    await navigateSettings(page, "source-access");
    await expect(page.locator("#approvedDatabase")).toBeVisible();
    await expect(page.locator("#sourceEditor")).toBeHidden();
    await expect(page.locator("#pauseCollection")).toBeHidden();
    assert.deepEqual(await page.locator("#settingsView [aria-describedby], #settingsView [aria-labelledby]").evaluateAll(nodes =>
        nodes.flatMap(node => ["aria-describedby", "aria-labelledby"].flatMap(attribute =>
            (node.getAttribute(attribute) || "").split(/\s+/).filter(id => id && !document.getElementById(id))))), []);
    assert.equal(posts.filter(item => item.path === "/api/collection/configure").length, 0);
    assert.deepEqual(await loadBoardState(context), before);
});

test("preference drafts, pending save, errors and uncertain recovery remain attached to their group", { timeout: 40000 }, async t => {
    const { page, context, runtime, posts } = await setup(t);
    const before = await loadBoardState(context);
    await selectActivityOption(page, "collectionWindow", "7");
    await expect(page.locator("#connectionPreferences #settingsDraftStatus")).toContainText("Unsaved changes");
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await captureState(page, "preferences-dirty");
    await navigateSettings(page, "display");
    await page.goBack();
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await page.locator("#cancelPreferences").click();
    await expect(page.locator("#collectionWindow")).toHaveValue("30");
    assert.equal((await runtime.collector.status()).config.windowDays, 30);
    await selectActivityOption(page, "collectionWindow", "7");
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/collection/configure", async route => { await gate; await route.continue(); }, { times: 1 });
    await page.locator("#saveCollection").click();
    await expect(page.locator("#connectionPreferences #settingsDraftStatus")).toContainText("Saving");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await expect(page.locator("#cancelPreferences")).toBeDisabled();
    await captureState(page, "preferences-pending");
    release();
    await expect(page.locator("#settingsMessage")).toContainText("Preferences saved.");
    assert.equal((await runtime.collector.status()).config.enabled, false);
    assert.equal((await runtime.collector.status()).config.windowDays, 7);
    await selectActivityOption(page, "collectionCadence", "15");
    await page.route("**/api/collection/configure", route => route.fulfill({
        status: 422, json: { error: "Invented preference save rejected; approved source is unchanged." },
    }), { times: 1 });
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Invented preference save rejected");
    await expect(page.locator("#connectionPreferences #cancelPreferences")).toBeEnabled();
    await captureState(page, "preferences-error");
    assert.equal((await runtime.collector.status()).config.pollSeconds, 5);
    await page.locator("#reloadSettings").click();
    await expect(page.locator("#reloadSettings")).toBeHidden();
    await page.locator("#cancelPreferences").click();
    await selectActivityOption(page, "collectionCadence", "15");
    await page.route("**/api/collection/configure", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
    await page.locator("#saveCollection").click();
    await expect(page.locator("#reloadSettings")).toBeVisible();
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await captureState(page, "preferences-uncertain");
    const count = posts.filter(item => item.path === "/api/collection/configure").length;
    await page.locator("#reloadSettings").click();
    await expect(page.locator("#reloadSettings")).toBeHidden();
    assert.equal(posts.filter(item => item.path === "/api/collection/configure").length, count);
    assert.equal((await runtime.collector.status()).config.pollSeconds, 15);
    assert.equal((await runtime.collector.status()).config.enabled, false);
    const after = await loadBoardState(context);
    for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
});
