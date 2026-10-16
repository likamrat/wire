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
import { mountReportComparisonJourney } from "../web/report-comparison-journey.mjs";
import { chooseReportScope, reportContents, scanReport, findReportCopy, openReportLibrary, openReportComparison } from "./report-journey-helpers.mjs";

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
        "/api/preview", "/api/privacy-review", "/api/export", "/api/cancel-preview",
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
    if (!await page.locator("#bundles").evaluate(node => node.open)) await page.locator("#savedLibraryTitle").click();
    const row = id => page.locator(`#bundleList [data-bundle-id="${id}"]`);
    return { context, controller, page, calls, bundles, savedComparison, row };
}
async function selectReport(page, label, bundleId) {
    await page.locator("#comparisonWorkspace").getByRole("combobox", { name: label, exact: true }).click();
    await page.locator(`.select-popup .select-option[data-value="${bundleId}"]`).click();
}
async function inspectSavedPair(page, bundles, row) {
    await openReportComparison(page);
    await selectReport(page, "Earlier report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await page.locator("#comparisonWorkspace").getByRole("button", { name: "Compare reports", exact: true }).click();
}

test("comparison is a bounded Reports task with a retained approved review and exact saved-source return", async t => {
    const { page, calls, bundles } = await setup(t);
    await page.getByRole("link", { name: "Compare saved reports", exact: true }).click();
    assert.match(page.url(), /task=compare/);
    assert.equal(await page.locator("#pageTitle").textContent(), "Compare saved reports");
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), false);
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), false);
    const workspace = page.locator("#comparisonWorkspace");
    await selectReport(page, "Earlier report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    const frame = workspace.locator(".comparison-prepared-files iframe");
    await frame.waitFor();
    const preparedFrame = await frame.elementHandle();
    await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    await workspace.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await workspace.getByRole("button", { name: "Save comparison", exact: true }).waitFor();
    await workspace.getByRole("button", { name: "Back to comparison choices", exact: true }).click();
    await workspace.getByRole("button", { name: "Inspect earlier report", exact: true }).click();
    await page.locator("#contextSidebar").getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator("#savedReportReader iframe").waitFor();
    const requestCount = calls.length;
    await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
    await page.locator("#contextSidebar[open]").waitFor();
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    await workspace.getByRole("button", { name: "Return to review", exact: true }).click();
    assert.equal(await frame.evaluate((node, original) => node === original, preparedFrame), true);
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true }).isEnabled(), true);
    await page.locator("#reportLibraryLink").click();
    assert.equal(await workspace.isVisible(), false);
    await page.goBack();
    await workspace.waitFor();
    assert.match(page.url(), /task=compare/);
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true }).isEnabled(), true);
    assert.equal(calls.length, requestCount, "Saved-source return and task Back reuse retained choices and approval without reads or writes.");
    assert.equal(calls.filter(call => call.path === "/api/report-comparison/preview").length, 1);
    assert.equal(calls.filter(call => call.path === "/api/report-comparison/review").length, 1);
    assert.equal(calls.filter(call => call.path === "/api/report-comparison/save").length, 0);
});

test("an empty comparison task has an honest prerequisite, explicit read errors and a bounded deep link", async t => {
    const { page, calls } = await setup(t, { empty: true });
    const origin = new URL(page.url()).origin;
    await openReportComparison(page);
    const workspace = page.locator("#comparisonWorkspace");
    await workspace.getByText("Two saved reports with structured facts are needed.", { exact: false }).waitFor();
    assert.equal(await workspace.getByRole("button", { name: "Compare reports", exact: true }).isDisabled(), true);
    await page.goto(origin + "/#reports?task=compare");
    await workspace.getByText("Two saved reports with structured facts are needed.", { exact: false }).waitFor();
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), false);
    await page.route("**/api/report-artifacts/list", route => route.fulfill({ status: 503, json: { error: "Invented saved choices unavailable" } }), { times: 1 });
    await page.reload();
    await workspace.getByRole("alert").filter({ hasText: "Invented saved choices unavailable" }).waitFor();
    assert.doesNotMatch(await workspace.innerText(), /Two saved reports with structured facts are needed/);
    await page.goto(origin + "/#reports?task=not-a-report-task");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(new URL(page.url()).hash.includes("task="), false);
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), true);
    assert.equal(calls.some(call => /\/(?:preview|review|save|export)$/.test(call.path)), false);
});

