import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

async function setup(t, { savedReport = false } = {}) {
    const records = Array.from({ length: 23 }, (_, index) => {
        const record = fixture(`foundation-${index}`);
        record.userPrompt.text = "Compare the launch calendar with the project notes.";
        record.sourceSessionName = "Invented launch review";
        record.toolCalls = Array.from({ length: 10 }, (_, call) => ({
            ...record.toolCalls[0], toolCallId: `foundation-${index}-${call}`, startEventId: `start-${index}-${call}`,
            requestArgs: { entityUrls: ["/me/calendarView"] }, toolSucceeded: call < 8,
            reportedOutcome: call < 8 ? "succeeded" : "failed",
        }));
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    if (savedReport) await updateBoardState(context, state => {
        state.exports.push({ bundleId: "export-00000000-0000-4000-8000-000000000000", kind: "report",
            preparedAt: "2026-10-01T12:00:00Z", formats: [], files: {}, promptMode: "none",
            selectionScope: { requestGroups: 23 } });
    });
    const before = await loadBoardState(context);
    let providers = 0;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { providers++; throw Error("No providers in screen proof"); },
            readSource: async () => { providers++; throw Error("No private source reads in screen proof"); } } });
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined,
        ignoreDefaultArgs: ["--hide-scrollbars"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // Geometry and interaction evidence must never be affected by screenshot animations.
    let captures = 0;
    const rejectCapture = () => { captures++; throw Error("Screen geometry proof cannot capture images or traces"); };
    page.screenshot = rejectCapture;
    page.context().tracing.start = rejectCapture;
    page.context().tracing.startChunk = rejectCapture;
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            assert.deepEqual(errors, []); assert.equal(providers, 0); assert.equal(captures, 0);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "exports", "cards", "personalEvaluation"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url); await ready(page);
    return page;
}

async function paintedFonts(page, selector) {
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
        assert.ok(nodeIds.length, selector);
        let glyphs = 0;
        for (const nodeId of nodeIds) {
            const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
            for (const font of fonts.filter(font => font.glyphCount > 0)) {
                assert.equal(font.isCustomFont, true, `${selector}: ${font.familyName}`);
                assert.match(font.familyName, /Asta Sans/);
                glyphs += font.glyphCount;
            }
        }
        assert.ok(glyphs > 0, `${selector} must paint actual Asta glyphs`);
    } finally { await cdp.detach(); }
}

async function iconInventory(page) {
    const inventory = await page.evaluate(() => ({
        svg: [...document.querySelectorAll("svg")].filter(node => node.checkVisibility()).map(node => ({
            asset: node.dataset.fluentIcon, excluded: node.matches(".brand-logo") || !!node.closest(".percentage-visual,.time-stack"),
        })),
        disclosure: [...document.querySelectorAll("details>summary")].filter(node => node.checkVisibility()).map(node => {
            const icon = node.querySelector(".disclosure-icon"), css = icon && getComputedStyle(icon);
            return { label: node.textContent, marker: getComputedStyle(node).listStyleType,
                asset: icon?.dataset.fluentIcon, width: css?.width, height: css?.height };
        }),
    }));
    assert.ok(inventory.svg.length > 0);
    assert.ok(inventory.svg.every(icon => icon.excluded || /^[a-z0-9_]+_(16|20|24)_(regular|filled)$/.test(icon.asset)), JSON.stringify(inventory.svg));
    for (const cue of inventory.disclosure) {
        assert.equal(cue.marker, "none", cue.label);
        assert.equal(cue.asset, "chevron_right_16_regular");
        assert.equal(cue.width, "16px"); assert.equal(cue.height, "16px");
    }
}

