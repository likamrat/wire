import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption, revealAnalyzeRecords } from "./helpers.mjs";

const proofs = process.env.WIRE_ICON_ROLE_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, name + ".png") });
}
async function setup(t, { touch = false } = {}) {
    const paths = ["/me/drive/root", "/me/calendarView", "/me/messages", "/me/joinedTeams",
        "/me/people", "/me/todo/lists", "/me/onenote/notebooks", "/users",
        "/me/drive/root", "/me/drive/root", "/me/drive/root", "/me/drive/root"];
    const records = [fixture("screen-icons-0"), fixture("screen-icons-1")].map((record, group) => {
        record.userPrompt.text = "Inspect the invented service requests and their recorded results.";
        record.sourceSessionName = "Invented service review";
        record.toolCalls = paths.slice(group * 6, group * 6 + 6).map((target, offset) => {
            const index = group * 6 + offset;
            return { ...record.toolCalls[0], toolCallId: `icon-call-${index}`, startEventId: `icon-start-${index}`,
                requestArgs: { entityUrls: [target] }, requestedApiPath: target,
                toolSucceeded: index < 7, reportedOutcome: index < 7 ? "succeeded" : "failed",
                apiResults: [{ index: 0, statusCode: index < 7 ? 200 : 403 }] };
        });
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw Error("No icon proof providers"); },
            readSource: async () => { throw Error("No icon proof source reads"); } } });
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined,
        ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--force-device-scale-factor=1.5"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", hasTouch: touch });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            assert.deepEqual(errors, []);
            const after = await loadBoardState(context);
            for (const field of ["evidence", "exports", "personalEvaluation", "cards"]) assert.deepEqual(after[field], before[field]);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url); await ready(page); await page.evaluate(() => document.fonts.ready);
    return page;
}
async function opticalSize(locator, size) {
    assert.ok(await locator.count() > 0, "The intended screen role must actually be present");
    for (const node of await locator.all()) {
        const actual = await node.evaluate(icon => {
            const box = icon.getBoundingClientRect();
            return { asset: icon.dataset.lucideIcon, size: Number(icon.dataset.iconSize), width: box.width, height: box.height,
                decorative: icon.getAttribute("aria-hidden"), focusable: icon.getAttribute("focusable") };
        });
        assert.ok(actual.asset);
        assert.equal(actual.size, size);
        assert.ok(Math.abs(actual.width - size) < .1 && Math.abs(actual.height - size) < .1, JSON.stringify(actual));
        assert.equal(actual.decorative, "true"); assert.equal(actual.focusable, "false");
    }
}
async function serviceGeometry(page) {
    const metrics = await page.locator('#percentageCharts [data-breakdown=services] .percentage-legend-row').evaluateAll(rows => rows.map(row => {
        const box = node => node.getBoundingClientRect();
        return { row: box(row).toJSON(), label: box(row.querySelector(".percentage-label")).toJSON(),
            count: box(row.querySelector(".percentage-value")).toJSON(), bar: box(row.querySelector(".percentage-bar-track")).toJSON() };
    }));
    assert.ok(metrics.length > 0);
    for (const { row, label, count, bar } of metrics) {
        assert.ok(Math.abs(label.x - row.x - 28) < 1 && Math.abs(bar.x - label.x) < 1,
            "Service glyphs retain the original 20px column plus 8px gap footprint for labels and bars");
        assert.ok(Math.abs(count.right - row.right) < 1 && Math.abs(bar.right - row.right) < 1);
        assert.ok(label.width >= 44 && label.height >= 44, "Accepted label hit targets do not shrink");
    }
}
async function metadataAlignment(page) {
    const offsets = await page.locator("#activityList .service-cue").evaluateAll(nodes => nodes.map(node => {
        const icon = node.querySelector(".wire-icon").getBoundingClientRect();
        const text = node.querySelector(".metadata-label") || node.querySelector(":scope>span");
        return icon.y + icon.height / 2 - text.getBoundingClientRect().y - parseFloat(getComputedStyle(text).lineHeight) / 2;
    }));
    assert.ok(offsets.length && offsets.every(offset => Number.isFinite(offset) && Math.abs(offset) < 1), JSON.stringify(offsets));
}
test("screen service, Settings, reader and report-control icons use coherent optical roles", async t => {
    const page = await setup(t);
    await opticalSize(page.locator("#themePreference .wire-icon"), 20);
    await opticalSize(page.locator("#percentageCharts [data-breakdown=services] .percentage-cue .wire-icon"), 24);
    await serviceGeometry(page);
    await page.locator("#percentageCharts").scrollIntoViewIfNeeded();
    await capture(page, "service-legends");
    await revealAnalyzeRecords(page);
    assert.equal(await page.locator("#activityList .request-row svg").count(), 0, "Minimal cards do not repeat decorative status/service glyphs");
    await page.locator('[data-analyze-mode="calls"]').click();
    await opticalSize(page.locator("#activityList .service-cue .wire-icon"), 24);
    await opticalSize(page.locator("#activityList .recorded-result .wire-icon"), 16);
    await metadataAlignment(page);
    await capture(page, "service-and-result-roles");
    await page.locator("#activityList .request-link").first().click(); await ready(page);
    await opticalSize(page.locator("#requestContent .service-cue .wire-icon"), 24);
    await opticalSize(page.locator("#requestContent .ux-copy:visible .wire-icon"), 20);
    await capture(page, "reader-roles");
    await navigateMain(page, "reports"); await ready(page);
    await page.getByRole("link", { name: "Create a report", exact: true }).click();
    await opticalSize(page.locator("#reportsView .ux-help:visible .wire-icon"), 16);
    await capture(page, "report-workspace-roles");
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "privacy");
    await page.locator("#deleteActivity").click();
    await expect(page.locator("#deleteDialog")).toBeVisible();
    await opticalSize(page.locator("#deleteWarningIcon .wire-icon"), 20);
    await capture(page, "dialog-warning-role");
    await page.locator("#deleteCancel").click();
    for (const [width, textScale, theme] of [[1440, 1, "light"], [375, 2, "dark"]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, textScale);
        await chooseTheme(page, theme);
        await navigateSettings(page, "connection");
        if (!await page.locator("#settingsCategoryNav").isVisible()) await page.locator("#settingsCategorySummary").click();
        assert.equal(await page.locator("#settingsCategoryNav .wire-icon").count(), 0);
        const metrics = await page.locator("#settingsCategoryNav a").evaluateAll(nodes => nodes.map(node => {
            const label = node.querySelector(".settings-category-label"), rect = label.getBoundingClientRect();
            return { label: label.textContent, targetHeight: node.getBoundingClientRect().height, fits: rect.right <= innerWidth };
        }));
        assert.ok(metrics.length === 5 && metrics.every(row => row.label && row.targetHeight >= 44 && row.fits), JSON.stringify(metrics));
        await capture(page, `settings-${theme}-${width}-text${textScale}`);
        if (proofs) await writeFile(path.join(proofs, `settings-${theme}-${width}.json`), JSON.stringify(metrics, null, 2));
        await navigateSettings(page, "display");
        await page.locator('[data-select-id="displayTimeZone"]').click();
        await opticalSize(page.locator('.select-popup .select-option[aria-selected=true] .select-check'), 16);
        await capture(page, `single-select-${theme}-${width}`);
        await page.keyboard.press("Escape");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await navigateMain(page, "analyze"); await ready(page);
    await serviceGeometry(page);
    await page.locator("#percentageCharts").scrollIntoViewIfNeeded();
    await capture(page, "service-legends-narrow-enlarged");
    await revealAnalyzeRecords(page);
    await page.locator('[data-analyze-mode="calls"]').click();
    await opticalSize(page.locator("#activityList .service-cue .wire-icon"), 24);
    await metadataAlignment(page);
    await page.locator("#activityList .service-cue").first().scrollIntoViewIfNeeded();
    await capture(page, "service-metadata-narrow-enlarged");
});

