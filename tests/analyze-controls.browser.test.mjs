import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters, restoreLegacySearch, chooseTheme, navigateMain, navigateSettings, revealAnalyzeRecords } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

async function setup(t, { initialize, longNames = false } = {}) {
    const app = await authorFilterFixture(t, { serviceCases: true, longNames }), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [], denied = [], snapshots = [];
    let snapshot;
    if (initialize) await page.addInitScript(initialize);
    page.on("pageerror", error => errors.push(error.message));
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list", "/api/period-comparison"];
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (url.pathname === "/api/snapshot") snapshots.push(request.postDataJSON());
        return route.continue();
    });
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    app.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []); });
    await page.goto(app.runtime.url); await ready(page);
    return { ...app, page, snapshots, snapshot: () => snapshot };
}

for (const width of [1440, 390]) test(`Settings sidebar shortcuts keep their original owners and unsaved preferences at ${width}px`, { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
    await closeAnalyzeFilters(page);
    const analyzeUrl = page.url();
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "connection");
    await selectActivityOption(page, "collectionWindow", "7");
    await expect(page.locator("#saveCollection")).toBeEnabled();
    const preference = await page.locator("#collectionWindow").elementHandle();
    const controls = await page.evaluateHandle(() => ["comparePeriods"].map(id => document.getElementById(id)));
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, width < 700 ? 200 : 100);
    await chooseTheme(page, width < 700 ? "dark" : "light");
    if (width >= 700) {
        await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.getElementById("sidebar").hasAttribute("data-navigation-moving"));
    }
    async function shortcut(id, name) {
        const drawer = page.locator("#navigationDrawer");
        if (width < 700 && !await drawer.isVisible()) await page.locator("#navigationToggle").click();
        await expect(page.locator("#analyzeTools")).toBeVisible();
        await expect(page.locator("#pageAction")).toBeHidden();
        await expect(page.locator("#openAnalyzeFilters")).toBeHidden();
        await expect(page.locator('#navigationFooter [data-nav="settings"]')).toHaveAttribute("aria-current", "page");
        const control = page.locator("#analyzeTools #" + id);
        await expect(control).toHaveAccessibleName(name);
        await control.focus();
        if (process.env.WIRE_SIDEBAR_PROOFS) {
            await mkdir(process.env.WIRE_SIDEBAR_PROOFS, { recursive: true });
            await page.waitForFunction(() => !document.getElementById("navigationDrawer").getAnimations().length);
            await page.screenshot({ path: path.join(process.env.WIRE_SIDEBAR_PROOFS, `settings-shortcut-${width}-${id}.png`) });
        }
        await control.press("Enter"); await ready(page);
        if (width < 700) await expect(drawer).toBeHidden();
        assert.equal(await controls.evaluate(nodes => nodes.every(node => node === document.getElementById(node.id))), true);
        assert.equal(await preference.evaluate(node => node === document.getElementById("collectionWindow") && node.value === "7"), true);
    }
    await navigateMain(page, "analyze"); await ready(page);
    assert.equal(page.url(), analyzeUrl, "Analyze returns to the retained filter scope");
    await expect(page.locator("#resultsLink")).toHaveCount(0);
    await expect(page.locator("#settingsDraftNotice")).toBeVisible();
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "display");
    await shortcut("comparePeriods", "Compare");
    await expect(page.locator("#periodComparisonSetup")).toBeVisible();
    await expect(page.locator("#comparisonAPreset-control")).toBeFocused();
    await expect(page.locator("#comparePeriods")).toHaveAttribute("aria-expanded", "true");
    await navigateMain(page, "settings"); await ready(page);
    await navigateMain(page, "analyze"); await ready(page);
    await expect(page.locator("#periodComparisonSetup")).toBeHidden();
    assert.equal(new URL(page.url()).hash.includes("compare=periods"), false);
    await navigateMain(page, "settings"); await ready(page);
    await navigateMain(page, "reports"); await ready(page);
    await expect(page.locator("#reportsView")).toBeVisible();
    await expect(page.locator("#pageTitle")).toHaveText("Reports");
    await expect(page.locator("#reportGallery")).toBeVisible();
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).has("task"), false);
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "connection");
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await controls.dispose();
});

