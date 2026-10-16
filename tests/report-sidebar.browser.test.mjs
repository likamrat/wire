import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, selectActivityOption, chooseTheme } from "./helpers.mjs";
import { reportContents, scanReport, findReportCopy, chooseReportScope } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";

async function capture(page, name) {
    const directory = process.env.WIRE_REPORT_SETUP_PROOFS;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, name + ".png") });
}

async function setup(t, { width = 1440, height = 1000, touch = false, recordCases } = {}) {
    const records = recordCases ?? Array.from({ length: 9 }, (_, index) => {
        const value = fixture(`report-sidebar-${index}`);
        value.userPrompt = { text: `Invented report question${index}: retain the release decisions and the unresolved calendar follow-up.`,
            status: "full", sourceTimestamp: "2026-09-30T12:00:00Z", sourceEventId: `report-prompt-${index}`,
            authorship: { actor: "user", basis: "source-user" } };
        value.sourceSessionName = `Invented report chat ${index}`;
        value.followUpPrompts = [];
        return value;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ url: new URL(request.url()), method: request.method(),
        body: request.method() === "POST" ? request.postDataJSON() : null }));
    await page.route("**/api/assessment/evaluate", route => route.abort("blockedbyclient"));
    await page.route("**/api/collection/refresh", route => route.abort("blockedbyclient"));
    await page.addInitScript(() => {
        window.reportCopies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            async writeText(text) { window.reportCopies.push(text); },
        } });
    });
    t.after(async () => {
        await browser.close();
        await runtime.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(request => request.url.origin === new URL(runtime.url).origin), "No off-device requests");
        assert.equal(requests.filter(request => /\/(?:evaluate|refresh)$/.test(request.url.pathname)).length, 0);
    });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime, context, records, requests };
}

