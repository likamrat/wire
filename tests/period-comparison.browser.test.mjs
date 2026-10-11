import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { assessmentOverview, buildAssessmentModel, invalidateAssessmentCache } from "../lib/assessment-read-model.mjs";
import { automaticScoreOffSummary, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";

const proof = process.env.WIRE_PERIOD_PROOFS;
async function setup(t, { polling = false } = {}) {
    const { state, input } = periodFixture();
    const before = structuredClone(state), model = buildAssessmentModel(state);
    invalidateAssessmentCache();
    const requests = [], errors = [], denied = [], replies = [];
    let delay = null, delaySnapshot = null, fail = false, alterComparison = null;
    let observed = { state: "paused", config: null, revision: state.revision, assessment: { basis: model.basis } };
    const contract = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    const comparisonModules = new Map(await Promise.all([
        "period-comparison-math", "report-outcome-comparison", "report-metric-comparison", "wire-report-metric-adapter",
    ].map(async name => [`/assets/${name}.mjs`, await readFile(new URL(`../lib/${name}.mjs`, import.meta.url), "utf8")])));
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/") {
                res.setHeader("Content-Type", "text/html"); res.end(renderHtmlShell("a".repeat(64), "period-proof")); return;
            }
            if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
                res.setHeader("Content-Type", "text/javascript"); res.end(contract); return;
            }
            if (req.method === "GET" && comparisonModules.has(req.url)) {
                res.setHeader("Content-Type", "text/javascript"); res.end(comparisonModules.get(req.url)); return;
            }
            if (req.url === "/favicon.svg") { res.statusCode = 204; res.end(); return; }
            let body = ""; for await (const chunk of req) body += chunk;
            const args = JSON.parse(body || "{}"); requests.push({ route: req.url, input: args });
            let data;
            if (req.url === "/api/snapshot") {
                data = await currentStatePayload({}, state, args);
                if (polling) data.collection = { state: "paused", config: null, revision: state.revision };
                if (delaySnapshot) await delaySnapshot();
            }
            else if (req.url === "/api/period-comparison") {
                if (fail) { res.statusCode = 409; res.end(JSON.stringify({ error: "The stored revision changed. Read the current Analyze view before comparing again." })); return; }
                data = buildPeriodComparison(state, args);
                if (alterComparison) alterComparison(data);
                replies.push(structuredClone(data));
                if (delay) await delay(args);
            } else if (req.url === "/api/assessment/overview") data = { schemaVersion: 1, basis: model.basis, data: assessmentOverview(state, model, args.interactionRefs) };
            else if (req.url === "/api/assessment/detail") data = { schemaVersion: 1, basis: model.basis, data: model.details.get(args.interactionRef) };
            else if (req.url === "/api/evaluation/automatic/summary") data = automaticScoreOffSummary();
            else if (req.url === "/api/collection/status") data = observed;
            else { denied.push(req.url); res.statusCode = 403; data = { error: "Only invented retained-data reads are available." }; }
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data));
        } catch (error) { errors.push(error.stack); res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
        await browser?.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(denied, []); assert.deepEqual(errors, []); assert.deepEqual(state, before);
        assert.doesNotMatch(JSON.stringify(requests), new RegExp(periodQuery));
    });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 }, timezoneId: "America/New_York", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === url) return route.continue();
        denied.push(route.request().url()); return route.abort();
    });
    return { page, url, requests, replies, input, delay: callback => { delay = callback; }, fail: value => { fail = value; },
        delaySnapshot: callback => { delaySnapshot = callback; },
        alterComparison: callback => { alterComparison = callback; },
        observe: assessment => { observed = { ...observed, assessment }; }, basis: model.basis };
}

async function openComparison(app, { select = false } = {}) {
    const { page, url } = app;
    await page.goto(url + "#analyze?from=2026-03-07&to=2026-03-07&services=Files&includeMissingService=true");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#activitySearch").fill(periodQuery);
    if (select) await page.locator("#select-request-period-request-0").check();
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("No comparison has been run");
    for (const [label, value] of [
        ["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"],
    ]) await page.getByLabel(label, { exact: true }).fill(value);
    await page.locator("#periodComparison").getByRole("button", { name: "Compare periods", exact: true }).click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Comparing retained activity only");
}

