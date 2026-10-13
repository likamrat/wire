import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption, openSourceEditor } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const proofs = process.env.WIRE_CONNECTION_PROOFS;
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: true });
}
async function setup(t, approved = true) {
    const cleanup = [];
    let app;
    if (approved) app = await searchFixture({ after: action => cleanup.push(action) }, { reply: false });
    else {
        const fixture = await privateFixture({ after: action => cleanup.push(action) });
        const runtime = await startServer(fixture.context, createExportController(fixture.context), { port: 0, collector: { timers: false } });
        app = { ...fixture, runtime };
        cleanup.unshift(() => runtime.close());
    }
    const before = await loadBoardState(app.context);
    const configPath = path.join(app.context.dataDir, "collector", "config.json");
    const savedConfig = approved ? await readFile(configPath) : null;
    const browser = await chromium.launch();
    const requests = [], errors = [];
    t.after(async () => {
        await browser.close();
        try {
            assert.deepEqual(errors, []);
            assert.equal(requests.some(url => /collection\/(configure|enabled|now)|assessment\/.*set|export|record/.test(url)), false);
            if (approved) assert.deepEqual(await readFile(configPath), savedConfig);
            else assert.equal((await app.runtime.collector.status()).config, null);
            const after = await loadBoardState(app.context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup) await action(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(app.runtime.url).origin) {
            errors.push("Unexpected external request");
            return route.abort();
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    await page.goto(app.runtime.url + "#settings?section=connection");
    await ready(page);
    return { ...app, page, requests };
}

test("ordinary Connection shows source approval and history controls without exposing source paths", async t => {
    const { page, config } = await setup(t);
    await expect(page.locator("#approvedConnection")).toBeVisible();
    await expect(page.locator("#approvedSourceDetails")).toBeHidden();
    await expect(page.locator("#editSource")).toBeHidden();
    await expect(page.locator("#collectionWindow-control")).toBeVisible();
    await expect(page.locator("#connectionStatus")).toHaveText("Paused");
    assert.equal(await page.locator(".permission-boundary").count(), 0);
    const sourceActions = await page.locator("#approvedConnection .settings-actions :is(a,button):visible").allTextContents();
    const headings = await page.locator('[data-settings-section=connection] :is(h2,h3):visible').allTextContents();
    assert.deepEqual(sourceActions, ["View source", "Resume collection"]);
    assert.deepEqual(headings, ["Connection & updates", "Source", "Recorded activity", "History and frequency"]);
    const reading = await page.locator(".settings-content").innerText();
    assert.ok(!reading.includes(config.appDbPath) && !reading.includes(config.sessionRoot));
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.evaluate(() => scrollTo(0, 0));
        await capture(page, `ordinary-${theme}-desktop`);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await expect(page.locator("#viewApprovedSource")).toBeVisible();
    assert.ok((await page.locator("#viewApprovedSource").boundingBox()).height >= 44);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await capture(page, "ordinary-dark-375-200");
    if (proofs) await writeFile(path.join(proofs, "ordinary-reading-order.json"), JSON.stringify({
        headings, sourceActions, exactPathsVisible: false,
    }, null, 2));
});

const dropdownContexts = [
    { name: "light-desktop", theme: "light", width: 1440, scale: 1 },
    { name: "dark-desktop", theme: "dark", width: 1440, scale: 1 },
    { name: "dark-narrow-200", theme: "dark", width: 375, scale: 2 },
    { name: "light-asta-metrics", theme: "light", width: 820, scale: 1, font: '"Asta Sans", sans-serif' },
];
async function dropdownContext(page, context) {
    await chooseTheme(page, context.theme);
    await page.setViewportSize({ width: context.width, height: 1000 });
    await page.evaluate(({ scale, font }) => {
        document.documentElement.style.fontSize = `${scale * 100}%`;
        if (font) document.documentElement.style.setProperty("--font", font);
        else document.documentElement.style.removeProperty("--font");
    }, context);
    if (context.font) assert.ok(await page.evaluate(async font => (await document.fonts.load(`600 16px ${font}`)).length > 0, context.font), "The bundled alternate font is actually loaded");
    await page.evaluate(() => document.fonts.ready);
}
async function dropdownGeometry(page, id, name) {
    const result = await page.evaluate(id => {
        const box = node => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        const trigger = document.getElementById(id + "-control"), popup = document.querySelector(".select-popup");
        const label = trigger.querySelector(".select-value");
        return {
            trigger: box(trigger), label: box(label), menu: box(popup),
            font: getComputedStyle(trigger).fontFamily,
            labelClipped: label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1,
            chevron: box(trigger.querySelector(".select-chevron")),
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            scrollHeight: popup.scrollHeight, scrollTop: popup.scrollTop, clientHeight: popup.clientHeight,
            actions: [...popup.querySelectorAll("button")].map(node => ({
                ...box(node), text: node.textContent, clipped: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
            })),
            rows: [...popup.querySelectorAll(".select-option")].map(node => {
                const label = node.querySelector(".select-option-label");
                return { ...box(node), text: label.textContent, label: box(label), check: box(node.querySelector(".select-check")),
                    clipped: label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1 };
            }),
        };
    }, id);
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: false });
    }
    return result;
}
function assertDropdownGeometry(result, width) {
    assert.ok(result.trigger.height >= 44 && result.rows.every(row => row.height >= 44), "Usable row targets");
    assert.equal(result.labelClipped, false, "Selected identity remains readable without ellipsis");
    assert.equal(result.overflow, false, "Controls do not widen the page");
    assert.ok(result.menu.x >= 8 && result.menu.right <= width - 7 && result.menu.y >= 8 && result.menu.bottom <= 993, "Popup stays within the viewport");
    assert.ok(result.label.right <= result.chevron.x, "Selected text does not overlap its chevron");
    for (const action of result.actions) {
        assert.ok(action.height >= 44 && !action.clipped, "All, Apply and Cancel keep readable usable targets");
        assert.ok(action.x >= result.menu.x && action.right <= result.menu.right, "Actions stay inside the menu");
    }
    for (const row of result.rows) {
        assert.equal(row.clipped, false, row.text);
        assert.ok(row.label.x >= row.x && row.label.right <= row.check.x && row.label.bottom <= row.bottom, "Full option text leaves room for its checkmark");
    }
}

test("short Settings choices use their content rather than the form column", async t => {
    const { page, requests } = await setup(t), measurements = [];
    for (const context of dropdownContexts) {
        await dropdownContext(page, context);
        const trigger = page.locator("#collectionWindow-control");
        await trigger.click();
        const geometry = await dropdownGeometry(page, "collectionWindow", "history-" + context.name);
        geometry.cadence = await page.locator("#collectionCadence-control").boundingBox();
        measurements.push({ ...context, ...geometry });
        assertDropdownGeometry(geometry, context.width);
        const reads = requests.filter(path => path === "/api/snapshot").length;
        await trigger.press("Home"); await trigger.press("9");
        await expect(page.locator(".select-option[data-active=true]")).toHaveText("90 days");
        await expect(page.locator("#collectionWindow")).toHaveValue("30");
        assert.equal(requests.filter(path => path === "/api/snapshot").length, reads, "Exploring the history window cannot apply a preference or request a snapshot");
        await trigger.press("Escape");
        await expect(trigger).toBeFocused();
    }
    if (proofs) await writeFile(path.join(proofs, "dropdown-geometry.json"), JSON.stringify(measurements, null, 2));
    for (const geometry of measurements) {
        assert.ok(geometry.trigger.width < geometry.cadence.width,
            `Short history choices must not inherit the longer frequency field width: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.menu.width < geometry.cadence.width, "A three-choice day menu does not need the frequency field's width");
        if (geometry.width === 1440) assert.ok(Math.abs(geometry.menu.x - geometry.trigger.x) <= 1, "Proximal Settings fields keep their menu on the control's leading edge");
    }
    await dropdownContext(page, dropdownContexts[2]);
    const wrapper = page.locator('[data-select-for="collectionWindow"]'), trigger = page.locator("#collectionWindow-control");
    await wrapper.evaluate(node => node.style.cssText = "position:fixed;right:8px;bottom:8px");
    await trigger.click();
    await expect(page.locator(".select-popup")).toHaveAttribute("data-side", "top");
    const edge = await dropdownGeometry(page, "collectionWindow", "history-bottom-right");
    assertDropdownGeometry(edge, 375);
    assert.equal(await page.locator(".select-option").first().evaluate(node => {
        const box = node.getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest(".select-option") === node;
    }), true, "The real portaled option is hit-testable at the viewport edge");
    await trigger.press("Escape");
    await wrapper.evaluate(node => node.style.cssText = `position:fixed;left:0;top:${1 - node.getBoundingClientRect().height}px`);
    await trigger.focus(); await page.keyboard.press("ArrowDown");
    assertDropdownGeometry(await dropdownGeometry(page, "collectionWindow", "history-partial-top-left"), 375);
    await page.keyboard.press("Escape");
    await wrapper.evaluate(node => node.removeAttribute("style"));
});

test("dropdown proportions retain long lists and multiselect drafts in the production root", async t => {
    const { page, requests } = await setup(t), measurements = [];
    for (const context of dropdownContexts) {
        await dropdownContext(page, context);
        await navigateSettings(page, "display");
        const zone = page.locator("#displayTimeZone-control");
        await zone.click(); await zone.press("End");
        const long = await dropdownGeometry(page, "displayTimeZone", "time-zone-" + context.name);
        assert.ok(long.rows.length > 100 && long.scrollHeight > long.clientHeight && long.scrollTop > 0, "The actual many-option list scrolls");
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await expect(page.locator(".select-option[data-active=true]")).toBeInViewport();
        await zone.press("Escape"); await expect(zone).toBeFocused();
        const longest = await page.locator("#displayTimeZone option").evaluateAll(options =>
            options.reduce((longest, option) => option.label.length > longest.label.length ? { label: option.label, value: option.value } : longest, { label: "", value: "" }));
        await selectActivityOption(page, "displayTimeZone", longest.value); await ready(page);
        await zone.click();
        const selected = await dropdownGeometry(page, "displayTimeZone", "selected-zone-" + context.name);
        await zone.press("Escape");
        await selectActivityOption(page, "displayTimeZone", "");
        await navigateMain(page, "analyze"); await ready(page);
        for (const [id, clear] of [["promptAuthorFilter", "clearPromptAuthorFilter"], ["outcomeFilter", "clearResultFilter"]]) {
            const trigger = page.locator("#" + id + "-control"), popup = page.locator(".select-popup");
            await trigger.click();
            const reads = requests.filter(path => path === "/api/snapshot").length;
            const value = await popup.locator('.select-option[aria-disabled=false]').first().getAttribute("data-value");
            const all = popup.locator(".select-all"), apply = popup.getByRole("button", { name: "Apply", exact: true });
            await all.click(); await expect(apply).toBeDisabled();
            await all.click(); await expect(apply).toBeEnabled();
            await all.click();
            await popup.locator(`.select-option[data-value="${value}"]`).click();
            await expect(apply).toBeEnabled();
            assert.equal(requests.filter(path => path === "/api/snapshot").length, reads, "Draft, All and Clear do not apply any filter");
            const multiple = await dropdownGeometry(page, id, id + "-" + context.name);
            await popup.getByRole("button", { name: "Cancel", exact: true }).click();
            await expect(trigger).toBeFocused();
            assert.equal(await page.locator("#" + id).evaluate(node => node.selectedOptions.length === node.options.length), true);
            await trigger.click(); await popup.locator(".select-all").click();
            await popup.locator(`.select-option[data-value="${value}"]`).click();
            await trigger.press("Tab"); await expect(apply).toBeFocused();
            await page.keyboard.press("Enter"); await ready(page);
            assert.deepEqual(await page.locator("#" + id).evaluate(node => [...node.selectedOptions].map(option => option.value)), [value]);
            await page.locator("#" + clear).click(); await ready(page);
            assert.equal(await page.locator("#" + id).evaluate(node => node.selectedOptions.length === node.options.length), true);
            measurements.push({ context, id, multiple });
        }
        measurements.push({ context, long, selected });
        await navigateMain(page, "settings"); await ready(page);
    }
    if (proofs) await writeFile(path.join(proofs, "long-and-multiple-geometry.json"), JSON.stringify(measurements, null, 2));
    for (const { context, long, selected, multiple } of measurements) {
        for (const geometry of [long, selected, multiple].filter(Boolean)) assertDropdownGeometry(geometry, context.width);
    }
});

test("explicit source inspection, source drafts, category return and Back preserve paths and paused state", async t => {
    const { page, config, runtime } = await setup(t);
    await page.locator("#viewApprovedSource").click(); await ready(page);
    await expect(page.locator("#approvedSourceTitle")).toBeFocused();
    await expect(page.locator("#approvedDatabase")).toHaveText(config.appDbPath);
    await expect(page.locator("#approvedSessions")).toHaveText(config.sessionRoot);
    await expect(page.locator("#viewApprovedSource")).toBeHidden();
    await expect(page.locator("#approvedSourceDetails #editSource")).toBeVisible();
    await capture(page, "approved-source-inspection");
    await page.goBack(); await ready(page);
    await expect(page.locator("#approvedSourceDetails")).toBeHidden();
    await page.goForward(); await ready(page);
    await expect(page.locator("#approvedSourceTitle")).toBeFocused();
    await openSourceEditor(page);
    await expect(page.locator("#sourceDatabase")).toBeFocused();
    const draft = config.appDbPath + ".draft";
    await page.locator("#sourceDatabase").fill(draft);
    await page.locator("#sourceDatabase").press("Enter");
    await expect(page.locator("#approvalScope")).toContainText("keeping original prompts locally");
    await expect(page.locator("#pauseCollection")).toBeDisabled();
    await expect(page.locator("#preferenceActions")).toBeHidden();
    const node = await page.locator("#sourceDatabase").elementHandle();
    await navigateSettings(page, "display");
    await page.goBack(); await ready(page);
    assert.equal(await node.evaluate(node => node === document.getElementById("sourceDatabase")), true);
    await expect(page.locator("#sourceDatabase")).toHaveValue(draft);
    await navigateSettings(page, "connection");
    await page.locator("#cancelSource").click();
    await expect(page.locator("#viewApprovedSource")).toBeFocused();
    await expect(page.locator("#approvedSourceDetails")).toBeHidden();
    await expect(page.locator("#sourceDatabase")).toHaveValue(config.appDbPath);
    await selectActivityOption(page, "collectionCadence", "15");
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await expect(page.locator("#pauseCollection")).toBeDisabled();
    await page.locator("#viewApprovedSource").click(); await ready(page);
    await expect(page.locator("#editSource")).toBeDisabled();
    await navigateSettings(page, "display");
    await page.goBack(); await ready(page);
    await expect(page.locator("#collectionCadence")).toHaveValue("15");
    await page.locator("#cancelPreferences").click();
    await expect(page.locator("#editSource")).toBeFocused();
    await expect(page.locator("#collectionCadence")).toHaveValue(String(config.pollSeconds));
    assert.equal((await runtime.collector.status()).config.enabled, false);
});

test("unapproved setup still requires review and explicit approval after path inspection links", async t => {
    const { page, runtime } = await setup(t, false);
    await expect(page.locator("#connectionStatus")).toHaveText("Not connected");
    await expect(page.locator("#reviewSource")).toBeVisible();
    await expect(page.locator("#viewApprovedSource")).toBeHidden();
    await page.goto(runtime.url + "#settings?section=connection&setting=source-paths"); await ready(page);
    await expect(page.locator("#reviewSource")).toBeFocused();
    await page.locator("#reviewSource").click();
    await expect(page.locator("#sourceDatabase")).toBeFocused();
    await page.locator("#sourceDatabase").fill("C:\\invented-not-approved\\data.db");
    await page.locator("#sourceSessions").fill("C:\\invented-not-approved\\session-state");
    await page.locator("#sourceSessions").press("Enter");
    await selectActivityOption(page, "collectionWindow", "7");
    await expect(page.locator("#approvalScope")).toContainText("7 days");
    await capture(page, "unapproved-source-review");
    await page.locator("#cancelSource").click();
    await expect(page.locator("#reviewSource")).toBeFocused();
    await expect(page.locator("#sourceEditor")).toBeHidden();
});
