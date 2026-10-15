import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { fixture, privateFixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedReportDocument, reportHash } from "../lib/report-artifacts.mjs";
import { chooseReportScope, reportContents, scanReport, openReportLibrary } from "./report-journey-helpers.mjs";

async function save(exports, context, formats = ["html", "json"]) {
    const state = await loadBoardState(context);
    const preview = await exports.preview("saved-reader", undefined, { promptMode: "none", formats },
        { kind: "all", revision: state.revision });
    await exports.review("saved-reader", preview.previewId, true);
    return (await exports.confirm("saved-reader", preview.previewId, true)).bundle;
}
test("saved HTML reader verifies exact bytes, registered ownership, disclosure, integrity and availability", async t => {
    const { context } = await privateFixture(t), exports = createExportController(context), bundle = await save(exports, context);
    let state = await loadBoardState(context);
    const bytes = await readFile(bundle.files["product-report.html"]), before = JSON.stringify(state);
    const value = await readSavedReportDocument(context, state, bundle.bundleId);
    assert.equal(value.html, bytes.toString("utf8")); assert.equal(value.sha256, reportHash(bytes));
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    const noHtml = await save(exports, context, ["json"]);
    state = await loadBoardState(context);
    await assert.rejects(readSavedReportDocument(context, state, noHtml.bundleId), /HTML was not saved/);
    await assert.rejects(readSavedReportDocument(context, { ...state, exports: [] }, bundle.bundleId), /no longer available/);
    const forged = structuredClone(state), entry = forged.exports.find(item => item.bundleId === bundle.bundleId);
    entry.files["product-report.html"] = path.join(context.dataDir, "outside.html");
    await assert.rejects(readSavedReportDocument(context, forged, bundle.bundleId), /outside its registered bundle/);
    entry.files["product-report.html"] = bundle.files["product-report.html"]; entry.kind = "comparison";
    await assert.rejects(readSavedReportDocument(context, forged, bundle.bundleId), /no longer available/);
    entry.kind = "report"; entry.privacyReview.reviewerConfirmed = false;
    await assert.rejects(readSavedReportDocument(context, forged, bundle.bundleId), /disclosure manifest/);
    await writeFile(bundle.files["product-report.html"], bytes + "\nchanged");
    await assert.rejects(readSavedReportDocument(context, state, bundle.bundleId), /HTML changed/);
    await writeFile(bundle.files["product-report.html"], bytes);
    const linkedState = structuredClone(state), linkedEntry = linkedState.exports.find(item => item.bundleId === bundle.bundleId);
    const linkedDir = path.join(context.dataDir, "reader-junction"), targetDir = path.join(context.dataDir, "reader-target");
    await mkdir(targetDir); await symlink(targetDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    linkedEntry.bundleDir = linkedDir; linkedEntry.files["product-report.html"] = path.join(linkedDir, "product-report.html");
    await assert.rejects(readSavedReportDocument(context, linkedState, bundle.bundleId), /outside its registered bundle/);
    assert.deepEqual(await readFile(bundle.files["product-report.html"]), bytes);
});

test("saved HTML open is capability-gated, inert, draft-preserving and fences closed or replaced reads", { timeout: 45000 }, async t => {
    const { context } = await privateFixture(t, [fixture("reader")]), exports = createExportController(context);
    const first = await save(exports, context), second = await save(exports, context), missing = await save(exports, context, ["json"]);
    const firstHtml = await readFile(first.files["product-report.html"], "utf8");
    const malicious = firstHtml.replace("</body>", '<h2>Historical Cost</h2><p>FROZEN_LEGACY_VALUE</p><img src="https://outside.invalid/image"><a href="https://outside.invalid/leave">External link</a><meta http-equiv="refresh" content="0;url=https://outside.invalid/refresh"><script>parent.readerExecuted=true</script></body>');
    await writeFile(first.files["product-report.html"], malicious);
    const manifestPath = first.files["coverage-and-redaction-manifest.json"], manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files["product-report.html"] = { sha256: reportHash(malicious), bytes: Buffer.byteLength(malicious) };
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(manifestPath, manifestBytes);
    await updateBoardState(context, state => { state.exports.find(entry => entry.bundleId === first.bundleId).manifestHash = reportHash(manifestBytes); });
    const frozen = await Promise.all(Object.values(first.files).map(file => readFile(file)));
    const runtime = await startServer(context, exports, { port: 0, collector: { timers: false } }), browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const origin = runtime.url.slice(0, -1);
    const rejected = await fetch(origin + "/api/report/open", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ bundleId: first.bundleId }) });
    assert.equal(rejected.status, 403);
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, colorScheme: "dark" }), external = [], writes = [], frameDocuments = [];
    page.setDefaultTimeout(10000);
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort();
    });
    page.on("request", request => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
    page.on("request", request => { if (request.isNavigationRequest() && request.frame() !== page.mainFrame()) frameDocuments.push(request.url()); });
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await chooseReportScope(page, "all"); await reportContents(page); await page.locator("[name=promptMode][value=none]").check();
    const draft = await scanReport(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    await openReportLibrary(page);
    const rowFor = id => page.locator(`[data-bundle-id="${id}"]`);
    const firstRow = rowFor(first.bundleId), secondRow = rowFor(second.bundleId);
    const open = firstRow.getByRole("button", { name: "Open saved report", exact: true });
    await open.click();
    const dialog = page.getByRole("region", { name: "Saved report", exact: true });
    await page.waitForFunction(() => document.querySelector("#savedReportReader iframe,#savedReportReader .error"));
    assert.equal(await dialog.locator("iframe").count(), 1, await dialog.innerText());
    await dialog.locator("iframe").waitFor();
    const frame = dialog.frameLocator("iframe");
    await frame.getByText("FROZEN_LEGACY_VALUE", { exact: true }).waitFor();
    assert.doesNotMatch(await dialog.innerText(), /Report ID:/, "Full identifiers remain in library details rather than competing with the saved document");
    assert.equal(await dialog.locator("iframe").getAttribute("sandbox"), "");
    assert.equal(await frame.locator('a[href]:not([href^="about:srcdoc#"])').count(), 0);
    assert.equal(await frame.locator("html").getAttribute("data-evidence-theme"), "light", "The frozen theme survives an OS-dark reader.");
    assert.equal(await frame.locator("html").getAttribute("lang"), "en");
    assert.equal(await frame.locator("script,base,iframe,meta[http-equiv=refresh]").count(), 0);
    await frame.getByText("External link", { exact: true }).click();
    assert.equal(new URL(page.url()).hash.split("?")[0], "#reports");
    const coverage = frame.getByRole("link", { name: "Coverage", exact: true });
    await coverage.click();
    await frame.locator("#coverage").waitFor({ state: "visible" });
    assert.match(await frame.locator("body").innerText(), /FROZEN_LEGACY_VALUE/);
    assert.ok(await frame.locator("#coverage").evaluate(node => Math.abs(node.getBoundingClientRect().top) < innerHeight));
    assert.deepEqual(frameDocuments, [], "Section links stay in the frozen document, never loading the app shell.");
    assert.equal(await page.evaluate(() => window.readerExecuted), undefined);
    assert.deepEqual(external, []);
    if (process.env.WIRE_QUALITY_PROOFS) await page.screenshot({ path: path.join(process.env.WIRE_QUALITY_PROOFS, "saved-report-reader-light.png") });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.evaluate(() => document.fonts.ready);
    const headerLayout = await dialog.locator(".saved-reader-heading").evaluate(header => {
        const title = header.querySelector("h2"), close = header.querySelector("button");
        const bounds = node => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        const range = document.createRange();
        range.selectNodeContents(title);
        return {
            header: bounds(header), title: bounds(title), close: bounds(close),
            titleLines: range.getClientRects().length,
            overflow: header.scrollWidth > header.clientWidth + 1,
        };
    });
    if (process.env.WIRE_READER_HEADER_PROOFS) {
        await mkdir(process.env.WIRE_READER_HEADER_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_READER_HEADER_PROOFS, "reader-header-375-200.png") });
        await writeFile(path.join(process.env.WIRE_READER_HEADER_PROOFS, "reader-header-layout.json"), JSON.stringify(headerLayout, null, 2));
    }
    assert.ok(headerLayout.titleLines <= 2, `Saved report must wrap by words, not characters: ${JSON.stringify(headerLayout)}`);
    assert.ok(headerLayout.header.height <= 240, "The reader header must leave useful space for the frozen document.");
    assert.ok(headerLayout.title.width >= 100 && headerLayout.close.width >= 44);
    assert.equal(headerLayout.overflow, false);
    assert.ok(headerLayout.close.height >= 44 && headerLayout.close.x >= 0 && headerLayout.close.right <= 375);
    assert.ok(headerLayout.close.y >= 0 && headerLayout.close.bottom <= 1000);
    const keyboardClose = dialog.getByRole("button", { name: "Back to report library", exact: true });
    await keyboardClose.focus();
    assert.equal(await keyboardClose.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await open.evaluate(node => document.activeElement === node), true);
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await open.click();
    await dialog.locator("iframe").waitFor();
    await dialog.getByRole("button", { name: "Back to report library", exact: true }).click();
    assert.equal(await open.evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed");
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), true);
    assert.equal(writes.filter(route => route === "/api/preview").length, 1);
    assert.equal(writes.includes("/api/export"), false);
    const read = Promise.withResolvers(), release = Promise.withResolvers();
    await page.route("**/api/report/open", async route => {
        if (route.request().postDataJSON().bundleId !== first.bundleId) return route.continue();
        const response = await route.fetch(); read.resolve(); await release.promise; await route.fulfill({ response });
    });
    await open.click(); await read.promise;
    await dialog.getByRole("button", { name: "Back to report library", exact: true }).click();
    await secondRow.getByRole("button", { name: "Open saved report", exact: true }).click();
    await dialog.locator("iframe").waitFor(); release.resolve();
    await page.waitForTimeout(50);
    assert.match(await dialog.frameLocator("iframe").locator("body").textContent(), new RegExp(second.bundleId));
    assert.equal(await dialog.frameLocator("iframe").getByText("FROZEN_LEGACY_VALUE", { exact: true }).count(), 0);
    await dialog.getByRole("button", { name: "Back to report library", exact: true }).click();
    const missingRow = rowFor(missing.bundleId); await missingRow.locator(".saved-report-summary").click();
    assert.equal(await missingRow.getByRole("button", { name: "Open saved report", exact: true }).count(), 0);
    assert.match(await page.locator("#contextSidebar").innerText(), /HTML was not saved/);
    assert.deepEqual(await Promise.all(Object.values(first.files).map(file => readFile(file))), frozen);
    assert.equal((await loadBoardState(context)).exports.length, 3);
    assert.ok(draft.previewId);
});