test("normal Analyze compares both periods, keeps precise scope and supports Back, themes and narrow 200% text", { timeout: 60000 }, async t => {
    const app = await setup(t), { page } = app;
    await openComparison(app, { select: true });
    const root = page.locator("#periodComparison"), a = root.locator('[data-period-side="baseline"]'), b = root.locator('[data-period-side="later"]');
    await expect(a).toContainText("3 matching records across all pages");
    await expect(b).toContainText("4 matching records across all pages");
    await expect(a).toContainText("Full retained interactions");
    await expect(a.locator(".assessment-findings")).toContainText("Work IQ sign-in was required");
    await expect(root).toContainText("+50 percentage-points");
    await expect(root).toContainText("0 ms; 2 / 3 calls timed");
    await expect(root).toContainText("3,000 ms; 2 / 4 calls timed");
    await expect(page.locator("#outcomeFilter-control")).toContainText("A: 3; B: 4");
    await expect(page.locator("#dateFilter-control")).not.toBeVisible();
    await expect(page.locator("#pageAction")).not.toBeVisible();
    await expect(page.locator("#applyPeriodComparison")).toBeFocused();
    assert.equal(new URL(page.url()).hash.includes(periodQuery), false);
    assert.equal(app.requests.filter(item => item.route === "/api/period-comparison").at(-1).input.scenarioIds.includes("period-request-5"), true);
    assert.equal(app.replies.at(-1).periods.baseline.assessment.metrics.find(metric => metric.definitionId === "tool-duration").coverage.eligible, 4);
    const layouts = [];
    for (const [theme, width, scale] of [["light", 1365, 1], ["dark", 1365, 1], ["light", 375, 2], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const geometry = await root.evaluate(node => ({
            overflow: document.documentElement.scrollWidth - innerWidth,
            fields: [...node.querySelectorAll('input[type="date"]')].map(input => ({
                width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height,
                left: input.getBoundingClientRect().left, right: input.getBoundingClientRect().right,
            })),
        }));
        assert.ok(geometry.overflow <= 1, JSON.stringify(geometry));
        assert.ok(geometry.fields.every(field => field.width > 0 && field.height >= 44 && field.left >= 0 && field.right <= width));
        layouts.push({ theme, width, scale, ...geometry });
        if (proof) {
            await mkdir(proof, { recursive: true });
            await root.screenshot({ path: path.join(proof, `comparison-${theme}-${width}-${scale}.png`) });
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proof, `viewport-${theme}-${width}-${scale}.png`) });
        }
    }
    await page.setViewportSize({ width: 1365, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
    const disclosure = a.locator(".assessment-saved-details > summary");
    await disclosure.focus(); await page.keyboard.press("Enter");
    await expect(a.locator(".assessment-grid")).toBeVisible();
    await expect(a).toContainText("2 of 2 requests assessed");
    await a.getByText("Exact matching records (3)", { exact: true }).click();
    await a.locator("a").first().click();
    await expect(page.locator("#requestView")).toBeVisible();
    await page.goBack();
    await expect(root).toBeVisible(); await expect(page.locator("#periodComparisonStatus")).toContainText("Comparing retained activity only");
    await expect(page.locator("#comparisonSearch")).toHaveValue(periodQuery);
    await expect(a.locator(".assessment-saved-details")).toHaveAttribute("open", "");
    await root.getByRole("button", { name: "Stop comparing" }).click();
    await expect(page.locator("#activityView")).toBeVisible(); await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
    await expect(page.locator("#pageAction")).toBeVisible();
    await expect(page.locator("#select-request-period-request-0")).toBeChecked();
    await expect(page.locator("#dateFilter-control")).toBeVisible();
    await expect(page.locator("#outcomeFilter-control")).not.toContainText("A:");
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("from"), "2026-03-07");
    if (proof) {
        await writeFile(path.join(proof, "normal-layout.json"), JSON.stringify(layouts, null, 2));
        await writeFile(path.join(proof, "accepted-comparison.json"), JSON.stringify(app.replies.at(-1), null, 2));
    }
});

test("private search and Author refinements, empty periods, stale errors and late reads stay distinct", { timeout: 60000 }, async t => {
    const app = await setup(t), { page } = app;
    await openComparison(app);
    const root = page.locator("#periodComparison");
    await selectActivityOption(page, "promptAuthorFilter", "user");
    await expect(root.locator('[data-period-side="later"]')).toContainText("2 matching records across all pages");
    await page.locator("#comparisonSearch").fill("no invented match");
    await expect(root.locator('[data-period-side="baseline"]')).toContainText("No matching retained activity");
    await expect(root.locator('[data-period-side="later"]')).toContainText("No matching retained activity");
    await expect(root).toContainText("Not applicable");
    app.fail(true);
    await page.locator("#comparisonSearch").fill(periodQuery);
    await expect(page.locator("#periodComparisonStatus")).toContainText("stored revision changed");
    await expect(root.locator("[data-period-side]")).toHaveCount(0);
    app.fail(false);
    await root.getByRole("button", { name: "Retry comparison read" }).click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Comparing retained activity only");
    let release;
    app.delay(input => input.scenarioIds.length === 0 ? new Promise(resolve => { release = resolve; }) : undefined);
    await page.locator("#comparisonSearch").fill("no match again");
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.locator("#comparisonSearch").fill(periodQuery);
    await expect(root.locator('[data-period-side="later"]')).toContainText("2 matching records across all pages");
    release(); app.delay(null);
    await expect(root.locator('[data-period-side="later"]')).toContainText("2 matching records across all pages");
    await expect(page.locator("#pageAction")).not.toBeVisible();
    await root.getByRole("button", { name: "Stop comparing" }).click();
    await page.locator('[data-analyze-mode="calls"]').click();
    await expect(page.locator("#callSortControls")).toBeVisible();
});