test("Filters and view discloses the same controls without querying, resetting or reserving a rail", { timeout: 30000 }, async t => {
    const { page, snapshots } = await setup(t);
    await expect(page.locator("#openAnalyzeFilters")).toBeVisible();
    await expect(page.locator("#filters")).not.toBeVisible();
    await expect(page.locator("#analyzeScopeCaption")).toBeEmpty();
    await expect(page.locator("#analyzeScopeSummary")).not.toBeVisible();
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(/All dates; Saved collection/);
    await expect(page.locator("#outcomeChart .percentage-total-value")).toHaveText("15");
    await page.evaluate(() => {
        window.originalAnalyzeFields = [...document.querySelectorAll("#filters select")];
    });
    const reads = snapshots.length;
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
    await expect(page.locator("#dateFilter-control")).toBeVisible();
    assert.equal(await page.locator("#filters select").count(), 11);
    await expect(page.locator("#filters #sourceFilter")).toHaveCount(1);
    assert.equal(await page.locator("#analyzeViewControls [data-chart]").count(), 3);
    await page.locator("#closeAnalyzeFilters").click();
    await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
    assert.equal(snapshots.length, reads, "Disclosure cannot load or collect activity");
    assert.equal(await page.evaluate(() => window.originalAnalyzeFields.every(node => node === document.getElementById(node.id))), true);
    assert.equal(await page.locator("#filters").count(), 1);
    assert.ok(await page.locator("#outcomeChart .percentage-legend a[href]").count(), "Native outcome drilldowns remain");
    assert.ok(await page.locator("#chart .time-column[href]").count(), "Native plotted time drilldowns remain");
    for (const id of ["comparePeriods"]) {
        assert.equal(await page.locator("#" + id).evaluate(node => Boolean(node.closest(".primary-navigation"))), true);
    }
});

