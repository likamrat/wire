import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { fixture, chooseTheme, navigateMain, navigateSettings, openSourceEditor } from "./helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createSettingsNavigation } from "../web/settings-navigation.mjs";
import { createLocalSearch } from "../web/local-search.mjs";
import { contrast } from "./color-measurements.mjs";

const proofDir = process.env.WIRE_SETTINGS_SEARCH_PROOFS;
const navigation = createSettingsNavigation(createLocalSearch());
const queries = ["reco", "record", "Theme", "city", "purge", "permission", "history", "display", "TIME-zone"];
const unavailableHere = new Set(["microsoft-collection", "microsoft-collection-state", "microsoft-collect-now", "global-collection"]);
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

async function setup(t) {
    const cleanup = [], record = fixture("settings-search");
    record.sourceSessionName = "Cedar planning";
    record.userPrompt.text = "Find the release checklist for the Cedar project.";
    record.followUpPrompts = [];
    const app = await searchFixture({ after: action => cleanup.push(action) }, { records: [record], reply: false });
    const before = await loadBoardState(app.context);
    const configPath = path.join(app.context.dataDir, "collector", "config.json");
    const beforeConfig = await readFile(configPath, "utf8");
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], denied = [], requests = [];
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    const reads = new Set(["/api/session", "/api/session/release", "/api/snapshot", "/api/collection/status",
        "/api/collection/issues", "/api/record/status", "/api/assessment/consent", "/api/assessment/overview",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list", "/api/search/status"]);
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        requests.push({ path: url.pathname, body: request.postData() });
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !reads.has(url.pathname)) {
            denied.push(`${request.method()} ${url.pathname}`);
            return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        try {
            await browser.close();
            const after = await loadBoardState(app.context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
            assert.equal(await readFile(configPath, "utf8"), beforeConfig);
            assert.deepEqual(errors, []);
            assert.deepEqual(denied, []);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(app.runtime.url + "#analyze");
    await ready(page);
    await navigateMain(page, "settings");
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return { page, requests };
}

async function capture(page, name) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.getAnimations().some(animation =>
        animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
    await page.screenshot({ path: path.join(proofDir, name + ".png"), fullPage: true });
}

test("Settings search reference layouts use the normal renderer and invented activity", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    await navigateSettings(page, "privacy");
    const matches = {};
    for (const query of queries) {
        await page.locator("#settingsSearch").fill(query);
        matches[query] = await page.locator("#settingsSearchResults a[data-setting]").evaluateAll(nodes => nodes.map(node => node.dataset.setting));
        assert.deepEqual(matches[query], navigation.find(query).filter(entry => !unavailableHere.has(entry.id)).map(entry => entry.id), query);
    }
    if (proofDir) {
        await mkdir(proofDir, { recursive: true });
        await writeFile(path.join(proofDir, "matches.json"), JSON.stringify(matches, null, 2));
    }
    for (const [theme, width, scale] of [
        ["light", 1440, 1], ["dark", 1440, 1], ["light", 390, 1],
        ["dark", 768, 1], ["light", 1440, 2], ["dark", 390, 2],
    ]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = scale * 100 + "%", scale);
        await chooseTheme(page, theme);
        await page.locator("#settingsSearch").fill("reco");
        await page.evaluate(() => scrollTo(0, 0));
        await page.mouse.move(0, 0);
        await capture(page, `settings-search-${theme}-${width}-${scale}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}/${scale}`);
        const paint = await page.locator(".settings-search").evaluate(node => {
            const input = node.querySelector("input"), field = input.parentElement;
            const face = getComputedStyle(field, "::before"), text = getComputedStyle(input);
            return {
                height: input.getBoundingClientRect().height, inset: parseFloat(face.top), radius: parseFloat(face.borderRadius),
                fill: face.backgroundColor, ink: text.color, image: text.backgroundImage, shadow: text.boxShadow,
                focus: face.outlineWidth, font: text.fontFamily,
                icon: node.querySelector(".wire-search-icon svg").getBoundingClientRect().width,
                clear: node.querySelector("button").getBoundingClientRect().toJSON(),
                textEnd: input.getBoundingClientRect().right - parseFloat(text.paddingRight),
                rows: [...node.querySelectorAll("a[data-setting]")].map(link => ({
                    height: link.getBoundingClientRect().height, background: getComputedStyle(link).backgroundColor,
                    ink: getComputedStyle(link).color,
                })),
                page: getComputedStyle(document.body).backgroundColor,
                globalImage: getComputedStyle(document.getElementById("wireSearch")).backgroundImage,
            };
        });
        assert.ok(paint.height >= 44 && paint.clear.height >= 44 && paint.clear.width >= 44);
        assert.ok(paint.clear.left >= paint.textEnd, "Query text must not overlap the clear target at enlarged sizes");
        assert.equal(paint.inset, 6);
        assert.ok(paint.radius <= 10);
        assert.equal(paint.image, "none");
        assert.equal(paint.shadow, "none");
        assert.equal(paint.focus, "2px");
        assert.equal(paint.icon, 16 * scale);
        assert.match(paint.font, /Asta Sans/);
        assert.match(paint.globalImage, /linear-gradient/, "The global Search field keeps its own paint");
        assert.ok(contrast(paint.ink, paint.fill) >= 4.5);
        for (const row of paint.rows) {
            assert.ok(row.height >= 44);
            assert.equal(row.background, "rgba(0, 0, 0, 0)");
            assert.ok(contrast(row.ink, paint.page) >= 4.5);
        }
        const result = page.locator('[data-setting="recollect-activity"]');
        const bounds = await result.boundingBox();
        await result.hover();
        assert.equal(await result.evaluate(node => getComputedStyle(node).textDecorationLine), "underline");
        assert.equal(await result.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
        await page.mouse.down();
        assert.equal(await result.evaluate(node => getComputedStyle(node).textDecorationThickness), "2px");
        assert.deepEqual(await result.boundingBox(), bounds, "Hover/press cannot shift a destination");
        await page.mouse.up();
        await expect(page.locator("#recollectActivity")).toBeFocused();
        await expect(result).toHaveAttribute("aria-current", "location");
        assert.equal(await result.evaluate(node => getComputedStyle(node, "::before").width), "2px");
        await expect(page.locator("dialog[open]")).toHaveCount(0);
        await page.goBack();
        await expect(result).toBeFocused();
        await expect(page.locator("#settingsSearch")).toHaveValue("reco");
    }
    await page.setViewportSize({ width: 1440, height: 760 });
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await chooseTheme(page, "light");
    await page.locator("#settingsSearch").fill("record");
    await page.locator('[data-setting="recollect-activity"]').click();
    await page.mouse.move(0, 0);
    await page.evaluate(() => scrollTo(0, 0));
    await capture(page, "settings-search-guide");
});

test("Settings search groups all existing title, description and keyword matches without repeated help", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    for (const query of queries) {
        await page.locator("#settingsSearch").fill(query);
        const expected = navigation.find(query).filter(entry => !unavailableHere.has(entry.id));
        await expect(page.locator("#settingsSearchResults a[data-setting]")).toHaveCount(expected.length);
        assert.deepEqual(await page.locator(".settings-search-heading>span").allTextContents(), [...new Set(expected.map(entry => entry.category))]);
        for (const entry of expected) {
            const row = page.locator(`#settingsSearchResults a[data-setting="${entry.id}"]`);
            assert.equal(await row.locator(":scope>span").first().textContent(), entry.title);
            assert.ok(!(await row.textContent()).includes(entry.context));
            const group = row.locator("xpath=../..");
            const heading = await group.getAttribute("aria-labelledby");
            assert.equal(await page.locator("#" + heading + ">span").textContent(), entry.category);
        }
        await expect(page.locator("#settingsCategories")).toBeHidden();
        await expect(page.locator("#settingsStatusLink")).toBeHidden();
        await expect(page.locator("#settingsSearchCount")).toContainText(`${expected.length} setting`);
    }
    await page.locator("#settingsSearch").fill("city");
    await expect(page.locator("#settingsSearchResults")).toHaveText("DisplayTime zone");
    await page.locator("#settingsSearch").fill("TIME-zone");
    await expect(page.locator("#settingsSearchResults mark")).toHaveText(["Time", "zone"]);
    await page.locator("#settingsSearch").fill("<img src=x onerror=alert(1)> [.*]");
    await expect(page.locator("#settingsSearchCount")).toHaveText("No settings match.");
    await expect(page.locator("#settingsSearchCount")).toBeVisible();
    await expect(page.locator("#settingsSearchResults")).toBeHidden();
    await expect(page.locator("#settingsSearchResults img")).toHaveCount(0);
    await capture(page, "settings-search-no-match");
    await page.keyboard.press("Escape");
    await expect(page.locator("#settingsSearch")).toHaveValue("");
    await expect(page.locator("#settingsSearch")).toBeFocused();
    await expect(page.locator("#settingsCategoryNav")).toBeVisible();
    await page.locator("#settingsSearch").fill("record");
    await page.locator("#clearSettingsSearch").click();
    await expect(page.locator("#settingsSearch")).toBeFocused();
    await expect(page.locator("#settingsSearchResults")).toBeHidden();
    await expect(page.locator("#settingsSearchCount")).toBeHidden();
    await page.locator("#settingsSearch").fill("   ");
    await expect(page.locator("#settingsCategories")).toBeVisible();
    assert.doesNotMatch(JSON.stringify(requests), /TIME-zone|onerror|purge|permission|city/);
});

test("Settings results reveal every available destination without changing data or executing an action", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    const targets = {
        source: "editSource", "source-paths": "approvedSourceTitle", "microsoft-connection": "connectionTitle",
    };
    for (const entry of navigation.entries.filter(entry => !unavailableHere.has(entry.id))) {
        await navigateMain(page, "settings");
        await page.locator("#settingsSearch").fill(entry.title);
        const result = page.locator(`#settingsSearchResults a[data-setting="${entry.id}"]`);
        await expect(result).toBeVisible();
        await result.click();
        let target = targets[entry.id] || entry.target;
        if (["displayTimeZone", "collectionWindow", "collectionCadence"].includes(target)) target += "-control";
        const destination = page.locator("#" + target);
        await expect(destination).toBeVisible();
        if (await destination.evaluate(node => node.tagName === "DETAILS")) await expect(destination.locator("summary")).toBeFocused();
        else if (await destination.evaluate(node => node.disabled === true)) {
            assert.equal(await destination.evaluate(node => node.closest(".ux-disabled-help") === document.activeElement), true, entry.id);
        } else await expect(destination).toBeFocused();
        assert.equal(new URL(page.url()).hash.includes("setting=" + entry.id), true);
        await expect(page.locator("dialog[open]")).toHaveCount(0);
        await expect(page.locator("#sourceEditor")).toBeHidden();
        if (entry.view !== "collection-status") {
            await expect(page.locator("#settingsSearch")).toHaveValue(entry.title);
            await expect(result).toHaveAttribute("aria-current", "location");
        }
    }
    await navigateMain(page, "settings");
    await page.locator("#settingsSearch").fill("Read history again");
    await page.locator('[data-setting="recollect-activity"]').click();
    await expect(page.getByRole("switch", { name: "Save Copilot replies locally", exact: true })).not.toBeChecked();
});

