import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { retirementFixture } from "./ai-review-retirement-fixture.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { assessmentHash } from "../lib/assessment-read-model.mjs";
import { navigateMain, navigateSettings, selectActivityOption, chooseTheme } from "./helpers.mjs";
import { scanReport } from "./report-journey-helpers.mjs";

const retiredCopy = /\bAI (?:reviews?|results?|checks?|judgments?)\b|model assessment|assessment coverage|automatic scor|saved reviews?|no saved review|calls and reviews|new assessment|not scored|pass[- ]share colors|quality grade|check errors|\bnot assessed\b|\b\d+ (?:\/ \d+ )?assessed\b|\b(?:personal|your) feedback\b|(?:save|withdraw) feedback/i;

test("every current interface excludes retired reviews, including menus, dialogs and report frames", { timeout: 120000 }, async t => {
    const cleanup = [], f = await retirementFixture({ after: action => cleanup.push(action) });
    const reports = createExportController(f.context), forbidden = [], errors = [], evaluationRequests = [];
    const deny = () => { forbidden.push("provider"); throw new Error("No evaluator or private source read may start."); };
    const runtime = await startServer(f.context, reports, { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: deny, readSource: deny, discover: deny } });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC",
    });
    page.setDefaultTimeout(7000);
    const evidence = [], proofDir = process.env.WIRE_AI_REMOVAL_PROOFS;
    t.after(async () => {
        try {
            if (proofDir) {
                await mkdir(proofDir, { recursive: true });
                await writeFile(path.join(proofDir, "all-interface-coverage.json"), JSON.stringify({
                    inventedOnly: true, evidence, errors, forbidden, evaluationRequests,
                }, null, 2));
            }
            await browser.close(); await runtime.close();
        } finally { for (const action of cleanup.reverse()) await action(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(runtime.url).origin) {
            forbidden.push("external:" + url.origin); return route.abort();
        }
        if (url.pathname.startsWith("/api/evaluation/") || url.pathname === "/api/assessment/feedback") evaluationRequests.push(url.pathname);
        return route.continue();
    });
    async function save(owner) {
        const state = await loadBoardState(f.context);
        const preview = await reports.preview(owner, undefined, { promptMode: "none", formats: ["html", "json"] },
            { kind: "all", revision: state.revision });
        await reports.review(owner, preview.previewId, true);
        return (await reports.confirm(owner, preview.previewId, true)).bundle;
    }
    const earlier = await save("fixture-owner");
    const later = await save("fixture-owner");
    const prepared = await reports.previewComparison("fixture-owner", earlier.bundleId, later.bundleId, { formats: ["html", "json"] });
    await reports.reviewComparison("fixture-owner", prepared.previewId, true);
    const comparison = (await reports.confirmComparison("fixture-owner", prepared.previewId, true)).bundle;
    const frozenFiles = [earlier, later, comparison].flatMap(bundle => Object.values(bundle.files));
    const originalHashes = await Promise.all(frozenFiles.map(async file => assessmentHash(await readFile(file))));
    const ledger = JSON.stringify((await loadBoardState(f.context)).personalEvaluation.modelEvaluation);
    const historicalFeedback = JSON.stringify((await loadBoardState(f.context)).personalEvaluation.feedback);

    async function capture(name, root = page.locator("main"), screenshot = false) {
        const text = await root.innerText();
        assert.doesNotMatch(text, retiredCopy, name);
        const controls = await root.locator("button,a,summary,select").evaluateAll(nodes => nodes.filter(node => node.checkVisibility())
            .map(node => ({ role: node.getAttribute("role") ?? node.tagName.toLowerCase(),
                label: node.getAttribute("aria-label") ?? node.textContent.trim() })));
        assert.doesNotMatch(JSON.stringify(controls), retiredCopy, name + " accessible controls");
        evidence.push({ name, url: page.url(), text, controls });
        if (proofDir && screenshot) {
            await mkdir(proofDir, { recursive: true });
            await page.screenshot({ path: path.join(proofDir, "surface-" + name + ".png") });
        }
    }
    async function expand(root, frozen = false) {
        if (frozen) {
            await root.locator("details").evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
            return;
        }
        for (const details of await root.locator("details").all()) {
            if (await details.isVisible() && !await details.evaluate(node => node.open)) await details.locator(":scope > summary").click();
        }
    }
    async function ready() { await expect(page.locator('#workspace[aria-busy="false"]')).toBeVisible(); }

    await page.goto(runtime.url); await ready();
    for (const label of ["Over time", "By category", "By path or operation"]) {
        await page.locator("#openAnalyzeFilters").click();
        await page.getByRole("button", { name: label, exact: true }).click();
        await page.locator("#closeAnalyzeFilters").click();
        await capture("dashboard-" + label.toLowerCase().replaceAll(" ", "-"));
    }
    await expect(page.locator("#analyzeReviewDetails,#homeInsights,#homeFindings")).toHaveCount(0);
    await capture("dashboard-no-reviews", page.locator("main"), true);
    await page.locator("#openChartReference").click();
    await capture("chart-data-and-definitions", page.locator("#meaning"));
    await page.locator("#closeChartReference").click();
    await page.locator("#openAnalyzeFilters").click();
    const filterIds = await page.locator('#analyzeFilterDialog [data-select-id]').evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => node.dataset.selectId));
    assert.ok(filterIds.length > 0);
    for (const id of filterIds) {
        await page.locator(`[data-select-id="${id}"]`).click();
        await capture("filter-" + id, page.locator(".select-popup"));
        await page.keyboard.press("Escape");
    }
    await page.locator("#closeAnalyzeFilters").click();
    await expect(page.locator("[data-analyze-mode],#callSort")).toHaveCount(0);
    await capture("activity");
    await page.locator(".request-card-open").first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await expect(page.locator("#contextSidebar .reader-call-duration").first()).toBeVisible();
    await expect(page.locator("#contextSidebar .reader-call-duration").first()).toContainText("Tool latency:");
    await expect(page.locator("#contextSidebar .reader-local-timing")).toHaveCount(0);
    await capture("interaction-reader", page.locator("#contextSidebar"), true);
    await expect(page.locator('[data-reader-section="reviews"],[data-feedback-dimension],.assessment-feedback-dialog')).toHaveCount(0);
    await page.locator("#closeContextSidebar").click();

    await navigateMain(page, "settings");
    for (const category of ["connection", "privacy", "display", "troubleshooting"]) {
        await navigateSettings(page, category);
        const root = page.locator(`[data-settings-section="${category}"]`);
        await expand(root); await capture("settings-" + category, root, category === "privacy");
    }
    await navigateSettings(page, "connection");
    await page.locator("#editSource").click();
    await capture("source-permission-review", page.locator("#sourceEditor"));
    await page.locator("#cancelSource").click();
    await navigateSettings(page, "privacy");
    await page.getByRole("switch", { name: "Save Copilot replies locally", exact: true }).check();
    await capture("response-saving-disclosure", page.locator("#assessmentSetup"));
    await page.getByRole("button", { name: "Discard change", exact: true }).click();
    await page.locator("#deleteActivity").click();
    await page.locator("#deleteAll").check(); await page.locator("#deletePreview").click();
    await expect(page.locator("#deleteConfirmation")).toBeVisible();
    await expand(page.locator("#deleteDialog")); await capture("activity-deletion-preview", page.locator("#deleteDialog"));
    await page.locator("#deleteCancel").click();
    await page.locator("#recollectActivity").click();
    await expect(page.locator("#recollectSources input").first()).toBeVisible();
    await capture("recollection-scope", page.locator("#recollectDialog"));
    await page.locator("#recollectClose").click();
    await navigateSettings(page, "troubleshooting");
    await page.getByRole("link", { name: "Open collection status", exact: true }).click();
    await expand(page.locator("#collectionStatusView"));
    await capture("collection-status", page.locator("#collectionStatusView"));
    await page.locator("#wireSearch").fill("AI reviews"); await page.locator("#wireSearch").click();
    for (const type of ["view", "setting"]) {
        await selectActivityOption(page, "wireSearchType", type);
        for (const query of ["AI reviews", "Automatic scores", "Personal feedback"]) {
            await page.locator("#wireSearch").fill(query); await page.locator("#wireSearch").click();
            await expect(page.locator("#wireSearchStatus")).toContainText("No matches");
            await capture("search-" + type + "-" + query.toLowerCase().replaceAll(" ", "-"), page.locator("#wireSearchPanel"));
        }
    }
    await selectActivityOption(page, "wireSearchType", "view");
    await page.locator("#wireSearch").fill("Failed calls");
    await expect(page.locator("#wireSearchResults")).toContainText("Failed calls");
    await page.locator("#wireSearchResults").getByText("Failed calls", { exact: true }).click();
    await expect(page).toHaveURL(/result=failure/);
    await ready();
    assert.doesNotMatch(page.url(), /mode=calls|callSort=/); assert.match(page.url(), /result=failure/);
    await capture("failed-call-navigation");

    await navigateMain(page, "reports");
    await capture("report-library", page.locator("#savedReportsPanel"));
    await page.getByRole("button", { name: "Open saved report", exact: true }).first().click();
    let body = page.frameLocator("iframe:visible").first().locator("body");
    await expect(body.getByRole("heading", { name: earlier.title, level: 1, exact: true })).toBeVisible();
    await expand(body, true); await capture("saved-current-report", body);
    await navigateMain(page, "reports");
    await page.getByRole("button", { name: "Open saved comparison", exact: true }).click();
    body = page.frameLocator("iframe:visible").first().locator("body");
    await expect(body.getByRole("heading", { name: comparison.title, level: 1, exact: true })).toBeVisible();
    await expand(body, true); await capture("saved-current-comparison", body);
    await navigateMain(page, "reports"); await page.locator("#reportCreateLink").click();
    await capture("report-activity", page.locator("#reportsView"));
    await page.locator('[data-select-id="reportPromptAuthorFilter"]').click();
    await capture("report-author-filter", page.locator(".select-popup")); await page.keyboard.press("Escape");
    await page.locator('[name=reportScope][value=all]').check();
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    await expand(page.locator("#reportStage2")); await capture("report-contents", page.locator("#reportStage2"));
    const preview = await scanReport(page);
    body = page.frameLocator("iframe:visible").first().locator("body");
    await expect(body.getByRole("heading", { name: preview.title, level: 1, exact: true })).toBeVisible();
    await expand(body, true); await capture("new-report-preview", body, true);
    for (const label of [/^Text \(/, /^Files \(/]) {
        await page.getByRole("tab", { name: label }).click();
        await capture(label.source.startsWith("^Text") ? "report-text-review" : "report-files", page.locator("#reportReviewBody"));
    }
    await page.getByRole("tab", { name: "Report", exact: true }).click();
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();

    await navigateMain(page, "analyze");
    await page.locator("#openAnalyzeFilters").click();
    const reset = page.getByRole("button", { name: "Reset filters", exact: true });
    await expect(reset).toBeEnabled();
    await reset.click();
    await page.locator("#closeAnalyzeFilters").click();
    await ready(); await page.locator("#comparePeriods").click();
    const day = new Date().toISOString().slice(0, 10);
    for (const id of ["comparisonAFrom", "comparisonATo", "comparisonBFrom", "comparisonBTo"]) await page.locator("#" + id).fill(day);
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonResultsTitle")).toBeVisible();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await expand(page.locator("#periodComparison"));
    await capture("period-comparison", page.locator("#periodComparison"), true);
    assert.equal(await page.getByRole("button", { name: "Measure definitions", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Create comparison report", exact: true }).click();
    await capture("period-report-activity", page.locator("#reportsView"));

    await navigateMain(page, "settings"); await navigateSettings(page, "display"); await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 375, height: 850 });
    for (const category of ["connection", "privacy", "display", "troubleshooting"]) {
        await navigateSettings(page, category); await capture("narrow-dark-" + category, page.locator("#settingsView"), category === "privacy");
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(forbidden, []);
    assert.deepEqual(evaluationRequests, []);
    assert.equal(JSON.stringify((await loadBoardState(f.context)).personalEvaluation.modelEvaluation), ledger);
    assert.equal(JSON.stringify((await loadBoardState(f.context)).personalEvaluation.feedback), historicalFeedback);
    assert.deepEqual(await Promise.all(frozenFiles.map(async file => assessmentHash(await readFile(file)))), originalHashes);
});