test("Reset filters is visibly named beside the applied chips and keeps its actual browsing reset", { timeout: 30000 }, async t => {
    const { page, snapshots, projectId } = await setup(t, { longNames: true });
    const output = process.env.WIRE_FILTER_LAYOUT_PROOFS, measurements = [];
    if (output) await mkdir(output, { recursive: true });
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    for (const theme of ["dark", "light"]) for (const width of [1440, 768, 390]) {
        await closeAnalyzeFilters(page);
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await openAnalyzeFilters(page);
        await page.waitForFunction(() => !document.querySelector("#analyzeFilterDialog").getAnimations().length);
        await page.locator("#resetView").scrollIntoViewIfNeeded();
        const value = await page.locator("#appliedFilters").evaluate(node => {
            const box = element => {
                const { x, y, right, bottom, width, height } = element.getBoundingClientRect();
                return { x, y, right, bottom, width, height };
            };
            return { chip: box(node.querySelector(".filter-chip")), reset: box(node.querySelector("#resetView")),
                label: node.querySelector("#resetView").innerText,
                view: box(document.querySelector("#analyzeViewControls")),
                overflow: document.documentElement.scrollWidth - innerWidth };
        });
        measurements.push({ theme, width, ...value });
        if (output) await page.locator("#analyzeFilterDialog").screenshot({ path: path.join(output, `${theme}-${width}.png`) });
        assert.equal(value.label, "Reset filters", "Reset's meaning must be visible, not tooltip-only");
        const beside = Math.abs(value.reset.y - value.chip.y) < 1
            && value.reset.x - value.chip.right >= 0 && value.reset.x - value.chip.right <= 16;
        const below = Math.abs(value.reset.x - value.chip.x) < 1
            && value.reset.y >= value.chip.bottom && value.reset.y - value.chip.bottom <= 8;
        assert.ok(beside || below, "Reset follows the applied chips, wrapping to their leading edge rather than floating at the far edge");
        assert.ok(value.view.y >= value.reset.bottom, "Presentation-only View controls remain a separate group");
        assert.ok(value.reset.height >= 44 && value.reset.right <= width && value.overflow <= 1);
    }
    await selectActivityOption(page, "projectFilter", projectId); await ready(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.locator("#resetView").scrollIntoViewIfNeeded();
    assert.ok(await page.locator("#appliedFilters").evaluate(node => {
        const reset = node.querySelector("#resetView"), chips = node.querySelector("#filterChips");
        return reset.getBoundingClientRect().y >= chips.getBoundingClientRect().bottom
            && reset.scrollWidth <= reset.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
    }), "Long chips and enlarged text keep the real reset readable below the group");
    await page.locator("#resetView").hover();
    const hover = await page.locator("#resetView").evaluate(node => getComputedStyle(node, "::before").backgroundColor);
    await page.locator("#resetView").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#resetView")).toBeFocused();
    assert.equal(await page.locator("#resetView").evaluate(node => node.matches(":focus-visible")
        && (getComputedStyle(node).outlineStyle !== "none" || getComputedStyle(node, "::before").outlineStyle !== "none")), true);
    assert.notEqual(hover, "rgba(0, 0, 0, 0)", "Reset keeps the existing quiet-action hover feedback");
    if (output) {
        await page.screenshot({ path: path.join(output, "long-chips-narrow-200-focus.png") });
        await writeFile(path.join(output, "filter-geometry.json"), JSON.stringify(measurements, null, 2));
    }
    await page.keyboard.press("Enter"); await ready(page);
    assert.deepEqual(snapshots.at(-1).filters, { scope: "history", includeMetadata: false });
    await expect(page.locator("#filterChips")).toBeEmpty();
    await closeAnalyzeFilters(page);
    await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
});

test("closed-panel captions keep accepted membership through pending and failed reads", { timeout: 30000 }, async t => {
    const { page, otherProjectId } = await setup(t);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
    }, { times: 1 });
    await selectActivityOption(page, "serviceAssociationFilter", "Files");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await closeAnalyzeFilters(page);
    await expect(page.locator("#activityCount")).toHaveText("15");
    await expect(page.locator("#analyzeScopeCaption")).not.toContainText("Files");
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(/Current collection/);
    await expect(page.locator("#openAnalyzeFilters")).not.toHaveAccessibleDescription(/Service: Files/);
    await expect(page.locator("#analyzeScopeStatus")).not.toBeVisible();
    await expect(page.locator("#analyzeScopeSummary")).not.toBeVisible();
    await expect(page.locator("#analyzeScopeError")).not.toBeVisible();
    release(); await ready(page);
    await expect(page.locator("#outcomeChart .percentage-total-value")).toHaveText("7");
    await expect(page.locator("#analyzeScopeCaption")).toContainText("Service: Files");
    await expect(page.locator("#analyzeScopeCaption")).toContainText("4 known matches; 3 context-only");
    await expect(page.locator("#openAnalyzeFilters")).toBeFocused();

    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented read failure." } }), { times: 1 });
    await selectActivityOption(page, "projectFilter", otherProjectId); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#analyzeScopeCaption")).toContainText("Service: Files");
    await expect(page.locator("#analyzeScopeCaption")).not.toContainText("Invented project B");
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(/Service: Files/);
    await expect(page.locator("#openAnalyzeFilters")).not.toHaveAccessibleDescription(/Invented project B/);
    await expect(page.locator("#analyzeScopeError")).toBeVisible();
    await expect(page.locator("#analyzeScopeError")).toContainText("Previous results");
    await expect(page.locator("#outcomeChart .percentage-total-value")).toHaveText("7");
    await expect(page.locator("#analyzeScopeSummary")).toBeVisible();
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(/Previous results/);
    if (process.env.WIRE_PENDING_CAPTION_PROOFS) {
        await mkdir(process.env.WIRE_PENDING_CAPTION_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_PENDING_CAPTION_PROOFS, "failed-read.png"), fullPage: true });
    }
    const colors = await page.locator("#analyzeScopeError").evaluate(node => {
        const reference = document.createElement("span");
        reference.className = "status failure"; document.body.append(reference);
        const values = { actual: getComputedStyle(node).color, expected: getComputedStyle(reference).color,
            icon: getComputedStyle(node.querySelector(".wire-icon")).color };
        reference.remove(); return values;
    });
    assert.equal(colors.actual, colors.expected, "Read failure keeps the existing error role");
    assert.equal(colors.icon, colors.expected, "The failure icon keeps the same severity");
    await openAnalyzeFilters(page);
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("15");
});

