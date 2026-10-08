import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, navigateMain, navigateSettings, openActivitySessions, chooseTheme } from "./helpers.mjs";
import { chooseReportScope, reportContents } from "./report-journey-helpers.mjs";

test("shared controls, insight spacing and contextual forms remain readable through real journeys", { timeout: 90000 }, async t => {
    const records = Array.from({ length: 3 }, (_, index) => {
        const row = fixture(`controls-${index}`);
        row.sourceSessionId = `invented-chat-${index}`;
        row.sourceSessionName = ["Calendar review", "Shared files", "Project updates"][index];
        row.userPrompt = { ...row.userPrompt, text: ["Find the meetings I need to prepare for.", "Find the shared planning document.", "Summarize the project updates."][index], sourceEventId: `prompt-${index}` };
        row.followUpPrompts = [];
        Object.assign(row.toolCalls[0], { startedAt: "2026-09-30T12:00:00Z", completedAt: "2026-09-30T12:00:01Z", durationMs: 1000,
            toolSucceeded: index !== 2, reportedOutcome: index === 2 ? "failed" : "succeeded" });
        return row;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    const errors = [], posts = [], measurements = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    const proof = process.env.WIRE_CONTROLS_PROOF_DIR;
    if (proof) await mkdir(proof, { recursive: true });
    async function screenshot(name, locator = page) {
        if (proof) await locator.screenshot({ path: path.join(proof, name + ".png") });
    }
    t.after(async () => {
        await browser.close(); await runtime.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.ok(posts.every(route => ["/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary", "/api/assessment/detail",
            "/api/assessment/overview", "/api/assessment/consent", "/api/deletion/preview", "/api/deletion/cancel"].includes(route)), "Only isolated reads and deletion preview/cancel: " + JSON.stringify(posts));
    });
    await page.goto(runtime.url + "#activity");
    await expect(page.locator("#activityInsights .assessment-grid")).toBeVisible();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await openActivitySessions(page);
        await page.evaluate(() => scrollTo(0, 0));
        await screenshot(`activity-${theme}`);
        await screenshot(`activity-rows-${theme}`, page.locator("#activityList .session-group").first());
        await page.locator("#activityList .request-link").first().click();
        await expect(page.locator(".interaction-insights .assessment-grid").first()).toBeVisible();
        await screenshot(`interaction-${theme}`);
        const details = page.locator(".interaction-insights [data-insight-details]").first();
        await details.click();
        await page.getByRole("dialog", { name: "Insight details", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
        await expect(details).toBeFocused();
        await details.click(); await page.keyboard.press("Escape"); await expect(details).toBeFocused();
        await navigateMain(page, "settings"); await navigateSettings(page, "collection");
        await screenshot(`settings-${theme}`);
        await navigateMain(page, "activity");
        await page.locator("#activityDeleteShortcut").click();
        await expect(page.locator("#deleteCancel")).toBeFocused();
        await screenshot(`deletion-edit-${theme}`, page.locator("#deleteDialog"));
        measurements.push(await page.locator("#deletePreview").evaluate(node => {
            const style = getComputedStyle(node), rect = node.getBoundingClientRect();
            const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
            const range = document.createRange(); range.selectNodeContents(text);
            const textRect = range.getBoundingClientRect();
            const help = node.previousElementSibling.getBoundingClientRect();
            return { consumer: "deletion", radius: parseFloat(style.borderRadius), width: rect.width,
                labelWidth: textRect.width, helperGap: rect.top - help.bottom, labelOffset: Math.abs((rect.left + rect.right - textRect.left - textRect.right) / 2) };
        }));
        await page.locator("#deleteAll").check(); await page.locator("#deletePreview").click();
        await expect(page.locator("#deleteConfirmation")).toBeVisible();
        await expect(page.locator("#deleteConfirm")).toHaveText("Delete 3 records");
        await screenshot(`deletion-preview-${theme}`, page.locator("#deleteDialog"));
        await page.keyboard.press("Escape");
        await expect(page.locator("#activityDeleteShortcut")).toBeFocused();
        await navigateMain(page, "reports"); await chooseReportScope(page, "all"); await reportContents(page);
        await screenshot(`report-options-${theme}`);
        await navigateMain(page, "activity");
        for (const width of [1200, 375]) for (const scale of [1, 2]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            await openActivitySessions(page);
            measurements.push(await page.evaluate(({ width, scale, theme }) => {
                const grid = document.querySelector("#activityInsights .assessment-grid").getBoundingClientRect();
                const list = document.querySelector("#activityPager").getBoundingClientRect();
                const badges = [...document.querySelectorAll("#activityList .result-link")].map(node => {
                    const style = getComputedStyle(node), paint = getComputedStyle(node, "::before"), rect = node.getBoundingClientRect();
                    return { height: rect.height, font: parseFloat(style.fontSize), radius: parseFloat(style.borderRadius),
                        paintHeight: rect.height - parseFloat(paint.top) - parseFloat(paint.bottom) };
                });
                return { consumer: "activity", width, scale, theme, overflow: document.documentElement.scrollWidth - innerWidth,
                    listGap: list.top - grid.bottom, badges };
            }, { width, scale, theme }));
            if (width === 375) {
                await screenshot(`activity-${theme}-${width}-${scale * 100}`);
                await screenshot(`insight-speed-${theme}-${width}-${scale * 100}`, page.locator("#activityInsights .assessment-dimension").nth(1));
                await screenshot(`activity-result-${theme}-${width}-${scale * 100}`, page.locator("#activityList .recorded-results").first());
            }
            await page.locator("#activityDeleteShortcut").click();
            await expect(page.locator("#deleteCancel")).toBeFocused();
            assert.ok(await page.locator("#deleteDialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
            if (width === 375) await screenshot(`deletion-${theme}-${width}-${scale * 100}`, page.locator("#deleteDialog"));
            await page.keyboard.press("Shift+Tab");
            assert.equal(await page.evaluate(() => document.activeElement.closest("dialog")?.id), "deleteDialog");
            await page.keyboard.press("Escape"); await expect(page.locator("#activityDeleteShortcut")).toBeFocused();
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1200, height: 1000 });
    }
    if (proof) await writeFile(path.join(proof, "measurements.json"), JSON.stringify(measurements, null, 2));
    for (const measurement of measurements) {
        if (measurement.consumer === "deletion") {
            assert.ok(measurement.radius <= 8, JSON.stringify(measurement));
            assert.ok(measurement.width - measurement.labelWidth <= 32, JSON.stringify(measurement));
            assert.ok(measurement.helperGap >= 12, JSON.stringify(measurement));
            assert.ok(measurement.labelOffset <= 1, JSON.stringify(measurement));
        } else {
            assert.ok(measurement.overflow <= 1, JSON.stringify(measurement));
            assert.ok(measurement.listGap >= 12, JSON.stringify(measurement));
            for (const badge of measurement.badges) {
                assert.ok(badge.height >= 44 && badge.font <= 12 * measurement.scale, JSON.stringify(measurement));
                assert.ok(badge.radius <= 8 && badge.paintHeight <= 28 * measurement.scale, JSON.stringify(measurement));
            }
        }
    }
});
