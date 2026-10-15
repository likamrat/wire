import test from "node:test";
import assert from "node:assert/strict";
import { reportContents, inspectReportCopies } from "./report-journey-helpers.mjs";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { fixture as sourceFixture, exportCatalogFor, chooseTheme, openActivitySessions } from "./helpers.mjs";
import { selectExportSnapshot } from "../lib/export-selection.mjs";

const proofDir = process.env.WORKIQ_CATEGORY_PROOFS;
const records = ["/me/events", "/me/messages", "/me/drive", "/teams", "/me/people", "/planner/tasks", "/me/onenote/pages", "/groups", "/search/query", "/unknown"].map((endpoint, index) => {
    const source = sourceFixture(`synthetic-category-${index}`);
    source.sourceSessionName = "Synthetic category examples";
    source.workflowState = "ready_to_export";
    source.toolCalls[0].requestedApiPath = endpoint;
    source.toolCalls[0].requestArgs = { entityUrls: [endpoint] };
    source.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
    return source;
});

async function fixture(run, contextOptions = {}) {
    const requests = [], errors = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-category-fixture'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; base-uri 'none'");
            return res.end(renderHtmlShell("a".repeat(64), "category-fixture"));
        }
        let text = ""; for await (const part of req) text += part;
        const input = JSON.parse(text);
        requests.push(req.url);
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/snapshot") return res.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [], coverage: { since: "2026-09-01", until: "2026-09-30", notes: [] },
            exportCatalog: exportCatalogFor(records),
            analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
        if (req.url === "/api/preview") {
            const chosen = selectExportSnapshot(records, input.selection, 1);
            const bundle = await buildSanitizedBundle(chosen.records, "a".repeat(64), input.options);
            return res.end(JSON.stringify({ ...bundle, previewId: "synthetic-category-preview" }));
        }
        if (req.url === "/api/cancel-preview") return res.end('{"cancelled":true}');
        res.statusCode = 403;
        res.end('{"error":"Synthetic category proof allows no review, export or collection mutations."}');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const context = await browser.newContext(contextOptions);
    context.setDefaultTimeout(5000);
    await context.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            writeText: () => { throw new Error("Category proof must not access the clipboard."); },
            readText: () => { throw new Error("Category proof must not read the clipboard."); },
        } });
    });
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    try {
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, url: `http://127.0.0.1:${server.address().port}`, requests });
        assert.deepEqual(errors, []);
        assert.ok(requests.every((url) => ["/api/snapshot", "/api/preview", "/api/cancel-preview"].includes(url)));
    } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
}

async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    if (await page.locator("#moreFilters").isVisible() && await page.locator("#moreFilters").getAttribute("open") === null) await page.locator("#moreFilters>summary").click();
    await openActivitySessions(page);
}
async function tooltipText(page, text) {
    const tip = page.getByRole("tooltip");
    await tip.waitFor({ state: "visible" });
    assert.equal(await tip.textContent(), text);
}

