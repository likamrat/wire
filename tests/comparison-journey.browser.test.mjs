import { historicalComparison } from "./historical-comparison-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { privateFixture, fixture } from "./helpers.mjs";
import { openReportLibrary } from "./report-journey-helpers.mjs";

const timeContext = { timeZone: "America/Los_Angeles", locale: "en-US" };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function hashes(bundle) {
    return Object.fromEntries(await Promise.all(Object.entries(bundle.files).map(async ([name, file]) => [name, hash(await readFile(file))])));
}
async function setup(t, { comparison = false, timed = false, empty = false, comparisonFormats = ["html", "json"] } = {}) {
    const a = fixture("baseline"), b = fixture("later");
    a.userPrompt.sourceEventId = "baseline-message"; b.userPrompt.sourceEventId = "later-message";
    b.toolCalls[0].toolSucceeded = false; b.toolCalls[0].reportedOutcome = "failed";
    if (timed) for (const [index, record] of [a, b].entries()) Object.assign(record.toolCalls[0], {
        completionEventId: `completion-${index}`, startedAt: "2026-10-01T12:00:00.000Z",
        completedAt: `2026-10-01T12:00:00.${index ? "150" : "200"}Z`, durationMs: index ? 150 : 200,
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [a, b]);
    let runtime, browser;
    const calls = [], errors = [], unexpected = [];
    t.after(async () => {
        try { await browser?.close(); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); }
        finally { try { await runtime?.close(); } finally { for (const action of cleanup) await action(); } }
    });
    const controller = createExportController(context), bundles = [];
    for (const id of empty ? [] : ["baseline", "later"]) {
        const state = await loadBoardState(context);
        const preview = await controller.preview("synthetic-seed", undefined, { promptMode: "none", formats: ["html", "json"], timeContext }, { kind: "selected", revision: state.revision, scenarioIds: [id] });
        await controller.review("synthetic-seed", preview.previewId, true, timeContext);
        bundles.push((await controller.confirm("synthetic-seed", preview.previewId, true, timeContext)).bundle);
    }
    let savedComparison;
    if (comparison) {
        const preview = await historicalComparison(context, bundles[0].bundleId, bundles[1].bundleId, { formats: comparisonFormats, timeContext });
        savedComparison = preview.bundle;
    }
    runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: timeContext.timeZone, locale: timeContext.locale, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin) { unexpected.push(url.href); return route.abort(); }
        if (request.method() === "POST") calls.push({ path: url.pathname, body: request.postDataJSON() });
        return route.continue();
    });
    await page.goto(runtime.url + "reports?task=library");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const row = id => page.locator(`#bundleList [data-bundle-id="${id}"]`);
    return { context, controller, page, calls, bundles, savedComparison, row };
}
async function openFile(row, format = "Web page (HTML)") {
    await row.locator(".saved-report-files").click();
    await row.getByRole("dialog").getByRole("button", { name: format, exact: true }).click();
}
test("contextual report deletion cancels safely and preserves a saved comparison's frozen files on confirm", { timeout: 45000 }, async t => {
    const { context, page, calls, bundles, savedComparison, row } = await setup(t, { comparison: true });
    const original = await hashes(bundles[0]), other = await hashes(bundles[1]), comparisonHash = await hashes(savedComparison);
    const evidence = (await loadBoardState(context)).evidence;
    const item = row(bundles[0].bundleId);
    await item.getByRole("button", { name: "Inspect details" }).click();
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/preview"));
    await page.locator("#contextSidebar").getByRole("button", { name: "Delete report", exact: true }).click();
    const deletionPreview = await previewResponse;
    assert.equal(deletionPreview.status(), 200, await deletionPreview.text());
    const dialog = page.locator('dialog[aria-labelledby="savedArtifactDeleteTitle"]');
    const confirm = dialog.getByRole("button", { name: "Delete report", exact: true });
    await page.waitForFunction(() => !document.querySelector(".delete-object-confirm")?.disabled);
    assert.match(await dialog.textContent(), /1 saved comparison keeps frozen information/);
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(node => node === document.activeElement), true);
    assert.equal(calls.filter(call => call.path === "/api/artifact-deletion/confirm").length, 0);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false);
    assert.deepEqual(await hashes(bundles[0]), original);
    await page.locator("#contextSidebar").getByRole("button", { name: "Delete report", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".delete-object-confirm")?.disabled);
    const deletion = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/confirm"));
    await confirm.click();
    const deletedResponse = await deletion;
    assert.equal(deletedResponse.status(), 200, await deletedResponse.text());
    await dialog.getByRole("button", { name: "Close", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#contextSidebar").getByText("This saved item is no longer available. Return to the library and refresh.", { exact: true }).waitFor();
    await page.locator("#closeContextSidebar").click();
    await page.waitForFunction(() => document.activeElement === document.querySelector("#savedLibraryTitle"));
    const state = await loadBoardState(context);
    assert.equal(state.exports.some(bundle => bundle.bundleId === bundles[0].bundleId), false);
    assert.equal(state.exports.some(bundle => bundle.bundleId === savedComparison.bundleId), true);
    assert.deepEqual(state.evidence, evidence);
    assert.deepEqual(await hashes(bundles[1]), other);
    assert.deepEqual(await hashes(savedComparison), comparisonHash);
    await assert.rejects(stat(bundles[0].files["product-report.json"]), { code: "ENOENT" });
    assert.equal(await page.locator("#savedLibraryTitle").evaluate(node => node === document.activeElement), true);
    const keptComparison = row(savedComparison.bundleId);
    await keptComparison.getByRole("button", { name: "Inspect details" }).click();
    const opened = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await page.locator("#contextSidebar").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    const openedResponse = await opened;
    assert.equal(openedResponse.status(), 200, await openedResponse.text());
    assert.equal((await openedResponse.json()).artifact.sourceReports.some(source => source.available === false), true);
    await page.locator("#savedReportReader iframe").waitFor();
    assert.match(await page.locator("#savedReportReader").textContent(), /original report is no longer available.*saved copy is unchanged/i);
    assert.deepEqual(await hashes(savedComparison), comparisonHash);
});