test("routine pending reads do not add text, a divider or height to Recorded outcomes", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const proof = process.env.WIRE_PENDING_CAPTION_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    const geometry = () => page.locator(".analyze-outcome-summary").evaluate(node => ({
        height: node.getBoundingClientRect().height,
        footerVisible: document.getElementById("analyzeScopeSummary").checkVisibility(),
        total: node.querySelector(".percentage-total-value").textContent,
        caption: document.getElementById("analyzeScopeCaption").textContent,
        revision: document.getElementById("analyzeScopeSummary").dataset.revision,
    }));
    for (const theme of ["dark", "light"]) {
        await chooseTheme(page, theme);
        await page.evaluate(() => document.fonts.ready);
        const before = await geometry();
        if (proof) await page.screenshot({ path: path.join(proof, `${theme}-settled-before.png`), fullPage: true });
        let release;
        const held = new Promise(resolve => { release = resolve; });
        t.after(() => release());
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch();
            await held;
            await route.fulfill({ response });
        }, { times: 1 });
        try {
            await selectActivityOption(page, "serviceAssociationFilter", "Files");
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
            await closeAnalyzeFilters(page);
            const pending = await geometry();
            if (proof) {
                await page.screenshot({ path: path.join(proof, `${theme}-held.png`), fullPage: true });
                await writeFile(path.join(proof, `${theme}-geometry.json`), JSON.stringify({ before, pending }, null, 2));
            }
            assert.deepEqual(pending, before, "A held read must retain the accepted widget without a transient footer");
            await expect(page.locator("#analyzeScopeStatus")).not.toBeVisible();
            await expect(page.locator("#outcomeChart")).not.toContainText("Updating view");
            await expect(page.locator("#openAnalyzeFilters")).not.toHaveAccessibleDescription(/Service: Files/);
        } finally { release(); }
        await ready(page);
        await expect(page.locator("#outcomeChart .percentage-total-value")).toHaveText("7");
        await expect(page.locator("#analyzeScopeCaption")).toContainText("Service: Files");
        await expect(page.locator("#analyzeScopeStatus")).not.toBeVisible();
        if (proof) await page.screenshot({ path: path.join(proof, `${theme}-settled-filter.png`), fullPage: true });
        await openAnalyzeFilters(page);
        await page.locator("#resetView").click(); await ready(page);
        await closeAnalyzeFilters(page);
        assert.deepEqual(await geometry(), before, "Reset to the accepted baseline leaves no phantom footer");
    }
});

test("rapid filter reads keep the accepted wheel stable and ignore an older completion", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const held = [];
    await page.route("**/api/snapshot", async route => {
        if (held.length >= 2) return route.continue();
        let release, finish;
        const gate = new Promise(resolve => { release = resolve; });
        const done = new Promise(resolve => { finish = resolve; });
        held.push({ release, done });
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
        finish();
    });
    const accepted = () => page.locator(".analyze-outcome-summary").evaluate(node => ({
        height: node.getBoundingClientRect().height,
        text: node.textContent.trim(),
        revision: document.getElementById("analyzeScopeSummary").dataset.revision,
    }));
    await page.evaluate(() => document.fonts.ready);
    const before = await accepted();
    try {
        await selectActivityOption(page, "serviceAssociationFilter", "Files");
        await expect.poll(() => held.length).toBe(1);
        await selectActivityOption(page, "toolFilter", "workiq-ask");
        await expect.poll(() => held.length).toBe(2);
        await closeAnalyzeFilters(page);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
        assert.deepEqual(await accepted(), before, "Multiple pending choices cannot publish a new scope or pending footer");
        held[1].release(); await held[1].done; await ready(page);
        await expect(page.locator("#outcomeChart .percentage-total-value")).toHaveText("1");
        await expect(page.locator("#analyzeScopeCaption")).toContainText("workiq-ask");
        await expect(page.locator("#analyzeScopeCaption")).toContainText("Service: Files");
        const newest = await accepted();
        held[0].release(); await held[0].done;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(await accepted(), newest, "A late older completion cannot restore broader values");
        await expect(page.locator("#analyzeScopeStatus")).not.toBeVisible();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
    } finally {
        held.forEach(read => read.release());
        await Promise.all(held.map(read => read.done));
    }
});