test("Activity stays interactive beside one mounted setup; peek, return and close retain its draft without preparing", { timeout: 30000 }, async t => {
    const { page, context, requests } = await setup(t);
    await page.locator("#pageAction").click();
    await page.locator("#reportList input").first().check();
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    await page.locator("#reportList input").first().check();
    await expect(page.locator("#reportActivitySummary")).toHaveText("1 chat · 2 interactions included");
    await expect(page.locator("#reportPageSelectionSummary")).toHaveText("1 included outside this page.");
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    await expect(page.locator("#reportPageSelectionSummary")).toHaveText("2 included outside this page.");
    await page.getByRole("button", { name: "Previous report requests", exact: true }).click();
    await page.evaluate(() => {
        window.setupOptions = document.querySelector(".report-options");
        window.picker = document.querySelector("#reportList").firstElementChild;
    });

    await reportContents(page);
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
    await expect(page.locator("#reportStage1")).toBeVisible();
    await expect(page.locator("#reportClearSelection")).toBeVisible();
    await expect(page.locator("#contextSidebarBody #reportStage2")).toBeVisible();
    await expect(page.locator("#contextSidebarFooter #exportBtn")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to contents", exact: true, includeHidden: true })).toBeHidden();
    assert.equal(await page.evaluate(() => window.picker === document.querySelector("#reportList").firstElementChild), true);
    await page.locator('[name=promptMode][value=original]').check();
    await page.locator('#formatOptions input[value=json]').check();
    await page.locator("#additionalMasking summary").click();
    await page.locator("#manualTerms").fill("Invented masking term");
    await capture(page, "normal-entry-setup");
    const savedTop = await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop);
    const inspection = page.locator("#reportList .request-link").nth(1);
    await inspection.click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Interaction");
    await expect(page.locator("#requestReportToggle")).toHaveText("Add to report");
    await expect(page.locator("#previewSelectionSummary")).toHaveText("1 chat · 2 interactions");
    await expect(page.getByRole("button", { name: "Back to report setup", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to contents", exact: true, includeHidden: true })).toBeHidden();
    await expect(page.locator("#reportStage1")).toBeVisible();
    await capture(page, "normal-entry-interaction-peek");
    await page.locator('[data-reader-section="activity"] .reader-section-toggle').click();
    const peekTop = await page.locator("#contextSidebarBody").evaluate(node => { node.scrollTop = 200; return node.scrollTop; });
    await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
    assert.equal(await page.evaluate(() => window.setupOptions === document.querySelector(".report-options")), true, "No cloned or rebuilt form");
    await expect(page.locator("#manualTerms")).toHaveValue("Invented masking term");
    await expect(page.locator("#manualTerms")).toBeFocused();
    await capture(page, "normal-entry-restored-setup");
    assert.ok(Math.abs(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop) - savedTop) <= 2);
    await expect(page.locator('[name=promptMode][value=original]')).toBeChecked();
    await expect(page.locator('#formatOptions input[value=json]')).toBeChecked();
    await inspection.click();
    await expect(page.locator('[data-reader-section="activity"] .reader-section-toggle')).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.locator("#contextSidebarBody").evaluate(node => node.scrollTop)).toBe(peekTop);
    await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    await page.locator("#reportRequestSearch").fill("question0");
    await expect(page.locator("#reportPageSelectionSummary")).toHaveText("1 included outside this page.");
    await expect(page.locator("#contextSidebarBody #reportStage2")).toBeVisible();
    await expect(page.locator("#reportList input")).toBeChecked();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    const continuation = page.getByRole("button", { name: "Continue to contents", exact: true });
    await expect(continuation).toBeVisible();
    await expect(continuation).toBeFocused();
    await continuation.click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
    await expect(page.locator("#manualTerms")).toHaveValue("Invented masking term");
    await page.locator("#reportList .request-link").first().click();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(continuation).toBeVisible();
    assert.equal(await page.evaluate(() => document.activeElement.checkVisibility() && !document.activeElement.disabled), true);
    await continuation.click();
    await expect(page.locator("#contextSidebarFooter #exportBtn")).toBeVisible();
    await expect(continuation).toBeHidden();
    await page.locator("#reportList input").first().uncheck();
    await page.locator("#reportRequestSearch").fill("question4");
    await page.locator("#reportList input").first().uncheck();
    await page.locator("#reportRequestSearch").fill("");
    await expect(page.locator("#exportBtn")).toBeDisabled();
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(continuation).toBeVisible();
    await expect(continuation).toBeDisabled();
    await expect(page.locator("#reportStepTitle1")).toBeFocused();
    await expect(page.locator("#reportStepTitle1")).toBeInViewport();
    const focused = await page.evaluate(() => ({
        top: document.querySelector("#reportStepTitle1").getBoundingClientRect().top,
        header: document.querySelector(".app-header").getBoundingClientRect().bottom,
    }));
    assert.ok(focused.top >= focused.header, JSON.stringify(focused));
    assert.equal(requests.filter(request => /\/api\/(?:preview|privacy-review|export)$/.test(request.url.pathname)).length, 0);
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

test("real preparation leaves the sidebar for wide Report/Text/Files, copy edits, explicit approval and separate save", { timeout: 30000 }, async t => {
    const { page, context, requests } = await setup(t);
    await page.locator("#pageAction").click();
    await page.locator("#reportList input").nth(0).check();
    await page.locator("#reportList input").nth(1).check();
    await capture(page, "normal-entry-activity");
    const width = await page.locator("#main").evaluate(node => node.clientWidth);
    await reportContents(page);
    await page.locator('#formatOptions input[value=json]').check();
    const first = await scanReport(page);
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator("#reportStage1")).toBeHidden();
    await expect(page.locator("#reportStage3")).toBeVisible();
    assert.equal(await page.locator("#main").evaluate(node => node.clientWidth), width);
    await expect(page.frameLocator(".report-frame").locator("h1")).toBeVisible();
    await capture(page, "actual-prepared-main-document");
    assert.equal(await page.locator(".report-frame").getAttribute("sandbox"), "allow-same-origin");
    await page.getByRole("tab", { name: /^Files \(/ }).click();
    await expect(page.locator("#reportFileInspection summary").filter({ hasText: "Inspect exact product-report.html" })).toBeVisible();
    await expect(page.locator("#reportFileInspection>h3")).toHaveCount(0);
    await capture(page, "actual-prepared-files");
    const copy = await findReportCopy(page, "question0");
    const copySurfaces = await copy.locator(".ux-code-block").evaluateAll(nodes => nodes.map(node => {
        const text = node.querySelector("pre"), style = getComputedStyle(text);
        return { font: style.fontFamily, weight: style.fontWeight, background: style.backgroundColor,
            blockBackground: getComputedStyle(node).backgroundColor,
            toolbarTop: node.querySelector(".ux-code-toolbar").getBoundingClientRect().top };
    }));
    assert.equal(copySurfaces.length, 2);
    assert.equal(copySurfaces[0].toolbarTop, copySurfaces[1].toolbarTop);
    for (const surface of copySurfaces) {
        assert.match(surface.font, /^"Asta Sans"/);
        assert.equal(surface.weight, "400");
        assert.equal(surface.background, "rgba(0, 0, 0, 0)");
        assert.equal(surface.blockBackground, "rgba(0, 0, 0, 0)");
    }
    await copy.getByText("Edit or omit this report copy", { exact: true }).click();
    await copy.locator("textarea").fill("Edited invented report copy");
    await capture(page, "actual-edit-report-copy");
    await expect(page.getByRole("button", { name: "Approve for local saving", exact: true })).toBeDisabled();
    const omitted = await findReportCopy(page, "question1");
    await omitted.getByText("Edit or omit this report copy", { exact: true }).click();
    await omitted.getByRole("checkbox", { name: "Omit this prompt from the report", exact: true }).check();
    const rebuiltResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    const rebuilt = await (await rebuiltResponse).json();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    assert.notEqual(rebuilt.previewId, first.previewId);
    assert.ok(rebuilt.promptReview.some(copy => copy.text === "Edited invented report copy"));
    assert.ok(rebuilt.promptReview.some(copy => copy.original?.includes("question1") && copy.omitted));
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    await expect(page.locator("#contextSidebarBody #reportStage2")).toBeVisible();
    await expect(page.locator("#reportStage1")).toBeVisible();
    const scans = requests.filter(request => request.url.pathname === "/api/preview").length;
    await page.locator("#exportBtn").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.equal(requests.filter(request => request.url.pathname === "/api/preview").length, scans);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
    assert.equal((await loadBoardState(context)).exports.length, 0, "Disclosure approval is not a write");
    const save = page.getByRole("button", { name: "Save report", exact: true });
    await expect(save).toBeFocused();
    await capture(page, "actual-disclosure-approved-separate-save");
    assert.equal(await save.locator("svg").count(), 0, "Save is text-only");
    await save.click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    await capture(page, "actual-saved-result");
    assert.equal((await loadBoardState(context)).exports.length, 1);
    assert.equal(requests.filter(request => request.url.pathname === "/api/export").length, 1);
    await page.getByRole("button", { name: "View saved reports", exact: true }).click();
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
});

test("setup controls and selection survive native close and reader returns without a retired feedback guard", { timeout: 30000 }, async t => {
    const { page, context, requests } = await setup(t);
    await page.locator("#pageAction").click();
    await page.locator("#reportList input").first().check();
    await reportContents(page);
    await page.locator('[name=promptMode][value=original]').check();
    await page.locator("#additionalMasking summary").click();
    await page.locator("#manualTerms").fill("Invented retained setup term");
    const options = await page.locator(".report-options").elementHandle();
    const expectOptions = async () => {
        assert.equal(await options.evaluate(node => node === document.querySelector(".report-options") && node.isConnected), true);
        await expect(page.locator('[name=promptMode][value=original]')).toBeChecked();
        await expect(page.locator("#manualTerms")).toHaveValue("Invented retained setup term");
        await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    };
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue to contents", exact: true })).toBeFocused();
    await page.locator("#reportList .request-link").first().click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Interaction");
    await expect(page.locator("#exportBtn")).toHaveCount(1, "Park the original setup footer instead of detaching its controls");
    await expect(page.locator("#requestContent [data-feedback-dimension],.assessment-feedback-dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to activity", exact: true }).click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator("#reportList input").first()).toBeChecked();
    await reportContents(page);
    await expectOptions();
    await page.locator("#reportList .request-link").first().click();
    await page.getByRole("button", { name: "2. Contents", exact: true }).click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
    await expectOptions();
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("#contextSidebar")) && document.activeElement.checkVisibility()), true);
    await page.locator("#reportList .request-link").first().click();
    await page.getByRole("button", { name: "1. Activity", exact: true }).click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-step", "1");
    await expect(page.locator("#previewSelectionSummary")).toHaveText("1 chat · 1 interaction");
    await reportContents(page);
    await expectOptions();
    await page.locator("#reportList .request-link").first().click();
    await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
    await expectOptions();
    await page.locator("#reportList .request-link").first().click();
    await page.getByRole("button", { name: "Remove from report", exact: true }).click();
    await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
    await expectOptions();
    await expect(page.locator("#exportBtn")).toBeDisabled();
    await expect(page.locator("#previewSelectionSummary")).toHaveText("No interactions included");
    await page.locator("#closeContextSidebar").click();
    await expect(page.getByRole("button", { name: "Continue to contents", exact: true })).toBeDisabled();
    await expect(page.locator("#reportStepTitle1")).toBeFocused();
    await expect(page.locator("#reportStepTitle1")).toBeInViewport();
    assert.equal(requests.filter(request => /\/api\/(?:preview|privacy-review|export|assessment\/feedback)$/.test(request.url.pathname)).length, 0);
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

test("inspection preserves Current/All membership and excluded Selected choices without converting scopes", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await page.locator("#pageAction").click();
    for (const scope of ["all", "current"]) {
        await chooseReportScope(page, scope);
        const membership = await page.locator("#previewSelectionSummary").textContent();
        await reportContents(page);
        await page.locator("#reportList .request-link").first().click();
        await expect(page.locator("#requestReportToggle")).toBeHidden();
        await expect(page.locator("#requestReportTitle")).toContainText("Included by this report's activity scope");
        await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
        await expect(page.locator("[name=reportScope]:checked")).toHaveValue(scope);
        await expect(page.locator("#previewSelectionSummary")).toHaveText(membership);
        await expect(page.locator("#reportList input")).toHaveCount(0);
    }
    await chooseReportScope(page, "selected");
    await page.locator("#reportList input").first().check();
    await reportContents(page);
    await selectActivityOption(page, "reportPromptAuthorFilter", ["agent"]);
    await expect(page.locator("#previewSelectionSummary")).toHaveText("No interactions included");
    await page.locator("#reportList .request-link").first().click();
    await expect(page.locator("#requestReportTitle")).toContainText("Selected; not included");
    await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
    await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
    await expect(page.locator("#reportList input").first()).toBeChecked();
    await expect(page.locator("#exportBtn")).toBeDisabled();
    assert.equal(requests.filter(request => request.url.pathname === "/api/preview").length, 0);
});

