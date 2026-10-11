import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { comparisonBodyHtml, renderComparisonMarkdown } from "../lib/report-presentation.mjs";
import { privateFixture, fixture, chooseTheme } from "./helpers.mjs";

const timeContext = { timeZone: "America/Los_Angeles", locale: "en-US" };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function hashes(bundle) {
    return Object.fromEntries(await Promise.all(Object.entries(bundle.files).map(async ([name, file]) => [name, hash(await readFile(file))])));
}
async function setup(t, { comparison = false, timed = false, comparisonFormats = ["html", "json"] } = {}) {
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
        const preview = await controller.previewComparison("synthetic-comparison-seed", bundles[0].bundleId, bundles[1].bundleId, { formats: comparisonFormats, timeContext });
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
        "/api/report/open", "/api/report-file", "/api/artifact-file",
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

test("closing a frozen comparison restores its library entry and preserves the comparison draft", async t => {
    const { page, calls, bundles, savedComparison, row } = await setup(t, { comparison: true });
    const original = await Promise.all([...bundles, savedComparison].map(hashes));
    await row(bundles[0].bundleId).locator(":scope>summary").click();
    await row(bundles[0].bundleId).getByRole("button", { name: "Compare saved reports", exact: true }).click();
    const workspace = page.locator("#comparisonWorkspace");
    await selectReport(page, "Baseline report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await row(savedComparison.bundleId).locator(":scope>summary").click();
    const open = row(savedComparison.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true });
    await open.click();
    await page.locator(".saved-report-dialog iframe").waitFor();
    const back = page.getByRole("button", { name: "Close saved comparison", exact: true });
    await back.focus();
    const before = await workspace.evaluate(node => ({ top: node.getBoundingClientRect().top, scroll: scrollY }));
    const count = calls.length;
    await page.keyboard.press("Enter");
    assert.equal(await open.evaluate(node => node === document.activeElement), true);
    assert.equal(await workspace.locator("select").first().inputValue(), bundles[0].bundleId);
    assert.equal(await workspace.locator("select").nth(1).inputValue(), bundles[1].bundleId);
    const after = await workspace.evaluate(node => ({ top: node.getBoundingClientRect().top, documentY: node.getBoundingClientRect().top + scrollY,
        scroll: scrollY, maxScroll: document.documentElement.scrollHeight - innerHeight }));
    assert.equal(after.top, Math.max(before.top, after.documentY - after.maxScroll));
    assert.equal(calls.length, count, "Returning to retained choices is local presentation, not another comparison/read/write.");
    assert.ok(calls.every(call => ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list", "/api/artifact-file"].includes(call.path)));
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
    assert.match(await unavailable.innerText(), /Tool outcomes do not tell us whether the answer was correct\. AI review needs separate approval.*0 of 1 assessed/s);
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
    for (const format of ["JSON", "PDF", "Markdown"]) await workspace.getByRole("checkbox", { name: format, exact: true }).check();
    const preview = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/preview"));
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    const response = await preview;
    assert.equal(response.status(), 200, await response.text());
    const data = await response.json();
    assert.equal(data.kind, "comparison");
    assert.equal(data.privacy.allSelectedFieldsScanned, true);
    assert.equal(await workspace.locator('.comparison-prepared-files iframe').count(), 1, "Disclosure review shows the actual frozen preview, not just the current live presenter");
    assert.equal(await workspace.locator(".report-comparison").isVisible(), false, "Prepared file review replaces rather than duplicates the inspected result");
    await workspace.frameLocator(".comparison-prepared-files iframe").getByRole("heading", { name: "Recorded tool results", exact: true }).waitFor();
    await workspace.locator(".comparison-prepared-files > details > summary").click();
    const jsonFile = workspace.locator(".comparison-prepared-files details").filter({ has: page.locator("summary", { hasText: /^Inspect exact comparison-report\.json$/ }) }).last();
    await jsonFile.locator(":scope > summary").click();
    assert.equal(await jsonFile.locator("pre").textContent(), data.files["comparison-report.json"]);
    for (const [theme, width, scale] of [["light", 1200, 100], ["light", 375, 200], ["dark", 375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "Prepared review and exact files reflow at narrow 200%");
        const controls = await workspace.locator(".comparison-review button,.comparison-review summary,.comparison-review label").evaluateAll(nodes =>
            nodes.filter(node => node.checkVisibility()).map(node => ({ height: node.getBoundingClientRect().height, label: node.textContent })));
        assert.ok(controls.every(control => control.height >= 44), JSON.stringify(controls));
        if (process.env.WIRE_COMPARISON_USABILITY_PROOFS) {
            await mkdir(process.env.WIRE_COMPARISON_USABILITY_PROOFS, { recursive: true });
            await workspace.locator(".comparison-prepared-files").evaluate(node =>
                scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 12));
            await workspace.frameLocator(".comparison-prepared-files iframe").getByRole("heading", { name: "Recorded tool results", exact: true }).waitFor();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.screenshot({ path: path.join(process.env.WIRE_COMPARISON_USABILITY_PROOFS, `review-${theme}-${width}-${scale}.png`) });
        }
    }
    await page.emulateMedia({ forcedColors: "active" });
    await page.keyboard.press("Tab");
    await workspace.locator(".comparison-prepared-files > details > summary").focus();
    assert.equal(await workspace.locator(".comparison-prepared-files > details > summary").evaluate(node => getComputedStyle(node).outlineStyle), "solid");
    await page.emulateMedia({ forcedColors: "none" });
    await page.setViewportSize({ width: 1200, height: 1000 }); await chooseTheme(page, "light");
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
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
    await row(saved.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await page.locator(".saved-report-dialog iframe").waitFor();
    await page.frameLocator(".saved-report-dialog iframe").getByRole("heading", { name: "Recorded tool results", exact: true }).waitFor();
    for (const [name, file] of Object.entries(saved.files)) {
        if (name === "coverage-and-redaction-manifest.json") continue;
        const value = data.files[name], expected = typeof value === "string" ? Buffer.from(value) : Buffer.from(value.data, "base64");
        assert.deepEqual(await readFile(file), expected, "Saved files are the exact independently reviewed preview");
    }
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
    const opened = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await keptComparison.locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    const openedResponse = await opened;
    assert.equal(openedResponse.status(), 200, await openedResponse.text());
    assert.equal((await openedResponse.json()).artifact.sourceReports.some(source => source.available === false), true);
    await page.locator(".saved-report-dialog iframe").waitFor();
    assert.match(await page.locator(".saved-report-dialog").textContent(), /original report is no longer available.*saved copy is unchanged/i);
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
    await row(savedComparison.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".saved-report-dialog iframe,#comparisonWorkspace .report-comparison,.saved-report-dialog .error"));
    assert.equal(await page.locator(".saved-report-dialog iframe").count(), 1, "Open must read a verified frozen file, not re-render its manifest facts");
    await page.frameLocator(".saved-report-dialog iframe").getByRole("heading", { name: "Independently reviewed historical comparison typography", exact: true }).waitFor();
    assert.equal(await page.frameLocator(".saved-report-dialog iframe").locator("script,a[href]").count(), 0);
    assert.equal(await page.evaluate(() => window.savedComparisonExecuted), undefined);
    await page.getByRole("button", { name: "Close saved comparison", exact: true }).click();
    assert.equal(await row(savedComparison.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).evaluate(node => node === document.activeElement), true);
    assert.equal(calls.slice(count).some(call => /\/(preview|review|save|export)$/.test(call.path)), false);
    assert.deepEqual(await hashes(savedComparison), original);
});

test("library downloads reject altered registered files instead of bypassing the frozen reader", async t => {
    const { page, bundles, row } = await setup(t);
    const name = "product-report.html", original = await readFile(bundles[0].files[name]);
    await writeFile(bundles[0].files[name], Buffer.concat([original, Buffer.from("\nALTERED_UNREVIEWED_COPY")]));
    const downloads = [];
    page.on("download", download => downloads.push(download.suggestedFilename()));
    await row(bundles[0].bundleId).locator(":scope>summary").click();
    const response = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await row(bundles[0].bundleId).getByRole("button", { name: "Download " + name, exact: true }).click();
    assert.equal((await response).status(), 409, "Unreviewed bytes must never be returned as a saved download");
    assert.deepEqual(downloads, []);
});

test("lost comparison Save response recovers by reading the saved library without replay or new approval", async t => {
    const { page, context, calls, bundles, row } = await setup(t);
    let saves = 0;
    await row(bundles[0].bundleId).locator(":scope > summary").click();
    await row(bundles[0].bundleId).getByRole("button", { name: "Compare saved reports", exact: true }).click();
    const workspace = page.locator("#comparisonWorkspace");
    await selectReport(page, "Baseline report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    await workspace.locator(".comparison-prepared-files iframe").waitFor();
    await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    await workspace.getByRole("button", { name: "Confirm disclosure", exact: true }).click();
    await page.route("**/api/report-comparison/save", async route => {
        saves++;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("connectionreset");
    });
    await workspace.getByRole("button", { name: "Save comparison", exact: true }).click();
    await workspace.getByRole("button", { name: "Read saved comparisons", exact: true }).waitFor();
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true, includeHidden: true }).isVisible(), false);
    const saved = (await loadBoardState(context)).exports.find(item => item.kind === "comparison");
    assert.ok(saved);
    await workspace.getByRole("button", { name: "Read saved comparisons", exact: true }).click();
    const open = row(saved.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true });
    await open.click();
    await page.locator(".saved-report-dialog iframe").waitFor();
    assert.equal(saves, 1);
    assert.equal(calls.filter(call => call.path === "/api/report-comparison/review").length, 1);
    assert.equal(calls.filter(call => call.path === "/api/report-comparison/preview").length, 1);
});

