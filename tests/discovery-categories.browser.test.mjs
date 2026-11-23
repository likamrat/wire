import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { createExportController, buildSanitizedBundle } from "../lib/export.mjs";
import { discoveryFixture } from "./discovery-fixtures.mjs";
import { privateFixture, chooseTheme, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters } from "./helpers.mjs";

const proofs = process.env.WIRE_DISCOVERY_PROOFS;
test("card operations open the matching recorded call and return to the operation link", async t => {
    const mixed = discoveryFixture(), repeated = structuredClone(mixed), unavailable = structuredClone(mixed);
    const [api, schema, agents, , retrieval, fetch] = mixed.toolCalls;
    mixed.toolCalls = [fetch, api, schema, agents, retrieval];
    repeated.scenarioId = "repeated-paths"; repeated.sourceSessionId = "other-chat";
    repeated.toolCalls = [fetch, ...[3, 1, 2].map(i => ({ ...api, toolCallId: `paths-${i}`, startEventId: `paths-start-${i}`,
        startedAt: `2026-10-01T00:00:0${i}Z` }))];
    unavailable.scenarioId = "missing-owner"; unavailable.sourceSessionId = "missing-chat"; unavailable.toolCalls = [schema];
    const { context } = await privateFixture(t, [mixed, repeated, unavailable]);
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend: "react", collector: { timers: false } });
    const browser = await chromium.launch(); t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.requestActivity.tool = snapshot.requestActivity.tool.filter(r => r.scenarioId !== unavailable.scenarioId);
        await route.fulfill({ response, json: snapshot });
    });
    await page.goto(runtime.url); await ready(page);
    const operations = record => page.locator(`article[data-view-key="request:${record.scenarioId}"] .card-identity-field`)
        .filter({ has: page.locator("dt", { hasText: /^Operations?$/ }) });
    for (const [record, name, id, keyboard] of [
        [mixed, "API discovery: open call", api.toolCallId, true],
        [mixed, "Schema lookup: open call", schema.toolCallId, false],
        [mixed, "Agent discovery: open call", agents.toolCallId, true],
        [mixed, "Search requested: open call", retrieval.toolCallId, false],
        [repeated, "API discovery: open first of 3 calls", "paths-1", true],
    ]) {
        const link = operations(record).getByRole("link", { name, exact: true });
        await expect(link).toBeVisible();
        if (record === repeated) await expect(link).toContainText("first of 3 calls");
        if (keyboard) await link.press("Enter"); else await link.click();
        await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", `request:${record.scenarioId}`);
        await expect(page.locator(`[data-tool-call-id="${id}"]`)).toBeFocused();
        if (keyboard) await page.goBack(); else await page.locator("#closeContextSidebar").click();
        await expect(link).toBeFocused();
    }
    await expect(operations(unavailable)).toHaveText(/Schema lookup/);
    await expect(operations(unavailable).getByRole("link")).toHaveCount(0);
});