test("picker search during a peek retains its current query when returning to setup", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#pageAction").click();
    await page.locator("#reportList input").first().check();
    await reportContents(page);
    await page.locator("#reportList .request-link").first().click();
    await page.locator("#reportRequestSearch").fill("question8");
    await expect(page.locator("#reportList")).toContainText("question8");
    await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
    await page.getByRole("button", { name: "Back to activity", exact: true }).click();
    await page.locator("#reportLibraryLink").click();
    await page.locator("#reportCreateLink").click();
    await expect(page.locator("#reportRequestSearch")).toHaveValue("question8");
    await expect(page.locator("#reportList")).toContainText("question8");
    await expect(page.locator("#previewSelectionSummary")).toHaveText("1 chat · 1 interaction");
});

test("setup uses the shared responsive panel with visible keyboard and touch actions in both themes", { timeout: 45000 }, async t => {
    const { page, requests } = await setup(t, { touch: true });
    await page.locator("#pageAction").click();
    await page.locator("#reportList input").first().check();
    const proof = process.env.WIRE_REPORT_SETUP_PROOFS, samples = [];
    if (proof) await mkdir(proof, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, height, scale, expanded] of [
        [1440, 1000, 1, true], [1280, 900, 1, false], [820, 900, 1, false],
        [375, 900, 1, true], [375, 900, 2, true], [820, 420, 2, false],
    ]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${16 * scale}px`, scale);
        const navigation = page.locator("#navigationCollapse");
        if (await navigation.isVisible() && (await navigation.getAttribute("aria-expanded") === "true") !== expanded) await navigation.click();
        await reportContents(page);
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 0);
        const measure = await page.evaluate(() => {
            const box = id => document.getElementById(id).getBoundingClientRect().toJSON();
            const panel = document.getElementById("contextSidebar"), body = document.getElementById("contextSidebarBody");
            return { panel: box("contextSidebar"), body: box("contextSidebarBody"), footer: box("contextSidebarFooter"),
                close: box("closeContextSidebar"), prepare: box("exportBtn"), prompts: box("promptOptions"), formats: box("formatOptions"),
                main: box("main"), modal: panel.matches(":modal"), scrollWidth: document.documentElement.scrollWidth,
                bodyOverflow: body.scrollWidth > body.clientWidth + 1,
                paint: { background: getComputedStyle(panel).backgroundColor,
                    text: getComputedStyle(document.querySelector("#reportStage2 legend")).color,
                    muted: getComputedStyle(document.querySelector("#reportStage2 .report-content-context")).color,
                    close: getComputedStyle(document.querySelector("#closeContextSidebar svg")).color } };
        });
        assert.ok(measure.scrollWidth <= width + 1, JSON.stringify(measure));
        assert.equal(measure.bodyOverflow, false, JSON.stringify(measure));
        assert.ok(measure.close.height >= 44 && measure.close.width >= 44);
        assert.ok(measure.prepare.height >= 44 && measure.prepare.width >= 44);
        assert.ok(measure.footer.bottom <= height + 1 && measure.footer.top >= measure.body.bottom - 1);
        assert.ok(measure.body.height >= 80, JSON.stringify(measure));
        assert.ok(contrast(measure.paint.text, measure.paint.background) >= 4.5, JSON.stringify(measure.paint));
        assert.ok(contrast(measure.paint.muted, measure.paint.background) >= 4.5, JSON.stringify(measure.paint));
        assert.ok(contrast(measure.paint.close, measure.paint.background) >= 3, JSON.stringify(measure.paint));
        assert.ok(Math.abs(measure.formats.x - measure.prompts.x) <= 1, "Setup fields stack at the panel's reading width");
        if (width >= 1280) assert.ok(!measure.modal && measure.main.right <= measure.panel.x + 1);
        else assert.equal(measure.modal, true);
        await page.locator("#exportBtn").focus();
        await expect(page.locator("#exportBtn")).toBeInViewport();
        await expect(page.locator("#evidence-tooltip")).toHaveText("Prepare report");
        await page.keyboard.press("Tab");
        if (measure.modal) {
            const focus = await page.evaluate(() => ({ id: document.activeElement.id, tag: document.activeElement.tagName,
                inPanel: document.querySelector("#contextSidebar").contains(document.activeElement), documentFocused: document.hasFocus() }));
            assert.equal(focus.inPanel || !focus.documentFocused, true, JSON.stringify({ width, height, scale, focus }));
            assert.equal(await page.evaluate(() => {
                const background = document.querySelector("#reportList input");
                background.focus();
                return document.activeElement === background;
            }), false, "The native modal makes the underlying picker inert");
        }
        if (proof) await page.screenshot({ path: path.join(proof, `setup-${theme}-${width}-${height}-${scale}-${expanded}.png`) });
        samples.push({ theme, width, height, scale, expanded, ...measure });
        await page.locator('[name=promptMode][value=original]').tap();
        await expect(page.locator('[name=promptMode][value=original]')).toBeChecked();
        await page.locator("#closeContextSidebar").tap();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    }
    if (proof) await writeFile(path.join(proof, "setup-geometry.json"), JSON.stringify(samples, null, 2));
    assert.equal(requests.filter(request => /\/api\/(?:preview|privacy-review|export)$/.test(request.url.pathname)).length, 0);
});

test("source invalidation scrubs retained peek subjects and keeps a safe route back to the current report setup", { timeout: 20000 }, async t => {
    const { page, context, records, requests } = await setup(t);
    await page.locator("#pageAction").click();
    await page.locator("#reportList input").first().check();
    await reportContents(page);
    await page.locator('[name=promptMode][value=original]').check();
    await page.locator("#reportList .request-link").first().click();
    await expect(page.locator('[data-reader-section="prompt"] pre')).toHaveText(records[0].userPrompt.text);
    const staleCopy = await page.getByRole("button", { name: "Copy prompt", exact: true }).elementHandle();
    const staleFold = await page.getByRole("button", { name: "Collapse all sections", exact: true }).elementHandle();
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.reportCopies), [records[0].userPrompt.text]);
    await replaceEvidence(context, () => ({ records: records.slice(1) }));
    await expect(page.locator("#requestContent")).not.toContainText("question0", { timeout: 10000 });
    await expect(page.locator("#requestContent .full-text-content,#requestContent .ux-copy")).toHaveCount(0);
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    await staleCopy.evaluate(node => node.click());
    await staleFold.evaluate(node => node.click());
    assert.deepEqual(await page.evaluate(() => window.reportCopies), [records[0].userPrompt.text], "Invalidated owners cannot copy their stale private subject");
    await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
    await expect(page.locator('[name=promptMode][value=original]')).toBeChecked();
    await expect(page.locator("#exportBtn")).toBeDisabled();
    await expect(page.locator("#previewSelectionSummary")).toHaveText("A selected request is no longer available");
    assert.equal(requests.filter(request => /\/api\/(?:preview|privacy-review|export|assessment\/feedback)$/.test(request.url.pathname)).length, 0);
});

test("animated setup departure retains its fields and footer until closed, then focuses the main journey", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#pageAction").click();
    await page.locator("#reportList input").first().check();
    await reportContents(page);
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    for (const action of ["Back to activity", "Prepare report"]) {
        await page.evaluate(() => {
            window.reportExitFrames = [];
            window.reportExitDone = false;
            const panel = document.querySelector("#contextSidebar");
            const sample = () => {
                if (!panel.open) { window.reportExitDone = true; return; }
                if (panel.getAnimations().some(animation => animation.playState === "running")) {
                    window.reportExitFrames.push({
                        contents: document.querySelector("#reportStage2").checkVisibility(),
                        footer: document.querySelector("#contextSidebarFooter").contains(document.querySelector("#exportBtn")),
                    });
                }
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        await page.getByRole("button", { name: action, exact: true }).click();
        await page.waitForFunction(() => window.reportExitDone);
        const frames = await page.evaluate(() => window.reportExitFrames);
        assert.ok(frames.length >= 2, "Sample the actual exit, not only its endpoint");
        assert.ok(frames.every(frame => frame.contents && frame.footer), JSON.stringify({ action, frames }));
        await expect(page.locator(action === "Back to activity" ? "#reportStepTitle1" : "#reportStepTitle3")).toBeFocused();
        if (action === "Back to activity") {
            await reportContents(page);
            await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        }
    }
});

test("setup return releases request-history ownership and late reads without losing the supplied footer", { timeout: 25000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#pageAction").click();
    await page.locator("#reportList input").first().check();
    for (const mode of ["auto", "manual"]) {
        await page.evaluate(mode => history.scrollRestoration = mode, mode);
        await reportContents(page);
        let release, arrived;
        const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
        t.after(() => release());
        const deliveries = [];
        await page.route("**/api/assessment/detail", route => {
            const delivery = (async () => {
                const response = await route.fetch();
                arrived(); await held;
                await route.fulfill({ response });
            })();
            deliveries.push(delivery);
            return delivery;
        });
        await page.locator("#reportList .request-link").first().click();
        await pending;
        assert.equal(await page.evaluate(() => history.scrollRestoration), "manual");
        await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
        assert.equal(await page.evaluate(() => history.scrollRestoration), mode);
        await expect(page.locator("#requestContent")).toBeEmpty();
        await expect(page.locator("#contextSidebarFooter #exportBtn")).toBeVisible();
        release(); await Promise.all(deliveries);
        await page.unroute("**/api/assessment/detail");
        await expect(page.locator("#requestContent")).toBeEmpty();
        await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
        await expect(page.locator("#contextSidebarFooter #exportBtn")).toBeEnabled();
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(await page.evaluate(() => history.scrollRestoration), mode);
    }
});

test("reopening setup during an interaction exit cannot inherit the old inert owner or deferred cleanup", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#pageAction").click();
    await page.locator("#reportList input").first().check();
    for (const mode of ["auto", "manual"]) {
        await page.evaluate(mode => history.scrollRestoration = mode, mode);
        await reportContents(page);
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        await page.locator("#reportList .request-link").first().click();
        const oldCopy = await page.locator('[data-reader-section="prompt"] .ux-copy').elementHandle();
        await page.getByRole("button", { name: "Continue to contents", exact: true, includeHidden: true }).evaluate(node => {
            node.addEventListener("click", () => {
                window.reportReopenedDuringExit = document.querySelector("#contextSidebar").getAnimations().some(animation => animation.playState === "running");
            }, { once: true, capture: true });
        });
        await page.locator("#closeContextSidebar").click();
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        assert.equal(await page.evaluate(() => window.reportReopenedDuringExit), true, "Exercise replacement before the old exit settles");
        await expect(page.locator("#contextSidebarTitle")).toHaveText("Report setup");
        assert.equal(await page.locator("#contextSidebar").evaluate(node => node.inert), false, "New setup owns an interactive panel");
        assert.equal(await page.evaluate(() => history.scrollRestoration), mode);
        await expect(page.locator("#requestContent")).toBeEmpty();
        await oldCopy.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        assert.deepEqual(await page.evaluate(() => window.reportCopies), [], "The detached old Copy getter cannot disclose its prior prompt");
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        await expect(page.locator("#exportBtn")).toHaveCount(1);
        await expect(page.locator("#contextSidebarFooter #exportBtn")).toBeVisible();
        await expect(page.locator("#contextSidebarFooter #exportBtn")).toBeEnabled();
        await page.locator('[name=promptMode][value=none]').check();
        await page.locator("#exportBtn").click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    }
});

test("Search inspection from the saved library keeps the existing explicit Continue to report action", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.locator('nav [data-nav="reports"]').click();
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await page.locator("#wireSearch").fill("question0");
    const hit = page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-kind", { hasText: /^Interaction$/ }) }).first();
    await hit.press("Enter");
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Interaction");
    await expect(page.locator("#requestReportContinue")).toHaveText("Continue to report");
    await expect(page.locator("#requestReportContinue")).toBeDisabled();
    await page.locator("#requestReportToggle").click();
    await page.locator("#requestReportContinue").click();
    await expect(page.locator("#reportStage1")).toBeVisible();
    await expect(page.locator("#reportList input").first()).toBeChecked();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
});

test("Back from report setup restores the original Analyze card anchor before closing the returned reader", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#resultsLink").click();
    const card = page.locator(".request-card-open").first();
    await card.scrollIntoViewIfNeeded();
    const entry = await card.boundingBox();
    await page.mouse.click(entry.x + entry.width / 2, entry.y + entry.height / 2);
    await page.locator("#requestReportToggle").click();
    await page.locator("#requestReportContinue").click();
    await expect(page.locator("#reportStage1")).toBeVisible();
    await reportContents(page);
    await page.goBack();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Interaction");
    await expect(page.locator("#requestReportContinue")).toBeFocused();
    await page.locator("#closeContextSidebar").click();
    await expect(card).toBeFocused();
    const restored = await card.boundingBox();
    assert.ok(Math.abs(restored.y - entry.y) < 3, JSON.stringify({ before: entry.y, after: restored.y }));
});

test("responsive adaptation preserves the main card anchor through narrow doubled text and back", { timeout: 20000 }, async t => {
    const { page } = await setup(t, { width: 1200 });
    await page.locator("#resultsLink").click();
    const card = page.locator(".request-card-open").first();
    await card.scrollIntoViewIfNeeded();
    const entry = await card.boundingBox();
    await page.mouse.click(entry.x + entry.width / 2, entry.y + entry.height / 2);
    for (const [width, scale] of [[375, 2], [1200, 1]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 16}px`, scale);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const returned = await card.boundingBox();
    assert.ok(Math.abs(returned.y - entry.y) < 3, JSON.stringify({ before: entry.y, after: returned.y }));
    await page.locator("#closeContextSidebar").click();
    const closed = await card.boundingBox();
    assert.ok(Math.abs(closed.y - entry.y) < 3, JSON.stringify({ before: entry.y, after: closed.y }));
});