test("Reset Analyze uses a clear reset glyph distinct from Refresh without changing its behavior", async t => {
    const page = await setup(t), metrics = [];
    const reset = page.locator("#resetView");
    const measure = phase => page.evaluate(phase => {
        const control = document.querySelector("#resetView"), icon = control.querySelector(".wire-icon");
        const refresh = document.querySelector("#checkActivity .wire-icon");
        const rect = node => node.getBoundingClientRect().toJSON();
        return { phase, disabled: control.disabled, parent: control.parentElement.id, asset: icon.dataset.lucideIcon,
            icon: rect(icon), target: rect(control), label: control.getAttribute("aria-label"),
            opacity: getComputedStyle(icon).opacity, color: getComputedStyle(icon).color, fill: getComputedStyle(icon).fill, stroke: getComputedStyle(icon).stroke,
            outline: getComputedStyle(control).outlineStyle, refreshAsset: refresh.dataset.lucideIcon, refresh: rect(refresh) };
    }, phase);
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1100 }); await chooseTheme(page, theme);
        await expect(reset).toBeDisabled();
        const parent = await reset.evaluate(node => node.parentElement.id);
        metrics.push({ theme, width, ...await measure("disabled") });
        await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
        await expect(reset).toBeEnabled();
        await page.mouse.move(0, 0);
        const enabled = await measure("enabled");
        metrics.push({ theme, width, ...enabled });
        await reset.hover();
        metrics.push({ theme, width, ...await measure("hover") });
        await capture(page, `reset-${theme}-${width}-hover`);
        await reset.focus(); await page.keyboard.press("Shift");
        const focused = await measure("focus");
        metrics.push({ theme, width, ...focused });
        assert.notEqual(focused.outline, "none");
        await capture(page, `reset-${theme}-${width}-focus`);
        await page.locator(".request-card-open").first().click();
        await page.locator("#requestReportToggle").click();
        await page.locator("#closeContextSidebar").click();
        await reset.press("Enter"); await ready(page);
        await expect(reset).toBeDisabled();
        await page.locator(".request-card-open").first().click();
        await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
        await page.locator("#requestReportToggle").click();
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#serviceAssociationFilter")).toHaveValue("all");
        assert.equal(await reset.evaluate(node => node.parentElement.id), parent);
        assert.equal((await reset.textContent()).trim(), "");
        assert.equal(enabled.label, "Reset Analyze");
        assert.ok(Math.abs(enabled.target.height - 44) < .1 && enabled.target.width >= 44, "The larger native glyph does not grow the existing 44px control");
        assert.ok(Math.abs(enabled.icon.y + enabled.icon.height / 2 - enabled.target.y - enabled.target.height / 2) < 2,
            "Reset glyph stays centered in its icon-only target");
        assert.equal(enabled.opacity, "1", "Enabled glyph is not faded by a competing style");
        assert.equal(enabled.fill, "none");
        assert.equal(enabled.stroke, enabled.color, "Official strokes inherit the control's foreground");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    if (proofs) await writeFile(path.join(proofs, "reset-icon-roles.json"), JSON.stringify(metrics, null, 2));
    assert.ok(metrics.every(entry => entry.asset === "rotate-ccw"), "Reset uses its own official return-to-start glyph");
    assert.ok(metrics.every(entry => Math.abs(entry.icon.width - 20) < .1 && Math.abs(entry.icon.height - 20) < .1));
    assert.ok(metrics.every(entry => entry.refreshAsset === "refresh-cw" && Math.abs(entry.refresh.width - 20) < .1),
        "Nearby Refresh retains its separate clockwise action and role");
});

