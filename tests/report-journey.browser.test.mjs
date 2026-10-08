import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, navigateMain, revealStoredRefresh } from "./helpers.mjs";
import { chooseReportScope, reportContents, inspectReportCopies, scanReport } from "./report-journey-helpers.mjs";

const proofs = process.env.WORKIQ_JOURNEY_PROOFS;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function ready(page) {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
}
async function setup(t, records, controllerOptions) {
    const { context } = await privateFixture(t, records);
    const controller = createExportController(context, undefined, controllerOptions);
    const runtime = await startServer(context, controller, { port: 0 });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1200, height: 960 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
    if (proofs) await mkdir(proofs, { recursive: true });
    return { context, runtime, page, errors, requests };
}

test("guided actual frontend: deliberate one-session scope, four stages and all genuine format downloads", { timeout: 180000 }, async t => {
    const records = [fixture("journey-a"), fixture("journey-b"), fixture("outside")];
    records[0].userPrompt.text = "JOURNEY_ORIGINAL Leila Navarro leila@example.invalid\npassword='JOURNEY_SECRET'\n<script>window.injected=true</script>";
    records[0].sourceSessionName = records[1].sourceSessionName = "Calendar follow-up";
    records[1].userPrompt = { text: null, status: "unavailable", provenance: "human-authored" };
    records[2].sourceSessionId = "unselected-session";
    const { page, runtime, context, errors, requests } = await setup(t, records);
    const initial = await loadBoardState(context);
    const original = await readFile(path.join(context.dataDir, "private-evidence", initial.evidenceFile));
    await page.goto(runtime.url + "#reports"); await ready(page);
    assert.equal(await page.locator("#collectionForm").isVisible(), false);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No requests selected");
    assert.equal(await page.locator("#promptOptions").isVisible(), false);
    assert.equal(await page.locator("#exportBtn").isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Continue to contents", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "3. Review", exact: true }).isDisabled(), true);
    assert.equal(requests.filter(request => request.path === "/api/preview").length, 0);
    for (const mode of ["masked", "none", "original"]) {
        await page.goto(runtime.url + "#activity?session=test-session"); await ready(page);
        const origin = page.url();
        await page.getByRole("button", { name: "Create report for this Copilot chat", exact: true }).click();
        assert.equal(await page.locator("#previewSelectionSummary").textContent(), "One report · 2 request groups included");
        assert.match(await page.locator(".report-entry-context").textContent(), /Calendar follow-up.*all retained dates and services/);
        assert.equal(await page.locator("[name=reportScope]:checked").inputValue(), "selected");
        await page.locator("#pageAction").click();
        assert.equal(page.url(), origin);
        await page.goBack();
        assert.equal(await page.locator("#previewSelectionSummary").textContent(), "One report · 2 request groups included");
        await reportContents(page);
        assert.equal(await page.evaluate(() => document.activeElement.id), "reportStepTitle2");
        assert.equal(await page.locator(".export-scope").isVisible(), false);
        await page.locator(`[name=promptMode][value=${mode}]`).check();
        for (const format of ["pdf", "json", "markdown"]) await page.locator(`#formatOptions input[value=${format}]`).check();
        const preview = await scanReport(page);
        assert.equal(preview.records.length, 2);
        assert.equal(preview.promptMode, mode);
        assert.deepEqual(preview.formats, ["html", "pdf", "json", "markdown"]);
        assert.equal(await page.locator("#overlay").evaluate(node => node.open), false, "Review is inline; sidebar and report context stay available");
        assert.equal(await page.locator(".report-copy-inspection").evaluate(node => node.open), false);
        assert.equal(await page.locator("#reportStage3").isVisible(), true);
        assert.equal(await page.locator("#reportStage4").isVisible(), false);
        assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
        assert.match(await page.locator(".report-time-context").first().textContent(), /America\/Los_Angeles/);
        await page.frameLocator(".report-frame").locator("h1").waitFor();
        const rendered = await page.frameLocator(".report-frame").locator("body").textContent();
        assert.equal(rendered.includes("JOURNEY_ORIGINAL"), mode !== "none");
        assert.equal(rendered.includes("leila@example.invalid"), mode === "original");
        assert.equal(rendered.includes("JOURNEY_SECRET"), false);
        assert.equal(await page.frameLocator(".report-frame").locator("script,img,iframe").count(), 0);
        if (mode === "masked") for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
            await page.setViewportSize({ width, height: 960 }); await chooseTheme(page, theme);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (proofs) {
                await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
                await page.screenshot({ path: path.join(proofs, `review-${theme}-${width}.png`), fullPage: true });
                await page.locator(".report-frame").evaluate(node => node.scrollIntoView({ block: "center" }));
                await page.frameLocator(".report-frame").locator("h1").waitFor({ state: "visible" });
                // Let Chromium composite the resized, script-disabled iframe before capturing pixels.
                await page.waitForTimeout(200);
                await page.screenshot({ path: path.join(proofs, `review-document-${theme}-${width}.png`) });
            }
        }
        await inspectReportCopies(page);
        assert.equal(await page.locator(".prompt-original pre").first().textContent(), records[0].userPrompt.text);
        if (mode !== "none") assert.ok(await page.locator(".prompt-report mark.mandatory").count());
        await page.getByRole("button", { name: "Back to contents", exact: true }).click();
        assert.equal(await page.locator("#exportBtn").textContent(), "Return to review");
        const scans = requests.filter(request => request.path === "/api/preview").length;
        await page.locator("#exportBtn").click();
        assert.equal(requests.filter(request => request.path === "/api/preview").length, scans, "Revisiting unchanged choices does not rescan or approve");
        await page.locator(".attestation input[data-review-control]").check();
        assert.equal(await page.getByRole("button", { name: "4. Save", exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
        await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
        assert.equal(await page.evaluate(() => document.activeElement.id), "reportStepTitle4");
        assert.equal((await loadBoardState(context)).exports.length, ["masked", "none", "original"].indexOf(mode));
        const saved = page.waitForResponse(response => response.url().endsWith("/api/export"));
        await page.getByRole("button", { name: "Confirm local export", exact: true }).dblclick();
        await saved;
        await page.locator("#reportsView[data-report-phase=saved]").waitFor();
        if (mode === "masked") for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
            await page.setViewportSize({ width, height: 960 }); await chooseTheme(page, theme);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (proofs) { await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); }); await page.screenshot({ path: path.join(proofs, `downloads-${theme}-${width}.png`), fullPage: true }); }
        }
        for (const name of ["product-report.html", "product-report.pdf", "product-report.json", "product-report.md"]) {
            const pending = page.waitForEvent("download");
            await page.locator("#reportStage4").getByRole("button", { name: "Download " + name, exact: true }).click();
            const item = await pending, bytes = await readFile(await item.path());
            assert.ok(bytes.length > 100);
            if (name.endsWith(".pdf")) assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
            if (name.endsWith(".json")) assert.deepEqual(JSON.parse(bytes).records, preview.records);
        }
        if (proofs) { await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); }); await page.screenshot({ path: path.join(proofs, `saved-${mode}.png`), fullPage: true }); }
    }
    const final = await loadBoardState(context);
    assert.equal(final.exports.length, 3);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 3, "Double clicks never duplicate writes");
    assert.deepEqual(final.cards, initial.cards);
    assert.deepEqual(await readFile(path.join(context.dataDir, "private-evidence", initial.evidenceFile)), original);
    const savedHashes = await Promise.all(final.exports.map(async bundle => [bundle.bundleId, await Promise.all(Object.values(bundle.files).map(async file => digest(await readFile(file))))]));
    await page.getByRole("button", { name: "Start a new report", exact: true }).click();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "1");
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No requests selected");
    assert.equal(await page.locator("#reportStage4").isVisible(), false);
    assert.deepEqual(await Promise.all(final.exports.map(async bundle => [bundle.bundleId, await Promise.all(Object.values(bundle.files).map(async file => digest(await readFile(file))))])), savedHashes);
    assert.deepEqual(errors, []);
});

