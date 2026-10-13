import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { createExportController, buildSanitizedBundle } from "../lib/export.mjs";
import { discoveryFixture } from "./discovery-fixtures.mjs";
import { privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

const proofs = process.env.WIRE_DISCOVERY_PROOFS;
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
test("Discovery reads consistently across whole charts, filters and action detail in light/navy and narrow layouts", { timeout: 90000 }, async t => {
    const record = discoveryFixture();
    record.toolCalls[5].requestArgs = { entityUrls: ["/me/events"] };
    record.toolCalls[5].apiResults = [{ index: 0, statusCode: 200 }];
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const errors = [], external = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin) external.push(url.origin);
        if (request.method() !== "GET" && !["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(url.pathname)) mutations.push(url.pathname);
    });

    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard access in discovery proof."); },
        writeText() { throw Error("No clipboard access in discovery proof."); },
    } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mutations, []);
    });
    for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        await page.goto(runtime.url + "#home?range=capture&chart=workload"); await ready(page);
        await page.waitForFunction(() => document.querySelector("#meaningMatched").textContent === "8 Work IQ tool calls");
        await chooseTheme(page, theme);
        assert.equal(await page.locator("#chartTitle").textContent(), "Activity categories");
        assert.match(await page.locator("#meaningMatched").textContent(), /^8 Work IQ tool calls$/);
        assert.equal(await page.locator('.filter-field:has(#serviceFilter) .help-heading label').textContent(), "Category");
        assert.match(await page.locator('[data-percentage-card="services"]').innerText(), /3 discovery \/ preparation; not service execution/);
        assert.equal(await page.locator('#serviceFilter option[value="Discovery"]').count(), 1);
        assert.equal(await page.locator('#serviceFilter option[value="Unknown"]').count(), 1);
        await screenshot(page, `${theme}-${width}-whole-chart`);
        if (width === 375) {
            await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "narrow chart supports 200% text");
            await screenshot(page, `${theme}-${width}-200-chart`);
        }
        await page.goto(runtime.url + "#request?request=discovery-categories&range=capture"); await ready(page);
        const discovery = page.locator('[data-tool-call-id="invented-call-0"]');
        assert.match(await discovery.innerText(), /API discovery/);
        assert.match(await discovery.innerText(), /Find available API paths/);
        assert.match(await discovery.innerText(), /Data service\s+Not applicable/);
        assert.doesNotMatch(await discovery.innerText(), /Service not identified|API path\s+Not recorded|API metadata: None/);
        const schema = page.locator('[data-tool-call-id="invented-call-1"]');
        assert.match(await schema.innerText(), /Schema lookup/);
        assert.match(await schema.innerText(), /Schema path\s+\/me\/messages/);
        assert.match(await schema.textContent(), /Tool failed/);
        assert.match(await page.locator('[data-tool-call-id="invented-call-2"]').textContent(), /Agent discovery[\s\S]*No result recorded/);
        assert.match(await page.locator('[data-tool-call-id="invented-call-3"]').textContent(), /Copilot assistance[\s\S]*Not in this record/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const sizes = await page.locator(".journey-item > details > summary").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        assert.ok(sizes.every(height => height >= 44));
        await screenshot(page, `${theme}-${width}-whole-detail`);
        if (width === 375) {
            await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "narrow detail supports 200% text");
            await screenshot(page, `${theme}-${width}-200-detail`);
        }
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.goto(runtime.url + "#home?range=capture&chart=workload"); await ready(page);
    await selectActivityOption(page, "serviceFilter", "Discovery"); await ready(page);
    await page.waitForFunction(() => document.querySelector("#meaningMatched").textContent.startsWith("3 "));
    assert.match(await page.locator("#meaningMatched").textContent(), /^3 Work IQ tool calls$/);
    assert.match(page.url(), /service=Discovery/);
    await screenshot(page, "discovery-filtered-three");
    await selectActivityOption(page, "outcomeFilter", ["partial"]); await ready(page);
    await page.waitForFunction(() => document.querySelector("#meaningMatched").textContent.startsWith("0 "));
    assert.match(await page.locator('[data-percentage-card="services"]').innerText(), /No activity in this applied view/);
    await screenshot(page, "discovery-zero");
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await selectActivityOption(page, "serviceFilter", "Unknown"); await ready(page);
    await page.waitForFunction(() => document.querySelector("#meaningMatched").textContent.startsWith("2 "));
    await selectActivityOption(page, "serviceFilter", "Discovery"); await ready(page);
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page);
    assert.doesNotMatch(page.url(), /service=Discovery/);
    assert.equal(await page.locator('.filter-field:has(#serviceFilter) .help-heading label').textContent(), "Category");
    assert.equal(await page.locator("#chartTitle").textContent(), "Service categories");
    assert.equal(await page.locator("#chartGrouping").textContent(), "One service category per tool-returned API result.");
    assert.match(await page.locator("#meaningMatched").textContent(), /^1 tool-returned API result$/);
    assert.equal(await page.locator('#serviceFilter option[value="Discovery"]').count(), 0);
    const single = discoveryFixture();
    single.scenarioId = "single-discovery";
    single.toolCalls = single.toolCalls.slice(0, 1);
    await replaceEvidence(context, () => ({ records: [single], importCoverage: { counts: { includedSessions: 1 }, roster: [] } }));
    await page.goto(runtime.url + "#request?request=single-discovery&range=capture"); await ready(page);
    const singleAction = page.locator('.journey-item[data-tool-call-id="invented-call-0"]');
    assert.match(await singleAction.innerText(), /API discovery/);
    assert.match(await singleAction.innerText(), /Data service\s+Not applicable/);
    assert.equal(await page.locator("#requestView dt").filter({ hasText: /^Purpose$/ }).count(), 1);
    assert.doesNotMatch(await page.locator("#requestView").innerText(), /Service not identified|API metadata: None recorded|API path\s+Not recorded/);
    assert.match(await page.locator(".full-request-results").textContent(), /1 Work IQ tool call[\s\S]*1 Worked/);
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
    assert.equal(await page.getByRole("heading", { name: "Activity categories in this report", exact: true }).count(), 1);
    assert.match(await page.locator(".service-glossary").innerText(), /Discovery[\s\S]*not applicable[\s\S]*regrouping, not a change in recorded outcomes/);
    assert.match(await page.locator("#operations").innerText(), /API discovery/);
    assert.match(await page.locator("#operations").innerText(), /Schema lookup - Schema path/);
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await screenshot(page, `new-report-${width}`);
    }
    assert.deepEqual(requests, []);
});
