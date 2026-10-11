import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController, buildSanitizedBundle } from "../lib/export.mjs";
import { serviceEvidenceFixture } from "./service-evidence-fixtures.mjs";
import { privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

const proofDir = process.env.WIRE_SERVICE_EVIDENCE_PROOFS;
async function shot(page, name) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(proofDir, name + ".png"), fullPage: true });
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    assert.deepEqual(await page.locator("#message:is(.error,.stale):visible").allTextContents(), []);
}
const dataService = item => item.locator("dt").filter({ hasText: /^Data service$/ }).evaluate(node => node.nextElementSibling.textContent);

test("a single-group legend explains the missing evidence without repeating the total", { timeout: 15000 }, async t => {
    const record = serviceEvidenceFixture(), call = record.toolCalls[0];
    record.toolCalls = Array.from({ length: 5 }, (_, index) => ({ ...call, toolCallId: `copy-call-${index}`, startEventId: `copy-start-${index}` }));
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(); t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, colorScheme: "dark" });
    await page.goto(runtime.url + "#home?bucket=week&service=Unknown"); await ready(page);
    const composition = page.locator('[data-percentage-card="services"]');
    assert.match(await composition.innerText(), /5 with missing service details/);
    assert.match(await composition.locator(".percentage-gap-list").innerText(), /Not in this record\s+5/);
    assert.equal(await composition.locator(".percentage-legend-row").count(), 0, "Missing details are not a fabricated service");
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, width === 375 ? "200%" : "100%");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proofDir) {
            await mkdir(proofDir, { recursive: true });
            const visibleCopy = width === 375 ? composition.locator(".percentage-coverage") : composition;
            await visibleCopy.screenshot({ path: path.join(proofDir, `single-group-dark-${width}.png`) });
        }
    }
});

test("the Unknown-filtered entry explains its actual calls before any disclosure is opened", { timeout: 30000 }, async t => {
    const { context } = await privateFixture(t, [serviceEvidenceFixture()]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const unexpected = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" &&
            !["/api/connect", "/api/snapshot", "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary"].includes(url.pathname)) unexpected.push(url.pathname);
    });
    await page.goto(runtime.url + "#activity?bucket=week&service=Unknown"); await ready(page);
    const explanation = page.locator("#serviceEvidenceSummary");
    assert.equal(await explanation.isVisible(), true, "The exact filtered entry must explain the service gap without opening hidden help.");
    assert.match(await explanation.innerText(), /3 of 3 Work IQ tool calls/);
    assert.match(await explanation.innerText(), /Copilot assistance[\s\S]*workiq-ask/);
    assert.match(await explanation.innerText(), /Path not recognized/);
    assert.match(await explanation.innerText(), /No target recorded/);
    assert.doesNotMatch(await explanation.innerText(), /Invented question|INVENTED-PRIVATE|\/unsupported\/resource/);
    assert.equal(await explanation.locator("[data-evidence-count]").evaluateAll(nodes =>
        nodes.reduce((sum, node) => sum + Number(node.dataset.evidenceCount), 0)), 3);
    for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1100 }); await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, width === 375 ? "200%" : "100%");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.equal(await explanation.isVisible(), true);
        if (proofDir) {
            await mkdir(proofDir, { recursive: true });
            await explanation.screenshot({ path: path.join(proofDir, `filtered-evidence-${theme}-${width}.png`) });
        }
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.goto(runtime.url + "#home?bucket=week&service=Unknown"); await ready(page);
    const composition = page.locator('[data-percentage-card="services"]');
    const reasonLines = await composition.locator(".percentage-gap-list > div").allTextContents();
    assert.equal(reasonLines.length, 3);
    assert.deepEqual(await composition.locator(".percentage-gap-list dd").allTextContents(), ["1", "1", "1"]);
    assert.match(reasonLines.join(" "), /Not in this record.*Path not recognized.*No target recorded/);
    assert.match(await composition.locator(".percentage-denominator").innerText(), /Work IQ tool calls/);
    if (proofDir) {
        await mkdir(proofDir, { recursive: true });
        await composition.screenshot({ path: path.join(proofDir, "multiple-groups-dark-1280.png") });
    }
    assert.equal(await composition.locator(".percentage-label").count(), 0);
    assert.equal(await composition.locator("details").evaluate(node => node.open), false);
    await page.goto(runtime.url + "#request?request=service-evidence&service=Unknown"); await ready(page);
    assert.equal(await explanation.isVisible(), false, "A full request must not be described as only the originating Unknown slice.");
    const ask = page.locator('[data-tool-call-id="service-evidence-call-0"]');
    assert.match(await ask.innerText(), /Downstream API path[\s\S]*Not recorded/);
    assert.match(await ask.innerText(), /HTTP method[\s\S]*Not recorded[\s\S]*API version[\s\S]*Not recorded/);
    for (const suffix of ["service=Files", "service=Unknown&result=failure"]) {
        await page.goto(runtime.url + "#activity?" + suffix); await ready(page);
        assert.equal(await explanation.isVisible(), false, "Known services and empty Unknown slices do not show irrelevant evidence explanations.");
    }
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
});

