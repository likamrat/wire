import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

const custom = "#home?range=custom&from=2026-09-21&to=2026-09-27";
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function picture(page, name) {
    if (!process.env.WIRE_HOME_PROOF_DIR) return;
    await mkdir(process.env.WIRE_HOME_PROOF_DIR, { recursive: true });
    await page.evaluate(() => { scrollTo(0, 0); return document.fonts.ready; });
    await page.screenshot({ path: path.join(process.env.WIRE_HOME_PROOF_DIR, name + ".png"), fullPage: true });
}
async function setup(t, { knownCoverage = true } = {}) {
    const records = Array.from({ length: 25 }, (_, index) => {
        const row = fixture(`home-layout-${index}`);
        row.sourceSessionId = `invented-chat-${index % 17}`;
        row.sourceSessionName = `Invented planning chat ${index % 17 + 1}`;
        row.userPrompt = { ...row.userPrompt, sourceEventId: `prompt-${index}`, text: `Invented calendar request ${index + 1}` };
        row.followUpPrompts = [];
        const startedAt = `2026-09-${index === 24 ? 20 : 21 + index % 7}T12:00:00Z`;
        row.toolCalls = Array.from({ length: index === 0 ? 6 : 5 }, (_, call) => ({
            ...row.toolCalls[0], toolCallId: `call-${index}-${call}`, startEventId: `start-${index}-${call}`,
            completionEventId: index === 23 && call === 4 ? null : `complete-${index}-${call}`,
            startedAt, completedAt: new Date(Date.parse(startedAt) + 5899).toISOString(), durationMs: 5899,
            toolSucceeded: index === 23 && call === 4 ? undefined : !(index < 7 && call === 0),
            reportedOutcome: index === 23 && call === 4 ? "unknown" : index < 7 && call === 0 ? "failed" : "succeeded",
        }));
        return row;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    const errors = [], requests = [], snapshots = [], overviews = [], overviewReads = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    page.on("response", response => {
        if (response.url().endsWith("/api/assessment/overview") && response.ok()) {
            overviewReads.push(response.json().then(payload => overviews.push(payload.data)));
        }
    });
    // Invented connected status; analytics, canonical membership and all reads use the real isolated store.
    const status = { state: "collecting-on-interval", configVersion: "invented-source",
        config: { approved: true, enabled: true, windowDays: 30, pollSeconds: 5 }, discovery: { counts: {} },
        checkedWindow: knownCoverage ? { since: "2026-09-07T07:00:00Z", until: "2026-10-07T14:00:00Z" } : null,
        lastCheckedAt: "2026-10-07T14:00:00Z", historyCoverage: { eligible: 17, readable: 17, pending: 0, unavailable: 0 },
        cadence: { pollSeconds: 5 }, metrics: {} };
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), data = await response.json();
        snapshots.push(data);
        await route.fulfill({ response, json: { ...data, collection: { ...status, revision: data.revision } } });
    });
    await page.route("**/api/collection/status", route => route.fulfill({ json: { ...status, revision: snapshots.at(-1)?.revision ?? 1 } }));
    t.after(async () => {
        await Promise.all(overviewReads);
        await browser.close(); await runtime.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(route => ["/api/snapshot", "/api/collection/status", "/api/assessment/overview"].includes(route)),
            "Home composition and filtering never collect or mutate: " + JSON.stringify(requests));
    });
    await page.goto(runtime.url + custom); await ready(page);
    await expect(page.locator("#homeInsights .assessment-grid")).toBeVisible();
    return { page, runtime, snapshots, overviews };
}

