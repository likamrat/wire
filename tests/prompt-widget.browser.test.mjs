import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { promptWidgetRecords } from "./prompt-widget-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { chooseTheme, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proof = process.env.WIRE_PROMPT_WIDGET_PROOFS;
async function settle(page) {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function setup(t, { completeSearch = false, disputedOrigin = false, qualifiedIssues = false } = {}) {
    const records = promptWidgetRecords(), cleanups = [];
    if (disputedOrigin) records[1].userPrompt.sourceEventId = records[0].userPrompt.sourceEventId;
    if (qualifiedIssues) {
        records[14].userPrompt.authorship.issue = "body-boundary-v1";
        records[11].userPrompt.authorship.issue = "host-wrapper-v1";
    }
    if (completeSearch) records[3].userPrompt = { ...records[3].userPrompt, status: "full", text: "Harbor review: read the mailbox updates." };
    const app = await searchFixture({ after: fn => cleanups.push(fn) }, { records, reply: completeSearch });
    const before = await loadBoardState(app.context), errors = [], denied = [];
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: "en-US", timezoneId: "UTC" });
    page.on("pageerror", error => errors.push(error.message));
    const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list", "/api/search/events", "/api/search/query",
        "/api/search/status", "/api/search/open", "/api/session"];
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(app.runtime.url).origin && (request.method() === "GET" || reads.includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        await browser.close();
        try {
            const after = await loadBoardState(app.context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
    });
    await page.clock.setFixedTime(new Date("2026-10-14T18:00:00Z"));
    await page.goto(app.runtime.url);
    await settle(page);
    return { page, widget: page.locator('[data-breakdown="authors"]') };
}
async function exact(page, widget, counts, calls) {
    await settle(page);
    const total = counts.reduce((sum, count) => sum + count, 0);
    await expect(widget).toHaveAttribute("data-total", String(total));
    await expect(widget.locator(".percentage-denominator")).toHaveText(`${total} matching ${total === 1 ? "interaction" : "interactions"}`);
    await expect(page.locator("#activityCount")).toHaveText(String(calls));
    const rows = await widget.locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
        actor: node.dataset.promptActor, count: Number(node.dataset.count), value: node.querySelector(".percentage-value").textContent,
        fraction: Number(node.querySelector(".percentage-bar").dataset.fraction), width: parseFloat(node.querySelector(".percentage-bar").style.width),
        label: node.querySelector(".percentage-label").textContent,
    })));
    if (total) {
        assert.deepEqual(rows.map(row => row.actor), ["user", "agent", "unknown"]);
        assert.deepEqual(rows.map(row => row.count), counts);
        assert.deepEqual(rows.map(row => row.label), ["My prompts", "Agent prompts", "Author unverified"]);
        for (const row of rows) {
            assert.equal(row.value, `${Number((row.count / total * 100).toFixed(1))}% (${row.count})`);
            assert.equal(row.fraction, row.count / total);
            assert.ok(Math.abs(row.width - row.fraction * 100) < .0001, "CSS percentage serialization keeps its available precision");
        }
    } else assert.deepEqual(rows, []);
    assert.equal(await widget.locator("a,button,svg").count(), 0, "Compact static facts do not invent a drilldown or pie");
    return rows;
}
async function reset(page) {
    await openAnalyzeFilters(page);
    await page.locator("#resetView").click();
    await closeAnalyzeFilters(page);
}
async function capture(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    await settle(page);
    await page.screenshot({ path: path.join(proof, name + "-context.png") });
    await page.locator(".analyze-dashboard").screenshot({ path: path.join(proof, name + "-dashboard.png") });
}

test("a disputed canonical origin stays unknown through filters and the actual reader", { timeout: 45000 }, async t => {
    const { page, widget } = await setup(t, { disputedOrigin: true });
    await exact(page, widget, [5, 5, 7], 36);
    await selectActivityOption(page, "promptAuthorFilter", "unknown");
    await closeAnalyzeFilters(page);
    await exact(page, widget, [0, 0, 7], 21);
    for (const index of [0, 1]) {
        const card = page.locator(`[data-view-key="request:prompt-widget-${index}"]`);
        await expect(card.locator(".request-card-author")).toHaveText("Author unverified");
        await card.locator(".request-card-open").click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        await expect(page.locator("#contextSidebar [data-prompt-actor=unknown]:not(.visually-hidden)")).toHaveText("Author unverified");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
    }
    await selectActivityOption(page, "outcomeFilter", "failure");
    await exact(page, widget, [0, 0, 4], 11);
    await selectActivityOption(page, "promptAuthorFilter", "agent");
    await exact(page, widget, [0, 2, 0], 4);
});