for (const heldChoices of [false, true]) test(`a changed saved inventory refreshes comparison choices when one report arrives as another disappears${heldChoices ? " during a held choices read" : ""}`, async t => {
    const { page, calls, context, controller, bundles } = await setup(t);
    const waiting = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    if (heldChoices) await page.route("**/api/report-artifacts/list", async route => {
        const response = await route.fetch();
        waiting.resolve();
        await release.promise;
        await route.fulfill({ response });
    }, { times: 1 });
    await openReportComparison(page);
    if (heldChoices) await waiting.promise;
    else await page.locator("#comparisonWorkspace select").first().locator("option").nth(2).waitFor({ state: "attached" });
    await openReportLibrary(page);
    const state = await loadBoardState(context);
    const prepared = await controller.preview("synthetic-inventory-change", undefined, { promptMode: "none", formats: ["html", "json"], timeContext },
        { kind: "selected", revision: state.revision, scenarioIds: ["baseline"] });
    await controller.review("synthetic-inventory-change", prepared.previewId, true, timeContext);
    const added = (await controller.confirm("synthetic-inventory-change", prepared.previewId, true, timeContext)).bundle;
    await updateBoardState(context, current => { current.exports = current.exports.filter(entry => entry.bundleId !== bundles[0].bundleId); });
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await refreshed;
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    if (heldChoices) {
        release.resolve();
        await page.locator("#comparisonWorkspace>[role=alert]").waitFor({ state: "attached" });
        assert.match(await page.locator("#comparisonWorkspace>[role=alert]").textContent(), /Saved reports changed/);
    }
    const listed = calls.filter(call => call.path === "/api/report-artifacts/list").length;
    await openReportComparison(page);
    await page.waitForFunction(id => [...document.querySelector("#comparisonWorkspace select").options].some(option => option.value === id), added.bundleId);
    assert.deepEqual((await page.locator("#comparisonWorkspace select").first().locator("option").evaluateAll(nodes => nodes.map(node => node.value).filter(Boolean))).sort(),
        [bundles[1].bundleId, added.bundleId].sort());
    assert.equal(calls.filter(call => call.path === "/api/report-artifacts/list").length, listed + 1);
    assert.equal(calls.some(call => /\/api\/(?:preview|privacy-review|export|report-comparison\/(?:preview|review|save))$/.test(call.path)), false,
        "Refreshing saved choices cannot prepare, approve or save a comparison");
});

test("new Prepare replaces only the other report preview and preserves both tasks' choices and copy edits", async t => {
    const { page, calls, bundles, row, context } = await setup(t);
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator('#formatOptions input[value=json]').check();
    await scanReport(page);
    const copy = await findReportCopy(page, "SYNTHETIC_PRIVATE_PROMPT");
    await copy.getByText("Edit or omit this report copy", { exact: true }).click();
    await copy.locator("textarea").fill("Edited invented report wording");
    const rebuilt = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    await rebuilt;
    await page.locator('#reportsView[data-report-phase="ready"]').waitFor();
    await page.locator('input[data-review-control]').check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator('#reportsView[data-report-phase="reviewed"]').waitFor();
    const ordinaryPreviews = calls.filter(call => call.path === "/api/preview").length;
    await openReportComparison(page);
    const workspace = page.locator("#comparisonWorkspace");
    await selectReport(page, "Earlier report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed", "Reading a comparison cannot invalidate an ordinary approval");
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    await workspace.locator(".comparison-prepared-files iframe").waitFor();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "draft", "A new comparison preview replaces ordinary preview authority");
    assert.equal(calls.filter(call => call.path === "/api/preview").length, ordinaryPreviews);
    await page.locator("#reportCreateLink").click();
    await reportContents(page);
    assert.equal(await page.locator("#exportBtn").textContent(), "Prepare report");
    assert.equal(await page.locator('[name=reportScope][value=all]').isChecked(), true);
    assert.equal(await page.locator('#formatOptions input[value=json]').isChecked(), true);
    const fresh = await scanReport(page);
    assert.ok(fresh.promptReview.some(copy => copy.text === "Edited invented report wording"), "Peer preparation retains existing report-copy edits");
    assert.deepEqual(await workspace.locator(".comparison-selectors select").evaluateAll(nodes => nodes.map(node => node.value)), bundles.map(bundle => bundle.bundleId));
    assert.equal(await workspace.locator(".comparison-prepared-files iframe").count(), 0, "An ordinary new preview revokes the replaced comparison preview");
    assert.equal(calls.filter(call => call.path === "/api/report-comparison/preview").length, 1);
    assert.equal(calls.filter(call => call.path === "/api/report-comparison/review" || call.path === "/api/report-comparison/save").length, 0);
    assert.equal((await loadBoardState(context)).exports.length, 2, "Preparing either task never saves files");
});

test("a held comparison Prepare cannot restore its preview after an ordinary report prepares", async t => {
    const { page, calls, bundles, row, context } = await setup(t);
    await inspectSavedPair(page, bundles, row);
    let release, arrived, latePreview;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    t.after(() => release());
    const deliveries = [];
    await page.route("**/api/report-comparison/preview", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            latePreview = await response.json(); arrived();
            await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    await page.locator("#comparisonWorkspace").getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    await pending;
    await chooseReportScope(page, "all");
    const ordinary = await scanReport(page);
    const cancelled = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/cancel"));
    release(); await Promise.all(deliveries); await cancelled;
    await page.unroute("**/api/report-comparison/preview");
    assert.notEqual(ordinary.previewId, latePreview.previewId);
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "ready");
    assert.equal(await page.locator("#comparisonWorkspace .comparison-prepared-files iframe").count(), 0);
    assert.ok(calls.some(call => call.path === "/api/report-comparison/cancel" && call.body.previewId === latePreview.previewId));
    assert.ok(!calls.some(call => call.path.endsWith("/cancel") && call.body.previewId === ordinary.previewId));
    await page.locator('input[data-review-control]').check();
    const reviewed = page.waitForResponse(response => response.url().endsWith("/api/privacy-review"));
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    assert.equal((await reviewed).status(), 200, "Late cancellation cannot cancel the newer ordinary preview");
    assert.equal(calls.filter(call => call.path === "/api/preview").length, 1);
    assert.equal((await loadBoardState(context)).exports.length, 2);
});

