import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, navigateMain, chooseTheme } from "./helpers.mjs";
import { chooseReportScope, reportContents, openReportLibrary } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function setup(t, count = 1001) {
    const { context } = await privateFixture(t, [fixture()]);
    const entries = [];
    for (let index = 0; index < count + 1; index++) {
        const bundleId = `export-${randomUUID()}`, kind = index === count ? "comparison" : "report";
        const folder = path.join(context.dataDir, "exports", bundleId, "files");
        await mkdir(folder, { recursive: true });
        const name = kind === "report" ? "product-report.html" : "comparison-report.html";
        const html = `<!doctype html><html lang="en"><body><h1>Frozen synthetic ${kind} ${index + 1}</h1><p>SYNTHETIC_PRIVATE_CONTENT_NEVER_SEARCHED</p></body></html>`;
        const manifestName = "coverage-and-redaction-manifest.json";
        const manifest = JSON.stringify({ bundleId, kind, privacyReview: { reviewerConfirmed: true }, files: { [name]: { sha256: hash(html), bytes: Buffer.byteLength(html) } } });
        await writeFile(path.join(folder, name), html); await writeFile(path.join(folder, manifestName), manifest);
        entries.push({
            bundleId, kind, bundleDir: folder, formats: ["html"], promptMode: index % 2 ? "masked" : "none",
            preparedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
            selectionScope: { requestGroups: index + 1 }, privacyReview: { reviewerConfirmed: true },
            manifestHash: hash(manifest), files: { [name]: path.join(folder, name), [manifestName]: path.join(folder, manifestName) },
            ...(kind === "comparison" ? { sourceReports: entries.slice(0, 2).map(entry => ({ bundleId: entry.bundleId })) } : {}),
        });
    }
    await updateBoardState(context, state => { state.exports.push(...entries); });
    const runtime = await startServer(context, createExportController(context), { port: 0 });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); runtime.server.closeAllConnections(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(60000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    return { page, context, entries, requests };
}
async function shot(page, name) {
    if (!process.env.WIRE_LIBRARY_PROOFS) return;
    await mkdir(process.env.WIRE_LIBRARY_PROOFS, { recursive: true });
    const modal = Boolean(await page.locator(":modal").count());
    if (!modal) await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(process.env.WIRE_LIBRARY_PROOFS, `${name}.png`), fullPage: !modal });
}

test("Reports opens directly on the library and switching to creation preserves the reviewed draft and browser Back", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, 2);
    assert.equal(await page.locator("#pageTitle").innerText(), "Reports");
    assert.equal(await page.locator(".report-journey").isVisible(), false);
    assert.equal(await page.locator("#savedReportSearch").isVisible(), true);
    assert.equal(await page.locator("#savedReportSearch").getAttribute("placeholder"), "Search saved reports");
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), true);
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), false, "Finding a report does not require passing Setup");
    await page.locator("#savedReportSearch").focus();
    assert.equal(await page.locator("#savedReportSearch").evaluate(node => node === document.activeElement), true);
    await shot(page, "entry-library-first");
    const create = page.getByRole("link", { name: "Create a report", exact: true });
    assert.match(await create.getAttribute("href"), /task=create/);
    await create.click();
    assert.equal(await page.locator(".report-journey").isVisible(), true);
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), false);
    await chooseReportScope(page, "all");
    await reportContents(page);
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await previewResponse).json();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    const countBefore = requests.length;
    await page.getByRole("link", { name: "Saved reports", exact: true }).click();
    assert.equal(await page.locator(".report-journey").isVisible(), false);
    await page.locator("#savedReportSearch").fill("masked");
    await page.locator("#bundleList").getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator(".saved-report-dialog iframe").waitFor();
    await page.getByRole("button", { name: "Close saved report", exact: true }).click();
    await page.goBack();
    assert.match(page.url(), /task=create/);
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed");
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "3");
    assert.equal(await page.getByRole("button", { name: "Confirm local export", exact: true }).isEnabled(), true);
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), true);
    assert.equal(requests.slice(countBefore).some(url => ["/api/cancel-preview", "/api/preview", "/api/export"].includes(url)), false);
    assert.equal(requests.filter(url => url === "/api/preview").length, 1, preview.previewId);
    await page.goForward();
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "masked");
    await page.getByRole("link", { name: "Continue draft", exact: true }).click();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed");
    await shot(page, "entry-preserved-draft");
    const cancelledBefore = requests.filter(url => url === "/api/cancel-preview").length;
    await navigateMain(page, "activity");
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed", "Unrelated navigation preserves the verified report basis");
    assert.equal(requests.filter(url => url === "/api/cancel-preview").length, cancelledBefore);
});

