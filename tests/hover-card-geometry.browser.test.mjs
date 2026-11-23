import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

async function setup(t, viewport, colorScheme) {
    const records = ["/me/events", "/me/messages", "/me/messages"].map((path, i) => {
        const record = fixture(`lantern-${i}`);
        record.userPrompt.text = ["Find the Lantern planning meeting.", "Find the launch update.", "Find the sign-off mail."][i];
        record.toolCalls[0].requestedApiPath = path;
        record.toolCalls[0].requestArgs = { entityUrls: [path] };
        return record;
    });
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport, colorScheme, reducedMotion: "reduce" });
    await page.goto(runtime.url);
    const card = page.getByRole("region", { name: "Services and operations" });
    const row = card.getByRole("listitem").filter({ hasText: "Calendar" });
    const calendar = row.getByRole("link", { name: /^Calendar: 1 of 3 Work IQ tool calls/ });
    await expect(calendar).toBeVisible();
    return { page, row, calendar };
}

async function calendarOnly(page) {
    await expect(page.locator("#activityList article")).toHaveCount(1);
    await expect(page.locator("#activityList article")).toContainText("Find the Lantern planning meeting.");
}

test("the service count shares its row's native link; modified click leaves Analyze in place", async t => {
    const { page, row, calendar } = await setup(t, { width: 1280, height: 900 }, "light");
    await expect(row.getByRole("link")).toHaveCount(1);
    await expect(row).toContainText(/33(?:\.3)?%\s*\(1\)/);
    await row.scrollIntoViewIfNeeded();
    const count = row.getByText("(1)", { exact: true });
    const box = await count.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y);
    assert.ok(await calendar.evaluate(link => link.matches(":hover")), "Hovering the count reaches the service link");
    const origin = page.url(), opened = page.context().waitForEvent("page");
    await page.keyboard.down("Control");
    try { await page.mouse.click(point.x, point.y); }
    finally { await page.keyboard.up("Control"); }
    const popup = await opened;
    try {
        await calendarOnly(popup);
        await expect(page).toHaveURL(origin);
        await expect(page.locator("#activityList article")).toHaveCount(3);
    } finally { await popup.close(); }
});

test("the narrow, enlarged service row stays readable and reachable with a visible keyboard focus", async t => {
    const { page, row, calendar } = await setup(t, { width: 375, height: 900 }, "dark");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await calendar.focus();
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(calendar).toBeFocused();
    assert.ok(await row.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.height >= 44 && bounds.left >= 0 && bounds.right <= innerWidth + 1 &&
            node.scrollWidth <= node.clientWidth + 1;
    }), "The complete label and count fit one usable target");
    assert.ok(await calendar.evaluate(link => [link, link.closest("li")].some(node => {
        const style = getComputedStyle(node);
        return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
    })), "Tab visibly outlines the service target");
    await page.keyboard.press("Enter");
    await calendarOnly(page);
});