test("nested draft dismissal and custom dates preserve the native commit and reset boundaries", { timeout: 30000 }, async t => {
    const { page, snapshots, olderDay, newerDay } = await setup(t);
    await page.locator(".request-card-open").first().click();
    await page.locator("#requestReportToggle").click();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toHaveAttribute("open", "");
    const selection = await page.locator("#activitySelectionSummary").textContent();
    assert.match(selection, /1 request group included/);
    await openAnalyzeFilters(page);
    const before = snapshots.length, authors = page.locator("#promptAuthorFilter-control");
    await authors.click();
    await page.locator('.select-popup [data-value="agent"]').click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".select-popup:visible")).toHaveCount(0);
    await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
    await expect(authors).toBeFocused();
    await authors.click();
    await page.locator('.select-popup [data-value="user"]').click();
    await page.locator("#analyzeFilterHeading").click();
    await expect(authors).toHaveAttribute("aria-expanded", "false");
    assert.equal(snapshots.length, before);
    assert.deepEqual(await page.locator("#promptAuthorFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)),
        ["user", "agent", "unknown"]);
    await page.keyboard.press("Escape");
    await expect(page.locator("#analyzeFilterDialog")).not.toBeVisible();
    await expect(page.locator("#openAnalyzeFilters")).toBeFocused();

    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(olderDay);
    await page.locator("#toFilter").fill(newerDay);
    await closeAnalyzeFilters(page);
    assert.equal(snapshots.length, before, "An unapplied custom-date draft is not a query");
    await openAnalyzeFilters(page);
    await expect(page.locator("#fromFilter")).toHaveValue(olderDay);
    await expect(page.locator("#toFilter")).toHaveValue(newerDay);
    await page.locator("#applyDates").click(); await ready(page);
    assert.equal(snapshots.length, before + 1, "Apply dates dispatches one accepted read");
    assert.equal(snapshots.at(-1).filters.from, olderDay);
    assert.equal(snapshots.at(-1).filters.to, newerDay);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#openAnalyzeFilters")).toHaveAttribute("aria-label", /1 active filter/);
    await expect(page.locator("#analyzeScopeCaption")).not.toContainText("All dates");
    await openAnalyzeFilters(page);
    await page.locator("#resetView").click(); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#analyzeScopeCaption")).toBeEmpty();
    await expect(page.locator("#analyzeScopeSummary")).not.toBeVisible();
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(/All dates; Saved collection/);
    await expect(page.locator("#analyzeFilterCount")).not.toBeVisible();
    await expect(page.locator("#activitySelectionSummary")).toHaveText(selection);
    assert.ok(await page.locator("#activityList").evaluate(list => {
        const actions = document.getElementById("analyzeResultActions"), pager = document.getElementById("activityPager");
        return Boolean(list.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING)
            && Boolean(list.compareDocumentPosition(pager) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), "Reset preserves the selection and below-list controls");
});

test("an unconfirmed source check stays visible without becoming a red failure or replaying an update", { timeout: 30000 }, async t => {
    const { page, snapshots } = await setup(t, { initialize: () => sessionStorage.setItem("workiq-evidence.source-check.v1", "pending") });
    await expect(page.locator("#analyzeScopeStatus")).toContainText("unconfirmed");
    await expect(page.locator("#analyzeScopeStatus")).toContainText("will not be repeated");
    await expect(page.locator("#analyzeScopeError")).not.toBeVisible();
    const reads = snapshots.length;
    await openAnalyzeFilters(page);
    await closeAnalyzeFilters(page);
    assert.equal(snapshots.length, reads);
    await expect(page.locator("#activityUpdateToggle")).toHaveCount(0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.source-check.v1")), "pending");
});

test("scoped-chat detail stays in Filters while material coverage remains beside accepted results", { timeout: 30000 }, async t => {
    const { page, chatId } = await setup(t);
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), body = await response.json();
        const source = body.sessions.find(value => value.sessionId === chatId);
        assert.ok(source, "The native fixture has the selected source");
        source.unavailable = true;
        await route.fulfill({ response, json: body });
    }, { times: 1 });
    await selectActivityOption(page, "chatFilter", chatId); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#sessionAnalysis")).not.toBeVisible();
    assert.equal(await page.locator("#sessionAnalysis").evaluate(node => node.closest("dialog")?.id), "analyzeFilterDialog");
    await expect(page.locator("#analyzeSourceCoverage")).toBeVisible();
    await expect(page.locator("#analyzeSourceCoverage")).toContainText("Saved history is unavailable");
    await expect(page.locator("#analyzeSourceCoverage")).toContainText("Previously collected evidence is shown");
    assert.equal(await page.locator(".session-coverage").count(), 1, "The original warning is moved, not copied");
    await openAnalyzeFilters(page);
    await page.locator("#resetView").click(); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#analyzeSourceCoverage")).not.toBeVisible();
    await expect(page.locator("#analyzeScopeCaption")).not.toContainText("Copilot chat:");
});