test("Analyze chat create intent, request return and explicit creation deep links bypass the library without losing selection", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, 2);
    const origin = new URL(page.url()).origin;
    await page.goto(origin + "/#activity?session=test-session");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.getByRole("button", { name: "Create report for this Copilot chat", exact: true }).click();
    assert.match(page.url(), /task=create/);
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 request group/);
    await page.goBack();
    assert.match(page.url(), /#analyze/);
    await page.goForward();
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 request group/);
    if (!await page.locator("#reportRequests").evaluate(node => node.open)) await page.locator("#reportRequests > summary").click();
    await page.locator("#reportList").getByRole("link", { name: "View interaction", exact: true }).click();
    await page.locator("#contextBack").click();
    assert.match(page.url(), /#reports.*task=create/);
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 request group/);
    await navigateMain(page, "reports");
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), true, "Main Reports navigation always leads to the library");
    for (const hash of ["#reports?task=create", "#report", "#reports?request=test-scenario"]) {
        await page.goto(origin + "/" + hash);
        await page.reload();
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        assert.equal(await page.locator("#reportCreatePanel").isVisible(), true, hash);
        assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No requests selected", "A fresh panel does not invent selection from a deep link");
    }
    assert.equal(requests.some(url => ["/api/preview", "/api/export", "/api/artifact-deletion/confirm"].includes(url)), false);
});