test("report-list search preserves the genuine frozen preview and complete exported membership", { timeout: 60000 }, async t => {
    const records = Array.from({ length: 9 }, (_, i) => ({
        ...fixture(`searched-report-${i}`),
        userPrompt: { ...fixture().userPrompt, text: `Synthetic report request ${String(i).padStart(2, "0")}` },
    }));
    const { page, runtime, context, errors, requests } = await setup(t, records);
    const initial = await loadBoardState(context);
    const original = await readFile(path.join(context.dataDir, "private-evidence", initial.evidenceFile));
    await page.goto(runtime.url + "#reports"); await ready(page);
    await chooseReportScope(page, "all"); await reportContents(page);
    await page.locator("[name=promptMode][value=none]").check();
    await page.locator("#formatOptions input[value=json]").check();
    const frozen = await scanReport(page);
    assert.equal(frozen.records.length, 9);
    await page.getByRole("button", { name: "1. Requests", exact: true }).click();
    await page.locator("#reportRequests>summary").click();
    await page.locator("#reportRequestSearch").fill("ReQuEsT-08");
    assert.equal(await page.locator("#reportList .report-entry").count(), 1, "A request beyond page one is found");
    assert.equal(await page.locator("#reportRequestSearchCount").innerText(), "1 of 9 report requests shown. All 9 remain included.");
    await reportContents(page);
    await page.locator("#exportBtn").click();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    assert.equal(requests.filter(row => row.path === "/api/preview").length, 1, "Search neither invalidates nor rescans the unchanged preview");
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    const final = await loadBoardState(context), saved = final.exports[0];
    assert.equal(final.exports.length, 1);
    const exported = JSON.parse(await readFile(saved.files["product-report.json"], "utf8"));
    assert.deepEqual(exported.records, frozen.records);
    for (const file of Object.values(saved.files)) assert.doesNotMatch(await readFile(file, "utf8"), /ReQuEsT-08/);
    assert.doesNotMatch(JSON.stringify(requests), /ReQuEsT-08/);
    assert.deepEqual(final.cards, initial.cards);
    assert.deepEqual(await readFile(path.join(context.dataDir, "private-evidence", initial.evidenceFile)), original);
    assert.deepEqual(errors, []);
    const searchProof = process.env.WORKIQ_SEARCH_REPORT_PROOFS;
    if (searchProof) {
        await mkdir(searchProof, { recursive: true });
        const files = {};
        for (const [name, file] of Object.entries(saved.files)) {
            const bytes = await readFile(file);
            await writeFile(path.join(searchProof, name), bytes);
            files[name] = digest(bytes);
        }
        await writeFile(path.join(searchProof, "membership-proof.json"), JSON.stringify({
            synthetic: true, matchingRequests: 1, includedRequests: 9, exportedRequests: exported.records.length,
            previewCount: requests.filter(row => row.path === "/api/preview").length, files,
        }, null, 2));
    }
});