test("bulk report deletion preserves saved comparisons", { timeout: 30000 }, async t => {
    const { context, page, calls, savedComparison } = await setup(t, { comparison: true });
    const frozen = await hashes(savedComparison), before = await loadBoardState(context);
    await openReportLibrary(page);
    await page.locator("#savedLibraryOptions").click();
    await page.locator("#deleteAllReports").click();
    const dialog = page.locator('dialog[aria-labelledby="savedArtifactDeleteTitle"]');
    await dialog.getByRole("button", { name: "Delete 2 saved reports", exact: true }).waitFor();
    assert.match(await dialog.innerText(), /draft reports.*unchanged/);
    assert.doesNotMatch(await dialog.innerText(), /unfinished drafts/);
    if (process.env.WIRE_LIBRARY_SCOPE_PROOFS) {
        await mkdir(process.env.WIRE_LIBRARY_SCOPE_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_LIBRARY_SCOPE_PROOFS, "confirmation-draft-scope.png") });
    }
    await dialog.getByRole("button", { name: "Delete 2 saved reports", exact: true }).click();
    await dialog.getByRole("heading", { name: "2 saved reports deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    assert.deepEqual(await hashes(savedComparison), frozen);
    const after = await loadBoardState(context);
    assert.deepEqual(after.exports.map(bundle => bundle.bundleId), [savedComparison.bundleId]);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(calls.filter(call => call.path === "/api/artifact-deletion/confirm").length, 1);
    assert.equal(calls.filter(call => call.path === "/api/report-comparison/save").length, 0);
});