test("native chart keyboard links, modified clicks and Back retain exact scoped membership", { timeout: 30000 }, async t => {
    const { page, snapshot } = await setup(t);
    await restoreLegacySearch(page, "Invented");
    await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
    await closeAnalyzeFilters(page);
    const beforeIds = snapshot().analytics.rows.map(row => row.id).sort();
    const failedIds = snapshot().analytics.rows.filter(row => row.outcome === "failure").map(row => row.id).sort();
    const failed = page.locator("#outcomeChart").getByRole("link", { name: /^Tool failed:/ });
    await failed.focus();
    const key = await failed.getAttribute("data-view-key");
    await failed.press("Enter"); await ready(page);
    assert.deepEqual(snapshot().analytics.rows.map(row => row.id).sort(), failedIds);
    await page.goBack(); await ready(page);
    assert.deepEqual(snapshot().analytics.rows.map(row => row.id).sort(), beforeIds);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.viewKey), key);
    await expect(page.locator("#activitySearch")).toHaveValue("Invented");
    const column = page.locator("#chart .time-column[href]").first();
    const target = await column.getAttribute("href");
    assert.doesNotMatch(target, /search=|Invented/);
    const [opened] = await Promise.all([page.context().waitForEvent("page"), column.click({ modifiers: ["Control"] })]);
    await ready(opened);
    const [view, query] = new URL(opened.url()).hash.split("?");
    const [expectedView, expectedQuery] = target.split("?");
    assert.equal(view, expectedView);
    const expectedParameters = new URLSearchParams(expectedQuery);
    assert.equal(expectedParameters.get("privateView"), "required");
    expectedParameters.delete("privateView");
    assert.deepEqual([...new URLSearchParams(query)].sort(), [...expectedParameters].sort());
    await expect(opened.locator("#activityCount")).toHaveText(String(beforeIds.length));
    await opened.close();
    await expect(page.locator('[data-analyze-mode="calls"]')).toHaveCount(0);
});

