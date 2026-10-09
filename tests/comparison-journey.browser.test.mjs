import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { comparisonBodyHtml, renderComparisonMarkdown } from "../lib/report-presentation.mjs";
import { privateFixture, fixture, chooseTheme } from "./helpers.mjs";

const timeContext = { timeZone: "America/Los_Angeles", locale: "en-US" };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function hashes(bundle) {
    return Object.fromEntries(await Promise.all(Object.entries(bundle.files).map(async ([name, file]) => [name, hash(await readFile(file))])));
}
async function setup(t, { comparison = false, timed = false } = {}) {
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
    for (const id of ["baseline", "later"]) {
        const state = await loadBoardState(context);
        const preview = await controller.preview("synthetic-seed", undefined, { promptMode: "none", formats: ["html", "json"], timeContext }, { kind: "selected", revision: state.revision, scenarioIds: [id] });
        await controller.review("synthetic-seed", preview.previewId, true, timeContext);
        bundles.push((await controller.confirm("synthetic-seed", preview.previewId, true, timeContext)).bundle);
    }
    let savedComparison;
    if (comparison) {
        const preview = await controller.previewComparison("synthetic-comparison-seed", bundles[0].bundleId, bundles[1].bundleId, { formats: ["html", "json"], timeContext });
        await controller.reviewComparison("synthetic-comparison-seed", preview.previewId, true, timeContext);
        savedComparison = (await controller.confirmComparison("synthetic-comparison-seed", preview.previewId, true, timeContext)).bundle;
    }
    runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: timeContext.timeZone, locale: timeContext.locale, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    const allowed = new Set([
        "/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary",
        "/api/report-artifacts/list", "/api/report-comparison/inspect", "/api/report-comparison/preview",
        "/api/report-comparison/review", "/api/report-comparison/save", "/api/report-comparison/cancel", "/api/report-comparison/open",
        "/api/artifact-deletion/preview", "/api/artifact-deletion/confirm", "/api/artifact-deletion/status", "/api/artifact-deletion/cancel",
    ]);
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || allowed.has(url.pathname))) {
            if (request.method() === "POST") calls.push({ path: url.pathname, body: request.postDataJSON() });
            return route.continue();
        }
        unexpected.push(url.href); return route.abort();
    });
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (!await page.locator("#bundles").evaluate(node => node.open)) await page.locator("#bundles>summary").click();
    const row = id => page.locator(`#bundleList details[data-disclosure-key="bundle:${id}"]`);
    return { context, controller, page, calls, bundles, savedComparison, row };
}
async function selectReport(page, label, bundleId) {
    await page.locator("#comparisonWorkspace").getByRole("combobox", { name: label, exact: true }).click();
    await page.locator(`.select-popup .select-option[data-value="${bundleId}"]`).click();
}

