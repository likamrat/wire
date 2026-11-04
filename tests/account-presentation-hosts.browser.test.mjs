import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";

test("account presentation hosts are real, empty and hidden before activation", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false });
    const requests = [];
    await page.route("**/*", route => {
        requests.push(route.request().url());
        return route.abort();
    });
    await page.setContent(renderHtmlShell("a".repeat(64), "account-hosts"));
    for (const id of ["wireAccountEntry", "microsoftConnectionHost"]) {
        const host = page.locator("#" + id);
        await expect(host).toHaveCount(1);
        await expect(host).toHaveAttribute("hidden", "");
        await expect(host).toBeHidden();
        await expect(host).toHaveText("");
        assert.equal(await host.locator(":scope > *").count(), 0);
    }
    assert.equal(await page.locator("#wireAccountEntry").evaluate(node =>
        node.parentElement.id === "navigationFooter" && node.parentElement.firstElementChild === node
        && node.parentElement.parentElement.id === "navigationContent"), true);
    assert.equal(await page.locator("#microsoftConnectionHost").evaluate(node =>
        node.parentElement.dataset.settingsSection === "connection" && node.nextElementSibling.id === "connectionPreferences"), true);
    assert.deepEqual(requests, []);
});