test("relocated launchers use native records, reference, comparison and update destinations", { timeout: 30000 }, async t => {
    const { page, snapshots, snapshot, olderDay, newerDay } = await setup(t);
    await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(olderDay); await page.locator("#toFilter").fill(newerDay);
    await page.locator("#applyDates").click(); await ready(page);
    await closeAnalyzeFilters(page);
    const before = structuredClone(snapshot().analytics.rows.map(row => row.id).sort());
    const filters = structuredClone(snapshots.at(-1).filters);
    const reads = snapshots.length;
    await revealAnalyzeRecords(page);
    const focus = page.locator("#activityView :focus");
    await expect(focus).toBeVisible();
    assert.ok(await focus.evaluate(node => {
        const box = node.getBoundingClientRect();
        return box.width > 1 && box.height > 1 && getComputedStyle(node).clipPath === "none";
    }), "The records list has visible focus context, never a clipped semantic heading");
    await page.locator("#openChartReference").click();
    await expect(page.locator("#meaning")).toHaveAttribute("open", "");
    await expect(page.locator("#chartReferenceTitle")).toBeFocused();
    await page.locator("#chartReferenceShowData").click();
    await expect(page.locator("#chartReferenceData table")).toBeVisible();
    assert.equal(snapshots.length, reads, "Opening existing exact data does not read or recollect evidence");
    await page.locator("#closeChartReference").click();

    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonSetup")).toBeVisible();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator("#resultsLink")).not.toBeVisible();
    await expect(page.locator("#openChartReference")).toBeHidden();
    await expect(page.locator("#openAnalyzeFilters")).toBeVisible();
    await expect(page.locator("#analyzeToolbar")).toBeHidden();
    await expect(page.locator("#comparePeriods")).toHaveAttribute("aria-current", "page");
    assert.equal(await page.locator("#filters").evaluate(node => node.closest("dialog")?.id), "analyzeFilterDialog");
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    for (const side of ["A", "B"]) for (const bound of ["From", "To"]) {
        await page.locator(`#comparison${side}${bound}`).fill(side === "A" ? olderDay : newerDay);
    }
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator("#periodComparisonResults")).toBeVisible();
    await page.getByRole("button", { name: "View calls", exact: true }).click();
    await page.locator("#comparisonRecordsB").click();
    let pairedReads = 0;
    page.on("request", request => { if (request.url().endsWith("/api/period-comparison")) pairedReads++; });
    await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
    await page.getByRole("button", { name: "View numbers", exact: true }).click();
    await expect(page.locator(".compare-inspection table").first()).toBeVisible();
    await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
    await page.getByRole("button", { name: "View calls", exact: true }).click();
    await expect(page.locator("#comparisonRecordsB")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".compare-inspection h2")).toBeFocused();
    assert.equal(pairedReads, 0, "The footer reveals the accepted selected roster without another paired read");
    await page.locator('.primary-navigation [data-nav="analyze"]').click(); await ready(page);
    assert.deepEqual(snapshot().analytics.rows.map(row => row.id).sort(), before);
    assert.deepEqual(snapshots.at(-1).filters, filters);
    assert.equal(await page.locator("#filters").evaluate(node => node.closest("dialog")?.id), "analyzeFilterDialog");
    const updateReads = snapshots.length;
    await expect(page.locator("#activityUpdateToggle")).toHaveCount(0);
    await expect(page.locator("#checkActivity")).not.toBeVisible();
    assert.equal(snapshots.length, updateReads, "Analyze does not dispatch a removed update action");
});