test("the report picker gives the actual prompt a bounded surface with aligned selection and concise qualified facts", { timeout: 20000 }, async t => {
    const { page, requests } = await setup(t);
    await page.locator("#pageAction").click();
    const row = page.locator("#reportList .report-entry").first();
    const paint = await row.evaluate(node => {
        const prompt = node.querySelector(".full-text-preview"), author = node.querySelector(".full-text-preview-label");
        const style = getComputedStyle(prompt);
        return { edge: parseFloat(style.borderInlineStartWidth), background: style.backgroundColor,
            weight: style.fontWeight, fontStyle: style.fontStyle, authorEdge: getComputedStyle(author).borderInlineStartWidth };
    });
    assert.equal(paint.edge, 2, "The restrained leading edge belongs to the prompt itself");
    assert.notEqual(paint.background, "rgba(0, 0, 0, 0)");
    assert.equal(paint.authorEdge, "0px", "The author label is not the prompt surface");
    assert.equal(paint.weight, "400");
    assert.equal(paint.fontStyle, "normal");
    await expect(row.locator(".report-entry-meta")).toContainText("Copilot Chat:");
    await expect(row.locator(".interaction-summary")).toContainText("Work IQ calls:");
    await expect(row.locator(".interaction-summary")).toContainText("1 Worked");
    await expect(row.locator(".report-entry-meta")).toContainText("Recorded:");
    await expect(row.locator(".report-entry-meta")).not.toContainText(/Model|Final response|Not recorded/);
    await expect(page.locator("#reportRequestSearch")).toHaveAttribute("placeholder", "Copilot Chat or prompt");
    await expect(page.getByRole("combobox", { name: "Authors in report", exact: true })).toBeVisible();
    await expect(page.locator("#reportRequestsTitle")).toHaveClass(/visually-hidden/);
    await expect(page.locator("#reportScopeGap")).toHaveText("Choose an interaction or another scope to continue.");
    const alignment = await row.evaluate(node => {
        const checkbox = node.querySelector(".report-selection-toggle").getBoundingClientRect();
        const heading = node.querySelector(".report-prompt-heading").getBoundingClientRect();
        return { checkbox: checkbox.y, heading: heading.y, checkboxWidth: checkbox.width, checkboxHeight: checkbox.height };
    });
    assert.ok(Math.abs(alignment.checkbox - alignment.heading) <= 1);
    assert.ok(alignment.checkboxWidth >= 44 && alignment.checkboxHeight >= 44);
    await row.locator("input").check();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await row.locator(".request-link").click();
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Interaction");
    await expect(page.locator("#previewSelectionSummary")).toHaveText("1 chat · 1 interaction");
    assert.equal(requests.filter(request => /\/api\/(?:preview|privacy-review|export)$/.test(request.url.pathname)).length, 0);
});