test("keyboard activation, polling, draft changes and Back retain the Settings search origin", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    const search = page.locator("#settingsSearch");
    await search.fill("record");
    await search.evaluate(node => node.setSelectionRange(2, 4));
    const handle = await search.elementHandle();
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"), { timeout: 12000 });
    assert.deepEqual(await handle.evaluate(node => [node.isConnected, node === document.activeElement, node.selectionStart, node.selectionEnd]), [true, true, 2, 4]);
    await search.fill("city");
    await page.keyboard.press("Tab");
    await expect(page.locator("#clearSettingsSearch")).toBeFocused();
    await page.keyboard.press("Tab");
    const timeZone = page.locator('[data-setting="time-zone"]');
    await expect(timeZone).toBeFocused();
    assert.equal(await timeZone.evaluate(node => getComputedStyle(node).outlineWidth), "2px");
    await page.keyboard.press("Enter");
    await expect(page.locator("#displayTimeZone-control")).toBeFocused();
    await expect(page.locator("#displayTimeZone")).toHaveValue("");
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.time-zone")), null);
    await page.goBack();
    await expect(timeZone).toBeFocused();
    await expect(search).toHaveValue("city");
    await page.goForward();
    await expect(page.locator("#displayTimeZone-control")).toBeFocused();
    await search.fill("record");
    await search.press("Tab"); await page.keyboard.press("Tab");
    const first = page.locator('#settingsSearchResults a[data-setting]').first();
    await expect(first).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-setting="delete-activity"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#deleteActivity")).toBeFocused();
    await capture(page, "settings-search-selected");
    await page.goBack();
    await expect(page.locator('[data-setting="delete-activity"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await navigateSettings(page, "connection");
    await openSourceEditor(page);
    await page.locator("#sourceSessions").fill("C:\\invented-draft\\session-state");
    await search.fill("pause");
    const pause = page.locator('[data-setting="collection-state"]');
    await expect(pause.locator(".settings-search-availability")).toHaveText("Action unavailable");
    await pause.click();
    await expect(page.locator("#pauseCollection")).toBeDisabled();
    assert.equal(await page.locator("#pauseCollection").evaluate(node => node.closest(".ux-disabled-help") === document.activeElement), true);
    await expect(page.locator("#sourceSessions")).toHaveValue("C:\\invented-draft\\session-state");
    await search.fill("city");
    await timeZone.click();
    await search.fill("source paths");
    await page.locator('[data-setting="source-paths"]').click();
    await expect(page.locator("#sourceDatabase")).toBeFocused();
    await expect(page.locator("#sourceSessions")).toHaveValue("C:\\invented-draft\\session-state");
    await page.locator("#cancelSource").click();
    await search.fill("recorder");
    const diagnostic = page.locator('[data-setting="network-diagnostic"]');
    await diagnostic.click();
    await expect(page.locator("#recorderDiagnostics>summary")).toBeFocused();
    await page.goBack();
    await expect(diagnostic).toBeFocused();
    await expect(search).toHaveValue("recorder");
    assert.ok(!page.url().includes("recorder"));
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await search.focus();
    assert.equal(await search.evaluate(node => getComputedStyle(node.parentElement, "::before").outlineWidth), "2px");
    await search.press("Tab"); await page.keyboard.press("Tab");
    assert.equal(await diagnostic.evaluate(node => getComputedStyle(node).outlineWidth), "2px");
    await page.keyboard.press("Enter");
    await page.goBack();
    await expect(diagnostic).toBeFocused();
});