test("retained origin causes reach the reader without changing author shares or recorded outcomes", { timeout: 45000 }, async t => {
    const { page, widget } = await setup(t, { qualifiedIssues: true });
    await exact(page, widget, [6, 6, 6], 36);
    await selectActivityOption(page, "promptAuthorFilter", "unknown");
    await closeAnalyzeFilters(page);
    await exact(page, widget, [0, 0, 6], 18);
    for (const [index, reason, width, theme] of [
        [14, "WIRE could not match the original prompt to a supported host message layout.", 1440, "light"],
        [11, "WIRE does not recognize the host-added context before the original prompt.", 390, "dark"],
    ]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1100 });
        await page.locator(`[data-view-key="request:prompt-widget-${index}"] .request-card-open`).click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        await expect(page.locator("#contextSidebar .reader-state")).toContainText(reason);
        await expect(page.locator("#contextSidebar")).toContainText(index === 14 ? "Call #1 completed" : "Call #1 failed");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await capture(page, `origin-issue-${index}-${width}`);
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
    }
});

test("ordinary Analyze shows complete prompt origins through filters, paging, guide and composed layouts", { timeout: 120000 }, async t => {
    const { page, widget } = await setup(t), evidence = [];
    await expect(widget).toHaveAccessibleName("Prompt authors");
    evidence.push({ state: "all", rows: await exact(page, widget, [6, 6, 6], 36) });
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(8);
    await page.locator('#activityView [data-page-direction="1"]').click();
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(8);
    await exact(page, widget, [6, 6, 6], 36);
    await page.locator('#activityView [data-page-direction="1"]').click();
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(2);
    await exact(page, widget, [6, 6, 6], 36);
    await selectActivityOption(page, "dateFilter", "day");
    await exact(page, widget, [1, 1, 1], 6);
    await reset(page);
    await selectActivityOption(page, "outcomeFilter", "failure");
    await selectActivityOption(page, "serviceAssociationFilter", "Mail");
    await selectActivityOption(page, "toolFilter", "workiq-fetch");
    await exact(page, widget, [2, 1, 1], 7);
    await selectActivityOption(page, "promptAuthorFilter", "user");
    await exact(page, widget, [2, 0, 0], 2);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#activityList [data-prompt-actor=user]")).toHaveCount(2);
    await reset(page);
    await selectActivityOption(page, "promptAuthorFilter", "unknown");
    await exact(page, widget, [0, 0, 6], 18);
    await closeAnalyzeFilters(page);
    await capture(page, "unverified-light");
    await reset(page);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceAllTopics").click();
    const topic = page.locator('[data-reference-topic="authors"]');
    await topic.hover();
    await topic.focus();
    await expect(topic).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#chartReferenceExplanation")).toContainText("One originating prompt per matching interaction, across all pages.");
    await page.locator("#chartReferenceShowData").click();
    await expect(page.locator("#chartReferenceData tbody th")).toHaveText(["My prompts", "Agent prompts", "Author unverified"]);
    await expect(page.locator("#chartReferenceData tbody td")).toHaveText(["6", "33.3%", "6", "33.3%", "6", "33.3%"]);
    await page.locator("#chartReferenceData summary").click();
    await expect(page.locator("#chartReferenceData")).toContainText("missing text alone does not change authorship");
    await page.locator("#closeChartReference").click();
    await expect(page.locator("#meaning")).toBeHidden();
    await expect(page.locator("#openChartReference")).toBeFocused();
    let release;
    await page.route("**/api/snapshot", async route => {
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Invented scope read failure" }) });
    }, { times: 1 });
    await selectActivityOption(page, "dateFilter", "day");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(widget).toHaveAttribute("data-total", "18");
    await expect.poll(() => typeof release).toBe("function");
    release();
    await settle(page);
    await expect(widget).toHaveAttribute("data-total", "18");
    await expect(page.locator("#periodResult")).toContainText("Previous results");
    await selectActivityOption(page, "dateFilter", "day");
    await exact(page, widget, [1, 1, 1], 6);
    await reset(page);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [768, 100], [390, 100], [390, 200]]) {
        await page.setViewportSize({ width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale + "%"; }, scale);
        await exact(page, widget, [6, 6, 6], 36);
        const geometry = await widget.evaluate(node => {
            const text = [...node.querySelectorAll(".percentage-label,.percentage-value,.percentage-denominator")];
            const boxes = [...document.querySelectorAll(".analyze-outcome-summary,.analyze-chart-main,#percentageCharts .percentage-card")]
                .map(item => ({ key: item.dataset.breakdown, ...item.getBoundingClientRect().toJSON() }));
            return { overflow: document.documentElement.scrollWidth > innerWidth + 1, boxes,
                clipped: text.filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.textContent),
                fontLoaded: document.fonts.check('16px "Asta Sans"'),
                background: getComputedStyle(node).backgroundColor,
                textColors: [...node.querySelectorAll("h3,.percentage-label,.percentage-value strong,.percentage-value span,.percentage-denominator")]
                    .map(item => ({ text: item.textContent, color: getComputedStyle(item).color })),
                labelColors: [...node.querySelectorAll(".percentage-label")].map(item => getComputedStyle(item).color),
                barColors: [...node.querySelectorAll(".percentage-bar")].map(item => getComputedStyle(item).backgroundColor) };
        });
        assert.equal(geometry.overflow, false); assert.deepEqual(geometry.clipped, []); assert.equal(geometry.fontLoaded, true);
        assert.deepEqual(geometry.barColors, geometry.labelColors, "Marks reuse the card's author colors");
        for (const { text, color } of geometry.textColors) {
            assert.ok(contrast(color, geometry.background) >= 4.5, `${theme}: ${text} remains readable`);
        }
        for (const [index, a] of geometry.boxes.entries()) for (const b of geometry.boxes.slice(index + 1)) {
            assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1);
        }
        evidence.push({ state: `${theme}-${width}-${scale}`, geometry });
        await capture(page, `${theme}-${width}-${scale}`);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await chooseTheme(page, "light");
    await page.locator("#activityList .request-card-open").first().click();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await capture(page, "reader-light");
    await page.locator("#closeContextSidebar").click();
    await page.locator("#navigationCollapse").click();
    await capture(page, "sidebar-collapsed-light");
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-10-14");
    await page.locator("#toFilter").fill("2026-10-14");
    await page.locator("#applyDates").click();
    await selectActivityOption(page, "promptAuthorFilter", "user");
    await closeAnalyzeFilters(page);
    await exact(page, widget, [1, 0, 0], 1);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme); await capture(page, "sparse-" + theme);
    }
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2020-01-01");
    await page.locator("#toFilter").fill("2020-01-02");
    await page.locator("#applyDates").click();
    await exact(page, widget, [0, 0, 0], 0);
    await expect(widget).toBeHidden();
    await expect(widget.locator(".percentage-empty")).toHaveText("No matching interactions.");
    if (proof) await writeFile(path.join(proof, "journey.json"), JSON.stringify(evidence, null, 2));
});

test("literal analytical Search admits whole prompt origins; unavailable coverage never becomes zero", { timeout: 60000 }, async t => {
    const { page, widget } = await setup(t, { completeSearch: true });
    await page.locator("#wireSearch").fill("planning item");
    await selectActivityOption(page, "wireSearchType", "interaction");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await page.locator("#wireSearch").focus();
    await expect(page.locator("#activityListScope")).toContainText("Search applied");
    await exact(page, widget, [5, 5, 6], 33);
    await page.locator("#wireSearch").fill("NO-CEDAR-MATCH");
    await expect(page.locator("#wireSearchStatus")).toContainText("No matches");
    await exact(page, widget, [0, 0, 0], 0);
    await page.locator("#wireSearchClear").click();
    await exact(page, widget, [6, 6, 6], 36);
    const partial = await setup(t);
    await partial.page.locator("#wireSearch").fill("Cedar");
    await selectActivityOption(partial.page, "wireSearchScope", "analysis");
    await partial.page.locator("#wireSearch").focus();
    await expect(partial.page.locator("#wireAnalysisSearchNotice")).toContainText("Counts and Current reports are unavailable");
    await expect(partial.widget).toBeHidden();
});