test("closing a pending frozen comparison fences its late response without changing the selected report", async t => {
    const { page, bundles, savedComparison, row } = await setup(t, { comparison: true });
    const reading = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/artifact-file", async route => {
        const response = await route.fetch(); reading.resolve(); await release.promise;
        await route.fulfill({ response });
    });
    await row(savedComparison.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await reading.promise;
    await page.getByRole("button", { name: "Close saved comparison", exact: true }).click();
    await row(bundles[0].bundleId).locator("..").getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator(".saved-report-dialog iframe").waitFor();
    const completed = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    release.resolve(); await completed;
    assert.match(await page.locator(".saved-report-dialog").innerText(), new RegExp(bundles[0].bundleId));
    assert.equal(await page.locator(".saved-report-dialog iframe").getAttribute("title"), "Frozen saved report");
});

test("a comparison without saved HTML names that limit and exposes only its verified saved formats", async t => {
    const { page, savedComparison, row } = await setup(t, { comparison: true, comparisonFormats: ["json"] });
    const entry = row(savedComparison.bundleId);
    assert.equal(await entry.locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).count(), 0);
    assert.match(await entry.locator("..").innerText(), /No HTML/);
    await entry.locator(":scope > summary").click();
    assert.match(await entry.innerText(), /HTML was not saved/);
    const response = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await entry.getByRole("button", { name: "Download comparison-report.json", exact: true }).click();
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
    await row(savedComparison.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await page.locator(".saved-report-dialog iframe").waitFor();
    assert.equal(reads, 2);
    assert.equal(calls.filter(call => call.path === "/api/session").length, 1);
    assert.equal(calls.some(call => /\/(preview|review|save|export)$/.test(call.path)), false);
    assert.deepEqual(await hashes(savedComparison), before);
});