test("saved comparison Back returns useful focus to its retained draft section without page-top navigation", async t => {
    const { page, calls, bundles, savedComparison, row } = await setup(t, { comparison: true });
    const original = await Promise.all([...bundles, savedComparison].map(hashes));
    await row(bundles[0].bundleId).locator(":scope>summary").click();
    await row(bundles[0].bundleId).getByRole("button", { name: "Compare saved reports", exact: true }).click();
    const workspace = page.locator("#comparisonWorkspace");
    await selectReport(page, "Baseline report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await row(savedComparison.bundleId).locator(":scope>summary").click();
    await row(savedComparison.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await workspace.locator(".report-comparison").waitFor();
    const back = workspace.getByRole("button", { name: "Back to comparison draft", exact: true });
    await back.focus();
    const before = await workspace.evaluate(node => ({ top: node.getBoundingClientRect().top, scroll: scrollY }));
    const count = calls.length;
    await page.keyboard.press("Enter");
    const heading = workspace.getByRole("heading", { name: "Compare saved reports", exact: true });
    t.diagnostic(JSON.stringify({ before, after: await workspace.evaluate(node => ({
        top: node.getBoundingClientRect().top, scroll: scrollY, maxScroll: document.documentElement.scrollHeight - innerHeight,
        focus: document.activeElement.tagName,
    })) }));
    assert.equal(await heading.evaluate(node => node === document.activeElement), true);
    assert.equal(await workspace.locator("select").first().inputValue(), bundles[0].bundleId);
    assert.equal(await workspace.locator("select").nth(1).inputValue(), bundles[1].bundleId);
    const after = await workspace.evaluate(node => ({ top: node.getBoundingClientRect().top, documentY: node.getBoundingClientRect().top + scrollY,
        scroll: scrollY, maxScroll: document.documentElement.scrollHeight - innerHeight }));
    assert.equal(after.top, Math.max(before.top, after.documentY - after.maxScroll));
    assert.equal(calls.length, count, "Returning to retained choices is local presentation, not another comparison/read/write.");
    assert.ok(calls.every(call => ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list", "/api/report-comparison/open"].includes(call.path)));
    assert.deepEqual(await Promise.all([...bundles, savedComparison].map(hashes)), original);
});

test("comparison choices describe saved scope and useful results precede unavailable detail", { timeout: 45000 }, async t => {
    const { page, bundles, row } = await setup(t, { timed: true });
    const original = await Promise.all(bundles.map(hashes));
    await row(bundles[0].bundleId).locator(":scope>summary").click();
    await row(bundles[0].bundleId).getByRole("button", { name: "Compare saved reports", exact: true }).click();
    const workspace = page.locator("#comparisonWorkspace");
    await workspace.locator("select").first().locator("option").nth(1).waitFor({ state: "attached" });
    const options = await workspace.locator("select").first().locator("option").allTextContents();
    assert.ok(options[1].startsWith(bundles[0].preparedAtDisplay), "The distinguishing preparation time leads the selected summary");
    assert.match(options[1], /1 request group.*No prompts/);
    assert.doesNotMatch(options.join(" "), /export-[a-f0-9-]{36}/, "Identity is not the primary option label");
    await workspace.getByRole("combobox", { name: "Baseline report", exact: true }).click();
    assert.match(await page.locator(`.select-option[data-value="${bundles[0].bundleId}"] .select-option-detail`).innerText(), new RegExp(bundles[0].bundleId));
    await page.keyboard.press("Escape");
    await selectReport(page, "Baseline report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    const response = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/inspect"));
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    const model = (await (await response).json()).comparison;
    await workspace.locator(".report-comparison").waitFor();
    const results = workspace.locator(".comparison-tool-results"), timing = workspace.locator(".comparison-metrics").filter({ hasText: "200 ms" });
    assert.ok((await results.boundingBox()).y < (await timing.boundingBox()).y, "Recorded result pair leads the measures");
    assert.deepEqual(await timing.locator(".comparison-metric-value").allTextContents(), ["200 ms", "150 ms"]);
    const unavailable = workspace.locator(".comparison-unavailable");
    assert.equal(await unavailable.evaluate(node => node.open), false);
    assert.match(await unavailable.locator(":scope>summary").innerText(), /Accuracy.*Trust/s);
    assert.doesNotMatch(await unavailable.locator(":scope>summary").innerText(), /Cost/);
    assert.equal(await unavailable.locator("table").isVisible(), false);
    await unavailable.locator(":scope>summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await unavailable.locator("table").isVisible(), true);
    assert.match(await unavailable.innerText(), /Local observations do not assess answer correctness.*0 of 1 assessed/s);
    const html = comparisonBodyHtml(model);
    assert.ok(html.indexOf('class="comparison-tool-results"') < html.indexOf("<caption>Recorded measures</caption>"));
    assert.ok(html.indexOf("<caption>Recorded measures</caption>") < html.indexOf('class="comparison-unavailable"'));
    assert.match(html.slice(html.indexOf('<table class="comparison-patterns">')), /comparison-mobile-label">Earlier/);
    assert.match(html.slice(html.indexOf('<table class="comparison-patterns">')), /comparison-mobile-label">Later/);
    const markdown = renderComparisonMarkdown(model, { preparedAtDisplay: "Synthetic preparation time", bundleId: "synthetic", sourceReports: [] });
    assert.ok(markdown.indexOf("Earlier:") < markdown.indexOf("## Recorded measures"));
    assert.ok(markdown.indexOf("## Recorded measures") < markdown.indexOf("## Unavailable measures and coverage"));
    assert.match(markdown, /200 ms.*150 ms.*-50 ms/);
    await unavailable.locator(":scope>summary").click();
    for (const [theme, width, scale] of [["light", 1200, 100], ["dark", 375, 100], ["dark", 320, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (width === 375 && scale === 100) for (const label of ["Baseline report", "Later report"]) {
            const timeFits = await workspace.getByRole("combobox", { name: label, exact: true }).locator(".select-value").evaluate(node => {
                const time = node.textContent.match(/\d{1,2}:\d{2}:\d{2} [AP]M/);
                if (!time || node.firstChild?.nodeType !== Node.TEXT_NODE) return false;
                const range = document.createRange();
                range.setStart(node.firstChild, 0);
                range.setEnd(node.firstChild, time.index + time[0].length);
                return range.getBoundingClientRect().right <= node.getBoundingClientRect().right - 12;
            });
            assert.equal(timeFits, true, "The complete clock time remains visible before narrow-field ellipsis");
        }
        for (const caption of await workspace.locator(".comparison-metrics:visible caption,.comparison-patterns caption").all()) {
            const bounds = await caption.boundingBox(), parent = await caption.locator("..").boundingBox();
            assert.ok(bounds.width >= parent.width * 0.9, "Table captions use the readable full column, not a crushed intrinsic track");
        }
        if (process.env.WIRE_COMPARISON_USABILITY_PROOFS) {
            await mkdir(process.env.WIRE_COMPARISON_USABILITY_PROOFS, { recursive: true });
            await workspace.evaluate(node => scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 12));
            await page.screenshot({ path: path.join(process.env.WIRE_COMPARISON_USABILITY_PROOFS, `viewport-${theme}-${width}-${scale}.png`) });
            await workspace.screenshot({ path: path.join(process.env.WIRE_COMPARISON_USABILITY_PROOFS, `comparison-${theme}-${width}-${scale}.png`) });
        }
    }
    assert.deepEqual(await Promise.all(bundles.map(hashes)), original);
});

test("two explicit saved reports produce a separately reviewed comparison without changing frozen originals", { timeout: 45000 }, async t => {
    const { context, page, calls, bundles, row } = await setup(t);
    const originalHashes = await Promise.all(bundles.map(hashes));
    await row(bundles[0].bundleId).locator(":scope>summary").click();
    await row(bundles[0].bundleId).getByRole("button", { name: "Compare saved reports", exact: true }).click();
    const workspace = page.locator("#comparisonWorkspace");
    await workspace.locator("select").first().locator("option").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await workspace.locator(".comparison-selectors select").evaluateAll(nodes => nodes.map(node => node.value)), ["", ""]);
    assert.equal(calls.filter(call => call.path.endsWith("/inspect")).length, 0);
    await selectReport(page, "Baseline report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    const inspect = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/inspect"));
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    const inspectResponse = await inspect;
    assert.equal(inspectResponse.status(), 200, await inspectResponse.text());
    await workspace.locator(".report-comparison").waitFor();
    assert.equal((await loadBoardState(context)).exports.length, 2);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No requests selected");
    await workspace.getByRole("checkbox", { name: "JSON", exact: true }).check();
    const preview = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/preview"));
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    const response = await preview;
    assert.equal(response.status(), 200, await response.text());
    const data = await response.json();
    assert.equal(data.kind, "comparison");
    assert.equal(data.privacy.allSelectedFieldsScanned, true);
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true }).isEnabled(), false);
    assert.equal((await loadBoardState(context)).exports.length, 2);
    await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    const review = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/review"));
    await workspace.getByRole("button", { name: "Confirm disclosure", exact: true }).click();
    assert.equal((await review).status(), 200);
    await workspace.getByRole("button", { name: "Save comparison", exact: true }).waitFor();
    const save = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/save"));
    await workspace.getByRole("button", { name: "Save comparison", exact: true }).click();
    const savedResponse = await save;
    assert.equal(savedResponse.status(), 200, await savedResponse.text());
    const saved = (await savedResponse.json()).bundle;
    assert.equal(saved.kind, "comparison");
    assert.equal((await loadBoardState(context)).exports.length, 3);
    assert.deepEqual(await Promise.all(bundles.map(hashes)), originalHashes);
    assert.equal(calls.filter(call => call.path.endsWith("/save")).length, 1);
});

test("contextual report deletion cancels safely and preserves a saved comparison's frozen files on confirm", { timeout: 45000 }, async t => {
    const { context, page, calls, bundles, savedComparison, row } = await setup(t, { comparison: true });
    const original = await hashes(bundles[0]), other = await hashes(bundles[1]), comparisonHash = await hashes(savedComparison);
    const evidence = (await loadBoardState(context)).evidence;
    const item = row(bundles[0].bundleId);
    await item.locator(":scope>summary").click();
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/preview"));
    await item.getByRole("button", { name: "Delete report", exact: true }).click();
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
    await item.getByRole("button", { name: "Delete report", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".delete-object-confirm")?.disabled);
    const deletion = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/confirm"));
    await confirm.click();
    const deletedResponse = await deletion;
    assert.equal(deletedResponse.status(), 200, await deletedResponse.text());
    await dialog.getByRole("button", { name: "Close", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForFunction(() => document.activeElement === document.querySelector("#bundles>summary"));
    const state = await loadBoardState(context);
    assert.equal(state.exports.some(bundle => bundle.bundleId === bundles[0].bundleId), false);
    assert.equal(state.exports.some(bundle => bundle.bundleId === savedComparison.bundleId), true);
    assert.deepEqual(state.evidence, evidence);
    assert.deepEqual(await hashes(bundles[1]), other);
    assert.deepEqual(await hashes(savedComparison), comparisonHash);
    await assert.rejects(stat(bundles[0].files["product-report.json"]), { code: "ENOENT" });
    assert.equal(await page.locator("#bundles>summary").evaluate(node => node === document.activeElement), true);
    const keptComparison = row(savedComparison.bundleId);
    await keptComparison.locator(":scope>summary").click();
    const opened = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/open"));
    await keptComparison.locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    const openedResponse = await opened;
    assert.equal(openedResponse.status(), 200, await openedResponse.text());
    assert.equal((await openedResponse.json()).sources.some(source => source.available === false), true);
    assert.match(await page.locator("#comparisonWorkspace").textContent(), /original report is no longer available.*frozen facts are unchanged/i);
    assert.deepEqual(await hashes(savedComparison), comparisonHash);
});

test("bulk report deletion preserves saved comparisons but invalidates their approved unsaved counterparts", { timeout: 30000 }, async t => {
    const { context, controller, page, calls, bundles, savedComparison, row } = await setup(t, { comparison: true });
    const frozen = await hashes(savedComparison), before = await loadBoardState(context);
    const stale = await controller.previewComparison("dependent-draft", bundles[0].bundleId, bundles[1].bundleId, { timeContext });
    await controller.reviewComparison("dependent-draft", stale.previewId, true, timeContext);
    await row(bundles[0].bundleId).locator(":scope>summary").click();
    await row(bundles[0].bundleId).getByRole("button", { name: "Compare saved reports", exact: true }).click();
    const workspace = page.locator("#comparisonWorkspace");
    await workspace.locator("select option").nth(1).waitFor({ state: "attached" });
    await selectReport(page, "Baseline report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    await workspace.getByRole("button", { name: "Confirm disclosure", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("#comparisonWorkspace button")].some(node => node.textContent === "Save comparison" && !node.disabled));
    await page.locator("#deleteAllReports").click();
    const dialog = page.locator('dialog[aria-labelledby="savedArtifactDeleteTitle"]');
    await dialog.getByRole("button", { name: "Delete 2 saved reports", exact: true }).waitFor();
    assert.match(await dialog.innerText(), /draft reports.*unchanged/);
    assert.match(await dialog.innerText(), /Unsaved comparisons using these reports will become invalid/);
    assert.doesNotMatch(await dialog.innerText(), /unfinished drafts/);
    if (process.env.WIRE_LIBRARY_SCOPE_PROOFS) {
        await mkdir(process.env.WIRE_LIBRARY_SCOPE_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_LIBRARY_SCOPE_PROOFS, "confirmation-draft-scope.png") });
    }
    await dialog.getByRole("button", { name: "Delete 2 saved reports", exact: true }).click();
    await dialog.getByRole("heading", { name: "2 saved reports deleted", exact: true }).waitFor();
    assert.match(await dialog.innerText(), /Unsaved comparisons using the deleted reports are no longer valid/);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true, includeHidden: true }).isDisabled(), true);
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true, includeHidden: true }).isVisible(), false);
    assert.equal(await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true, includeHidden: true }).isChecked(), false);
    await assert.rejects(controller.confirmComparison("dependent-draft", stale.previewId, true, timeContext), /no longer available/);
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
    await item.locator(":scope>summary").click();
    const prepared = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/preview"));
    await item.getByRole("button", { name: "Delete report", exact: true }).click();
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