test("whole category view and detail explain remaining service evidence without question marks or reconstructed chart icons", { timeout: 90000 }, async t => {
    const { context } = await privateFixture(t, [serviceEvidenceFixture()]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const errors = [], external = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin) external.push(url.origin);
        if (request.method() !== "GET" && !["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail",
            "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(url.pathname)) mutations.push(url.pathname);
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard access in service proof."); },
        writeText() { throw Error("No clipboard access in service proof."); },
    } }));
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mutations, []); });
    for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(runtime.url + "#home?range=capture&chart=workload"); await ready(page);
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        await chooseTheme(page, theme);
        assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "6");
        assert.match(await page.locator("#chart").innerText(), /Service not shown/);
        assert.equal(await page.locator(".dimensional-category-label svg").count(), 0);
        const composition = page.locator('[data-percentage-card="services"]');
        assert.match(await composition.innerText(), /3 with missing service details/);
        assert.equal(await composition.locator('[data-category="Unknown"]').count(), 0);
        if (!await composition.locator("details").evaluate(node => node.open)) await composition.locator("summary").click();
        const explanation = await composition.locator(".percentage-exact").innerText();
        assert.match(explanation, /Its record does not identify a service or API path/);
        assert.match(explanation, /target path was recorded/);
        assert.match(explanation, /No service target/);
        if (!await page.locator("#serviceDefinitions").evaluate(node => node.open)) await page.locator("#serviceDefinitions > summary").click();
        assert.match(await page.locator("#serviceDefinitions").innerText(), /Its record does not identify a service or API path/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `remaining-${theme}-${width}-chart`);
        await page.goto(runtime.url + "#request?request=service-evidence&range=capture"); await ready(page);
        const ask = page.locator('[data-tool-call-id="service-evidence-call-0"]');
        assert.match(await ask.innerText(), /Copilot assistance/);
        assert.equal(await dataService(ask), "Not in this record");
        const unrecognized = page.locator('[data-tool-call-id="service-evidence-call-3"]');
        assert.match(await unrecognized.innerText(), /Service not shown/);
        assert.equal(await dataService(unrecognized), "Path not recognized");
        const missing = page.locator('[data-tool-call-id="service-evidence-call-4"]');
        assert.equal(await dataService(missing), "No target recorded");
        assert.match(await page.locator('[data-tool-call-id="service-evidence-call-2"]').textContent(), /Files[\s\S]*Tool failed/);
        assert.match(await page.locator('[data-tool-call-id="service-evidence-call-5"]').innerText(), /Schema lookup[\s\S]*Not applicable[\s\S]*Schema path/);
        await ask.getByRole("button", { name: "About Copilot assistance", exact: true }).click();
        assert.match(await page.getByRole("tooltip").innerText(), /Its record does not identify a service or API path/);
        await page.keyboard.press("Escape");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `remaining-${theme}-${width}-detail`);
        if (width === 375) {
            await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await shot(page, `remaining-${theme}-${width}-200-detail`);
        }
    }
    await page.goto(runtime.url + "#home?range=capture&chart=workload"); await ready(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await selectActivityOption(page, "serviceFilter", "Unknown"); await ready(page);
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "3");
    assert.match(page.url(), /service=Unknown/);
    await selectActivityOption(page, "outcomeFilter", ["failure"]); await ready(page);
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "0");
    assert.match(await page.locator('[data-percentage-card="services"]').innerText(), /No activity in this applied view/);
});

test("new readable report retains the neutral evidence reasons and safe shared-file paths", { timeout: 30000 }, async t => {
    const record = serviceEvidenceFixture(); record.toolCalls.splice(4, 1);
    const bundle = await buildSanitizedBundle([record], "e".repeat(64), { formats: ["html"], promptMode: "none" });
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.setContent(bundle.files["product-report.html"]);
    assert.match(await page.locator(".service-glossary").innerText(), /Service not shown/);
    assert.match(await page.locator("#operations").innerText(), /Its record does not identify a service or API path/);
    assert.match(await page.locator("#operations").innerText(), /\/shares\/\{id\}\/driveItem/);
    assert.doesNotMatch(await page.locator("main").innerText(), /INVENTED-PRIVATE|ANOTHER-INVENTED|INVENTED-SCHEMA/);
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `remaining-report-${width}`);
    }
});