test("guided scope and controls stay usable at 375/820/1200 in both themes; no all-default, missing-format or scan dead end", { timeout: 120000 }, async t => {
    const { page, runtime, errors } = await setup(t, Array.from({ length: 84 }, (_, i) => fixture(`large-${i}`)), async () => { throw new Error("Synthetic PDF unavailable"); });
    await page.goto(runtime.url + "#reports"); await ready(page);
    assert.equal(await page.locator("#collectionForm").isVisible(), false);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 960 }); await chooseTheme(page, theme);
        await chooseReportScope(page, "all");
        assert.equal(await page.locator("#previewSelectionSummary").textContent(), "One report · 84 request groups included");
        if (proofs) { await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); }); await page.screenshot({ path: path.join(proofs, `requests-${theme}-${width}.png`), fullPage: true }); }
        await reportContents(page);
        await page.locator("#formatOptions input[value=html]").uncheck();
        assert.equal(await page.locator("#exportBtn").isDisabled(), true);
        assert.equal(await page.locator("#formatError").isVisible(), true);
        await page.locator("#formatOptions input[value=html]").check();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('[aria-current=step]').getAttribute("aria-label"), "2. Contents");
        if (proofs) { await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); }); await page.screenshot({ path: path.join(proofs, `contents-${theme}-${width}.png`), fullPage: true }); }
    }
    await page.setViewportSize({ width: 375, height: 960 });
    await page.addStyleTag({ content: "html {font-size:200%}" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.addStyleTag({ content: "html {font-size:100%}" });
    await page.locator("#formatOptions input[value=pdf]").check();
    await page.locator("#exportBtn").click();
    await page.locator("#reportsView[data-report-phase=blocked]").waitFor();
    assert.match(await page.locator("#reportJourneyError").textContent(), /operation failed.*No files were written/);
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    await page.locator("#formatOptions input[value=pdf]").uncheck();
    await scanReport(page);
    await inspectReportCopies(page);
    await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
    await page.locator(".prompt-comparison textarea").first().fill("Edited local copy password='EDIT_SECRET'");
    assert.equal(await page.getByRole("button", { name: "Complete disclosure review", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
    assert.doesNotMatch(await page.frameLocator(".report-frame").locator("body").innerText(), /EDIT_SECRET/);
    await navigateMain(page, "activity"); await page.goBack();
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "One report · 84 request groups included");
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No requests selected");
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "1");
    assert.deepEqual(errors, []);
});

test("a scan can be cancelled, changed source requires fresh review, and reconnect never carries consent", { timeout: 60000 }, async t => {
    const source = fixture();
    const { page, runtime, context, requests, errors } = await setup(t, [source]);
    await page.goto(runtime.url + "#reports"); await ready(page);
    await chooseReportScope(page, "all"); await reportContents(page);
    let release, arrived;
    const hold = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    await page.route("**/api/preview", async route => {
        const response = await route.fetch();
        arrived(); await hold; await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#exportBtn").click(); await pending;
    assert.equal(await page.locator("#reportReviewBody .pending-indicator").isVisible(), true);
    assert.equal(await page.locator("#reportReviewBody .pending-indicator").getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator("#reportReviewBody").getAttribute("aria-busy"), "true");
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    assert.equal(await page.locator("#reportReviewBody .pending-indicator").count(), 0, "Cancelled scan leaves no spinning work");
    const cancelled = page.waitForResponse(response => response.url().endsWith("/api/cancel-preview"));
    release(); await cancelled;
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "2");
    assert.equal(await page.locator(".attestation [data-review-control]").count(), 0);
    await scanReport(page);
    source.userPrompt.text = "Changed synthetic source after scan";
    await replaceEvidence(context, () => ({ records: [source], importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=blocked]").waitFor();
    assert.match(await page.locator("#reportJourneyError").textContent(), /changed|fresh|new preview/i);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await scanReport(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await refreshed; await ready(page);
    assert.equal(await page.getByRole("button", { name: "4. Save", exact: true }).isDisabled(), true);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 0);
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    await scanReport(page);
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
    assert.deepEqual(errors, []);
});

test("final save survives read/lifecycle events, while an uncertain export is never replayed or called success", { timeout: 60000 }, async t => {
    const { page, runtime, context, requests, errors } = await setup(t, [fixture()]);
    await page.goto(runtime.url + "#reports"); await ready(page);
    await chooseReportScope(page, "all");
    async function approve() {
        await scanReport(page);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
        await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    }
    await approve();
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    await page.route("**/api/export", async route => {
        const response = await route.fetch();
        arrived(); await held; await route.fulfill({ response });
    }, { times: 1 });
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await pending;
    assert.equal(await page.getByRole("button", { name: "Confirm local export", exact: true }).getAttribute("data-pending"), "true");
    assert.equal(await page.getByRole("button", { name: "Confirm local export", exact: true }).getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("#reportStage4 .pending-indicator").isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "1. Requests", exact: true }).isDisabled(), true);
    await page.evaluate(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("online"));
        document.querySelector("#refreshBtn").click();
    });
    release();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    assert.equal((await loadBoardState(context)).exports.length, 1);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    await reportContents(page);
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "draft");
    assert.equal(await page.locator(".report-progress-label").textContent(), "Step 2 of 4");
    await approve();
    await page.route("**/api/export", async route => {
        await route.fetch();
        await route.abort("failed");
    }, { times: 1 });
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=blocked]").waitFor();
    assert.match(await page.locator("#reportJourneyError").textContent(), /not replayed|No action was replayed/);
    assert.match(await page.locator("#reportJourneyError").textContent(), /may have completed/);
    assert.equal(await page.locator("#reportSaveBody .report-save-success").count(), 0);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 2);
    assert.equal((await loadBoardState(context)).exports.length, 2, "The interrupted response conceals a real synthetic save; do not repeat it");
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await page.locator("#bundles > summary").click();
    assert.match(await page.locator("#savedReportCount").textContent(), /^2 saved reports/);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 2);
    assert.deepEqual(errors, []);
});
