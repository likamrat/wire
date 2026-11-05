import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createProfileSource, profilePNG } from "./source-profile-fixture.mjs";
import { privateFixture, chooseTheme } from "./helpers.mjs";

test("ordinary approved-source profile inherits workspace/default avatars and clears changes across local logout", { timeout: 60000 }, async t => {
    const cleanups = [], { root, context } = await privateFixture({ after: work => cleanups.push(work) });
    const source = await createProfileSource(root), requests = [], external = [], errors = [];
    let access, runtime, browser;
    t.after(async () => {
        await browser?.close(); await runtime?.close(); await access?.close(); source.db.close();
        for (const cleanup of cleanups.reverse()) await cleanup();
        assert.deepEqual(external, []); assert.deepEqual(errors, []);
    });
    access = await createCopilotRuntimeAccess(context);
    runtime = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false },
        githubProfile: { fetch: async (url, options) => {
            requests.push(url);
            assert.match(url, /^https:\/\/avatars\.githubusercontent\.com\/u\/7000[12]\?v=\d+&s=96$/);
            assert.equal(options.credentials, "omit");
            assert.equal(options.headers.Authorization, undefined);
            return new Response(profilePNG, { headers: { "content-type": "image/png" } });
        } } });
    const origin = new URL(runtime.url).origin;
    const session = await fetch(origin + "/api/session", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" }).then(response => response.json());
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": session.capability };
    const beforeConnect = await fetch(origin + "/api/profile/github", { headers }).then(response => response.json());
    assert.equal(beforeConnect.identity.state, "unavailable");
    assert.equal(requests.length, 0);
    const configured = await fetch(origin + "/api/collection/configure", { method: "POST", headers,
        body: JSON.stringify({ appDbPath: source.appDbPath, sessionRoot: source.sessionRoot,
            approved: true, enabled: false, windowDays: 30, pollSeconds: 60 }) });
    assert.equal(configured.status, 200, await configured.text());
    const inherited = await fetch(origin + "/api/profile/github", { headers }).then(response => response.json());
    assert.equal(inherited.identity.state, "verified", JSON.stringify(inherited.issues));
    const before = await loadBoardState(context);
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const pages = [];
    for (let index = 0; index < 2; index++) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on("pageerror", error => errors.push(error.message));
        await page.route(url => url.origin !== origin, route => { external.push(route.request().url()); return route.abort(); });
        await page.goto(runtime.url + "#settings?section=connection");
        await expect(page.locator("#wireAccountTrigger")).toContainText("Morgan Rivera");
        await expect(page.locator("#wireAccountTrigger img")).toBeVisible();
        assert.equal(await page.locator("#wireAccountTrigger img").evaluate(image => image.complete && image.naturalWidth > 0), true);
        await expect(page.locator("#wireAccountTrigger")).toHaveAccessibleName("Copilot app profile: Morgan Rivera");
        await expect(page.locator("#wireAccountTrigger .wire-account-copy")).toHaveText("Morgan Rivera");
        await expect(page.locator("#wireAccountTrigger .wire-account-copy small")).toBeHidden();
        pages.push(page);
    }
    const [page, second] = pages, oldURL = await page.locator("#wireAccountTrigger img").getAttribute("src");
    source.db.exec("DELETE FROM app_state WHERE key='activeWorkspaceId'");
    for (const panel of pages) {
        await panel.evaluate(() => dispatchEvent(new Event("focus")));
        await expect(panel.locator("#wireAccountTrigger .wire-account-copy")).toHaveText("Riley Chen");
        await expect(panel.locator("#wireAccountTrigger")).not.toContainText("riley_managed");
        await expect(panel.locator("#wireAccountTrigger img")).toBeVisible();
    }
    assert.equal((await fetch(origin + oldURL, { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 404);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#wireAccountTrigger").click();
        await expect(page.locator("#wireAccountGate")).toBeFocused();
        if (process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS) {
            await mkdir(process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS, `inherited-${theme}-desktop.png`) });
        }
        await page.keyboard.press("Escape");
        await expect(page.locator("#wireAccountTrigger")).toBeFocused();
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.locator("#navigationToggle").click();
        await page.locator("#wireAccountTrigger").click();
        await expect(page.locator(".wire-account-identity small")).toHaveText("GitHub profile: @riley_managed");
        await expect(page.locator("#wireAccountGate")).toBeFocused();
        const bounds = await page.locator("#wireAccountMenu").boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0);
        if (process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS) {
            await mkdir(process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS, `inherited-${theme}-390.png`) });
        }
        await page.keyboard.press("Escape");
        await expect(page.locator("#wireAccountTrigger")).toBeFocused();
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const currentImage = await second.locator("#wireAccountTrigger img").getAttribute("src");
    await page.locator("#wireAccountTrigger").click();
    await page.locator("#wireAccountGate").click();
    await expect(second.locator("#message")).toContainText("signed out");
    await expect(second.locator("#wireAccountTrigger img")).toHaveCount(0);
    await expect(second.locator("#wireAccountTrigger")).not.toContainText("riley_managed");
    assert.equal((await fetch(origin + currentImage, { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 403);
    await second.reload();
    await expect(second.locator("#message")).toContainText("signed out");
    if (!await page.locator("#wireAccountMenu").isVisible()) await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toHaveText("Sign in to WIRE");
    await page.locator("#wireAccountGate").click();
    await expect(second.locator("#wireAccountTrigger .wire-account-copy")).toHaveText("Riley Chen");
    await expect(second.locator("#wireAccountTrigger img")).toBeVisible();
    assert.deepEqual(await loadBoardState(context), before);
    source.db.exec("DELETE FROM accounts WHERE kind='github'");
    await second.evaluate(() => dispatchEvent(new Event("focus")));
    await expect(second.locator("#wireAccountTrigger img")).toHaveCount(0);
    await expect(second.locator("#wireAccountTrigger")).not.toContainText("Riley");
    assert.ok(requests.length >= 2);
});