for (const owner of ["report", "comparison"]) test(`a dispatched and lost ${owner} Save blocks only the other NEW Prepare until exact recovery`, async t => {
    const { page, calls, bundles, row, context } = await setup(t);
    await chooseReportScope(page, "all");
    if (owner === "comparison") {
        await scanReport(page);
        const copy = await findReportCopy(page, "SYNTHETIC_PRIVATE_PROMPT");
        await copy.getByText("Edit or omit this report copy", { exact: true }).click();
        await copy.locator("textarea").fill("Edited report copy retained during comparison recovery");
        await page.getByRole("button", { name: "Rebuild preview", exact: true }).waitFor();
    }
    await inspectSavedPair(page, bundles, row);
    const workspace = page.locator("#comparisonWorkspace");
    if (owner === "report") {
        await scanReport(page);
        await page.locator('input[data-review-control]').check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.locator('#reportsView[data-report-phase="reviewed"]').waitFor();
    } else {
        await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
        await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
        await workspace.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await workspace.getByRole("button", { name: "Save comparison", exact: true }).waitFor();
    }
    const endpoint = owner === "report" ? "/api/export" : "/api/report-comparison/save";
    const peerEndpoint = owner === "report" ? "/api/report-comparison/preview" : "/api/preview";
    const peer = owner === "report" ? workspace.getByRole("button", { name: "Prepare comparison copy", exact: true, includeHidden: true }) : page.locator("#exportBtn");
    const peerCount = calls.filter(call => call.path === peerEndpoint).length;
    let release, arrived, saveId, saves = 0;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    t.after(() => release());
    await page.route("**" + endpoint, async route => {
        saves++;
        const response = await route.fetch();
        saveId = (await response.json()).bundle.bundleId;
        arrived(); await held; await route.abort("connectionreset");
    });
    await page.getByRole("button", { name: owner === "report" ? "Save report" : "Save comparison", exact: true }).click();
    await pending;
    assert.equal(await peer.isDisabled(), true);
    await peer.evaluate(node => { node.disabled = false; node.click(); });
    assert.equal(await peer.isDisabled(), true, "The dispatch seam rechecks real save state, not disabled styling");
    assert.equal(calls.filter(call => call.path === peerEndpoint).length, peerCount);
    release();
    const recovery = owner === "report" ? page.getByRole("button", { name: "Check save status", exact: true })
        : workspace.getByRole("button", { name: "Read saved comparisons", exact: true });
    await recovery.waitFor();
    assert.equal(await peer.isDisabled(), true);
    await peer.evaluate(node => { node.disabled = false; node.click(); });
    assert.equal(calls.filter(call => call.path === peerEndpoint).length, peerCount);
    if (owner === "comparison") {
        await page.locator("#reportCreateLink").click();
        assert.equal(await page.getByRole("button", { name: "Rebuild preview", exact: true }).isDisabled(), true);
        assert.match(await page.locator(".rebuild-preview").innerText(), /Check the comparison save status/);
    }
    await openReportLibrary(page);
    await row(bundles[0].bundleId).getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator("#savedReportReader iframe").waitFor();
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    if (owner === "report") await page.locator("#reportCreateLink").click();
    else await openReportComparison(page);
    await recovery.click();
    if (owner === "report") await page.locator('#reportsView[data-report-phase="saved"]').waitFor();
    else await page.waitForFunction(() => ![...document.querySelectorAll("#comparisonWorkspace button")]
        .find(button => button.textContent === "Read saved comparisons").checkVisibility());
    assert.equal(await peer.isEnabled(), true, "Exact recovery releases only the prepare block");
    assert.equal(saves, 1);
    assert.equal(calls.filter(call => call.path === peerEndpoint).length, peerCount);
    assert.equal((await loadBoardState(context)).exports.filter(entry => entry.bundleId === saveId).length, 1);
    if (owner === "comparison") {
        await page.locator("#reportCreateLink").click();
        const fresh = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
        assert.ok((await (await fresh).json()).promptReview.some(copy => copy.text === "Edited report copy retained during comparison recovery"));
    }
});