test("a thousand-report library has bounded rows, direct page navigation, metadata search, frozen open and confirmed report-only deletion", { timeout: 120000 }, async t => {
    const { page, context, entries, requests } = await setup(t);
    const before = await loadBoardState(context);
    assert.equal(await page.locator("#bundleList .saved-report").count(), 6);
    assert.match(await page.locator("#savedReportCount").textContent(), /1,001 reports.*1 comparison/);
    await shot(page, "large-library-light");
    await page.getByRole("spinbutton", { name: "Saved library page", exact: true }).fill("167");
    await page.getByRole("button", { name: "Go to page", exact: true }).click();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await page.locator("#savedReportSearch").fill(entries[0].bundleId);
    assert.equal(await page.locator("#bundleList .saved-report").count(), 1);
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.frameLocator(".saved-report-dialog iframe").getByRole("heading", { name: "Frozen synthetic report 1", exact: true }).waitFor();
    await page.getByRole("button", { name: "Close saved report", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Open saved report", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.locator("#savedReportSearch").fill("SYNTHETIC_PRIVATE_CONTENT_NEVER_SEARCHED");
    assert.match(await page.locator("#bundleList").textContent(), /No saved reports match/);
    await shot(page, "no-matches");
    await page.locator("#clearSavedReportSearch").click();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await navigateMain(page, "activity"); await page.goBack();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await page.locator("#savedReportSearch").fill(entries[0].bundleId);
    await page.locator("#bundleList .saved-report > summary").click();
    await page.locator("#bundleList").getByRole("button", { name: "Delete report", exact: true }).click();
    await page.locator(".delete-object-confirm:not([disabled])").waitFor();
    await page.locator(".deletion-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/preview"), { timeout: 60000 });
    await page.locator("#deleteAllReports").click();
    const bulkPreview = await previewResponse;
    assert.equal(bulkPreview.status(), 200, JSON.stringify(await bulkPreview.json()));
    await page.getByRole("button", { name: "Delete 1,001 saved reports", exact: true }).waitFor();
    await shot(page, "bulk-confirmation");
    await page.locator(".deletion-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual((await loadBoardState(context)).exports, before.exports);
    await page.locator("#deleteAllReports").click();
    const comparison = entries.at(-1), frozen = await readFile(comparison.files["comparison-report.html"]);
    await page.getByRole("button", { name: "Delete 1,001 saved reports", exact: true }).click();
    await page.getByRole("heading", { name: "1,001 saved reports deleted", exact: true }).waitFor();
    await page.locator(".deletion-dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#clearSavedReportSearch").click();
    assert.match(await page.locator("#bundleList").innerText(), /1-1 of 1 saved item/);
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
    const after = await loadBoardState(context);
    assert.deepEqual(after.exports.map(entry => entry.bundleId), [comparison.bundleId]);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
    assert.equal(await readFile(comparison.files["comparison-report.html"], "utf8"), frozen.toString());
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/confirm").length, 1);
    assert.deepEqual(requests.filter(url => ["/api/export", "/api/preview", "/api/evaluation/run", "/api/evaluation/automatic/approve", "/api/collection/now"].includes(url)), []);
});

test("small, empty and error library states retain accessible controls at narrow widths and 200 percent text", { timeout: 60000 }, async t => {
    const { page, context } = await setup(t, 6);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [820, 100], [375, 100], [1200, 200], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.locator("#bundles").evaluate(root => {
            const rect = node => {
                const box = node.getBoundingClientRect();
                return { label: node.textContent, width: box.width, height: box.height, scroll: node.scrollWidth, client: node.clientWidth };
            };
            const colorPair = node => {
                let background = "rgba(0, 0, 0, 0)";
                for (let parent = node; parent && background === "rgba(0, 0, 0, 0)"; parent = parent.parentElement) background = getComputedStyle(parent).backgroundColor;
                return { label: node.textContent, foreground: getComputedStyle(node).color, background };
            };
            return {
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                controls: [...root.querySelectorAll("button,summary,input"), ...document.querySelectorAll("#reportTaskNav a")].filter(node => node.checkVisibility()).map(rect),
                search: root.querySelector("#savedReportSearch").getBoundingClientRect().width,
                library: root.getBoundingClientRect().width,
                fontLoaded: getComputedStyle(document.body).fontFamily.startsWith("Arial") && document.fonts.check("14px Arial"),
                colors: [...root.querySelectorAll(".saved-report-identity,.saved-report-metadata,.saved-report-manage,#savedReportCount")].map(colorPair),
            };
        });
        assert.equal(geometry.overflow, false, `${theme}/${width}/${scale}`);
        assert.equal(geometry.fontLoaded, true);
        for (const pair of geometry.colors) assert.ok(contrast(pair.foreground, pair.background) >= 4.5, `${theme}: ${pair.label}`);
        assert.deepEqual(geometry.controls.filter(node => node.height < 44 || node.scroll > node.client + 1), [], JSON.stringify({ theme, width, scale, geometry }));
        if (width === 1440 && scale === 100) assert.ok(geometry.search < geometry.library * .6, "Search does not fill the entire desktop library");
        await shot(page, `small-${theme}-${width}-${scale}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.locator("#savedLibraryHelp > summary").click();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => { await gate; await route.fulfill({ status: 503, json: { error: "Synthetic saved-list read unavailable." } }); }, { times: 1 });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.locator('#workspace[aria-busy="true"]').waitFor();
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A pending list does not permit a new deletion preview");
    await shot(page, "library-loading");
    release();
    await page.getByText("Synthetic saved-list read unavailable.", { exact: false }).first().waitFor();
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A failed snapshot cannot approve destructive work");
    await shot(page, "library-error");
    await updateBoardState(context, state => { state.exports = []; });
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    if (!await page.locator("#bundles").evaluate(node => node.open)) await page.locator("#bundles > summary").click();
    assert.match(await page.locator("#bundleList").innerText(), /No local reports have been saved/);
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
    await shot(page, "empty-library");
});

test("a lost bulk response survives panel reload, checks only its receipt and leaves an unfinished draft unchanged", { timeout: 30000 }, async t => {
    const { page, context, requests } = await setup(t, 2);
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator('[name=promptMode][value=original]').check();
    const draftBefore = await page.locator("#reportsView").getAttribute("data-report-step");
    await openReportLibrary(page);
    await page.route("**/api/artifact-deletion/confirm", async route => {
        const result = await route.fetch();
        assert.equal(result.status(), 200);
        await route.abort("connectionreset");
    });
    await page.locator("#deleteAllReports").click();
    await page.getByRole("button", { name: "Delete 2 saved reports", exact: true }).click();
    await page.getByRole("button", { name: "Check deletion result", exact: true }).waitFor();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), draftBefore);
    assert.equal(await page.locator('[name=promptMode][value=original]').isChecked(), true);
    assert.equal((await loadBoardState(context)).exports.length, 1);
    await shot(page, "uncertain-bulk-result");
    const receipt = await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion"));
    assert.ok(receipt);
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.getByRole("button", { name: "Check earlier saved-item deletion", exact: true }).click();
    await page.getByRole("heading", { name: "2 saved reports deleted", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion")), null);
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/confirm").length, 1);
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/status").length, 1);
    await shot(page, "recovered-bulk-result");
});