test("an in-flight comparison is invalidated during an unchanged stored reread and can restart afterward", { timeout: 30000 }, async t => {
    const app = await setup(t), { page } = app;
    await openComparison(app);
    let releaseComparison, releaseSnapshot;
    app.delay(() => new Promise(resolve => { releaseComparison = resolve; }));
    await page.locator("#comparisonSearch").fill("request 0");
    await expect.poll(() => Boolean(releaseComparison)).toBe(true);
    app.delaySnapshot(() => new Promise(resolve => { releaseSnapshot = resolve; }));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => Boolean(releaseSnapshot)).toBe(true);
    await expect(page.locator("#periodComparisonStatus")).toContainText("updating or stale");
    await expect(page.locator("#periodComparison [data-period-side]")).toHaveCount(0);
    releaseComparison(); app.delay(null);
    releaseSnapshot(); app.delaySnapshot(null);
    await expect(page.locator("#periodComparisonStatus")).toContainText("Comparing retained activity only");
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("2 matching records across all pages");
});

test("a permission-basis observation clears displayed findings while the accepted snapshot remains deferred", { timeout: 30000 }, async t => {
    const app = await setup(t, { polling: true }), { page } = app;
    await openComparison(app);
    const snapshots = () => app.requests.filter(item => item.route === "/api/snapshot").length;
    const before = snapshots();
    await page.locator("#comparisonSearch").focus();
    app.observe({ basis: { ...app.basis, consentRevision: app.basis.consentRevision + 1 }, pendingCleanup: false });
    await expect(page.locator("#periodComparisonStatus")).toContainText("permission changed", { timeout: 12000 });
    await expect(page.locator("#periodComparison [data-period-side]")).toHaveCount(0);
    assert.equal(snapshots(), before);
    await expect(page.locator("#pageAction")).not.toBeVisible();
});

test("comparison Outcome choices use both cohorts and a late facet read does not discard an open draft", { timeout: 30000 }, async t => {
    const app = await setup(t), { page } = app;
    await openComparison(app);
    await selectActivityOption(page, "outcomeFilter", "unknown");
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("No matching retained activity");
    await expect(page.locator('[data-period-side="later"]')).toContainText("1 matching records across all pages");
    await selectActivityOption(page, "outcomeFilter", "all");
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("3 matching records across all pages");
    let release;
    app.delay(() => new Promise(resolve => { release = resolve; }));
    await page.locator("#comparisonSearch").fill("request 0");
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.locator("#outcomeFilter-control").click();
    const choice = page.locator('.select-popup .select-option[data-value="failure"]');
    await choice.click();
    await expect(choice).toHaveAttribute("aria-selected", "false");
    release(); app.delay(null);
    await expect(page.locator("#periodComparisonStatus")).toContainText("Comparing retained activity only");
    await expect(page.locator("#outcomeFilter-control")).toHaveAttribute("aria-expanded", "true");
    await expect(choice).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Escape");
    await expect(page.locator("#outcomeFilter-control")).toContainText("A: 2; B: 0");
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("result"), null);
});

test("inconsistent derived response shows an error and clears comparison tables and facet labels", { timeout: 30000 }, async t => {
    const app = await setup(t), { page } = app;
    await openComparison(app);
    app.alterComparison(value => { value.comparison.outcomes.change.success = 1; });
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Comparison facts do not match");
    await expect(page.locator("#periodComparisonResults table")).toHaveCount(0);
    await expect(page.locator("#outcomeFilter-control")).not.toContainText("A:");
    app.alterComparison(value => { value.periods.baseline.analytics.resultFacet.totals.count = -1; });
    await page.getByRole("button", { name: "Retry comparison read", exact: true }).click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Comparison facts do not match");
    await expect(page.locator("#periodComparisonResults table")).toHaveCount(0);
    await expect(page.locator("#outcomeFilter-control")).not.toContainText("-1");
    app.alterComparison(null);
    await page.getByRole("button", { name: "Retry comparison read", exact: true }).click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Comparing retained activity only");
    await expect(page.locator("#outcomeFilter-control")).toContainText("A: 3; B: 4");
});
