import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { privateFixture } from "./helpers.mjs";

test("typed localhost entry redirects before app authority and preserves fragment routes on actual configured ports", async t => {
    const cleanups = [];
    const { context } = await privateFixture({ after: cleanup => cleanups.push(cleanup) });
    let runtime, access, browser;
    t.after(async () => {
        await browser?.close();
        await runtime?.close();
        await access?.close();
        for (const cleanup of cleanups) await cleanup();
    });
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage(), errors = [], external = [], aliasRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return route.continue();
        external.push(url.origin);
        return route.abort();
    });
    page.on("request", request => {
        if (new URL(request.url()).hostname === "localhost") aliasRequests.push({
            path: new URL(request.url()).pathname, method: request.method(), document: request.isNavigationRequest(),
        });
    });
    let port = 0;
    for (const route of ["#analyze", "#settings?section=connection"]) {
        runtime = await startServer(context, createExportController(context), {
            port, collector: { timers: false }, sourcePolicy: "copilot-only",
            createAccess: async () => access = await createCopilotRuntimeAccess(context),
        });
        const actualPort = Number(new URL(runtime.url).port);
        if (port) assert.equal(actualPort, port, "An explicit port must be preserved.");
        assert.equal(runtime.server.address().address, "127.0.0.1");
        const response = await page.goto(`http://localhost:${actualPort}/${route}`);
        assert.equal(response.status(), 200);
        assert.equal(page.url(), runtime.url + route, "The browser must preserve the original fragment through redirect.");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        if (route === "#analyze") await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        else await expect(page.locator("#settingsView")).toContainText("Connection & updates");
        const previous = response.request().redirectedFrom();
        assert.ok(previous);
        assert.equal(new URL(previous.url()).hostname, "localhost");
        const redirect = await previous.response();
        assert.equal(redirect.status(), 302);
        assert.equal(redirect.headers().location, runtime.url);
        assert.equal((await page.request.get(runtime.url + "health")).status(), 200);
        assert.equal(runtime.accessBootstrap.mode, "enforced");
        await page.goto("about:blank");
        await runtime.close(); runtime = null;
        await access.close(); access = null;
        port = actualPort;
    }
    assert.ok(aliasRequests.length >= 2);
    assert.ok(aliasRequests.every(request => request.path === "/" && request.method === "GET" && request.document),
        "No app asset, API request or write may use the localhost alias.");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
});