test("a dispatched comparison keeps its exact recovery identity through replacement, source loss and read-only return", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.route("**/*", route => route.abort());
    await page.setContent('<main id="comparison"></main>');
    await page.addScriptTag({ content: mountReportComparisonJourney.toString() });
    await page.evaluate(() => {
        window.calls = [];
        window.prepares = 0;
        window.sources = ["earlier", "later"].map(bundleId => ({
            bundleId, kind: "report", preparedAt: "2026-10-01T12:00:00Z",
            requestGroupCount: 2, formats: ["html"], comparisonEligibility: "available",
        }));
        window.available = [...window.sources];
        window.journey = mountReportComparisonJourney(document.querySelector("#comparison"), {
            api: async (path, body) => {
                window.calls.push({ path, body });
                if (path.endsWith("/list")) return { artifacts: window.available };
                if (path.endsWith("/inspect")) return { comparison: {} };
                if (path.endsWith("/open")) return new Promise(resolve => { window.settleRead = resolve; });
                if (path.endsWith("/preview")) return window.prepared = {
                    kind: "comparison", bundleId: "dispatched-comparison", previewId: "dispatched-preview",
                    comparison: {}, privacy: { allSelectedFieldsScanned: true },
                    previewHtml: "<h1>Invented comparison</h1>", files: {
                        "comparison-report.html": "Invented comparison",
                        "coverage-and-redaction-manifest.json": '{"reviewerConfirmed":false}',
                    },
                };
                if (path.endsWith("/review")) return {
                    ...window.prepared, privacy: { allSelectedFieldsScanned: true, reviewerConfirmed: true },
                    files: { ...window.prepared.files, "coverage-and-redaction-manifest.json": '{"reviewerConfirmed":true}' },
                };
                if (path.endsWith("/save")) return new Promise((resolve, reject) => { window.settleSave = { resolve, reject }; });
                if (path.endsWith("/cancel")) return {};
                throw Error("Unexpected synthetic route " + path);
            },
            renderer: { render(root) { root.textContent = "Invented frozen facts"; }, clear(root) { root.replaceChildren(); } },
            timeContext: () => ({ timeZone: "UTC", locale: "en-US" }),
            refresh: async () => { window.journey.syncPresence(window.available); return true; },
            beforePrepare: () => { window.prepares++; return ""; },
            onError: message => { throw Error(message); }, inspectSource() {},
        });
    });
    await page.evaluate(() => window.journey.open());
    const choices = page.locator(".comparison-selectors select");
    await choices.nth(0).selectOption("earlier"); await choices.nth(1).selectOption("later");
    await page.getByRole("button", { name: "Compare reports", exact: true }).click();
    await page.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    await page.getByRole("button", { name: "Back to comparison choices", exact: true }).click();
    await page.getByRole("button", { name: "Return to review", exact: true }).click();
    assert.equal(await page.evaluate(() => window.prepares), 1, "Returning to unchanged review never invalidates a peer");
    await page.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.getByRole("button", { name: "Save comparison", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.settleSave));
    await page.evaluate(() => {
        window.journey.invalidate("Synthetic source change during save", true, { force: true });
        window.journey.syncPresence([]);
        window.journey.receive(window.sources);
    });
    assert.equal(await page.evaluate(() => window.journey.isBusy()), true, "Source changes cannot end an in-flight write");
    await page.evaluate(() => window.settleSave.reject(Error("Synthetic lost save response")));
    const recovery = page.getByRole("button", { name: "Read saved comparisons", exact: true });
    await recovery.waitFor();
    assert.equal(await choices.nth(0).isDisabled(), true, "An unknown write cannot be replaced by choosing another pair");
    assert.equal(await page.getByRole("button", { name: "Discard comparison", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.journey.isBusy()), false, "Read-only navigation is not globally blocked");
    await choices.nth(0).evaluate(node => { node.value = "later"; node.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(await choices.nth(0).inputValue(), "earlier", "Programmatic changes cannot replace the dispatched pair");
    await page.evaluate(() => {
        for (const label of ["Compare reports", "Prepare comparison copy", "Save comparison", "Discard comparison"]) {
            const control = [...document.querySelectorAll("button")].find(button => button.textContent === label);
            control.disabled = false; control.click();
        }
    });
    assert.equal(await page.evaluate(() => window.journey.invalidate("Synthetic source replacement", true, { force: true })), false);
    await page.evaluate(() => {
        window.available = [];
        window.journey.invalidateSavedReport("earlier");
        window.journey.receive([]);
        window.journey.syncPresence([]);
    });
    assert.equal(await recovery.isVisible(), true, "Source removal and an empty list cannot settle an unknown write");
    await page.evaluate(() => { window.readPromise = window.journey.open("unrelated-saved-comparison"); });
    await page.waitForFunction(() => Boolean(window.settleRead));
    await page.getByRole("button", { name: "Back to comparison draft", exact: true }).click();
    await page.evaluate(async () => { window.settleRead({ comparison: {} }); await window.readPromise; });
    assert.equal(await recovery.isVisible(), true);
    assert.match(await page.locator('#comparison > [role="status"],#comparison > [role="alert"]').innerText(), /not confirmed|may have completed/, "A late saved-file read cannot replace the original save's recovery status after Back");
    await recovery.click();
    assert.equal(await recovery.isVisible(), true, "No receipt is not proof that no write occurred");
    await page.evaluate(() => {
        window.available = [{ kind: "comparison", bundleId: "another-comparison" }, { kind: "report", bundleId: "dispatched-comparison" }];
    });
    await recovery.click();
    assert.equal(await recovery.isVisible(), true, "Wrong identity or artifact kind cannot resolve this save");
    await page.evaluate(() => { window.available = [{ kind: "comparison", bundleId: "dispatched-comparison" }]; });
    await recovery.click();
    assert.equal(await recovery.isVisible(), false);
    assert.match(await page.locator('#comparison > [role="status"]').innerText(), /Comparison saved: dispatched-comparison/);
    assert.equal(await page.getByRole("button", { name: "Discard comparison", exact: true, includeHidden: true }).isEnabled(), true);
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.filter(call => call.path.endsWith("/save")).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith("/preview")).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith("/review")).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith("/cancel")).length, 0, "Never cancel a dispatched write as though it were an unsaved preview");
});

