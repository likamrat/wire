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
    const cleanup = new AsyncDisposableStack();
    t.after(() => cleanup.disposeAsync());
    const { context } = await privateFixture({ after: fn => cleanup.defer(fn) }, [fixture()]);
    const controller = createExportController(context), entries = [];
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
    cleanup.defer(async () => { runtime.server.closeAllConnections(); await runtime.close(); });
    const browser = await chromium.launch({ headless: true });
    cleanup.defer(() => browser.close());
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

test("a thousand-report library has bounded rows, direct page navigation, metadata search and frozen open", { timeout: 120000 }, async t => {
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
    const [cancelled] = await Promise.all([page.waitForResponse("**/api/artifact-deletion/cancel"),
        page.locator(".deletion-dialog").getByRole("button", { name: "Cancel", exact: true }).click()]);
    assert.ok(cancelled.ok());
    assert.deepEqual((await loadBoardState(context)).exports, before.exports);
    assert.ok(!requests.includes("/api/artifact-deletion/confirm"));
});

test("a pending or failed list cannot authorize deletion; verified empty stays distinct from an unavailable library", { timeout: 30000 }, async t => {
    const { page, context } = await setup(t, 6);
    await openReportLibrary(page);
    const gate = Promise.withResolvers();
    await page.route("**/api/snapshot", async route => { await gate.promise; await route.fulfill({ status: 503, json: { error: "Synthetic saved-list read unavailable." } }); });
    try {
        await Promise.all([page.waitForRequest("**/api/snapshot"), page.evaluate(() => window.dispatchEvent(new Event("online")))]);
        await page.locator('#workspace[aria-busy="true"]').waitFor();
        assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A pending list does not permit a new deletion preview");
    } finally {
        gate.resolve();
        await page.unrouteAll({ behavior: "wait" });
    }
    await page.getByText("Synthetic saved-list read unavailable.", { exact: false }).first().waitFor();
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A failed snapshot cannot approve destructive work");
    await updateBoardState(context, state => { state.exports = []; });
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.match(await page.locator("#bundleList").innerText(), /No saved reports/);
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
});

test("a lost bulk response survives panel reload, checks only its receipt and leaves an unfinished draft unchanged", { timeout: 30000 }, async t => {
    const { page, context, requests, entries } = await setup(t, 7);
    const before = await loadBoardState(context), comparison = entries.at(-1);
    const frozen = await readFile(comparison.files["comparison-report.html"]);
    await page.locator('[name=promptMode][value=original]').check();
    await openReportLibrary(page);
    await expect(page.locator(".saved-library-row")).toHaveCount(6);
    await page.locator("#savedReportSearch").fill(entries[0].bundleId);
    await expect(page.locator(".saved-library-row")).toHaveCount(1);
    await page.locator("#savedLibraryOptions").click();
    let committed;
    await page.route("**/api/artifact-deletion/confirm", async route => {
        const result = await route.fetch();
        if (!result.ok()) return route.fulfill({ response: result });
        committed = route.request().postDataJSON().operationId;
        await route.abort("connectionreset");
    }, { times: 1 });
    await page.locator("#deleteAllReports").click();
    await page.getByRole("button", { name: "Delete 7 saved reports", exact: true }).click();
    await page.getByRole("button", { name: "Check deletion result", exact: true }).waitFor();
    assert.equal(requests.includes("/api/preview"), false);
    assert.equal(await page.locator('[name=promptMode][value=original]').isChecked(), true);
    assert.equal((await loadBoardState(context)).exports.length, 1);
    const receipt = await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion"));
    assert.ok(receipt);
    assert.ok(committed);
    assert.equal(JSON.parse(receipt).operationId, committed);
    await page.locator(".deletion-dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#clearSavedReportSearch").click();
    await expect(page.locator("#savedReportSearch")).toHaveValue("");
    await page.reload();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    const [lookup] = await Promise.all([page.waitForRequest("**/api/artifact-deletion/status"),
        page.getByRole("button", { name: "Check earlier saved-item deletion", exact: true }).click()]);
    assert.deepEqual(lookup.postDataJSON(), JSON.parse(receipt));
    await page.getByRole("heading", { name: "7 saved reports deleted", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion")), null);
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/confirm").length, 1);
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/status").length, 1);
    const after = await loadBoardState(context);
    assert.deepEqual(after.exports.map(entry => entry.bundleId), [comparison.bundleId]);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
    assert.deepEqual(await readFile(comparison.files["comparison-report.html"]), frozen);
    assert.deepEqual(requests.filter(url => ["/api/export", "/api/preview", "/api/evaluation/run", "/api/evaluation/automatic/approve", "/api/collection/now"].includes(url)), []);
});
