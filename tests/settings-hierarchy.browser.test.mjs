import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { privateFixture, navigateSettings, chooseTheme, selectActivityOption, openSourceEditor } from "./helpers.mjs";

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
async function setup(t, approved = true) {
    const cleanup = [], denied = [], posts = [], errors = [];
    const f = approved ? await evaluationFixture({ after: action => cleanup.push(action) })
        : await privateFixture({ after: action => cleanup.push(action) });
    if (approved) await materializeEvaluationSource(f);
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

test("Settings groups contain their own controls with consistent nearby columns across categories", { timeout: 40000 }, async t => {
    const { page, context, posts } = await setup(t);
    const before = await loadBoardState(context);
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await navigateSettings(page, "connection");
        const source = page.getByRole("region", { name: "Source", exact: true });
        const preferences = page.getByRole("region", { name: "History and frequency", exact: true });
        await expect(source.locator("#connectionStatus")).toHaveText("Paused");
        await expect(source.locator("#viewApprovedSource")).toBeVisible();
        await expect(source.locator("#pauseCollection")).toBeVisible();
        await expect(preferences.locator("#preferenceActions")).toBeVisible();
        await expect(preferences.locator("#saveCollection")).toBeDisabled();
        await expect(preferences.locator("#collectionWindow-control")).toBeVisible();
        await expect(source.locator("#connectionSummary")).toHaveCount(0);
        await expect(preferences.locator("#historyWindowHelp,#collectionPreferenceDetails")).toHaveCount(0);
        for (const selector of ["#sourceEditor", "#approvedSourceDetails", "#settingsDraftStatus", "#freshResult"]) {
            assert.equal(await page.locator(selector).evaluate(node => node.getBoundingClientRect().height), 0,
                `${selector} does not reserve a blank row when inactive`);
        }
        assert.deepEqual(await page.locator('[data-settings-section=connection] > section').evaluateAll(nodes => nodes.map(node => node.id)),
            ["connectionSource", "freshActivity", "connectionPreferences"]);
        const geometry = await preferences.evaluate(root => {
            const box = node => {
                const { x, y, right, bottom } = node.getBoundingClientRect();
                return { x, y, right, bottom };
            };
            return { root: box(root), label: box(root.querySelector(".settings-field > label")),
                history: box(root.querySelector("#collectionWindow-control")), cadence: box(root.querySelector("#collectionCadence-control")),
                actions: box(root.querySelector("#preferenceActions")) };
        });
        assert.ok(Math.abs(geometry.history.x - geometry.cadence.x) <= 1, "Both preference controls use the same leading column");
        assert.ok(geometry.history.x - geometry.label.x <= 320, "Dropdown stays near its label, not the far pane edge");
        // Native DOMRect rounding can exceed the shared bottom by 0.00001145 CSS px.
        assert.ok(geometry.actions.x >= geometry.root.x && geometry.actions.right <= geometry.root.right + 1
            && geometry.actions.y >= geometry.cadence.bottom && geometry.actions.bottom <= geometry.root.bottom + 0.0001,
        "Save and Cancel are contained below the fields they govern");
        await capture(page, `connection-${width}-${theme}`);
        for (const category of ["privacy", "display", "troubleshooting"]) {
            await navigateSettings(page, category);
            const pane = page.locator(`[data-settings-section=${category}]`);
            assert.equal(await pane.locator("h2").count(), 1);
            assert.deepEqual(await pane.locator("[aria-describedby],[aria-labelledby]").evaluateAll(nodes =>
                nodes.flatMap(node => ["aria-describedby", "aria-labelledby"].flatMap(attribute =>
                    (node.getAttribute(attribute) || "").split(/\s+/).filter(id => id && !document.getElementById(id))))), [],
            "Removed explanations leave no dead accessible descriptions");
            assert.equal(await page.locator("#automaticScoreSetup,[data-category=ai]").count(), 0);
            if (category === "display") await expect(pane.getByRole("heading", { name: "Time zone", level: 3 })).toBeVisible();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            assert.deepEqual(await pane.locator("button,label,summary").evaluateAll(nodes => nodes.filter(node =>
                node.checkVisibility() && node.scrollWidth > node.clientWidth + 1).map(node => node.textContent)), []);
            await capture(page, `${category}-${width}-${theme}`);
        }
    }
    assert.equal(posts.filter(item => item.path === "/api/collection/configure").length, 0);
    assert.deepEqual(await loadBoardState(context), before);
});

test("preference drafts, pending save, errors and uncertain recovery remain attached to their group", { timeout: 40000 }, async t => {
    const { page, context, runtime, posts } = await setup(t);
    const before = await loadBoardState(context);
    await selectActivityOption(page, "collectionWindow", "7");
    await expect(page.locator("#connectionPreferences #settingsDraftStatus")).toContainText("Unsaved preferences");
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
    await expect(page.locator("#connectionPreferences #settingsDraftStatus")).toContainText("saved");
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

test("unconfigured source and source-edit controls stay in Source without granting permission", { timeout: 30000 }, async t => {
    const { page, runtime, posts } = await setup(t, false);
    await page.setViewportSize({ width: 375, height: 1000 });
    await chooseTheme(page, "dark");
    await expect(page.locator("#connectionSource #connectionStatus")).toHaveText("Not connected");
    await expect(page.locator("#connectionSource #reviewSource")).toBeVisible();
    await expect(page.locator("#connectionPreferences #preferenceActions")).toBeHidden();
    await captureState(page, "unconfigured");
    await page.locator("#reviewSource").tap();
    await expect(page.locator("#connectionSource #sourceEditor")).toBeVisible();
    await page.locator("#sourceDatabase").fill("C:\\invented-source\\data.db");
    await page.locator("#sourceSessions").fill("C:\\invented-source\\session-state");
    await page.keyboard.press("Enter");
    await expect(page.locator("#connectionSource #approvalScope")).toBeVisible();
    await captureState(page, "unconfigured-source-draft");
    assert.equal((await runtime.collector.status()).config, null);
    assert.equal(posts.filter(item => item.path === "/api/collection/configure").length, 0);
    await page.locator("#cancelSource").click();
    await expect(page.locator("#sourceEditor")).toBeHidden();
    await expect(page.locator("#reviewSource")).toBeFocused();
});

test("source inspection, Settings search and Time zone retain exact destinations and browser Back", { timeout: 30000 }, async t => {
    const { page, runtime, context, posts } = await setup(t);
    const config = await readFile(path.join(context.dataDir, "collector", "config.json"));
    await openSourceEditor(page);
    await expect(page.locator("#connectionSource #sourceDatabase")).toBeFocused();
    await page.locator("#sourceDatabase").fill("C:\\invented-change\\data.db");
    await expect(page.locator("#sourceChangeImpact")).toContainText("stays paused");
    await page.locator("#cancelSource").click();
    await page.locator("#settingsSearch").fill("time zone");
    await page.locator('#settingsSearchResults a[data-setting="time-zone"]').click();
    await expect(page.locator("#displayTimeZone-control")).toBeFocused();
    await selectActivityOption(page, "displayTimeZone", "UTC");
    await expect(page.locator("#displayTimeZone")).toHaveValue("UTC");
    await expect(page.locator("#displayTimeEffective")).toBeHidden();
    await page.goBack();
    await expect(page.locator("[data-settings-section=connection]")).toBeVisible();
    assert.equal((await runtime.collector.status()).config.enabled, false);
    assert.equal(posts.filter(item => item.path === "/api/collection/configure").length, 0);
    assert.deepEqual(await readFile(path.join(context.dataDir, "collector", "config.json")), config);
});