test("service definitions stay in their existing disclosure while count links drill down", { timeout: 30000 }, async () => fixture(async ({ context, url, requests }) => {
    const page = await context.newPage();
    await page.goto(url + "/#home?chart=workload"); await ready(page);
    const before = page.url(), reads = requests.length;
    assert.equal(await page.locator(".service-chart-row .ux-help").count(), 0);
    assert.equal(await page.locator("#serviceDefinitions").evaluate(node => node.open), false);
    await page.locator("#serviceDefinitions summary").click();
    assert.ok((await page.locator("#serviceDefinitions").innerText()).includes(serviceCategories.describe("Calendar").description));
    assert.equal(page.url(), before); assert.equal(requests.length, reads);
    const row = page.locator(".service-chart-row").filter({ has: page.locator(".group-name", { hasText: /^Calendar$/ }) }).locator(".chart-row");
    await row.locator(".dimensional-count").hover(); await page.waitForTimeout(250);
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    await row.focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.match(page.url(), /#activity/);
    assert.equal(await page.locator("#serviceFilter").inputValue(), "Calendar");
    await page.goBack(); await ready(page);
    await page.locator('[data-group-id="group:other"] .dimensional-count').click(); await ready(page);
    assert.equal(await page.locator(".service-chart-row").count(), 10);
    assert.equal(await page.locator("#serviceDefinitions dt").count(), 10);
    assert.ok((await page.locator("#serviceDefinitions").innerText()).includes(serviceCategories.describe("Unknown").description));
}));

test("touch reads service definitions without filtering, then selects the explicit count", { timeout: 20000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage(); await page.goto(url + "/#home?chart=workload"); await ready(page);
    const before = page.url(), summary = page.locator("#serviceDefinitions summary");
    await summary.tap();
    assert.ok((await page.locator("#serviceDefinitions").innerText()).includes(serviceCategories.describe("Calendar").description));
    assert.equal(page.url(), before);
    await summary.tap();
    const count = page.locator(".service-chart-row").filter({ has: page.locator(".group-name", { hasText: /^Calendar$/ }) }).locator(".dimensional-count");
    assert.ok((await count.boundingBox()).height >= 44);
    await count.tap(); await ready(page); assert.match(page.url(), /#activity/);
}, { viewport: { width: 375, height: 900 }, isMobile: true, hasTouch: true }));

test("service labels, counts and definitions remain readable without per-column help at responsive widths", { timeout: 40000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 1000 }); await page.goto(url + "/#home?chart=workload");
        await ready(page); await chooseTheme(page, theme);
        assert.equal(await page.locator(".service-chart-row .ux-help").count(), 0);
        const rows = await page.locator(".service-chart-row").evaluateAll(nodes => nodes.map(row => {
            const box = node => { const b = node.getBoundingClientRect(); return { center: b.x + b.width / 2, y: b.y, bottom: b.bottom, height: b.height }; };
            return { name: box(row.querySelector(".group-name")), value: box(row.querySelector(".dimensional-count")),
                paint: box(row.querySelector(".dimensional-front")), labelClipped: row.querySelector(".group-name").scrollWidth > row.querySelector(".group-name").clientWidth + 1 };
        }));
        for (const row of rows) {
            assert.ok(Math.abs(row.name.center - row.paint.center) < 1 && Math.abs(row.value.center - row.paint.center) < 1);
            assert.ok(row.value.bottom < row.paint.y && row.value.height >= 44);
            assert.equal(row.labelClipped, false);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (proofDir) await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `categories-${theme}-${width}.png`) });
    }
}));

test("filter, result, evidence and report explanations have discoverable help without toggling choices", { timeout: 30000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url);
    await ready(page);
    for (const name of ["When", "Service", "GitHub Copilot project", "Activity"]) {
        const help = page.locator("#filters").getByRole("button", { name: "About " + name, exact: true });
        await help.click();
        await page.getByRole("tooltip").waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
    }
    const original = page.url();
    await page.locator("#outcomeFilter-control").click();
    await page.keyboard.press("w");
    assert.equal(await page.locator('.select-option[data-value="success"] .select-option-description').count(), 0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "About Recorded result", exact: true }).click();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.match(await page.getByRole("tooltip").textContent(), /not.*correct/i);
    await page.keyboard.press("Escape");
    assert.equal(page.url(), original, "Reading field help does not apply its filter");
    assert.equal(await page.locator("#resultSummary .ux-help").count(), 1, "One field-level explanation, not one per option");
    await page.locator('nav a[data-nav="activity"]').click();
    await ready(page);
    await page.locator("#activityList .ux-help").first().click();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#activityList input[type=checkbox]").first().check();
    await page.locator('nav a[data-nav="reports"]').click();
    await reportContents(page);
    assert.match(await page.locator("#promptOptions").innerText(), /masked.*confidential meaning/s);
    assert.match(await page.locator("#formatOptions").innerText(), /same reviewed facts.*JSON keeps structured data/s);
    const selectedModes = await page.locator('input[name=promptMode]:checked').inputValue();
    assert.equal(await page.locator("#formatOptions .ux-help").count(), 0, "One consequential explanation replaces a help control per format");
    assert.equal(await page.locator('input[name=promptMode]:checked').inputValue(), selectedModes);
    assert.deepEqual(await page.locator("#formatOptions input:checked").evaluateAll((nodes) => nodes.map((node) => node.value)), ["html"]);
    await page.locator("#exportBtn").click();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    await inspectReportCopies(page);
    assert.match(await page.locator(".prompt-review-summary").innerText(), /Originals stay unchanged; edits affect this report only/);
    assert.equal(await page.locator("#reportStage3").isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Save report", exact: true, includeHidden: true }).isDisabled(), true);
}));
