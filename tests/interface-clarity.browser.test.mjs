import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme } from "./helpers.mjs";
import { chooseReportScope, reportContents, scanReport, openReportLibrary } from "./report-journey-helpers.mjs";

async function setup(t) {
    const { context, root } = await privateFixture(t);
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        search: { modelDirectory: path.join(root, "model-not-provisioned") },
        evaluation: {
            evaluatorFactory: async () => { throw new Error("Interface proof cannot run a model."); },
            readSource: async () => { throw new Error("Interface proof cannot read external sources."); },
        },
    });
    const browser = await chromium.launch();
    t.after(async () => {
        await browser.close();
        runtime.server.closeAllConnections();
        await runtime.close();
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST") writes.push(new URL(request.url()).pathname);
    });
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue() : route.abort("blockedbyclient"));
    t.after(() => assert.deepEqual(errors, []));
    async function go(hash) {
        if (page.url() === runtime.url + hash) await page.reload();
        else await page.goto(runtime.url + hash);
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        await page.evaluate(() => document.fonts.ready);
    }
    return { page, go, context, writes };
}

test("screen titles stand alone and existing help keeps keyboard and touch access", { timeout: 30000 }, async t => {
    const { page, go, writes } = await setup(t);
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const [route, heading] of [
            ["#reports", "Reports"], ["#reports?task=create", "Create a report"],
            ["#settings?section=display", "Settings"], ["#collection-status", "Collection status"],
        ]) {
            await go(route);
            await chooseTheme(page, theme);
            await expect(page.locator("#pageTitle")).toHaveText(heading);
            await expect(page.locator("#pageIntro")).toBeHidden();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        }
        await go("#analyze");
        const summary = page.locator("#freshHelp > summary");
        await summary.focus();
        const closed = await summary.boundingBox();
        await summary.press("Enter");
        await expect(page.locator("#freshHelp")).toHaveAttribute("open", "");
        await expect(summary).toBeFocused();
        const opened = await summary.boundingBox();
        assert.ok(Math.abs(opened.x - closed.x) <= 1 && Math.abs(opened.y - closed.y) <= 1);
        await expect(page.locator("#freshHelp")).toContainText("Paused collection stays paused.");
        await expect(page.locator("#freshHelp")).toContainText("all eligible chats, not this view's filters");
        await expect(page.locator("#freshHelp")).toContainText("does not run Work IQ or Graph queries");
        await summary.press("Space");
        await expect(page.locator("#freshHelp")).not.toHaveAttribute("open", "");
        const reclosed = await summary.boundingBox();
        assert.ok(Math.abs(reclosed.x - closed.x) <= 1 && Math.abs(reclosed.y - closed.y) <= 1);
        await summary.tap();
        await expect(page.locator("#freshHelp")).toHaveAttribute("open", "");
        await summary.tap();
        const dateHelp = page.locator('#dateFilter').locator("xpath=ancestor::div[contains(@class,'filter-field')]").locator(".ux-help");
        await dateHelp.focus();
        await expect(page.getByRole("tooltip")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dateHelp).toBeFocused();
        await expect(page.getByRole("tooltip")).toBeHidden();
    }
    assert.ok(!writes.some(endpoint => /\/(?:configure|enabled|preview|export|feedback|consent\/set)$/.test(endpoint)));
});

test("Setup presents nonzero exclusion facts without turning unavailable counts into zero", { timeout: 30000 }, async t => {
    const { page, go, writes } = await setup(t);
    let mode = "known-empty";
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), json = await response.json();
        if (mode === "mixed") Object.assign(json.exportCatalog.excluded, {
            syntheticRequestGroups: 2, duplicateEvidenceRecords: 3,
            excludedOrDuplicateEvidenceRecords: 4, unidentifiableEvidenceRecords: null,
        });
        if (mode === "missing") delete json.exportCatalog.excluded;
        await route.fulfill({ response, json });
    });
    await go("#reports?task=create");
    await expect(page.locator("#report-heading-context,#reportsTitle")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Set up your report", exact: true })).toBeVisible();
    await expect(page.locator("#reportPromptAuthorHelp")).toHaveCount(0);
    assert.equal(await page.locator('#formatOptions input[type=checkbox]').count(), 4);
    assert.equal(await page.locator('[name=reportScope]').count(), 3);
    assert.equal(await page.locator('[name=promptMode]').count(), 3);
    await expect(page.locator("#exportBtn")).toBeDisabled();
    await page.locator("#scopeDetails > summary").click();
    await expect(page.locator("#scopeExclusions")).toHaveText("No collection exclusions.");
    await expect(page.locator("#scopeExclusions dl")).toHaveCount(0);
    await chooseReportScope(page, "all");
    await expect(page.locator("#exportBtn")).toBeEnabled();
    for (const next of ["mixed", "missing"]) {
        mode = next;
        await go("#reports?task=create");
        await page.locator("#scopeDetails > summary").click();
        if (next === "missing") {
            await expect(page.locator("#scopeExclusions")).toHaveText("Collection exclusion counts unavailable.");
            continue;
        }
        assert.deepEqual(await page.locator("#scopeExclusions dl > div").evaluateAll(rows =>
            rows.map(row => [row.querySelector("dt").textContent, row.querySelector("dd").textContent])), [
            ["Synthetic request groups", "2"], ["Duplicate evidence records", "3"],
            ["Unidentifiable evidence records", "Count unavailable"],
            ["Total excluded or deduplicated evidence records", "4"],
        ]);
        await expect(page.locator("#scopeExclusions")).toContainText("Categories may overlap; do not add them.");
        for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
            await page.setViewportSize({ width, height: 1000 });
            await chooseTheme(page, theme);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            assert.deepEqual(await page.locator("#scopeExclusions dt,#scopeExclusions dd").evaluateAll(nodes =>
                nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent)), []);
        }
    }
    assert.ok(!writes.some(endpoint => ["/api/preview", "/api/privacy-review", "/api/export"].includes(endpoint)));
});

test("library keeps one count and opens the actual frozen report after separate Review and Save", { timeout: 30000 }, async t => {
    const { page, go, context, writes } = await setup(t);
    await go("#reports");
    await expect(page.locator("#savedReportSearch")).toBeHidden();
    await expect(page.locator("#savedLibraryHelp")).toBeHidden();
    await page.getByRole("link", { name: "Create a report", exact: true }).click();
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator('[name=promptMode][value=none]').check();
    await scanReport(page);
    await page.frameLocator("#reportReviewBody iframe").locator("h1").waitFor();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    const saved = (await loadBoardState(context)).exports[0];
    const before = await Promise.all(Object.values(saved.files).map(file => readFile(file)));
    await openReportLibrary(page);
    await expect(page.locator("#savedLibraryTitle")).toHaveText("Saved reports (1)");
    await expect(page.locator("#savedReportCount")).toBeHidden();
    await page.locator("#savedLibraryHelp > summary").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#savedLibraryHelp")).toContainText("use the saved copy");
    await page.keyboard.press("Space");
    await page.locator("#savedReportSearch").fill("no-such-report");
    await expect(page.locator("#bundleList")).toContainText("No saved reports match");
    await page.locator("#clearSavedReportSearch").click();
    const open = page.getByRole("button", { name: "Open saved report", exact: true });
    await open.click();
    await page.frameLocator("#savedReportReader iframe").locator("h1").waitFor();
    await page.keyboard.press("Escape");
    await expect(open).toBeFocused();
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(file => readFile(file))), before);
    for (const endpoint of ["/api/preview", "/api/privacy-review", "/api/export"]) {
        assert.equal(writes.filter(value => value === endpoint).length, 1);
    }
});