for (const mismatch of ["identity", "kind", "shape"]) test(`comparison Save rejects a mismatched ${mismatch} receipt without permitting a replacement`, async t => {
    const { page, context, bundles, row } = await setup(t);
    await openReportComparison(page);
    const workspace = page.locator("#comparisonWorkspace");
    await selectReport(page, "Earlier report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    const prepared = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/preview"));
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    const preview = await (await prepared).json();
    await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    await workspace.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    let saves = 0;
    await page.route("**/api/report-comparison/save", async route => {
        saves++;
        await route.fulfill({ status: 200, json: mismatch === "shape" ? {} : { bundle: {
            bundleId: mismatch === "identity" ? bundles[0].bundleId : preview.bundleId,
            kind: mismatch === "kind" ? "report" : "comparison",
        } } });
    });
    await workspace.getByRole("button", { name: "Save comparison", exact: true }).click();
    const recovery = workspace.getByRole("button", { name: "Read saved comparisons", exact: true });
    await recovery.waitFor();
    assert.match(await workspace.innerText(), /receipt did not match the dispatched comparison/);
    assert.doesNotMatch(await workspace.innerText(), /Comparison saved:/);
    assert.equal(await workspace.getByRole("combobox", { name: "Earlier report", exact: true }).isDisabled(), true);
    assert.equal(await workspace.getByRole("button", { name: "Discard comparison", exact: true }).isDisabled(), true);
    await recovery.click();
    assert.equal(await recovery.isVisible(), true);
    if (mismatch === "shape") {
        await updateBoardState(context, state => { state.exports = []; });
        const refreshed = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
        await recovery.click();
        await refreshed;
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        await openReportLibrary(page);
        assert.match(await page.locator("#bundleList").innerText(), /No local reports have been saved/);
        await openReportComparison(page);
        assert.equal(await recovery.isVisible(), true, "An empty library cannot hide a dispatched save's recovery task");
        await recovery.click();
        assert.equal(await recovery.isVisible(), true, "Deleted sources and an absent receipt do not settle the original write");
    }
    assert.equal(saves, 1);
    assert.equal((await loadBoardState(context)).exports.filter(entry => entry.kind === "comparison").length, 0);
});