test("the integrated dashboard and panel reflow with long names, both themes and enlarged text", { timeout: 180000 }, async t => {
    const { page, projectId, chatId, runtime } = await setup(t, { longNames: true });
    const proof = process.env.WIRE_DASHBOARD_FILTER_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    const measurements = [];
    for (const width of [1440, 768, 390, 375]) for (const scale of [1, 2]) for (const theme of ["dark", "light"]) {
        await closeAnalyzeFilters(page);
        await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            scrollTo(0, 0);
        });
        const name = `${width}-${scale}-${theme}`;
        const overview = await page.evaluate(() => {
            const box = id => document.getElementById(id).getBoundingClientRect();
            const main = box("main"), sidebar = box("sidebar"), trigger = box("openAnalyzeFilters");
            const visibleSidebar = document.getElementById("sidebar").checkVisibility();
            return { overflow: document.documentElement.scrollWidth - innerWidth,
                sidebarOverlap: visibleSidebar ? Math.max(0, sidebar.right - main.left) : 0,
                trigger: { width: trigger.width, height: trigger.height },
                headingHeight: document.querySelector(".page-heading").getBoundingClientRect().height,
                titleClip: getComputedStyle(document.getElementById("pageTitle").parentElement).clipPath,
                scopeClipped: document.getElementById("analyzeScopeCaption").scrollWidth - document.getElementById("analyzeScopeCaption").clientWidth };
        });
        if (proof) {
            await page.screenshot({ path: path.join(proof, `${name}-overview.png`) });
            await page.screenshot({ path: path.join(proof, `${name}-full.png`), fullPage: true });
        }
        assert.ok(overview.overflow <= 1, name + " page overflow");
        assert.equal(overview.sidebarOverlap, 0, name + " sidebar must not cover content");
        assert.ok(overview.trigger.width >= 44 && overview.trigger.height >= 44, name + " filter entry");
        assert.ok(overview.headingHeight <= 1 && overview.titleClip === "inset(50%)", name + " no visual Analyze title band: " + JSON.stringify(overview));
        assert.ok(overview.scopeClipped <= 1, name + " accepted scope stays readable");
        await openAnalyzeFilters(page);
        if (!await page.locator("#moreFilters").evaluate(node => node.open)) await page.locator("#moreFiltersToggle").click();
        await page.locator("#analyzeFilterDialog").evaluate(async node => {
            await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished));
        });
        const panel = await page.locator("#analyzeFilterDialog").boundingBox();
        assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 1, name + " panel fits viewport");
        const fields = [];
        for (const id of ["dateFilter", "sourceFilter", "toolFilter", "serviceAssociationFilter", "outcomeFilter", "promptAuthorFilter",
            "serviceFilter", "projectFilter", "chatFilter", "layerFilter", "scopeFilter"]) {
            const control = page.locator("#" + id + "-control");
            await control.scrollIntoViewIfNeeded();
            const value = await control.evaluate(node => {
                const box = node.getBoundingClientRect(), text = node.querySelector(".select-value");
                return { id: node.id, x: box.x, right: box.right, width: box.width, height: box.height,
                    clipped: text.scrollWidth - text.clientWidth, verticalClip: text.scrollHeight - text.clientHeight };
            });
            assert.ok(value.x >= 0 && value.right <= width + 1 && value.height >= 44 && value.clipped <= 1 && value.verticalClip <= 1,
                name + " " + JSON.stringify(value));
            fields.push(value);
        }
        await page.locator("#analyzeFilterDialog").evaluate(node => { node.scrollTop = 0; });
        if (proof) await page.screenshot({ path: path.join(proof, `${name}-panel.png`) });
        measurements.push({ width, scale, theme, overview, panel, fields });
    }
    await selectActivityOption(page, "projectFilter", projectId); await ready(page);
    await selectActivityOption(page, "chatFilter", chatId); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#analyzeScopeCaption")).toContainText("Invented lighthouse research");
    await expect(page.locator("#analyzeScopeCaption")).toContainText("Invented harbor research");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const badge = await page.locator("#analyzeFilterCount").evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        const text = range.getBoundingClientRect(), bounds = node.getBoundingClientRect();
        return { top: text.top - bounds.top, bottom: bounds.bottom - text.bottom,
            left: text.left - bounds.left, right: bounds.right - text.right };
    });
    assert.ok(Object.values(badge).every(inset => inset >= -1), "The active-filter count fits its surface at 200%: " + JSON.stringify(badge));
    if (proof) {
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(proof, "long-applied-phone-200-overview.png") });
        await page.screenshot({ path: path.join(proof, "long-applied-phone-200.png"), fullPage: true });
        await writeFile(path.join(proof, "geometry.json"), JSON.stringify(measurements, null, 2));
    }
    if (process.env.WIRE_DASHBOARD_TASTE_SCRIPT) {
        assert.ok(proof, "Taste inspection requires an explicit proof directory");
        const inspection = await new Promise(resolve => execFile(process.execPath, [process.env.WIRE_DASHBOARD_TASTE_SCRIPT, "--app", runtime.url,
            "--out", path.join(proof, "taste"), "--allow", process.env.WIRE_DASHBOARD_TASTE_ALLOW || ""],
        { encoding: "utf8", timeout: 120000, env: process.env }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
        await writeFile(path.join(proof, "taste-output.txt"), (inspection.stdout || "") + (inspection.stderr || ""));
        if (inspection.error) throw inspection.error;
    }
});
