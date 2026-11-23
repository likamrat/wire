import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, navigateMain } from "./helpers.mjs";
import { openReportLibrary } from "./report-journey-helpers.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function setup(t, count = 1001) {
    const { context } = await privateFixture(t, [fixture()]), controller = createExportController(context), entries = [];
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
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); runtime.server.closeAllConnections(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(8000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    return { page, context, entries, requests };
}

test("a thousand-report library has bounded rows, direct page navigation, metadata search, frozen open and confirmed report-only deletion", { timeout: 120000 }, async t => {
    const { page, context, entries, requests } = await setup(t);
    const before = await loadBoardState(context);
    await openReportLibrary(page);
    await expect(page.locator(".saved-library-row")).toHaveCount(6);
    assert.match(await page.locator("#savedReportCount").textContent(), /1,001 reports.*1 comparison/);
    await page.getByRole("spinbutton", { name: "Saved library page", exact: true }).fill("167");
    await page.getByRole("button", { name: "Go to page", exact: true }).click();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await page.locator("#savedReportSearch").fill(entries[0].bundleId);
    await expect(page.locator(".saved-library-row")).toHaveCount(1);
    const opener = page.locator(".saved-library-row .saved-report-title");
    await opener.click();
    await page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: "Frozen synthetic report 1", exact: true }).waitFor();
    await page.getByRole("button", { name: "Back to saved reports", exact: true }).click();
    await expect(opener).toBeFocused();
    await page.locator("#savedReportSearch").fill("SYNTHETIC_PRIVATE_CONTENT_NEVER_SEARCHED");
    assert.match(await page.locator("#bundleList").textContent(), /No saved reports match/);
    await page.locator("#clearSavedReportSearch").click();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await navigateMain(page, "analyze"); await page.goBack();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await page.locator("#savedReportSearch").fill(entries[0].bundleId);
    await page.locator(".saved-library-row").getByRole("button", { name: "Delete report", exact: true }).click();
    await page.locator(".delete-object-confirm:not([disabled])").waitFor();
    await page.locator(".deletion-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual((await loadBoardState(context)).exports, before.exports);
    await page.locator("#savedLibraryOptions").click();
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/preview"), { timeout: 60000 });
    await page.locator("#deleteAllReports").click();
    const bulkPreview = await previewResponse;
    assert.equal(bulkPreview.status(), 200, JSON.stringify(await bulkPreview.json()));
    const comparison = entries.at(-1), frozen = await readFile(comparison.files["comparison-report.html"]);
    const [confirmed] = await Promise.all([page.waitForResponse("**/api/artifact-deletion/confirm", { timeout: 60000 }),
        page.getByRole("button", { name: "Delete 1,001 saved reports", exact: true }).click()]);
    assert.equal(confirmed.status(), 200);
    await page.getByRole("heading", { name: "1,001 saved reports deleted", exact: true }).waitFor();
    await page.locator(".deletion-dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#clearSavedReportSearch").click();
    await expect(page.locator(".saved-library-row")).toHaveCount(1);
    assert.equal(await page.locator("#bundleList .list-pager").isVisible(), false);
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
    const after = await loadBoardState(context);
    assert.deepEqual(after.exports.map(entry => entry.bundleId), [comparison.bundleId]);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
    assert.equal(await readFile(comparison.files["comparison-report.html"], "utf8"), frozen.toString());
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/confirm").length, 1);
    assert.deepEqual(requests.filter(url => ["/api/export", "/api/preview", "/api/evaluation/run", "/api/evaluation/automatic/approve", "/api/collection/now"].includes(url)), []);
});

test("a pending or failed list cannot authorize deletion; verified empty stays distinct from an unavailable library", async t => {
    const { page, context } = await setup(t, 6);
    await openReportLibrary(page);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => { await gate; await route.fulfill({ status: 503, json: { error: "Synthetic saved-list read unavailable." } }); }, { times: 1 });
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await page.locator('#workspace[aria-busy="true"]').waitFor();
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A pending list does not permit a new deletion preview");
    release();
    await page.getByText("Synthetic saved-list read unavailable.", { exact: false }).first().waitFor();
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A failed snapshot cannot approve destructive work");
    await updateBoardState(context, state => { state.exports = []; });
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.match(await page.locator("#bundleList").innerText(), /No saved reports/);
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
});

test("a lost bulk response survives panel reload, checks only its receipt and leaves an unfinished draft unchanged", { timeout: 30000 }, async t => {
    const { page, context, requests } = await setup(t, 2);
    await page.locator('[name=promptMode][value=original]').check();
    await openReportLibrary(page);
    await page.locator("#savedLibraryOptions").click();
    await page.route("**/api/artifact-deletion/confirm", async route => {
        const result = await route.fetch();
        assert.equal(result.status(), 200);
        await route.abort("connectionreset");
    });
    await page.locator("#deleteAllReports").click();
    await page.getByRole("button", { name: "Delete 2 saved reports", exact: true }).click();
    await page.getByRole("button", { name: "Check deletion result", exact: true }).waitFor();
    assert.equal(requests.includes("/api/preview"), false);
    assert.equal(await page.locator('[name=promptMode][value=original]').isChecked(), true);
    assert.equal((await loadBoardState(context)).exports.length, 1);
    const receipt = await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion"));
    assert.ok(receipt);
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.getByRole("button", { name: "Check earlier saved-item deletion", exact: true }).click();
    await page.getByRole("heading", { name: "2 saved reports deleted", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion")), null);
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/confirm").length, 1);
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/status").length, 1);
});