test("Outcome status glyphs and selection checks align independently without changing draft semantics", async t => {
    const page = await setup(t, { touch: true });
    async function checkPaint(row, selected) {
        const paint = await row.locator(".select-check").evaluate(svg => ({
            outline: getComputedStyle(svg).outlineStyle,
            outlineWidth: parseFloat(getComputedStyle(svg).outlineWidth),
            paths: [...svg.querySelectorAll("path,polyline")].map(node => {
                const style = getComputedStyle(node);
                return { visible: node.checkVisibility({ visibilityProperty: true }), stroke: style.stroke, opacity: style.opacity };
            }),
        }));
        assert.ok(paint.outline !== "none" && paint.outlineWidth > 0, "The checkbox affordance remains visible");
        assert.ok(paint.paths.length > 0);
        assert.ok(paint.paths.every(shape => (shape.visible && Number(shape.opacity) > 0 && !["none", "transparent", "rgba(0, 0, 0, 0)"].includes(shape.stroke)) === selected),
            `Selected=${selected}: actual Lucide stroke paint ${JSON.stringify(paint)}`);
    }
    for (const [width, scale, theme] of [[1440, 1, "light"], [375, 2, "dark"]]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await page.locator('[data-select-id="outcomeFilter"]').click();
        const rows = page.locator(".select-popup .select-option"), popup = page.locator(".select-popup");
        await expect(rows).toHaveCount(6);
        await opticalSize(rows.locator(".result-legend-icon .wire-icon"), 20);
        const metrics = await rows.evaluateAll(nodes => nodes.map(node => {
            const left = node.querySelector(".result-legend-icon").getBoundingClientRect();
            const label = node.querySelector(".result-option-label"), text = label.getBoundingClientRect();
            const check = node.querySelector(".select-check"), box = check.getBoundingClientRect(), style = getComputedStyle(check);
            return { value: node.dataset.value, text: label.textContent, leftX: left.x, rightX: box.x,
                statusAlignment: left.y + left.height / 2 - text.y - parseFloat(getComputedStyle(label).lineHeight) / 2,
                checkSize: box.width, checkContentSize: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
                    - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
                checkAsset: check.dataset.lucideIcon, height: node.getBoundingClientRect().height };
        }));
        assert.ok(metrics.every(row => Math.abs(row.statusAlignment) < 1 && row.height >= 44));
        assert.equal(new Set(metrics.map(row => row.leftX)).size, 1);
        assert.equal(new Set(metrics.map(row => row.rightX)).size, 1);
        assert.ok(metrics.every(row => Math.abs(row.checkSize - 20) < .1 && Math.abs(row.checkContentSize - 16) < .1 && row.checkAsset === "check"));
        assert.deepEqual(metrics.map(row => row.value), ["success", "failure", "unknown", "partial", "other", "transport"]);
        assert.match(metrics[0].text, /\(7\)/); assert.match(metrics[1].text, /\(5\)/);
        assert.ok(metrics.slice(2).every(row => row.text.endsWith("(0)")));
        await rows.first().hover(); await capture(page, `outcome-${theme}-${width}-selected`);
        await rows.first().click();
        await expect(rows.first()).toHaveAttribute("aria-selected", "false");
        await checkPaint(rows.first(), false);
        await checkPaint(rows.nth(1), true);
        await expect(page.locator("#activityCount")).toHaveText("12");
        await capture(page, `outcome-${theme}-${width}-draft`);
        await expect(popup.getByRole("checkbox", { name: /^Select all results/ })).toHaveAttribute("aria-checked", "mixed");
        await popup.getByRole("checkbox", { name: /^Select all results/ }).click();
        await popup.getByRole("checkbox", { name: /^Deselect all results/ }).click();
        await expect(popup.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
        await popup.getByRole("checkbox", { name: /^Select all results/ }).click();
        await popup.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.locator('[data-select-id="outcomeFilter"]').click();
        await expect(rows.first()).toHaveAttribute("aria-selected", "true");
        await checkPaint(rows.first(), true);
        await page.locator('[data-select-id="outcomeFilter"]').press("Space");
        await expect(rows.first()).toHaveAttribute("aria-selected", "false");
        await checkPaint(rows.first(), false);
        await page.keyboard.press("Escape"); await expect(popup).toBeHidden();
        await expect(page.locator('[data-select-id="outcomeFilter"]')).toBeFocused();
        await expect(page.locator("#activityCount")).toHaveText("12");
        await page.locator('[data-select-id="outcomeFilter"]').tap();
        await checkPaint(rows.first(), true);
        await rows.first().tap();
        await checkPaint(rows.first(), false);
        await popup.getByRole("button", { name: "Apply", exact: true }).tap(); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("5");
        await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("12");
        if (proofs) await writeFile(path.join(proofs, `outcome-${theme}-${width}.json`), JSON.stringify(metrics, null, 2));
    }
    await page.emulateMedia({ forcedColors: "active" });
    await page.locator('[data-select-id="outcomeFilter"]').click();
    const outlines = await page.locator(".select-popup-multiple .select-check").evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    }));
    assert.ok(outlines.length === 6 && outlines.every(value => value.outline !== "none" && value.width > 0),
        "Selection outlines remain visible in forced colors");
    await page.keyboard.press("Escape");
});
