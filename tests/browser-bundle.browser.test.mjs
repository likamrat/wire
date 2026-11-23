import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, navigateMain } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { loadBrowserAssets } from "../lib/browser-assets.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { replaceEvidence } from "../lib/store.mjs";

async function setup(t, { enforced = false, frontend = "bundled" } = {}) {
    const cleanup = [];
    const { context } = await privateFixture({ after: work => cleanup.push(work) }, [fixture("bundled-first"), fixture("bundled-second")]);
    const access = enforced ? await createCopilotRuntimeAccess(context) : undefined;
    const runtime = await startServer(context, createExportController(context), {
        port: 0, frontend, access, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw new Error("No providers in browser delivery proof."); } },
    });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    t.after(async () => {
        await browser.close(); await runtime.close(); await access?.close();
        for (const work of cleanup.reverse()) await work();
    });
    return { page, runtime, context };
}

for (const frontend of ["bundled", "react"]) {
test(`reader controls stay compact with doubled text in both layouts (${frontend})`, async t => {
    const { page, runtime } = await setup(t, { frontend });
    await page.setViewportSize({ width: 2800, height: 1000 });
    await page.goto(runtime.url);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    const prompt = page.locator("#activityList .request-card-open").first();
    await prompt.click();
    const reader = page.locator("#contextSidebar");
    for (const [mode, names] of [
        ["docked", ["Narrow interaction", "Widen interaction", "Maximize interaction", "Close interaction"]],
        ["overlay", ["Close interaction"]],
    ]) {
        if (mode === "overlay") await page.setViewportSize({ width: 375, height: 900 });
        await expect(reader).toHaveAttribute("data-mode", mode);
        for (const name of names) {
            const control = reader.getByRole("button", { name, exact: true });
            await expect(control).toBeVisible();
            const { width, height } = await control.boundingBox();
            assert.deepEqual([width, height], [44, 44], `${mode}: ${name}`);
        }
    }
    await reader.getByRole("button", { name: "Close interaction" }).click();
    await expect(prompt).toBeFocused();
});

test(`losing an open bookmark releases the old Analyze cards without exposing a fallback (${frontend})`, async t => {
    const { page, runtime, context } = await setup(t, { frontend });
    await page.goto(runtime.url);
    const link = page.locator("#activityList .request-card-open").first();
    await expect(link).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    const priorText = await link.locator(".card-excerpt").evaluateHandle(node => node.firstChild);
    await link.click();
    await expect(page.locator("#requestContent")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await replaceEvidence(context, () => ({ records: [fixture("unrelated")], importCoverage: { counts: {}, roster: [] } }));
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(page.locator("#requestContent")).toContainText("This interaction is unavailable");
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(0);
    assert.equal(await priorText.evaluate(node => node.textContent), "");
    await page.locator("#closeContextSidebar").click();
    await navigateMain(page, "analyze");
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(1);
});

test(`the built module opens the real workspace with panel-local bootstrap and separately cacheable code (${frontend})`, async t => {
    const { page, runtime } = await setup(t, { frontend }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const response = await page.goto(runtime.url + "#analyze");
    const shell = await response.text();
    assert.equal(response.headers()["cache-control"], "no-store");
    assert.ok(!shell.includes("function mountEvidence("), "Application functions are not serialized into the delivered document.");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await expect(page.locator("#wireBootstrap")).toHaveCount(0);
    assert.equal(await page.evaluate(() => Object.hasOwn(window, "__wireAppearance")), false);
    const assets = await loadBrowserAssets({ renderer: frontend });
    const asset = await fetch(new URL(assets.entry, runtime.url));
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.ok(!(await asset.text()).includes("SYNTHETIC_PRIVATE_PROMPT"));
    await navigateMain(page, "settings");
    await expect(page.locator("#pageTitle")).toHaveText("Settings");
    await navigateMain(page, "analyze");
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    assert.deepEqual(errors, []);
});

test(`a missing browser module has an actionable error and cannot start private requests (${frontend})`, async t => {
    const { page, runtime } = await setup(t, { frontend }), requests = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url()); });
    await page.route("**/assets/client/**", route => route.abort());
    await page.goto(runtime.url);
    await expect(page.locator("#loadingStatus")).toHaveText("WIRE could not load its browser code. Check the local build and reload this panel.");
    await expect(page.locator("#loadingStatus")).toHaveAttribute("role", "alert");
    assert.deepEqual(requests, []);
});

