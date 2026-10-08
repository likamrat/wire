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
        const composition = page.locator('[data-percentage-card="composition"]');
        const unknown = composition.locator('[data-category="Unknown"].percentage-legend-row');
        assert.equal(await unknown.getAttribute("data-count"), "3");
        assert.match(await unknown.innerText(), /Service not shown/);
        if (!await composition.locator("details").evaluate(node => node.open)) await composition.locator("summary").click();
        const explanation = await composition.locator(".percentage-exact").innerText();
        assert.match(explanation, /does not expose which downstream services/);
        assert.match(explanation, /target path was recorded/);
        assert.match(explanation, /No service target/);
        if (!await page.locator("#serviceDefinitions").evaluate(node => node.open)) await page.locator("#serviceDefinitions > summary").click();
        assert.match(await page.locator("#serviceDefinitions").innerText(), /does not expose which downstream services/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `remaining-${theme}-${width}-chart`);
        await page.goto(runtime.url + "#request?request=service-evidence&range=capture"); await ready(page);
        const ask = page.locator('[data-tool-call-id="service-evidence-call-0"]');
        assert.match(await ask.innerText(), /Copilot assistance/);
        assert.equal(await dataService(ask), "Not exposed by Work IQ");
        const unrecognized = page.locator('[data-tool-call-id="service-evidence-call-3"]');
        assert.match(await unrecognized.innerText(), /Service not shown/);
        assert.equal(await dataService(unrecognized), "Path not recognized");
        const missing = page.locator('[data-tool-call-id="service-evidence-call-4"]');
        assert.equal(await dataService(missing), "No target recorded");
        assert.match(await page.locator('[data-tool-call-id="service-evidence-call-2"]').innerText(), /Files[\s\S]*Tool failed/);
        assert.match(await page.locator('[data-tool-call-id="service-evidence-call-5"]').innerText(), /Schema lookup[\s\S]*Not applicable[\s\S]*Schema path/);
        await ask.getByRole("button", { name: "About Copilot assistance", exact: true }).click();
        assert.match(await page.getByRole("tooltip").innerText(), /does not expose which downstream services/);
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
    assert.match(await page.locator('[data-percentage-card="composition"]').innerText(), /No activity in this applied view/);
});

test("new readable report retains the neutral evidence reasons and safe shared-file paths", { timeout: 30000 }, async t => {
    const record = serviceEvidenceFixture(); record.toolCalls.splice(4, 1);
    const bundle = await buildSanitizedBundle([record], "e".repeat(64), { formats: ["html"], promptMode: "none" });
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.setContent(bundle.files["product-report.html"]);
    assert.match(await page.locator(".service-glossary").innerText(), /Service not shown/);
    assert.match(await page.locator("#operations").innerText(), /does not expose which downstream services/);
    assert.match(await page.locator("#operations").innerText(), /\/shares\/\{id\}\/driveItem/);
    assert.doesNotMatch(await page.locator("main").innerText(), /INVENTED-PRIVATE|ANOTHER-INVENTED|INVENTED-SCHEMA/);
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `remaining-report-${width}`);
    }
});