test("closing a frozen comparison restores its library entry and preserves the comparison draft", async t => {
    const { page, calls, bundles, savedComparison, row } = await setup(t, { comparison: true });
    const original = await Promise.all([...bundles, savedComparison].map(hashes));
    await openReportComparison(page);
    const workspace = page.locator("#comparisonWorkspace");
    await selectReport(page, "Earlier report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await openReportLibrary(page);
    const open = row(savedComparison.bundleId).getByRole("button", { name: "Open saved comparison", exact: true });
    await open.scrollIntoViewIfNeeded();
    const before = await workspace.evaluate(node => ({ top: node.getBoundingClientRect().top, scroll: scrollY }));
    await open.click();
    await page.locator("#savedReportReader iframe").waitFor();
    const back = page.getByRole("button", { name: "Back to report library", exact: true });
    await back.focus();
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
    await openReportComparison(page);
    const workspace = page.locator("#comparisonWorkspace");
    await workspace.locator("select").first().locator("option").nth(1).waitFor({ state: "attached" });
    const options = await workspace.locator("select").first().locator("option").allTextContents();
    assert.deepEqual(await workspace.locator(".comparison-selectors select").evaluateAll(nodes => nodes.map(node => node.dataset.selectPresentation)), ["filter", "filter"]);
    assert.ok(options[1].startsWith(bundles[0].preparedAtDisplay), "The distinguishing preparation time leads the selected summary");
    assert.match(options[1], /1 interaction.*No prompts/);
    assert.doesNotMatch(options.join(" "), /export-[a-f0-9-]{36}/, "Identity is not the primary option label");
    await workspace.getByRole("combobox", { name: "Earlier report", exact: true }).click();
    assert.match(await page.locator(`.select-option[data-value="${bundles[0].bundleId}"] .select-option-detail`).innerText(), new RegExp(bundles[0].bundleId));
    await page.keyboard.press("Escape");
    await selectReport(page, "Earlier report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await workspace.getByRole("button", { name: "Inspect earlier report", exact: true }).click();
    assert.match(await page.locator("#contextSidebar").innerText(), new RegExp(bundles[0].bundleId));
    assert.deepEqual(await workspace.locator(".comparison-selectors select").evaluateAll(nodes => nodes.map(node => node.value)), bundles.map(bundle => bundle.bundleId));
    await page.locator("#closeContextSidebar").click();
    assert.deepEqual(await workspace.locator(".comparison-selectors select").evaluateAll(nodes => nodes.map(node => node.value)), bundles.map(bundle => bundle.bundleId));
    assert.equal(await workspace.getByRole("button", { name: "Inspect earlier report", exact: true }).evaluate(node => node === document.activeElement), true);
    const response = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/inspect"));
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    const model = (await (await response).json()).comparison;
    await workspace.locator(".report-comparison").waitFor();
    const results = workspace.locator(".comparison-tool-results"), timing = workspace.locator(".comparison-metrics").filter({ hasText: "200 ms" });
    assert.ok((await results.boundingBox()).y < (await timing.boundingBox()).y, "Recorded result pair leads the measures");
    assert.deepEqual(await timing.locator(".comparison-metric-value").allTextContents(), ["200 ms", "150 ms"]);
    const unavailable = workspace.locator(".comparison-unavailable");
    assert.equal(await unavailable.evaluate(node => node.open), false);
    assert.equal((await unavailable.locator(":scope > summary").innerText()).replace(/\s+/g, " ").trim(),
        "Measures without a result (1) Time to recorded final response");
    assert.equal(model.metricProjectionVersion, 4);
    assert.ok(model.metrics.every(metric => metric.metric === "speed"));
    assert.equal(await unavailable.locator("table").isVisible(), false);
    await unavailable.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await unavailable.locator("table").isVisible(), true);
    assert.equal(await unavailable.locator("tbody tr").count(), 1);
    assert.deepEqual(await unavailable.locator(".comparison-metric-value").allTextContents(), ["Not measured", "Not measured"]);
    assert.equal(await unavailable.getByText(/0 of 1 requests timed/).count(), 2);
    assert.doesNotMatch(await workspace.locator(".report-comparison").innerText(), /Answer correctness|Answer support|Personal feedback|Your feedback|AI review|Cost/);
    const html = comparisonBodyHtml(model);
    assert.ok(html.indexOf('class="comparison-tool-results"') < html.indexOf("<caption>Recorded measures</caption>"));
    assert.ok(html.indexOf("<caption>Recorded measures</caption>") < html.indexOf('class="comparison-unavailable"'));
    assert.match(html.slice(html.indexOf('<table class="comparison-patterns">')), /comparison-mobile-label">Earlier/);
    assert.match(html.slice(html.indexOf('<table class="comparison-patterns">')), /comparison-mobile-label">Later/);
    const markdown = renderComparisonMarkdown(model, { preparedAtDisplay: "Synthetic preparation time", bundleId: "synthetic", sourceReports: [] });
    assert.ok(markdown.indexOf("Earlier:") < markdown.indexOf("## Recorded measures"));
    assert.ok(markdown.indexOf("## Recorded measures") < markdown.indexOf("## Unavailable measures and coverage"));
    assert.match(markdown, /200 ms.*150 ms.*-50 ms/);
    await unavailable.locator(":scope > summary").click();
    for (const [theme, width, scale] of [["light", 1200, 100], ["dark", 375, 100], ["dark", 320, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (width === 375 && scale === 100) for (const label of ["Earlier report", "Later report"]) {
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
    await openReportComparison(page);
    const workspace = page.locator("#comparisonWorkspace");
    await workspace.locator("select").first().locator("option").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await workspace.locator(".comparison-selectors select").evaluateAll(nodes => nodes.map(node => node.value)), ["", ""]);
    assert.equal(calls.filter(call => call.path.endsWith("/inspect")).length, 0);
    await selectReport(page, "Earlier report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    const inspect = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/inspect"));
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    const inspectResponse = await inspect;
    assert.equal(inspectResponse.status(), 200, await inspectResponse.text());
    await workspace.locator(".report-comparison").waitFor();
    assert.equal((await loadBoardState(context)).exports.length, 2);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No interactions included");
    for (const format of ["JSON", "PDF", "Markdown"]) await workspace.getByRole("checkbox", { name: format, exact: true }).check();
    const preview = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/preview"));
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    const response = await preview;
    assert.equal(response.status(), 200, await response.text());
    const data = await response.json();
    assert.equal(data.kind, "comparison");
    assert.equal(data.privacy.allSelectedFieldsScanned, true);
    assert.equal(await workspace.getByRole("tab", { name: "Report", exact: true }).count(), 1);
    assert.equal(await workspace.getByRole("tab", { name: "Files (5)", exact: true }).count(), 1);
    assert.equal(await workspace.locator('.comparison-prepared-files iframe').count(), 1, "Disclosure review shows the actual frozen preview, not just the current live presenter");
    assert.equal(await workspace.locator(".report-comparison").isVisible(), false, "Prepared file review replaces rather than duplicates the inspected result");
    await workspace.frameLocator(".comparison-prepared-files iframe").getByRole("heading", { name: "Recorded tool results", exact: true }).waitFor();
    await workspace.getByRole("tab", { name: "Files (5)", exact: true }).click();
    const jsonFile = workspace.locator(".comparison-prepared-files details").filter({ has: page.locator("summary", { hasText: /^\s*comparison-report\.json$/ }) }).last();
    await jsonFile.locator(":scope > summary").click();
    assert.equal(await jsonFile.locator("pre").textContent(), data.files["comparison-report.json"]);
    assert.equal(await workspace.locator(".comparison-prepared-files details details").count(), 0, "Files have one disclosure level, not a second exact-files gate");
    await workspace.locator(".comparison-prepared-files iframe").evaluate(node => { window.comparisonFrameBeforeReturn = node; });
    await workspace.getByRole("button", { name: "Back to comparison choices", exact: true }).click();
    assert.deepEqual(await workspace.locator(".comparison-selectors select").evaluateAll(nodes => nodes.map(node => node.value)), bundles.map(bundle => bundle.bundleId));
    const preparations = calls.filter(call => call.path.endsWith("/preview")).length;
    await workspace.getByRole("button", { name: "Return to review", exact: true }).click();
    assert.equal(calls.filter(call => call.path.endsWith("/preview")).length, preparations);
    assert.equal(await workspace.locator(".comparison-prepared-files iframe").evaluate(node => node === window.comparisonFrameBeforeReturn), true);
    await workspace.getByRole("tab", { name: "Files (5)", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await workspace.getByRole("tab", { name: "Report", exact: true }).getAttribute("aria-selected"), "true");
    await page.keyboard.press("End");
    assert.equal(await workspace.getByRole("tab", { name: "Files (5)", exact: true }).getAttribute("aria-selected"), "true");
    for (const [theme, width, scale] of [["light", 1200, 100], ["light", 375, 200], ["dark", 375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "Prepared review and exact files reflow at narrow 200%");
        const controls = await workspace.locator(".comparison-review button,.comparison-review summary,.comparison-review label").evaluateAll(nodes =>
            nodes.filter(node => node.checkVisibility()).map(node => ({ height: node.getBoundingClientRect().height, label: node.textContent })));
        assert.ok(controls.every(control => control.height >= 44), JSON.stringify(controls));
        if (process.env.WIRE_COMPARISON_USABILITY_PROOFS) {
            await workspace.getByRole("tab", { name: "Report", exact: true }).click();
            await mkdir(process.env.WIRE_COMPARISON_USABILITY_PROOFS, { recursive: true });
            await workspace.locator(".comparison-prepared-files").evaluate(node =>
                scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 12));
            await workspace.frameLocator(".comparison-prepared-files iframe").getByRole("heading", { name: "Recorded tool results", exact: true }).waitFor();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.screenshot({ path: path.join(process.env.WIRE_COMPARISON_USABILITY_PROOFS, `review-${theme}-${width}-${scale}.png`) });
            await workspace.getByRole("tab", { name: "Files (5)", exact: true }).click();
        }
    }
    await page.emulateMedia({ forcedColors: "active" });
    await workspace.getByRole("tab", { name: "Files (5)", exact: true }).click();
    await page.keyboard.press("Tab");
    await jsonFile.locator(":scope > summary").focus();
    assert.equal(await jsonFile.locator(":scope > summary").evaluate(node => getComputedStyle(node).outlineStyle), "solid");
    await page.emulateMedia({ forcedColors: "none" });
    await page.setViewportSize({ width: 1200, height: 1000 }); await chooseTheme(page, "light");
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true, includeHidden: true }).isVisible(), false);
    assert.equal((await loadBoardState(context)).exports.length, 2);
    await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    const review = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/review"));
    await workspace.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    const reviewedResponse = await review;
    assert.equal(reviewedResponse.status(), 200);
    const reviewedCopy = await reviewedResponse.json();
    assert.equal(await workspace.locator('pre[aria-label="coverage-and-redaction-manifest.json"]').textContent(),
        reviewedCopy.files["coverage-and-redaction-manifest.json"], "Files shows the actual manifest updated by disclosure approval");
    await workspace.getByRole("button", { name: "Save comparison", exact: true }).waitFor();
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true }).evaluate(node => node === document.activeElement), true);
    const approvals = calls.filter(call => call.path.endsWith("/review")).length;
    await workspace.getByRole("button", { name: "Back to comparison choices", exact: true }).click();
    await workspace.getByRole("button", { name: "Return to review", exact: true }).click();
    assert.equal(calls.filter(call => call.path.endsWith("/review")).length, approvals, "An unchanged return retains approval without replaying it");
    assert.equal(calls.filter(call => call.path.endsWith("/preview")).length, preparations);
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true }).isEnabled(), true);
    const save = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/save"));
    await workspace.getByRole("button", { name: "Save comparison", exact: true }).click();
    const savedResponse = await save;
    assert.equal(savedResponse.status(), 200, await savedResponse.text());
    const saved = (await savedResponse.json()).bundle;
    assert.equal(saved.kind, "comparison");
    assert.equal((await loadBoardState(context)).exports.length, 3);
    assert.deepEqual(await Promise.all(bundles.map(hashes)), originalHashes);
    assert.equal(calls.filter(call => call.path.endsWith("/save")).length, 1);
    await openReportLibrary(page);
    await row(saved.bundleId).getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await page.locator("#savedReportReader iframe").waitFor();
    await page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: "Recorded tool results", exact: true }).waitFor();
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
    await item.locator(".saved-report-summary").click();
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
    await keptComparison.locator(".saved-report-summary").click();
    const opened = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await keptComparison.getByRole("button", { name: "Open saved comparison", exact: true }).click();
    const openedResponse = await opened;
    assert.equal(openedResponse.status(), 200, await openedResponse.text());
    assert.equal((await openedResponse.json()).artifact.sourceReports.some(source => source.available === false), true);
    await page.locator("#savedReportReader iframe").waitFor();
    assert.match(await page.locator("#savedReportReader").textContent(), /original report is no longer available.*saved copy is unchanged/i);
    assert.deepEqual(await hashes(savedComparison), comparisonHash);
});