test("picker full, long agent, partial unverified and unavailable prompts preserve access and reflow in both themes", { timeout: 30000 }, async t => {
    const cases = ["full", "agent-long", "partial", "missing"].map((name, index) => {
        const record = fixture("picker-" + name);
        record.sourceSessionName = "Invented picker chat";
        record.followUpPrompts = [];
        record.userPrompt = { text: "Find the invented calendar decision and its owner.", status: "full",
            sourceEventId: "picker-prompt-" + index, sourceTimestamp: "2026-09-30T12:00:00Z",
            authorship: { actor: "user", basis: "source-user" } };
        return record;
    });
    cases[1].userPrompt.text = "  Invented delegated planning request.\nKeep these exact spaces.  \n" + "Compare the fictional launch plans without collecting new history. ".repeat(14);
    cases[0].toolCalls.push({ ...fixture("picker-extra").toolCalls[0], toolSucceeded: false, reportedOutcome: "failed" });
    cases[1].userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    cases[1].toolCalls[0].toolSucceeded = false;
    cases[1].toolCalls[0].reportedOutcome = "failed";
    cases[2].userPrompt = { ...cases[2].userPrompt, text: "This retained fragment ends before the final question. ".repeat(5),
        status: "partial", sourceTimestamp: null, authorship: { actor: "unknown", basis: "missing-source" } };
    cases[2].toolCalls[0].startedAt = "2026-09-30T12:09:00Z";
    cases[3].userPrompt = { ...cases[3].userPrompt, text: null, status: "unavailable", sourceTimestamp: null };
    cases[3].toolCalls[0].toolSucceeded = undefined;
    cases[3].toolCalls[0].reportedOutcome = "unknown";
    const { page, requests } = await setup(t, { recordCases: cases });
    await selectActivityOption(page, "outcomeFilter", "failure");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#pageAction").click();
    const row = name => page.locator(`[data-view-key="report:picker-${name}"]`);
    await expect(page.locator("#reportList .full-text-preview-state")).toHaveCount(0);
    await expect(row("full").locator(".interaction-summary")).toContainText("1 Worked");
    await expect(row("full").locator(".interaction-summary")).toContainText("1 Tool failed");
    await expect(row("agent-long").locator(".full-text-provenance")).toHaveText("Agent prompt");
    await expect(row("agent-long").locator(".interaction-summary")).toContainText("1 Tool failed");
    await expect(row("partial").locator(".full-text-provenance")).toHaveText("Author unverified");
    await expect(row("partial").locator(".full-text-availability")).toContainText("Only part of the original was recorded");
    await expect(row("partial").locator(".report-entry-meta")).toContainText("First timed action:");
    await expect(row("missing").locator(".full-text-preview")).toHaveText("Prompt not available");
    await expect(row("missing").locator(".interaction-summary")).toContainText("1 No result recorded");
    await expect(row("missing").locator(".report-entry-meta")).not.toContainText(/Recorded:|Request time|Model|Final response|Not recorded/);
    await expect(row("missing").locator(".full-text-toggle")).toHaveCount(0);
    await row("agent-long").getByRole("button", { name: "Read full prompt", exact: true }).click();
    await expect(row("agent-long").locator(".full-text-body pre")).toHaveText(cases[1].userPrompt.text, { useInnerText: false });
    const beforeCopy = await row("agent-long").boundingBox();
    await row("agent-long").getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.reportCopies), [cases[1].userPrompt.text]);
    assert.equal((await row("agent-long").boundingBox()).height, beforeCopy.height, "Copy feedback adds no row");
    await row("agent-long").getByRole("button", { name: "Hide prompt", exact: true }).click();
    await row("partial").getByRole("button", { name: "Read retained prompt", exact: true }).click();
    assert.equal(await row("partial").locator(".full-text-body pre").textContent(), cases[2].userPrompt.text);
    await row("partial").getByRole("button", { name: "Hide prompt", exact: true }).click();
    await row("full").locator("input").check();
    await row("agent-long").locator("input").check();
    await selectActivityOption(page, "reportPromptAuthorFilter", ["user"]);
    await expect(row("agent-long")).toContainText("Not included with the current prompt-author choice.");
    await expect(row("agent-long").locator("input")).toBeChecked();
    await expect(page.locator("#previewSelectionSummary")).toHaveText("1 chat · 1 interaction");
    await expect(page.locator("#reportList .full-text-preview-state")).toHaveCount(0);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 16}px`, scale);
        for (const name of ["full", "agent-long", "partial", "missing"]) {
            const item = row(name);
            await item.evaluate(node => node.scrollIntoView({ block: "start" }));
            const geometry = await item.evaluate(node => {
                const prompt = node.querySelector(".full-text-preview"), style = getComputedStyle(prompt);
                const author = node.querySelector(".full-text-preview-label"), key = node.querySelector("dt"), value = node.querySelector("dd");
                return { viewport: innerWidth, document: document.documentElement.scrollWidth, overflow: node.scrollWidth > node.clientWidth + 1,
                    rowWidth: node.getBoundingClientRect().width, promptWidth: prompt.getBoundingClientRect().width,
                    readerHeight: node.querySelector(".full-text").getBoundingClientRect().height,
                    edge: parseFloat(style.borderInlineStartWidth), background: style.backgroundColor, color: style.color,
                    authorColor: getComputedStyle(author).color, edgeColor: style.borderInlineStartColor,
                    headingHeight: node.querySelector(".report-prompt-heading").getBoundingClientRect().height,
                    authorLine: parseFloat(getComputedStyle(author).lineHeight),
                    font: style.fontFamily, authorFont: getComputedStyle(author).fontFamily, weight: style.fontWeight, fontStyle: style.fontStyle,
                    key: [getComputedStyle(key).fontFamily, getComputedStyle(key).fontSize, getComputedStyle(key).fontWeight],
                    value: [getComputedStyle(value).fontFamily, getComputedStyle(value).fontSize, getComputedStyle(value).fontWeight],
                    controls: [...node.querySelectorAll(".report-selection-toggle,.request-link,.full-text-toggle")].map(control => {
                        const box = control.getBoundingClientRect(); return { width: box.width, height: box.height };
                    }) };
            });
            assert.ok(geometry.document <= width + 1 && !geometry.overflow, JSON.stringify({ name, theme, width, geometry }));
            assert.ok(geometry.readerHeight > 0, "The existing retained-text reader keeps a measurable reading anchor");
            if (width === 375) assert.ok(Math.abs(geometry.promptWidth - geometry.rowWidth) <= 1, "Enlarged prompts use the row width, not a checkbox gutter");
            assert.equal(geometry.edge, 2);
            if (width === 1440) assert.ok(geometry.headingHeight <= geometry.authorLine + 1, "Utility targets must not inflate the author line");
            if (name === "full" || name === "agent-long") assert.equal(geometry.authorColor, geometry.edgeColor, "Author label and prompt edge share their real author cue");
            assert.equal(geometry.weight, "400");
            assert.equal(geometry.fontStyle, "normal");
            assert.equal(geometry.font, geometry.authorFont);
            assert.deepEqual(geometry.key, geometry.value);
            assert.ok(contrast(geometry.color, geometry.background) >= 4.5);
            assert.ok(geometry.controls.every(control => control.width >= 44 && control.height >= 44));
            if (width === 375 || name === "full") await capture(page, `picker-${theme}-${width}-${scale}-${name}`);
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "16px");
    await row("partial").locator(".request-link").click();
    await expect(page.locator("#requestContent")).toContainText("Who sent this was not recorded");
    await page.getByRole("button", { name: "Back to activity", exact: true }).click();
    await row("missing").locator(".request-link").click();
    await expect(page.locator("#requestContent")).toContainText("Prompt not available");
    await page.getByRole("button", { name: "Back to activity", exact: true }).click();
    await expect(page.locator("#previewSelectionSummary")).toHaveText("1 chat · 1 interaction");
    assert.equal(requests.filter(request => /\/api\/(?:preview|privacy-review|export)$/.test(request.url.pathname)).length, 0);
});
