import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController, buildSanitizedBundle } from "../../lib/export.mjs";
import { serviceEvidenceFixture } from "./service-evidence-fixtures.mjs";
import { privateFixture } from "../support/helpers.mjs";
import { createServiceCategories } from "../../lib/service-categories.mjs";
import { createEvidenceUX } from "../../web/ux.mjs";
import { uxIcons } from "../../web/ux-icons.mjs";

test("requested-source help names recorded choices and only adds a real unsupported-source qualification", async t => {
    const browser = await chromium.launch(), page = await browser.newPage(), errors = [];
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent("<main></main>");
    await page.addScriptTag({ content: `window.categories = (${createServiceCategories.toString()})();
        window.ux = (${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});` });
    for (const [capabilities, expected] of [
        [[{ name: "Email" }, { name: "TeamsMessages" }], "Requested sources: email and Teams messages."],
        [[{ name: "Email" }, { name: "InventedUnknown" }], "Requested sources: email. Some requested sources could not be identified."],
        [[{ name: "InventedUnknown" }], "Requested sources not identified. The recorded source choices are not recognized."],
    ]) {
        await page.evaluate(capabilities => {
            const scope = window.categories.requestedSearchScope({ tool: "workiq-retrieve", requestArgs: { capabilities }, toolSucceeded: false });
            document.querySelector("main").replaceChildren(window.ux.helpButton("Search and retrieval",
                [scope.label + ".", scope.description].filter(Boolean).join(" ")));
        }, capabilities);
        await page.getByRole("button", { name: "About Search and retrieval", exact: true }).click();
        await expect(page.getByRole("tooltip")).toHaveText(expected);
        await expect(page.getByRole("tooltip")).not.toContainText("returned results");
        await expect(page.getByRole("tooltip")).not.toContainText("InventedUnknown");
        await page.keyboard.press("Escape");
    }
});

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

test("Guide separates an undisclosed service from an unclassified path and leads to its actual call", async t => {
    const record = serviceEvidenceFixture();
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend: "react", collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1350, height: 900 }, reducedMotion: "reduce" });
    await page.goto(runtime.url); await ready(page);
    const article = page.locator("#chartReferenceExplanation");
    await page.locator("#openChartReference").click();
    await page.locator('#chartReferenceTopics button[data-reference-topic="services"]').click();
    await expect(article).toContainText("Recorded path not recognized");
    await expect(article).toContainText("who wrote the prompt");
    await expect(article).toContainText("tool-call count");
    await expect(article).not.toContainText("INVENTED-PRIVATE");
    await page.locator('#chartReferenceTopics button[data-reference-topic="paths"]').click();
    await expect(article).toContainText("Recorded path not recognized");
    await expect(article).toContainText(/open the prompt/i);
    await page.locator("#chartReferenceShowData").click();
    const drilldown = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.locator("#chartReferenceData").getByText("/{id}/{id}", { exact: true }).click();
    assert.deepEqual((await (await drilldown).json()).analytics.rows.map(row => row.toolCallId), ["service-evidence-call-3"]);
    await expect(page.locator("#activityListSummary")).toContainText("1 matching tool call");
    await page.locator(".request-card-open").first().click();
    const call = page.locator('[data-tool-call-id="service-evidence-call-3"]');
    await expect(call).toContainText(/completed/i);
    await expect(call).toContainText("Recorded path not recognized");
    const toggle = call.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(call).toContainText(/\/unsupported\/resource|\/\{id\}\/\{id\}/);
});

test("profile relationship calls show People for the complete service denominator and exact-call reader", { timeout: 30000 }, async t => {
    const source = serviceEvidenceFixture();
    source.toolCalls = ["/me/manager?$select=id", "/users/INVENTED-PERSON/directReports?$top=12"].map((target, index) => ({
        ...source.toolCalls[1], toolCallId: `profile-relationship-${index}`, startEventId: `profile-relationship-start-${index}`,
        mcpServerName: "cc-invented-connector", requestArgs: { entityUrls: [target] }, requestedApiPath: target,
        apiResults: [{ index: 0, statusCode: 200 }],
    }));
    const { context } = await privateFixture(t, [source]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#analyze"); await ready(page);
    const services = page.locator("section.percentage-card").filter({ has: page.locator('[id$="-services-title"]') });
    await expect(services.getByRole("link", { name: "People: 2 of 2 Work IQ tool calls (100%). View matching records.", exact: true })).toBeVisible();
    await expect(services).not.toContainText("Recorded path not recognized");
    await services.getByRole("link", { name: "People: 2 of 2 Work IQ tool calls (100%). View matching records.", exact: true }).click(); await ready(page);
    await expect(page.locator("#activityList .request-row")).toHaveCount(1);
    await page.locator("#activityList .request-card-open").click(); await ready(page);
    for (const sourceCall of source.toolCalls) {
        const call = page.locator(`[data-tool-call-id="${sourceCall.toolCallId}"]`);
        const toggle = call.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        await expect(call.locator(".reader-call-services")).toContainText("People");
    }
    assert.deepEqual(errors, []);
});

test("readable HTML reports show service coverage and masked file paths without page overflow", async t => {
    const record = serviceEvidenceFixture(); record.toolCalls.splice(4, 1);
    const bundle = await buildSanitizedBundle([record], "e".repeat(64), { formats: ["html"], promptMode: "none" });
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.setContent(bundle.files["product-report.html"]);
    await expect(page.locator("main")).toContainText("2 calls with missing or partial service details");
    assert.match(await page.locator("#operations").innerText(), /\/shares\/\{id\}\/driveItem/);
    assert.doesNotMatch(await page.locator("main").innerText(), /INVENTED-PRIVATE|ANOTHER-INVENTED|INVENTED-SCHEMA/);
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `remaining-report-${width}`);
    }
});

test("unknown service evidence separates hosted assistance, an unrecognized path and an absent target", async t => {
    const source = serviceEvidenceFixture();
    const { context } = await privateFixture(t, [source]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const read = page.waitForResponse(r => r.ok() && r.url().endsWith("/api/snapshot"));
    await page.goto(runtime.url + "?service=Unknown"); await ready(page);
    const data = (await (await read).json()).analytics;
    assert.deepEqual(data.rows.map(r => r.toolCallId).sort(), [0,3,4].map(i => `service-evidence-call-${i}`));
    const names = ["Asked Copilot", "Recorded path not recognized", "Service target not recorded"];
    const widget = page.locator('[data-percentage-card="services"]');
    for (const [i, name] of names.entries()) {
        const row = widget.locator(".percentage-legend-row").filter({ hasText: name });
        await expect(row.locator(".percentage-value")).toHaveText("33.3% (1)");
        await row.locator(".percentage-label").press("Enter");
        const target = page.locator("#activityList .widget-record");
        const id = source.toolCalls[[0,3,4][i]].toolCallId;
        await expect(target).toHaveAttribute("data-action-id", data.rows.find(r => r.toolCallId === id).id);
        await target.getByRole("link").press("Enter");
        await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", id);
        await page.goBack(); await expect(target).toBeVisible();
        await page.goBack(); await expect(row).toBeVisible();
    }
    await expect(widget).not.toContainText(/INVENTED-PRIVATE|Invented question|\/unsupported\/resource/);
});