async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    const error = await page.locator("#message:is(.error,.stale):visible").allTextContents();
    assert.deepEqual(error.filter(Boolean), [], "The snapshot must load without an error notice.");
}
async function screenshot(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: true });
}
test("Discovery reads consistently across charts, filters and call details in both themes and narrow layouts", { timeout: 90000 }, async t => {
    const record = discoveryFixture();
    record.toolCalls[5].requestArgs = { entityUrls: ["/me/events"] };
    record.toolCalls[5].apiResults = [{ index: 0, statusCode: 200 }];
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend: "react", collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const errors = [], external = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin) { external.push(url.origin); return route.abort(); }
        const statusOnly = url.pathname === "/api/app-update" && request.method() === "POST" && request.postDataJSON()?.action === "status";
        if (request.method() !== "GET" && !statusOnly && !["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(url.pathname)) {
            mutations.push(url.pathname); return route.abort();
        }
        return route.continue();
    });

    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard access in discovery proof."); },
        writeText() { throw Error("No clipboard access in discovery proof."); },
    } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mutations, []);
    });
    const analyze = new URL("/?range=capture&chart=workload", runtime.url).href;
    const services = page.locator('[data-percentage-card="services"]');
    const calls = page.locator("#activityList .card-panel-link");
    for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(analyze); await ready(page);
        await chooseTheme(page, theme);
        await expect(page.locator("#chartTitle")).toHaveText("Activity categories");
        await expect(page.locator("#meaningMatched")).toHaveText("8 Work IQ tool calls");
        await expect(services.getByRole("link", { name: /Discovery \/ preparation: 3 of 8 Work IQ tool calls \(37\.5%\)/ })).toBeVisible();
        await screenshot(page, `${theme}-${width}-whole-chart`);
        if (width === 375) {
            await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "narrow chart supports 200% text");
            await screenshot(page, `${theme}-${width}-200-chart`);
        }
        await calls.click();
        const toggles = page.locator('[data-reader-section="activity"] .reader-call-toggle');
        await expect(toggles).toHaveCount(8);
        const targets = await toggles.evaluateAll(nodes => nodes.map(node => ({
            id: node.closest("[data-tool-call-id]").dataset.toolCallId, height: node.getBoundingClientRect().height,
        })));
        assert.deepEqual(targets.map(target => target.id).sort(), record.toolCalls.map(call => call.toolCallId).sort());
        assert.ok(targets.every(target => target.height >= 44), `${theme}/${width}: reader disclosure targets`);
        const discovery = page.locator('[data-tool-call-id="invented-call-0"]');
        await discovery.locator(".reader-call-toggle").click();
        assert.match(await discovery.innerText(), /API discovery/);
        assert.match(await discovery.innerText(), /Find available API paths/);
        assert.doesNotMatch(await discovery.innerText(), /Unidentified service|Target\s+Mail|API path\s+Not recorded/);
        const schema = page.locator('[data-tool-call-id="invented-call-1"]');
        await schema.locator(".reader-call-toggle").click();
        assert.match(await schema.innerText(), /Schema lookup/);
        assert.match(await schema.innerText(), /Schema path\s+\/me\/messages/);
        await expect(schema).toContainText("1 tool call failed");
        await expect(schema).toContainText("it does not run it");
        const agents = page.locator('[data-tool-call-id="invented-call-2"]');
        await expect(agents).toContainText("Agent discovery");
        await expect(agents).toContainText("has no recorded result");
        const asked = page.locator('[data-tool-call-id="invented-call-3"]');
        await asked.locator(".reader-call-toggle").click();
        await expect(asked).toContainText("Asked Copilot");
        await expect(asked).toContainText("which apps, if any, Copilot used");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await screenshot(page, `${theme}-${width}-${width === 375 ? "200" : "whole"}-detail`);
        await page.locator("#closeContextSidebar").click();
        await expect(calls).toBeFocused();
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.goto(analyze); await ready(page);
    await openAnalyzeFilters(page);
    if (!await page.locator("#serviceFilter-control").isVisible()) await page.locator("#moreFiltersToggle").click();
    await expect(page.locator("#serviceFilter-control")).toHaveAccessibleName("Activity category");
    await expect(page.locator('#serviceFilter option[value="Unknown"]')).toHaveCount(1);
    await selectActivityOption(page, "serviceFilter", "Discovery"); await ready(page);
    await page.waitForFunction(() => document.querySelector("#meaningMatched").textContent.startsWith("3 "));
    assert.match(await page.locator("#meaningMatched").textContent(), /^3 Work IQ tool calls$/);
    assert.match(page.url(), /service=Discovery/);
    await screenshot(page, "discovery-filtered-three");
    await selectActivityOption(page, "outcomeFilter", ["partial"]); await ready(page);
    await page.waitForFunction(() => document.querySelector("#meaningMatched").textContent.startsWith("0 "));
    assert.match(await page.locator('[data-percentage-card="services"]').innerText(), /No matching activity/);
    await screenshot(page, "discovery-zero");
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await selectActivityOption(page, "serviceFilter", "Unknown"); await ready(page);
    await page.waitForFunction(() => document.querySelector("#meaningMatched").textContent.startsWith("2 "));
    await selectActivityOption(page, "serviceFilter", "Discovery"); await ready(page);
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page);
    assert.doesNotMatch(page.url(), /service=Discovery/);
    await expect(page.locator("#serviceFilter-control")).toHaveAccessibleName("Activity category");
    assert.equal(await page.locator("#chartTitle").textContent(), "Service categories");
    assert.match(await page.locator("#meaningMatched").textContent(), /^1 tool-returned API result$/);
    assert.equal(await page.locator('#serviceFilter option[value="Discovery"]').count(), 0);
    await closeAnalyzeFilters(page);
    const single = discoveryFixture();
    single.scenarioId = "single-discovery";
    single.toolCalls = single.toolCalls.slice(0, 1);
    await replaceEvidence(context, () => ({ records: [single], importCoverage: { counts: { includedSessions: 1 }, roster: [] } }));
    await page.goto(analyze); await ready(page);
    await expect(calls).toHaveCount(1);
    await calls.click();
    const singleAction = page.locator('.journey-item[data-tool-call-id="invented-call-0"]');
    await expect(singleAction.getByText("API discovery", { exact: true })).toHaveCount(1);
    await expect(singleAction).toContainText("1 tool call completed");
    await expect(page.locator('[data-reader-section="activity"] [data-tool-call-id]')).toHaveCount(1);
    await singleAction.locator(".reader-call-toggle").click();
    await expect(singleAction).toContainText("Find available API paths");
    assert.doesNotMatch(await singleAction.innerText(), /Unidentified service|API metadata: None recorded|API path\s+Not recorded/);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await screenshot(page, `${theme}-single-discovery`);
    }
});

test("new readable report exposes the same Discovery meaning without promoting a schema to an execution", { timeout: 30000 }, async t => {
    const bundle = await buildSanitizedBundle([discoveryFixture()], "c".repeat(64), { formats: ["html"], promptMode: "none" });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    const requests = [];
    page.on("request", request => { if (!request.url().startsWith("data:")) requests.push(request.url()); });
    await page.setContent(bundle.files["product-report.html"]);
    const services = page.locator("#breakdowns section").filter({ has: page.getByRole("heading", { name: "Services", exact: true }) });
    await expect(services).toContainText("3 preparation calls with no applicable data service");
    await expect(services).toContainText("2 calls with missing or partial service details");
    assert.match(await page.locator("#operations").innerText(), /API discovery/);
    assert.match(await page.locator("#operations").innerText(), /Schema lookup - Schema path/);
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await screenshot(page, `new-report-${width}`);
    }
    assert.deepEqual(requests, []);
});