test("bulk report deletion preserves saved comparisons but invalidates their approved unsaved counterparts", { timeout: 30000 }, async t => {
    const { context, controller, page, calls, bundles, savedComparison, row } = await setup(t, { comparison: true });
    const frozen = await hashes(savedComparison), before = await loadBoardState(context);
    const stale = await controller.previewComparison("dependent-draft", bundles[0].bundleId, bundles[1].bundleId, { timeContext });
    await controller.reviewComparison("dependent-draft", stale.previewId, true, timeContext);
    await openReportComparison(page);
    const workspace = page.locator("#comparisonWorkspace");
    await workspace.locator("select option").nth(1).waitFor({ state: "attached" });
    await selectReport(page, "Earlier report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    await workspace.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("#comparisonWorkspace button")].some(node => node.textContent === "Save comparison" && !node.disabled));
    await openReportLibrary(page);
    await page.locator("#savedLibraryManagement > summary").click();
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
    await openReportComparison(page);
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
    await item.locator(".saved-report-summary").click();
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
    await row(savedComparison.bundleId).getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#savedReportReader iframe,#comparisonWorkspace .report-comparison,#savedReportReader .error"));
    assert.equal(await page.locator("#savedReportReader iframe").count(), 1, "Open must read a verified frozen file, not re-render its manifest facts");
    await page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: "Independently reviewed historical comparison typography", exact: true }).waitFor();
    assert.equal(await page.frameLocator("#savedReportReader iframe").locator("script,a[href]").count(), 0);
    assert.equal(await page.evaluate(() => window.savedComparisonExecuted), undefined);
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    assert.equal(await row(savedComparison.bundleId).getByRole("button", { name: "Open saved comparison", exact: true }).evaluate(node => node === document.activeElement), true);
    assert.equal(calls.slice(count).some(call => /\/(preview|review|save|export)$/.test(call.path)), false);
    assert.deepEqual(await hashes(savedComparison), original);
});