test("uncertain saved-object deletion recovers after page renewal without another confirm", { timeout: 30000 }, async t => {
    const { context, page, bundles, row } = await setup(t);
    let confirms = 0, committedStatus;
    await page.route("**/api/artifact-deletion/confirm", async route => {
        confirms++;
        assert.deepEqual(Object.keys(route.request().postDataJSON()).sort(), ["confirmed", "operationId"]);
        const result = await route.fetch();
        committedStatus = result.status();
        await route.abort("connectionreset");
    });
    const item = row(bundles[0].bundleId);
    await item.getByRole("button", { name: "Inspect details" }).click();
    const prepared = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/preview"));
    await page.locator("#contextSidebar").getByRole("button", { name: "Delete report", exact: true }).click();
    const preparedResponse = await prepared;
    assert.equal(preparedResponse.status(), 200);
    const preview = await preparedResponse.json();
    assert.equal(/^[a-f0-9]{64}$/.test(preview.receiptToken), true);
    const dialog = page.locator('dialog[aria-labelledby="savedArtifactDeleteTitle"]');
    await page.waitForFunction(() => !document.querySelector(".delete-object-confirm").disabled);
    await dialog.getByRole("button", { name: "Delete report", exact: true }).click();
    await dialog.getByRole("button", { name: "Check deletion result", exact: true }).waitFor();
    assert.equal(committedStatus, 200);
    assert.equal(await page.locator("body").textContent().then(text => text.includes(preview.receiptToken)), false);
    await page.reload();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator("#contextSidebar").getByText("This saved item is no longer available. Return to the library and refresh.", { exact: true }).waitFor();
    await page.locator("#closeContextSidebar").click();
    const recovered = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/status"));
    await page.getByRole("button", { name: "Check earlier saved-item deletion", exact: true }).click();
    const recoveredResponse = await recovered;
    assert.equal(recoveredResponse.status(), 200);
    assert.equal((await recoveredResponse.json()).phase, "complete");
    await page.waitForFunction(() => sessionStorage.getItem("wire.saved-artifact-deletion") === null);
    assert.equal(confirms, 1);
    assert.equal((await loadBoardState(context)).exports.some(item => item.bundleId === bundles[0].bundleId), false);
    assert.equal(await page.locator("body").textContent().then(text => text.includes(preview.receiptToken)), false);
});

test("library comparison Open reads its actual frozen HTML rather than today's comparison renderer", async t => {
    const { context, page, calls, savedComparison, row } = await setup(t, { comparison: true });
    const name = "comparison-report.html", manifestName = "coverage-and-redaction-manifest.json";
    const html = (await readFile(savedComparison.files[name], "utf8")).replace("</main>",
        '<h2 id="historical-copy">Independently reviewed historical comparison typography</h2><script>parent.savedComparisonExecuted=true</script><a href="https://outside.invalid/">External companion</a></main>');
    await writeFile(savedComparison.files[name], html);
    const manifest = JSON.parse(await readFile(savedComparison.files[manifestName], "utf8"));
    manifest.files[name] = { sha256: hash(html), bytes: Buffer.byteLength(html) };
    const bytes = JSON.stringify(manifest);
    await writeFile(savedComparison.files[manifestName], bytes);
    await updateBoardState(context, state => { state.exports.find(item => item.bundleId === savedComparison.bundleId).manifestHash = hash(bytes); });
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    const original = await hashes(savedComparison), count = calls.length;
    await openFile(row(savedComparison.bundleId));
    await page.waitForFunction(() => document.querySelector("#savedReportReader iframe,#savedReportReader .error"));
    assert.equal(await page.locator("#savedReportReader iframe").count(), 1, "Open must read a verified frozen file, not re-render its manifest facts");
    await page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: "Independently reviewed historical comparison typography", exact: true }).waitFor();
    assert.equal(await page.frameLocator("#savedReportReader iframe").locator("body").getAttribute("class"), "comparison-document");
    assert.equal(await page.frameLocator("#savedReportReader iframe").locator("body").evaluate(node => getComputedStyle(node).paddingLeft), "32px",
        "Frozen document classes and their original layout survive the inert preview");
    assert.equal(await page.frameLocator("#savedReportReader iframe").locator("script,a[href]").count(), 0);
    assert.equal(await page.evaluate(() => window.savedComparisonExecuted), undefined);
    await page.getByRole("button", { name: "Back to saved reports", exact: true }).click();
    assert.equal(await row(savedComparison.bundleId).locator(".saved-report-files").evaluate(node => node === document.activeElement), true);
    assert.equal(calls.slice(count).some(call => /\/(preview|review|save|export)$/.test(call.path)), false);
    assert.deepEqual(await hashes(savedComparison), original);
});