test("Home reads filters, one applied summary, visual activity, then truthful measures", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await picture(page, `home-${theme}-1440`);
        assert.equal(await page.locator("#filters #outcomeFilter").count(), 1, "Result belongs beside date/refinement controls, not below insights.");
        const layout = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const text = selector => {
                const node = document.querySelector(selector), range = document.createRange();
                range.selectNodeContents(node);
                return range.getBoundingClientRect();
            };
            const date = rect("#dateFilter-control"), from = rect("#fromFilter"), to = rect("#toFilter"), result = rect("#outcomeFilter-control");
            return { chartTop: rect(".chart-panel").top, chartBottom: rect(".chart-panel").bottom, insightsTop: rect("#homeInsights").top,
                datesAligned: Math.abs(date.top - from.top) < 2 && Math.abs(from.top - to.top) < 2 && Math.abs(result.top - from.top) < 2,
                applyAligned: Math.abs(rect("#applyDates").top - from.top) < 2,
                resultGap: rect("#resultSummary").left - rect("#dateFields").right,
                resultLabelInset: text("#resultFilterLabel").left - text("#outcomeFilter-control .select-value").left,
                labelBaselineDelta: text("#resultFilterLabel").bottom - text("#dateFields label>span").bottom,
                overflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.ok(layout.datesAligned && layout.applyAligned && layout.resultGap >= 8 && layout.resultGap <= 17
            && layout.chartBottom < layout.insightsTop, JSON.stringify(layout));
        assert.ok(Math.abs(layout.resultLabelInset) <= 1 && Math.abs(layout.labelBaselineDelta) <= 1, JSON.stringify(layout));
        assert.equal(layout.overflow, 0);
        await expect(page.locator("#periodResult")).toContainText("121 Work IQ tool calls");
        assert.equal(await page.locator('#filterChips [aria-label^="Remove date filter"]').count(), 0);
        assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
        assert.equal(await page.locator("#homeInsights .assessment-dimension").count(), 4);
        for (const [width, scale] of [[820, 1], [375, 1], [375, 2]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            await picture(page, `home-${theme}-${width}-${scale * 100}`);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            for (const selector of ["#fromFilter", "#toFilter", "#applyDates", "#outcomeFilter-control"]) {
                assert.ok(await page.locator(selector).evaluate(node => node.scrollWidth <= node.clientWidth + 1), selector);
            }
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1440, height: 1000 });
    }
});

test("Home date/result apply, clear, Back and failed reads keep one accepted chart and insight scope", { timeout: 30000 }, async t => {
    const { page, snapshots, overviews } = await setup(t);
    const reconcile = async () => {
        const snapshot = snapshots.at(-1);
        await expect(page.locator("#periodResult")).toContainText(`${snapshot.analytics.totals.count} Work IQ tool call`);
        assert.equal(Number(await page.locator(".percentage-section").getAttribute("data-total")), snapshot.analytics.totals.count);
        assert.equal(await page.locator("#resultSummary").getAttribute("data-revision"), String(snapshot.revision));
        await expect(page.locator("#homeInsights")).not.toHaveAttribute("aria-busy", "true");
    };
    await page.locator("#fromFilter").fill("2026-09-22");
    await page.locator("#toFilter").fill("2026-09-22");
    await page.locator("#applyDates").click(); await ready(page); await reconcile();
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page); await reconcile();
    assert.equal(snapshots.at(-1).analytics.totals.count, 1);
    await expect.poll(() => overviews.at(-1)?.metrics.find(metric => metric.definitionId === "tool-duration")?.coverage)
        .toEqual({ eligible: 5, covered: 5 });
    await expect(page.locator("#homeInsights")).toContainText("5 / 5 timed");
    await page.locator("#clearResultFilter").click(); await ready(page); await reconcile();
    await page.locator("#clearDates").click(); await ready(page); await reconcile();
    assert.equal(snapshots.at(-1).analytics.totals.count, 126);
    await page.goBack(); await ready(page); await reconcile();
    assert.equal(await page.locator("#fromFilter").inputValue(), "2026-09-22");
    await page.route("**/api/snapshot", route => route.abort("connectionrefused"));
    await page.locator("#fromFilter").fill("2026-09-23"); await page.locator("#toFilter").fill("2026-09-23");
    await page.locator("#applyDates").click(); await ready(page);
    await expect(page.locator("#message")).toContainText("last recorded snapshot");
    await expect(page.locator("#periodResult")).toContainText("Previous results");
    await picture(page, "home-failed-read");
    await page.unroute("**/api/snapshot");
    await page.locator("#message").getByRole("button", { name: "Try again" }).click(); await ready(page);
    await expect(page.locator("#message")).toBeHidden();
});

test("Home leaves missing coverage explicit rather than removing it to simplify the page", async t => {
    const { page } = await setup(t, { knownCoverage: false });
    await expect(page.locator("#periodCoverage")).toBeVisible();
    await expect(page.locator("#periodCoverageText")).toHaveText("Checked history is unknown; this view uses retained activity.");
    await expect(page.locator("#periodResult")).toHaveText("121 Work IQ tool calls (Sep 21 - Sep 27, 2026)");
    await picture(page, "home-missing-coverage");
});