test(`bundled delivery preserves synchronous held-node clearance after another panel withdraws access (${frontend})`, async t => {
    const { page, runtime } = await setup(t, { enforced: true, frontend });
    await page.goto(runtime.url + "#analyze");
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await page.locator("#activityList .request-card-open").first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    const ordinary = page.url();
    assert.ok(new URL(ordinary).searchParams.has("record"));
    await page.locator("#wireSearch").fill("SYNTHETIC_PRIVATE_PROMPT");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    await page.locator("#wireSearch").press("Escape");
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.evaluate(() => {
        const nodes = [];
        for (const id of ["activityList", "requestContent", "wireSearchResults"]) {
            const walker = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) if (walker.currentNode.data.includes("SYNTHETIC_PRIVATE_PROMPT")) nodes.push(walker.currentNode);
        }
        window.heldPrivateNodes = nodes;
        window.retiredSearchAction = document.querySelector(".wire-search-hit");
        window.retiredActivityAction = document.querySelector("#activityList .request-card-open");
        window.retiredActivityAttribute = window.retiredActivityAction.closest(".request-row").getAttributeNode("data-view-key");
        if (!window.retiredActivityAttribute?.value.includes("bundled-")) throw new Error("Missing private activity identity in fixture");
    });
    const origin = new URL(runtime.url).origin;
    const send = async (path, body, capability) => {
        const response = await fetch(origin + path, { method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1",
                ...(capability ? { "X-Board-Capability": capability } : {}) },
            body: JSON.stringify(body) });
        assert.equal(response.status, 200);
        return response.json();
    };
    const session = await send("/api/session", {});
    const status = await fetch(origin + "/api/access/status", {
        headers: { "X-Board-Capability": session.capability },
    }).then(response => response.json());
    await send("/api/access/command", { schemaVersion: 1, action: "wire-sign-out",
        operationId: randomUUID(), generation: status.generation }, session.capability);
    await expect(page.locator("#workspace")).toBeHidden();
    assert.equal(await page.evaluate(() => window.heldPrivateNodes.length > 0
        && window.heldPrivateNodes.every(node => node.data === "")), true);
    assert.equal(await page.evaluate(() => document.body.textContent.includes("SYNTHETIC_PRIVATE_PROMPT")), false);
    assert.equal(await page.evaluate(() => window.retiredActivityAttribute.value), "");
    await expect(page.locator("#wireSearch")).toHaveValue("");
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await expect(page.locator("#contextSidebar[open],#analyzeFilterDialog[open]")).toHaveCount(0);
    const current = await fetch(origin + "/api/access/status", {
        headers: { "X-Board-Capability": session.capability },
    }).then(response => response.json());
    await send("/api/access/command", { schemaVersion: 1, action: "wire-sign-in",
        operationId: randomUUID(), generation: current.generation }, session.capability);
    await expect(page.locator("#requestContent")).toContainText("This interaction is unavailable");
    await expect(page.locator("#workspace")).toBeHidden();
    assert.equal(page.url(), ordinary);
    await page.locator("#closeContextSidebar").click();
    await navigateMain(page, "analyze");
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    const resumed = page.url();
    await page.evaluate(() => { window.retiredActivityAction.click(); window.retiredSearchAction.click(); });
    assert.equal(page.url(), resumed, "Readiness cannot revive a retired row action.");
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await send("/api/session/release", {}, session.capability);
});
}

test("deleted and malformed ordinary bookmarks refuse without choosing another record", async t => {
    const { page, context, runtime } = await setup(t, { frontend: "react", enforced: true });
    await page.goto(runtime.url + "#request?request=bundled-second");
    await expect(page.locator("#requestContent")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    const url = new URL(page.url());
    assert.ok(url.searchParams.has("record"));
    assert.doesNotMatch(url.href, /#|bundled-second/);
    const malformed = new URL(url); malformed.searchParams.append("record", "invalid");
    await page.goto(malformed.href);
    await expect(page.locator("#requestContent")).toContainText("This interaction is unavailable");
    await expect(page.locator("#workspace")).toBeHidden();
    const deletion = createDeletionController(context);
    const plan = await deletion.preview("synthetic-owner", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("synthetic-owner", { operationId: plan.operationId, confirmed: true });
    await page.goto(url.href);
    await expect(page.locator("#requestContent")).toContainText("This interaction is unavailable");
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator("#requestContent")).not.toContainText("SYNTHETIC_PRIVATE_PROMPT");
});
