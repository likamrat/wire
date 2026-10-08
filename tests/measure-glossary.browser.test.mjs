import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

test("measure help and glossary explain real unavailable facts without hover resurrection or lost scope", { timeout: 60000 }, async t => {
    const records = [fixture("glossary-a"), fixture("glossary-b")];
    Object.assign(records[0].toolCalls[0], {
        completionEventId: "complete-a", startedAt: "2026-09-30T12:00:00.000Z",
        completedAt: "2026-09-30T12:00:01.200Z", durationMs: 1200,
    });
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", hasTouch: true });
    page.setDefaultTimeout(5000);
    const errors = [], writes = [], foreign = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (new URL(request.url()).origin !== new URL(runtime.url).origin) foreign.push(request.url());
        if (request.method() === "POST" && !["/api/snapshot", "/api/assessment/overview", "/api/assessment/detail", "/api/collection/status", "/api/session", "/api/evaluation/automatic/summary"].includes(new URL(request.url()).pathname)) writes.push(new URL(request.url()).pathname);
    });
    await page.goto(runtime.url + "#request?request=glossary-a");
    const insights = page.locator(".interaction-insights");
    await insights.locator(".assessment-grid").waitFor().catch(error => {
        throw new Error(`Interaction did not render. Browser errors: ${JSON.stringify(errors)}. ${error.message}`);
    });
    assert.match(await insights.innerText(), /Results for 0 of 1 request/);
    assert.doesNotMatch(await insights.innerText(), /\bCost\b/);
    for (const term of ["Accuracy", "Speed", "Trust"]) {
        const help = insights.getByRole("button", { name: `About ${term}`, exact: true });
        await help.click();
        await page.getByRole("tooltip").waitFor();
        assert.ok((await page.getByRole("tooltip").innerText()).length > 30);
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        await page.waitForTimeout(250);
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "Dismissed help stays dismissed while pointer and focus remain");
    }
    const help = insights.getByRole("button", { name: "About Accuracy", exact: true });
    await insights.getByRole("button", { name: "Details and feedback", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await help.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    await page.getByRole("tooltip").waitFor();
    await page.keyboard.press("Escape");
    const definitions = insights.getByRole("button", { name: "Details and feedback", exact: true });
    await definitions.click();
    const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
    await dialog.getByText("Glossary", { exact: true }).click();
    const glossary = dialog.locator("[data-measure-glossary]");
    assert.equal(await glossary.locator("dt").count(), 7);
    assert.match(await glossary.innerText(), /Answer trust/);
    assert.match(await glossary.innerText(), /Action trust/);
    await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
    assert.match(await dialog.innerText(), /No current answer assessment/);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await definitions.evaluate(node => node === document.activeElement), true);
    for (const [theme, width] of [["light", 1440], ["dark", 1440], ["light", 375], ["dark", 375]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        for (const dimension of ["answer-trust", "action-trust"]) {
            const row = insights.locator(`[data-dimension="${dimension}"]`).first();
            const order = await row.evaluate(node => {
                const coverage = node.querySelector(".assessment-coverage").getBoundingClientRect();
                const value = node.querySelector(".assessment-value").getBoundingClientRect();
                return coverage.bottom <= value.top;
            });
            assert.ok(order, "Check coverage reads before its unavailable result.");
            assert.equal(await row.locator(".assessment-value").innerText(), "No result");
        }
        if (process.env.WIRE_MEASURE_PROOFS) {
            await mkdir(process.env.WIRE_MEASURE_PROOFS, { recursive: true });
            await insights.screenshot({ path: path.join(process.env.WIRE_MEASURE_PROOFS, `measures-${theme}-${width}.png`) });
        }
    }
    await help.tap();
    await page.getByRole("tooltip").waitFor();
    await insights.getByRole("heading", { name: "Insights", exact: true }).tap();
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    await definitions.click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await definitions.evaluate(node => node === document.activeElement), true);
    await page.goto(runtime.url + "#home");
    await page.locator("#homeInsights .assessment-grid").waitFor();
    await page.goBack();
    await insights.locator(".assessment-grid").waitFor();
    assert.match(await insights.innerText(), /1.2 s/);
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(foreign, []);
});