test("opened-report downloads reject altered registered files instead of bypassing verification", async t => {
    const { page, bundles, row } = await setup(t);
    const name = "product-report.html", original = await readFile(bundles[0].files[name]);
    await openFile(row(bundles[0].bundleId));
    await page.locator("#savedReportReader iframe").waitFor();
    await writeFile(bundles[0].files[name], Buffer.concat([original, Buffer.from("\nALTERED_UNREVIEWED_COPY")]));
    const downloads = [];
    page.on("download", download => downloads.push(download.suggestedFilename()));
    const response = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await page.locator("#savedReportReader").getByRole("button", { name: "Download", exact: true }).click();
    assert.equal((await response).status(), 409, "Unreviewed bytes must never be returned as a saved download");
    assert.deepEqual(downloads, []);
});

test("closing a pending frozen comparison fences its late response without changing the selected report", async t => {
    const { page, bundles, savedComparison, row } = await setup(t, { comparison: true });
    const reading = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/artifact-file", async route => {
        const response = await route.fetch(); reading.resolve(); await release.promise;
        await route.fulfill({ response });
    });
    await openFile(row(savedComparison.bundleId));
    await reading.promise;
    await page.getByRole("button", { name: "Back to saved reports", exact: true }).click();
    await openFile(row(bundles[0].bundleId));
    await page.locator("#savedReportReader iframe").waitFor();
    const completed = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    release.resolve(); await completed;
    assert.match(await page.frameLocator("#savedReportReader iframe").locator("body").textContent(), new RegExp(bundles[0].bundleId));
    assert.equal(await page.frameLocator("#savedReportReader iframe").locator("h1").innerText(), bundles[0].title);
    assert.equal(await page.locator("#savedReportReader iframe").getAttribute("title"), bundles[0].title);
});

test("a comparison without saved HTML opens its verified JSON and exposes only its saved formats", async t => {
    const { page, savedComparison, row } = await setup(t, { comparison: true, comparisonFormats: ["json"] });
    const entry = row(savedComparison.bundleId);
    assert.equal(await entry.locator(".saved-report-title").count(), 1);
    await openFile(entry, "Structured data (JSON)");
    const tree = page.locator("#savedReportReader .saved-json-tree");
    await tree.waitFor();
    assert.equal(await page.locator("#pageTitle").textContent(), savedComparison.title);
    const frozen = JSON.parse(await readFile(savedComparison.files["comparison-report.json"], "utf8"));
    assert.deepEqual(await tree.locator(":scope > .saved-json-row > .saved-json-key, :scope > details > summary > .saved-json-key").allTextContents(),
        Object.keys(frozen));
    assert.deepEqual(await page.locator("#savedReportReader select option").allTextContents(), ["Report in WIRE", "Structured data (JSON)", "File list (manifest)"]);
    const response = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await page.locator("#savedReportReader").getByRole("button", { name: "Download", exact: true }).click();
    const value = await (await response).json();
    assert.equal(value.format, "json");
    assert.deepEqual(Buffer.from(value.data, "base64"), await readFile(savedComparison.files["comparison-report.json"]));
});

test("an expired connection renews only the verified frozen-file read, never review or save", async t => {
    const { page, calls, savedComparison, row } = await setup(t, { comparison: true });
    const before = await hashes(savedComparison);
    let reads = 0;
    await page.route("**/api/artifact-file", route => ++reads === 1
        ? route.fulfill({ status: 403, json: { code: "session_expired", error: "Invented expired connection." } })
        : route.continue());
    await openFile(row(savedComparison.bundleId));
    await page.locator("#savedReportReader iframe").waitFor();
    assert.equal(reads, 2);
    assert.equal(calls.filter(call => call.path === "/api/session").length, 1);
    assert.equal(calls.some(call => /\/(preview|review|save|export)$/.test(call.path)), false);
    assert.deepEqual(await hashes(savedComparison), before);
});
