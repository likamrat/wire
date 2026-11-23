import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { visualWidgetFixture } from "./visual-widget-fixture.mjs";

async function setup(t, records) {
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce", timezoneId: "UTC" });
    const reading = page.waitForResponse(r => r.ok() && r.url().endsWith("/api/snapshot")).then(r => r.json());
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    return { page, analytics: (await reading).analytics };
}

test("service and operation rows lead to the accepted unique calls, not a count-sized substitute", async t => {
    const { page, analytics } = await setup(t, visualWidgetFixture().evidence);
    const widget = page.getByRole("region", { name: "Services and operations", exact: true });
    await expect(widget).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText("247");
    await expect(page.locator("#activityListSummary")).toHaveText("79 interactions · 247 matching tool calls");
    await expect(page.locator('#outcomeChart li[data-category="failure"]')).toHaveAttribute("data-count", "33");
    await expect(page.locator('#outcomeChart li[data-category="unknown"]')).toHaveAttribute("data-count", "2");
    await expect(page.locator('[data-breakdown="tools"] .percentage-legend-row')).toHaveCount(8);
    for (const [selector, count, includes] of [
        ["[data-category=Files]", 37, row => row.serviceAssociation.services.includes("Files")],
        ["[data-service-basis=Search]", 84, row => row.serviceAssociation.basis === "tool-purpose" && row.serviceAssociation.services.includes("Search")],
        ["[data-service-basis=Discovery]", 63, row => row.serviceAssociation.status === "not-applicable"],
        ["[data-service-basis=Assistance]", 20, row => row.tool === "workiq-ask" && row.serviceAssociation.gaps.some(gap => gap.reason === "hosted-routing")],
    ]) {
        const link = widget.locator(selector + " .percentage-label");
        await expect(widget.locator(selector)).toHaveAttribute("data-count", String(count));
        const expected = analytics.rows.filter(includes).map(row => row.id).sort();
        assert.equal(expected.length, count);
        await link.press("Enter");
        await expect(page.locator("#activityListSummary")).toContainText(`${count} matching tool calls`);
        if (selector === "[data-category=Files]") {
            await page.locator("#outcomeChart").getByRole("link", { name: `View all ${count} Work IQ tool calls`, exact: true }).click();
        }
        const rows = page.locator("#activityList .widget-record");
        const actual = [];
        while (actual.length < count) {
            const ids = await rows.evaluateAll(nodes => nodes.map(n => n.dataset.actionId));
            assert.ok(ids.length && ids.every(id => !actual.includes(id)), `${selector}: expected a new page of calls`);
            actual.push(...ids);
            if (actual.length < count) await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
        }
        assert.deepEqual(actual.sort(), expected);
        await page.goto(new URL("/", page.url()).href);
        await expect(page.locator("#activityCount")).toHaveText("247");
    }
});

test("one call can involve many services; recorded search targets do not become searches by tool purpose", async t => {
    const record = fixture("service-overlap");
    const paths = ["/me/messages", "/me/calendarView", "/me/drive/root", "/me/chats", "/me/people", "/planner/plans", "/me/onenote/notebooks", "/groups", "/search/query"];
    record.toolCalls = [
        { ...record.toolCalls[0], requestArgs: { entityUrls: [...paths, "/unrecognized/resource"] }, requestedApiPath: null },
        { tool: "workiq-get_schema", toolCallId: "prep", startEventId: "prep-start", requestArgs: { path: "/me/messages" }, toolSucceeded: true },
        { tool: "workiq-retrieve", toolCallId: "purpose", startEventId: "purpose-start", requestArgs: { query: "Invented survey notes" }, toolSucceeded: true },
    ];
    const { page, analytics } = await setup(t, [record]);
    const widget = page.locator('[data-breakdown="services"]');
    const targets = widget.locator("[data-category]");
    await expect(targets).toHaveCount(9);
    for (const row of await targets.all()) {
        await expect(row.locator(".percentage-value")).toHaveText("33.3% (1)");
        const bar = row.locator(".percentage-bar");
        assert.equal(Number(await bar.getAttribute("data-fraction")), 1 / 3);
        const { fill, track } = await bar.evaluate(n => ({ fill: n.getBoundingClientRect().width, track: n.parentElement.getBoundingClientRect().width }));
        assert.ok(track > 0 && Math.abs(fill - track / 3) < 0.1);
    }
    await expect(widget.locator("[data-category=Search]")).toHaveAttribute("data-count", "1");
    await expect(widget.locator("[data-service-basis=Search]")).toHaveAttribute("data-count", "1");
    await widget.locator("[data-service-basis=Search] .percentage-label").click();
    await expect(page.locator("#activityList .widget-record")).toHaveAttribute("data-action-id", analytics.rows.find(row => row.toolCallId === "purpose").id);
    await expect(page.locator("#activityListSummary")).toContainText("1 matching tool call");
    await expect(page.locator("#activityCount")).toHaveText("3");
    await page.goBack(); await expect(page.locator("#activityCount")).toHaveText("3");
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    assert.deepEqual(await widget.locator(".percentage-label,.percentage-value").evaluateAll(nodes =>
        nodes.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent)), []);
});