test("library downloads reject altered registered files instead of bypassing the frozen reader", async t => {
    const { page, bundles, row } = await setup(t);
    const name = "product-report.html", original = await readFile(bundles[0].files[name]);
    await writeFile(bundles[0].files[name], Buffer.concat([original, Buffer.from("\nALTERED_UNREVIEWED_COPY")]));
    const downloads = [];
    page.on("download", download => downloads.push(download.suggestedFilename()));
    await row(bundles[0].bundleId).locator(".saved-report-summary").click();
    const response = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await page.locator("#contextSidebar").getByRole("button", { name: "Download " + name + " for " + bundles[0].bundleId, exact: true }).click();
    assert.equal((await response).status(), 409, "Unreviewed bytes must never be returned as a saved download");
    assert.deepEqual(downloads, []);
});

test("lost comparison Save response recovers by reading the saved library without replay or new approval", async t => {
    const { page, context, calls, bundles, row } = await setup(t);
    let saves = 0;
    await openReportComparison(page);
    const workspace = page.locator("#comparisonWorkspace");
    await selectReport(page, "Earlier report", bundles[0].bundleId);
    await selectReport(page, "Later report", bundles[1].bundleId);
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    await workspace.locator(".comparison-prepared-files iframe").waitFor();
    await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    await workspace.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.route("**/api/report-comparison/save", async route => {
        saves++;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("connectionreset");
    });
    await workspace.getByRole("button", { name: "Save comparison", exact: true }).click();
    await workspace.getByRole("button", { name: "Read saved comparisons", exact: true }).waitFor();
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true, includeHidden: true }).isVisible(), false);
    await workspace.getByRole("button", { name: "Inspect earlier report", exact: true }).click();
    await page.locator("#closeContextSidebar").click();
    assert.equal(await workspace.getByRole("button", { name: "Read saved comparisons", exact: true }).isVisible(), true);
    assert.match(await workspace.innerText(), /save is not confirmed and may have completed/);
    const saved = (await loadBoardState(context)).exports.find(item => item.kind === "comparison");
    assert.ok(saved);
    await workspace.getByRole("button", { name: "Read saved comparisons", exact: true }).click();
    await openReportLibrary(page);
    const open = row(saved.bundleId).getByRole("button", { name: "Open saved comparison", exact: true });
    await open.click();
    await page.locator("#savedReportReader iframe").waitFor();
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
    await row(savedComparison.bundleId).getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await reading.promise;
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await row(bundles[0].bundleId).getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator("#savedReportReader iframe").waitFor();
    const completed = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    release.resolve(); await completed;
    assert.match(await page.frameLocator("#savedReportReader iframe").locator("body").textContent(), new RegExp(bundles[0].bundleId));
    assert.match(await page.frameLocator("#savedReportReader iframe").locator("h1").innerText(), /Activity report/);
    assert.equal(await page.locator("#savedReportReader iframe").getAttribute("title"), "Frozen saved report");
});

test("a comparison without saved HTML names that limit and exposes only its verified saved formats", async t => {
    const { page, savedComparison, row } = await setup(t, { comparison: true, comparisonFormats: ["json"] });
    const entry = row(savedComparison.bundleId);
    assert.equal(await entry.getByRole("button", { name: "Open saved comparison", exact: true }).count(), 0);
    assert.match(await entry.innerText(), /JSON.*No HTML/s);
    await entry.locator(".saved-report-summary").click();
    assert.match(await page.locator("#contextSidebar").innerText(), /HTML was not saved/);
    const response = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await page.locator("#contextSidebar").getByRole("button", { name: "Download comparison-report.json for " + savedComparison.bundleId, exact: true }).click();
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
    await row(savedComparison.bundleId).getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await page.locator("#savedReportReader iframe").waitFor();
    assert.equal(reads, 2);
    assert.equal(calls.filter(call => call.path === "/api/session").length, 1);
    assert.equal(calls.some(call => /\/(preview|review|save|export)$/.test(call.path)), false);
    assert.deepEqual(await hashes(savedComparison), before);
});
