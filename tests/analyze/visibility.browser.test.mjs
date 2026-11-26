import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { replaceEvidence } from "../../lib/store.mjs";
import { fixture, privateFixture } from "../support/helpers.mjs";

test("return to a visible tab and reconnect after restart publish the latest records without reloading", async t => {
    const record = title => {
        const item = fixture("visibility");
        item.userPrompt.text = title;
        return item;
    };
    const { context } = await privateFixture(t, [record("Initial Lantern request.")]);
    const start = port => startServer(context, createExportController(context), { port, collector: { timers: false } });
    let runtime = await start(0);
    t.after(() => runtime.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(runtime.url);
    const card = page.locator("#activityList article");
    await expect(card).toContainText("Initial Lantern request.");
    let loads = 0, sessions = 0;
    const writes = [];
    page.on("request", req => {
        const path = new URL(req.url()).pathname;
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) loads++;
        if (path === "/api/session") sessions++;
        if (req.method() === "POST" && ["/api/collection/now", "/api/record", "/api/export", "/api/privacy-review"].includes(path)) writes.push(path);
    });
    const replace = title => replaceEvidence(context, () => ({ records: [record(title)], importCoverage: { counts: {}, roster: [] } }));
    await replace("Changed while away.");
    // Exercise the document handler, not the native Copilot panel lifecycle.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(card).toContainText("Changed while away.");
    const port = runtime.server.address().port;
    await runtime.close();
    await replace("After the runtime restart.");
    runtime = await start(port);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(card).toContainText("After the runtime restart.");
    assert.equal(sessions, 1, "Renew the old capability once");
    assert.equal(loads, 0);
    await card.getByRole("link", { name: "1 tool call completed" }).click();
    await expect(page.getByRole("dialog", { name: "Interaction" })).toContainText("After the runtime restart.");
    assert.deepEqual(writes, []);
});