test("populated screens retain painted Asta roles and coherent Fluent disclosures at wide and narrow sizes", async t => {
    const page = await setup(t);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${100 * scale}%`, scale);
        await navigateMain(page, "analyze"); await ready(page);
        await expect(page.locator("#periodResult")).toHaveText("230 Work IQ tool calls");
        const roles = await page.locator("#periodResult,#activityCount,#activityUnit").evaluateAll(nodes => nodes.map(node => {
            const css = getComputedStyle(node);
            return { size: css.fontSize, weight: css.fontWeight, line: css.lineHeight, font: css.fontFamily };
        }));
        assert.equal(roles.length, 3); assert.deepEqual(roles, [roles[0], roles[0], roles[0]]);
        assert.equal(roles[0].size, `${22 * scale}px`);
        await paintedFonts(page, "#periodResult");
        await paintedFonts(page, "#activityList .activity-card-facts dd");
        await paintedFonts(page, "#activityList .full-text-preview");
        await paintedFonts(page, "#wireSearch");
        await iconInventory(page);

        const summary = page.locator("#moreFilters>summary");
        await expect(summary.locator(".disclosure-icon")).toHaveCount(1);
        const label = await summary.textContent();
        await summary.focus(); await page.keyboard.press("Enter");
        await expect(page.locator("#moreFilters")).toHaveAttribute("open", "");
        assert.equal(await summary.locator(".disclosure-icon").evaluate(n => getComputedStyle(n).transform), "matrix(0, 1, -1, 0, 0, 0)");
        await page.keyboard.press("Space");
        await expect(page.locator("#moreFilters")).not.toHaveAttribute("open", "");
        await expect(summary).toHaveText(label);
        await page.locator('[data-select-id="outcomeFilter"]').click();
        await paintedFonts(page, ".select-popup .result-option-label");
        const status = page.locator(".select-popup .result-legend-icon .fluent-icon").first();
        const selection = page.locator(".select-popup .select-check").first();
        assert.match(await status.getAttribute("data-fluent-icon"), /_20_regular$/);
        assert.equal(await selection.getAttribute("data-fluent-icon"), "checkmark_16_regular");
        await page.keyboard.press("Escape");

        await page.locator("#activityList .request-link").first().click(); await ready(page);
        await paintedFonts(page, "#requestContent .full-text-content");
        await iconInventory(page);
        await page.getByRole("link", { name: "Back to results", exact: true }).click(); await ready(page);
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        await paintedFonts(page, "#reportsView h2");
        await iconInventory(page);
        await navigateMain(page, "settings");
        await navigateSettings(page, "display");
        await paintedFonts(page, "#settingsView h2");
        await page.locator('[data-select-id="displayTimeZone"]').click();
        await paintedFonts(page, ".select-popup .select-option-label");
        await page.keyboard.press("Escape");
        await iconInventory(page);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
});

test("Refresh pending paint uses an official glyph without moving its label, and restores after failure", async t => {
    const page = await setup(t);
    await chooseTheme(page, "dark");
    const refresh = page.locator("#checkActivity");
    let release, entered;
    const hold = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { entered = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        entered(); await hold;
        await route.fulfill({ status: 500, json: { error: "Invented local read failure" } });
    }, { times: 1 });
    const geometry = () => refresh.evaluate(node => {
        const icon = node.querySelector("svg"), range = document.createRange();
        range.selectNode([...node.childNodes].find(child => child.nodeType === 3 && child.textContent.trim()));
        return { target: node.getBoundingClientRect().toJSON(), icon: icon.getBoundingClientRect().toJSON(),
            text: range.getBoundingClientRect().toJSON() };
    });
    const before = await geometry();
    await refresh.click(); await requested;
    await page.evaluate(() => new Promise(resolve => {
        const start = performance.now();
        const frame = now => now - start > 120 ? resolve() : requestAnimationFrame(frame);
        requestAnimationFrame(frame);
    }));
    const busy = await geometry();
    assert.deepEqual(busy.target, before.target); assert.deepEqual(busy.text, before.text);
    for (const [position, size] of [["x", "width"], ["y", "height"]]) {
        assert.ok(Math.abs(busy.icon[position] + busy.icon[size] / 2 - before.icon[position] - before.icon[size] / 2) < .1);
    }
    const pending = refresh.locator(".pending-indicator");
    await expect(pending).toHaveAttribute("data-fluent-icon", "spinner_ios_20_regular");
    assert.equal(await pending.evaluate(n => getComputedStyle(n).borderWidth), "0px");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await pending.evaluate(n => getComputedStyle(n).animationName), "none");
    release(); await ready(page);
    await expect(refresh.locator(".pending-indicator")).toHaveCount(0);
    await expect(refresh.locator("svg")).toHaveAttribute("data-fluent-icon", "arrow_clockwise_20_regular");
    await expect(page.locator("#activityCount")).toHaveText("230");
    await expect(page.locator("#freshStatus")).toHaveText("Stored view not updated.");
    await expect(page.locator("#freshStatus")).toHaveAttribute("data-severity", "error");
    await selectActivityOption(page, "serviceAssociationFilter", "Calendar"); await ready(page);
    await expect(page.locator("#resetView")).toBeEnabled();
    await page.locator("#resetView").press("Enter"); await ready(page);
    await expect(page.locator("#resetView")).toBeDisabled();
});

test("dynamic disclosure labels and saved-report management retain one official glyph and native keyboard behavior", async t => {
    const page = await setup(t, { savedReport: true });
    const summary = page.locator("#moreFilters>summary");
    const project = await page.locator("#projectFilter option").nth(1).getAttribute("value");
    await selectActivityOption(page, "projectFilter", project); await ready(page);
    await expect(summary).toContainText("active");
    await expect(summary.locator(".disclosure-icon")).toHaveCount(1);
    await page.locator("#resetView").click(); await ready(page);
    await expect(summary).toHaveText("More filters");
    await expect(summary.locator(".disclosure-icon")).toHaveCount(1);
    await navigateMain(page, "reports");
    const manage = page.locator(".saved-report-summary");
    for (const [theme, width] of [["light", 1440], ["dark", 390]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await expect(manage.locator(".saved-report-manage>.disclosure-icon")).toHaveCount(1);
        await expect(manage.locator(":scope>.disclosure-icon")).toHaveCount(0);
        await expect(manage.locator(".disclosure-icon")).toHaveAttribute("data-fluent-icon", "chevron_right_16_regular");
        await paintedFonts(page, ".saved-report-manage");
        await manage.focus(); await page.keyboard.press("Enter");
        await expect(manage.locator("..")).toHaveAttribute("open", "");
        await page.keyboard.press("Space");
        await expect(manage.locator("..")).not.toHaveAttribute("open", "");
        await expect(manage).toBeFocused();
        assert.ok(await manage.evaluate(n => n.getBoundingClientRect().height >= 44 && getComputedStyle(n).outlineStyle !== "none"));
        assert.equal(await manage.locator(".saved-report-manage").evaluate(n => getComputedStyle(n, "::after").content), "none");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
});
