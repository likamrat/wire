import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, openAnalyzeFilters, navigateMain, selectActivityOption } from "../support/helpers.mjs";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";

async function setup(t) {
    const records = ["Lantern", "Cedar", null].map((project, i) => {
        const record = fixture(`planned-${i}`);
        Object.assign(record, { project, projectId: project && `project-${i}`, sourceSessionId: `chat-${i}` });
        record.userPrompt.text = ["Read Lantern notes.", "Read Cedar notes.", "Read the unassigned notes."][i];
        return record;
    });
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 980 }, colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(runtime.url);
    await expect(page.locator("#activityList article")).toHaveCount(3);
    return page;
}

test("a project choice filters by recorded project and preserves chats without one", async t => {
    const page = await setup(t);
    await page.setViewportSize({ width: 375, height: 900 });
    await openAnalyzeFilters(page);
    await page.locator("#moreFiltersToggle").click();
    const field = page.getByRole("combobox", { name: "Project", exact: true });
    await expect(field).toBeVisible();
    await field.click();
    for (const name of ["Lantern", "Cedar"]) await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await selectActivityOption(page, "projectFilter", "unscoped");
    await expect(page.locator("#activityList article")).toHaveCount(1);
    await expect(page.locator("#activityList article")).toContainText("Read the unassigned notes.");
});

test("switching appearance with the keyboard preserves unfinished report choices without preparing a copy", async t => {
    const page = await setup(t);
    await navigateMain(page, "reports");
    const keep = page.getByRole("radio", { name: /^Keep chat details\b/ });
    await keep.check();
    const formats = page.getByRole("button", { name: /^Formats:/ });
    await formats.click();
    await page.getByRole("checkbox", { name: /PDF/ }).check();
    await page.keyboard.press("Escape");
    const before = page.url(), selected = await formats.innerText(), writes = [];
    assert.match(selected, /PDF/);
    page.on("request", request => { if (request.method() === "POST" && /\/api\/(?:snapshot|preview|privacy-review|export)$/.test(request.url())) writes.push(request.url()); });
    const theme = page.getByRole("switch", { name: "Dark theme", exact: true });
    await theme.press("Enter");
    await expect(theme).toBeChecked(); await expect(theme).toBeFocused();
    await theme.press("Space");
    await expect(theme).not.toBeChecked(); await expect(theme).toBeFocused();
    await expect(keep).toBeChecked(); await expect(formats).toHaveText(selected);
    await expect(page).toHaveURL(before);
    assert.deepEqual(writes, []);
});
