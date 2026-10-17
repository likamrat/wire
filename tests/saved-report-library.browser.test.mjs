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
import { chooseReportScope, reportContents, openReportLibrary, openReportComparison, scanReport } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function setup(t, count = 1001, { prepared = false } = {}) {
    const records = prepared ? Array.from({ length: 8 }, (_, index) => {
        const record = fixture(`report-layout-${index}`);
        record.userPrompt.text = `Invented planning request ${index + 1}: summarize the release exercise and its next steps.`;
        return record;
    }) : [fixture()];
    const { context } = await privateFixture(t, records), controller = createExportController(context);
    const entries = [];
    if (prepared) t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-16T12:00:00.000Z") });
    if (prepared) for (let index = 0; index < count; index++) {
        t.mock.timers.setTime(Date.parse("2026-10-16T12:00:00.000Z") + index * 120000);
        const state = await loadBoardState(context), timeContext = { timeZone: "UTC", locale: "en-US" };
        const selection = index ? { kind: "selected", revision: state.revision, scenarioIds: records.slice(0, index + 1).map(record => record.scenarioId) }
            : { kind: "all", revision: state.revision };
        const preview = await controller.preview("synthetic-layout-seed", undefined, {
            title: index === count - 1
                ? "Readiness review - calendar changes, document lookups and unresolved follow-up across the planning exercise"
                : `Planning exercise ${index + 1}`,
            promptMode: ["none", "masked", "original"][index % 3],
            formats: index === count - 1 ? ["json"] : ["html", "pdf", "json", "markdown"], timeContext,
        }, selection);
        await controller.review("synthetic-layout-seed", preview.previewId, true, timeContext);
        entries.push((await controller.confirm("synthetic-layout-seed", preview.previewId, true, timeContext)).bundle);
    }
    else for (let index = 0; index < count + 1; index++) {
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
    if (prepared) t.mock.timers.reset();
    if (!prepared) await updateBoardState(context, state => { state.exports.push(...entries); });
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
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

test("six saved reports share a deliberate page frame with tasks, inspector and wide document review", { timeout: 90000 }, async t => {
    const { page, context, entries, requests } = await setup(t, 6, { prepared: true });
    page.setDefaultTimeout(8000);
    const files = entries.flatMap(entry => Object.values(entry.files));
    const originals = await Promise.all(files.map(async file => hash(await readFile(file))));
    const measurements = [], violations = [], external = [];
    const origin = new URL(page.url()).origin;
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    async function capture(name, body, { library = false, wide = false } = {}) {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => Promise.all([...document.querySelectorAll("#main,#sidebar,#contextSidebar")]
            .flatMap(node => node.getAnimations()).map(animation => animation.finished)));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measured = await page.evaluate(({ body, library }) => {
            const box = node => {
                const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
                return { x, y, width, height, right, bottom };
            };
            const textRight = node => {
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), rights = [];
                for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                    if (text.parentElement.closest('svg,[aria-hidden="true"]')) continue;
                    const range = document.createRange(); range.selectNodeContents(text);
                    rights.push(...[...range.getClientRects()].filter(rect => rect.width).map(rect => rect.right));
                }
                return Math.max(...rights);
            };
            const frame = document.querySelector(body), heading = document.querySelector(".page-heading");
            const controls = [...document.querySelectorAll("#reportTaskNav a,#savedReportsPanel button,#savedReportsPanel summary,#savedReportSearch,#savedReportOrder-control")]
                .filter(node => node.checkVisibility()).map(node => {
                    const words = [], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                        if (text.parentElement.closest('svg,[aria-hidden="true"]')) continue;
                        for (const match of text.textContent.matchAll(/\S+/g)) {
                            const range = document.createRange();
                            range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
                            const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
                            if (rects.length) words.push({ word: match[0], lines: new Set(rects.map(rect => rect.y)).size,
                                left: Math.min(...rects.map(rect => rect.x)), right: Math.max(...rects.map(rect => rect.right)) });
                        }
                    }
                    return { label: node.getAttribute("aria-label") || node.textContent.trim(), box: box(node), words };
                });
            return { viewport: innerWidth, text: getComputedStyle(document.documentElement).fontSize,
                collapsed: document.querySelector("#navigationCollapse").getAttribute("aria-expanded") === "false",
                main: box(document.querySelector("#main")), heading: box(heading), body: box(frame),
                title: box(document.querySelector("#pageTitle")), controls,
                actions: [...document.querySelectorAll("#reportTaskNav a")].filter(node => node.checkVisibility()).map(box),
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                ...(library ? {
                    search: box(document.querySelector("#savedReportSearch")), order: box(document.querySelector("#savedReportOrder-control")),
                    help: box(document.querySelector("#savedLibraryHelp")), position: box(document.querySelector("#bundleList [data-page-position]")),
                    pager: box(document.querySelector("#bundleList .list-pager")),
                    rows: [...document.querySelectorAll(".saved-library-row")].map(row => ({
                        box: box(row), identity: box(row.querySelector(".saved-report-identity")),
                        identityTextRight: textRight(row.querySelector(".saved-report-identity")),
                        metadata: box(row.querySelector(".saved-report-metadata")),
                        metadataText: row.querySelector(".saved-report-metadata").textContent,
                        metadataTextRight: textRight(row.querySelector(".saved-report-metadata")),
                        open: box(row.querySelector(":scope>button:not(.saved-report-summary),:scope>.saved-report-no-html")),
                    })),
                } : {}) };
        }, { body, library });
        measurements.push({ name, wide, ...measured });
        const fail = (condition, reason) => { if (condition) violations.push(`${name}: ${reason}`); };
        fail(Math.abs(measured.heading.x - measured.body.x) > 1 || Math.abs(measured.heading.width - measured.body.width) > 1,
            `heading ${measured.heading.width}px / body ${measured.body.width}px use different frames`);
        fail(measured.actions.some(action => action.x < measured.body.x - 1 || action.right > measured.body.right + 1), "task actions escape the body frame");
        fail(measured.overflow || measured.controls.some(control => control.box.height < 44
            || control.words.some(word => word.lines !== 1 || word.left < control.box.x - 1 || word.right > control.box.right + 1)),
            "page overflow, a sub-44px target or a fragmented label");
        if (wide) fail(measured.body.width < Math.min(1200, measured.main.width - 48), "document review is constrained to a catalog width");
        if (library) {
            fail(measured.actions.length !== 2, "both report task entries must remain visible");
            fail(measured.rows.some(row => row.metadata.y > row.identity.y + 1 && Math.abs(row.open.y - row.identity.y) > 1),
                "stacked rows must keep Open aligned with report identity");
            fail(measured.position.y - measured.help.bottom > 16 || measured.rows[0].box.y - measured.position.bottom > 16,
                `empty list spacing: ${measured.position.y - measured.help.bottom}px before count, ${measured.rows[0].box.y - measured.position.bottom}px after`);
            if (measured.viewport >= 1400 && measured.text === "16px") {
                fail(Math.abs(measured.search.y - measured.order.y) > 1 || measured.order.x - measured.search.right > 24, "search/order controls do not align");
                fail(measured.rows.some(row => row.metadata.x - row.identityTextRight > 130), "row metadata is detached from identity");
                fail(measured.rows.some(row => Math.abs(row.metadata.y - row.identity.y) <= 1
                    && row.metadataText.includes("Markdown") && row.open.x - row.metadataTextRight > 160), "Open is detached from the report metadata");
            }
        }
        await shot(page, name);
    }
    assert.equal(entries.length, 6);
    assert.equal(await page.locator("#bundleList .saved-library-row").count(), 6);
    for (const theme of ["light", "dark"]) for (const [width, text, collapsed] of [
        [2000, 100, false], [2000, 100, true], [1440, 100, false], [1440, 200, true], [375, 100, false], [375, 200, false],
    ]) {
        await page.setViewportSize({ width: 1440, height: 1100 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        if (await page.locator("#navigationCollapse").getAttribute("aria-expanded") === String(collapsed)) await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: width === 2000 ? 1220 : 1100 });
        await page.evaluate(text => { document.documentElement.style.fontSize = text + "%"; }, text);
        const name = `${theme}-${width}-${text}-${collapsed ? "collapsed" : "expanded"}`;
        await capture("library-" + name, "#bundles", { library: true });
        const inspect = page.locator(".saved-library-row").filter({ has: page.getByRole("button", { name: "Open saved report", exact: true }) }).first().locator(".saved-report-summary");
        await inspect.click();
        await page.locator("#contextSidebar[open]").waitFor();
        await capture("inspector-" + name, "#bundles", { library: true });
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        assert.equal(await inspect.evaluate(node => node === document.activeElement), true);
    }
    await page.setViewportSize({ width: 2000, height: 1220 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await chooseTheme(page, "light");
    await page.locator("#savedLibraryHelp>summary").click();
    await capture("library-help-wide", "#bundles", { library: true });
    await page.locator("#savedLibraryHelp>summary").click();
    await page.locator("#savedLibraryManagement>summary").click();
    await capture("library-management-wide", "#bundles", { library: true });
    await page.locator("#savedLibraryManagement>summary").click();
    await chooseReportScope(page, "all");
    await capture("create-wide", "#reportCreatePanel");
    await reportContents(page);
    await capture("contents-wide", "#reportCreatePanel");
    await scanReport(page);
    await capture("review-wide", "#reportCreatePanel", { wide: true });
    await openReportLibrary(page);
    await openReportComparison(page);
    await page.locator("#comparisonWorkspace select").first().locator("option").nth(1).waitFor({ state: "attached" });
    await capture("comparison-wide", "#comparisonWorkspace");
    for (const [label, entry] of [["Earlier report", entries[0]], ["Later report", entries[1]]]) {
        await page.locator("#comparisonWorkspace").getByRole("combobox", { name: label, exact: true }).click();
        await page.locator(`.select-popup .select-option[data-value="${entry.bundleId}"]`).click();
    }
    await page.locator("#comparisonWorkspace").getByRole("button", { name: "Compare reports", exact: true }).click();
    await page.locator("#comparisonWorkspace").getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    await page.locator("#comparisonWorkspace .comparison-prepared-files iframe").waitFor();
    await capture("comparison-review-wide", "#comparisonWorkspace", { wide: true });
    await openReportLibrary(page);
    const htmlEntry = entries.find(entry => entry.formats.includes("html"));
    await page.locator(`.saved-library-row[data-bundle-id="${htmlEntry.bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").locator("h1").waitFor();
    await capture("saved-reader-wide", "#savedReportReader", { wide: true });
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await capture("returned-library-wide", "#bundles", { library: true });
    assert.deepEqual(await Promise.all(files.map(async file => hash(await readFile(file)))), originals);
    assert.equal((await loadBoardState(context)).exports.length, 6);
    assert.equal(requests.some(endpoint => ["/api/export", "/api/report-comparison/save", "/api/artifact-deletion/confirm"].includes(endpoint)), false);
    assert.deepEqual(external, []);
    if (process.env.WIRE_LIBRARY_PROOFS) await writeFile(path.join(process.env.WIRE_LIBRARY_PROOFS, "page-composition.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(violations, [], "Report header/actions/body, row spacing and complete labels must form one coherent page");
});

test("the library is an immediately readable list with useful scope identity and a direct return from frozen reading", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, 8);
    page.setDefaultTimeout(8000);
    assert.equal(await page.locator("#bundles").evaluate(node => node.tagName), "SECTION");
    assert.equal(await page.locator("#coverage").isVisible(), false, "Live Analyze coverage must not masquerade as saved-report coverage");
    assert.equal(await page.locator("#bundleList .saved-report").count(), 6);
    assert.match(await page.locator(".saved-report-summary").nth(1).innerText(), /8 interactions/);
    assert.doesNotMatch(await page.locator("#bundleList").innerText(), /Report ID:/);
    await page.locator("#savedReportSearch").fill("No prompts");
    const inspect = page.locator(".saved-library-row").filter({ has: page.getByRole("button", { name: "Open saved report", exact: true }) }).first().locator(".saved-report-summary");
    await inspect.click();
    await page.locator("#contextSidebar").waitFor({ state: "visible" });
    assert.equal(requests.includes("/api/report/open"), false, "Selection reads indexed metadata only");
    assert.match(await page.locator("#contextSidebarTitle").innerText(), /Activity report/);
    assert.match(await page.locator("#contextSidebarBody").innerText(), /Prepared/);
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").locator("h1").waitFor();
    assert.equal(await page.locator("#contextSidebar").isVisible(), false);
    assert.equal(await page.locator("#pageTitle").evaluate(node => node === document.activeElement), true);
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.locator("#contextSidebar").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Close saved report details", exact: true }).click();
    const open = page.getByRole("button", { name: "Open saved report", exact: true }).first();
    await open.click();
    await page.frameLocator("#savedReportReader iframe").locator("h1").waitFor();
    assert.equal(await page.locator("#savedReportReader iframe").getAttribute("sandbox"), "");
    assert.doesNotMatch(await page.locator("#savedReportReader").innerText(), /Report ID:/);
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    assert.equal(await page.locator("#contextSidebar").isVisible(), false, "Direct Open does not force an inspector on return");
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "No prompts");
    assert.equal(await open.evaluate(node => node === document.activeElement), true);
});

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
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    const countBefore = requests.length;
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    assert.equal(await page.locator(".report-journey").isVisible(), false);
    await page.locator("#savedReportSearch").fill("masked");
    await page.locator("#bundleList").getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator("#savedReportReader iframe").waitFor();
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.goBack();
    assert.match(page.url(), /task=create/);
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed");
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "3");
    assert.equal(await page.getByRole("button", { name: "Save report", exact: true }).isEnabled(), true);
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
    page.setDefaultTimeout(8000);
    const origin = new URL(page.url()).origin;
    await page.goto(origin + "/#activity?session=test-session");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.getByRole("button", { name: "Create report for this Copilot chat", exact: true }).click();
    assert.match(page.url(), /task=create/);
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 interaction/);
    await page.goBack();
    assert.match(page.url(), /#analyze/);
    await page.goForward();
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 interaction/);
    await page.locator("#reportList").getByRole("link", { name: "View interaction", exact: true }).click();
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Back to activity", exact: true }).click();
    assert.match(page.url(), /#reports.*task=create/);
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 interaction/);
    await navigateMain(page, "reports");
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), true, "Main Reports navigation always leads to the library");
    for (const hash of ["#reports?task=create", "#report", "#reports?request=test-scenario"]) {
        await page.goto(origin + "/" + hash);
        await page.reload();
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        assert.equal(await page.locator("#reportCreatePanel").isVisible(), true, hash);
        assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No interactions included", "A fresh panel does not invent selection from a deep link");
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
    await page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: "Frozen synthetic report 1", exact: true }).waitFor();
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Open saved report", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.locator("#savedReportSearch").fill("SYNTHETIC_PRIVATE_CONTENT_NEVER_SEARCHED");
    assert.match(await page.locator("#bundleList").textContent(), /No saved reports match/);
    await shot(page, "no-matches");
    await page.locator("#clearSavedReportSearch").click();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await navigateMain(page, "activity"); await page.goBack();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await page.locator("#savedReportSearch").fill(entries[0].bundleId);
    await page.locator("#bundleList .saved-report-summary").click();
    await page.locator("#contextSidebar").getByRole("button", { name: "Delete report", exact: true }).click();
    await page.locator(".delete-object-confirm:not([disabled])").waitFor();
    await page.locator(".deletion-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("#closeContextSidebar").click();
    await page.locator("#savedLibraryManagement > summary").click();
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
                fontLoaded: getComputedStyle(document.body).fontFamily.startsWith('"Asta Sans"') && document.fonts.check('14px "Asta Sans"'),
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
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await page.locator('#workspace[aria-busy="true"]').waitFor();
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A pending list does not permit a new deletion preview");
    await shot(page, "library-loading");
    release();
    await page.getByText("Synthetic saved-list read unavailable.", { exact: false }).first().waitFor();
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A failed snapshot cannot approve destructive work");
    await shot(page, "library-error");
    await updateBoardState(context, state => { state.exports = []; });
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    if (!await page.locator("#bundles").evaluate(node => node.open)) await page.locator("#savedLibraryTitle").click();
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
    await page.locator("#savedLibraryManagement > summary").click();
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
