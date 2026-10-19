import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { assessmentOverview, assessmentDependencies, buildAssessmentModel, invalidateAssessmentCache } from "../lib/assessment-read-model.mjs";
import { automaticScoreOffSummary, chooseTheme, selectActivityOption, restoreLegacySearch } from "./helpers.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";

const proof = process.env.WIRE_PERIOD_PROOFS;
async function setup(t, { polling = false, permissionFeedback = false } = {}) {
    const { state, input } = periodFixture();
    if (permissionFeedback) {
        const first = [...buildAssessmentModel(state).details.values()][0];
        state.personalEvaluation.feedback.records.push({
            schemaVersion: 1, dependencies: assessmentDependencies(first),
            assessment: { ...first.assessments.find(item => item.checkId === "action-authorization-compliance"),
                origin: "user-personal", assessmentRef: "assessment-" + "e".repeat(32), verdict: "fail", reason: "user-verdict" },
        });
        state.personalEvaluation.feedback.revision = 1;
        state.personalEvaluation.overrideRevision = 1;
    }
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
    await restoreLegacySearch(page, periodQuery);
    if (select) await page.locator("#select-request-period-request-0").check();
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    for (const [label, value] of [
        ["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"],
    ]) await page.getByLabel(label, { exact: true }).fill(value);
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
}

test("Tool latency period labels identify matching aggregates and exact tool records without changing values", { timeout: 45000 }, async t => {
    const app = await setup(t), { page } = app;
    await openComparison(app);
    const root = page.locator("#periodComparison");
    const region = root.locator(".compare-latency");
    await expect(region.locator("h4")).toHaveText(["Median", "95th percentile"]);
    const before = await region.innerText();
    const metrics = structuredClone(app.replies.at(-1).comparison.matchingCallTiming);
    assert.equal(metrics.median.baseline.value, 0);
    assert.equal(metrics.p95.baseline.value, 1000);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1280, 1], [375, 2]]) {
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        assert.equal(await region.innerText(), before);
        await expect(region.locator("svg")).toHaveCount(2);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
        const first = root.locator('[data-period-side="baseline"]');
        await page.locator("#comparisonRecordsA").click();
        await expect(first).toBeVisible();
        await expect(first.locator("table")).toContainText("Tool latency");
        if (proof) {
            await mkdir(proof, { recursive: true });
            await region.screenshot({ path: path.join(proof, `tool-latency-period-${theme}-${width}-${scale}.png`) });
        }
    }
    assert.deepEqual(app.replies.at(-1).comparison.matchingCallTiming, metrics);
});

test("F13 period visualization separates permission feedback from tool-use matching without changing facts", { timeout: 30000 }, async t => {
    const app = await setup(t, { permissionFeedback: true }), { page } = app;
    await page.goto(app.url + "#analyze?compare=periods&services=Files&includeMissingService=true&aFrom=2026-03-07&aTo=2026-03-07&bFrom=2026-03-08&bTo=2026-03-09");
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    const root = page.locator("#periodComparison");
    const first = root.locator('[data-period-side="baseline"]');
    await expect(first.locator('[data-finding-origin="model-assessed"]')).toContainText("Tool use");
    await expect(first.locator('[data-finding-origin="user-personal"]')).toContainText("Permission");
    await expect(first.locator('[data-finding-origin="user-personal"]')).toContainText("not given");
    const details = root.getByText("Compare saved checks and full-interaction timing", { exact: true });
    await details.focus(); await page.keyboard.press("Enter");
    const table = root.getByRole("table", { name: "Saved reviews and measurements by source and method" });
    await expect(table).toContainText("Tool use vs. request");
    await expect(table).toContainText("Permission for tool use");
    await expect(table).not.toContainText("action-intent-alignment");
    await expect(table).not.toContainText("action-authorization-compliance");
    await expect(table).toContainText("assessed requests");
    await expect(table).toContainText("timed calls");
    await expect(table).toContainText("No comparable saved review on this side");
    await expect(table).toContainText("Some requests lack review results");
    await expect(table).toContainText("Smaller share with review results");
    await expect(table).toContainText("Some calls lack timing");
    await expect(table).toContainText("Smaller share with timing");
    await expect(table).not.toContainText("partial-coverage");
    await expect(table).not.toContainText("coverage-decreased");
    assert.ok(app.replies.at(-1).comparison.metrics.some(row => row.result?.warnings.includes("partial-coverage")));
    assert.ok(app.replies.at(-1).comparison.metrics.some(row => row.result?.warnings.includes("coverage-decreased")));
    const modelMetric = app.replies.at(-1).periods.baseline.assessment.metrics.find(row => row.checkId === "action-intent-alignment");
    assert.equal(modelMetric.numerator, 1); assert.equal(modelMetric.denominator, 2);
    if (proof) {
        await mkdir(proof, { recursive: true });
        await table.screenshot({ path: path.join(proof, "F13-period-review-labels.png") });
        await writeFile(path.join(proof, "F13-period-facts.json"), JSON.stringify(app.replies.at(-1).comparison.metrics, null, 2));
    }
});

test("comparison review labels use intrinsic space without splitting Permission or overflowing long labels", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t, { permissionFeedback: true });
    await page.goto(url + "#analyze?compare=periods&services=Files&includeMissingService=true&aFrom=2026-03-07&aTo=2026-03-07&bFrom=2026-03-08&bTo=2026-03-09");
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    const lane = page.locator('[data-period-side="baseline"] [data-finding-origin="user-personal"]');
    const label = lane.locator(".assessment-compact-verdicts strong");
    await expect(label).toHaveText("Permission");
    for (const [width, scale] of [[1440, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const geometry = await label.evaluate(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return { lines: [...range.getClientRects()].length, text: node.textContent,
                overflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.equal(geometry.lines, 1, JSON.stringify({ width, scale, ...geometry }));
        assert.ok(geometry.overflow <= 1, JSON.stringify(geometry));
        await expect(lane).toContainText("not given");
        await expect(lane.locator(".period-review-coverage")).toHaveText("1 / 3 reviewed");
        const aligned = await page.locator('[data-period-side="baseline"] .assessment-compact-verdicts').evaluateAll(lists =>
            lists.map(list => [...list.children].map(row => ({
                labelRight: row.querySelector("strong").getBoundingClientRect().right,
                resultLeft: row.querySelector(".period-review-result").getBoundingClientRect().left,
                coverageLeft: row.querySelector(".period-review-coverage").getBoundingClientRect().left,
            }))));
        for (const rows of aligned) for (const row of rows) {
            assert.ok(row.labelRight <= row.resultLeft);
            assert.ok(Math.abs(row.resultLeft - rows[0].resultLeft) <= 1);
            assert.ok(Math.abs(row.coverageLeft - rows[0].coverageLeft) <= 1);
        }
    }
    await label.evaluate(node => { node.textContent = "Saved review (type not recorded)"; });
    const wrapped = await label.evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return { lines: [...range.getClientRects()].length, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    assert.ok(wrapped.lines > 1);
    assert.ok(wrapped.overflow <= 1);
});

test("comparison findings show labeled counts for full interactions and keep all disclosure anchors stable", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t, { permissionFeedback: true });
    await page.goto(url + "#analyze?compare=periods&services=Files&includeMissingService=true&aFrom=2026-03-07&aTo=2026-03-07&bFrom=2026-03-08&bTo=2026-03-09");
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    const root = page.locator("#periodComparison");
    const a = root.locator('[data-period-side="baseline"]'), b = root.locator('[data-period-side="later"]');
    const pairs = locator => locator.evaluate(node => [...node.children].map(row => [
        row.querySelector("dt").textContent, row.querySelector("dd").textContent,
    ]));
    assert.deepEqual(await pairs(a.locator(".period-count-facts").first()), [["Interactions", "3"]]);
    assert.deepEqual(await pairs(a.locator(".period-outcome-counts")), [["Succeeded", "3"], ["Failed", "1"], ["Other or missing outcome", "1"]]);
    assert.deepEqual(await pairs(b.locator(".period-outcome-counts")), [["Succeeded", "2"], ["Failed", "1"], ["Other or missing outcome", "1"]]);
    await expect(a.getByRole("heading", { name: "Reported calls (5)", exact: true })).toBeVisible();
    await expect(b.getByRole("heading", { name: "Reported calls (4)", exact: true })).toBeVisible();
    await expect(a).toContainText("Exact matching records (4)");
    await expect(a.locator('[data-finding-kind="cause"]')).toHaveText("Work IQ sign-in required1 call");
    await expect(b.locator('[data-finding-kind="cause"]')).toHaveText("Cause not retained1 call");
    await expect(root).not.toContainText("Reported outcomes:");
    await expect(root).not.toContainText("verified full interactions");
    await expect(root).not.toContainText("Each record counts once");
    await expect(a.locator('[data-finding-origin="model-assessed"] .period-review-coverage').first()).toHaveText("2 / 3 reviewed");
    await expect(b.locator(".assessment-findings")).toContainText("Review could not finish");
    const summaries = root.locator("details > summary");
    assert.equal(await summaries.count(), 7);
    for (const summary of await summaries.all()) {
        await summary.evaluate(node => node.scrollIntoView({ block: "center" }));
        const before = await summary.evaluate(node => ({ top: node.getBoundingClientRect().top, y: scrollY }));
        for (let i = 0; i < 4; i++) {
            await summary.click();
            const after = await summary.evaluate(node => ({ top: node.getBoundingClientRect().top, y: scrollY }));
            assert.deepEqual(after, before);
        }
    }
    await a.locator(".assessment-saved-details > summary").click();
    await a.getByRole("button", { name: "Measure definitions", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Comparison measure definitions" })).toBeVisible();
});

test("normal Analyze compares both periods, keeps precise scope and supports Back, themes and narrow 200% text", { timeout: 60000 }, async t => {
    const app = await setup(t), { page } = app;
    await openComparison(app, { select: true });
    const root = page.locator("#periodComparison"), a = root.locator('[data-period-side="baseline"]'), b = root.locator('[data-period-side="later"]');
    await expect(a).toContainText("Exact matching records (3)");
    await expect(b).toContainText("Exact matching records (4)");
    await expect(root).toContainText("Whole interactions");
    await expect(a.locator(".assessment-findings")).toContainText("Work IQ sign-in required");
    await expect(root).toContainText("+50 percentage points");
    await expect(root).toContainText("0 ms; 2 / 3 calls timed");
    await expect(root).toContainText("3,000 ms; 2 / 4 calls timed");
    await expect(page.locator("#outcomeFilter-control")).toContainText("A: 3; B: 4");
    await expect(page.locator("#dateFilter-control")).not.toBeVisible();
    await expect(page.locator("#pageAction")).not.toBeVisible();
    await expect(page.locator("#periodComparisonResultsTitle")).toBeFocused();
    assert.equal(new URL(page.url()).hash.includes(periodQuery), false);
    assert.equal(app.requests.filter(item => item.route === "/api/period-comparison").at(-1).input.scenarioIds.includes("period-request-5"), true);
    assert.equal(app.replies.at(-1).periods.baseline.assessment.metrics.find(metric => metric.definitionId === "tool-duration").coverage.eligible, 4);
    const layouts = [];
    for (const [theme, width, scale] of [["light", 1365, 1], ["dark", 1365, 1], ["light", 375, 2], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const geometry = await page.locator("#periodComparisonSetup").evaluate(node => ({
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
    await expect(root).toBeVisible(); await expect(page.locator("#createPeriodReport")).toBeVisible();
    await expect(page.locator("#comparisonSearch")).toHaveValue(periodQuery);
    await expect(a.locator(".assessment-saved-details")).toHaveAttribute("open", "");
    await page.getByRole("button", { name: "Stop comparing" }).click();
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
    await expect(root.locator('[data-period-side="later"]')).toContainText("Exact matching records (2)");
    await restoreLegacySearch(page, "no invented match");
    await expect(root).toContainText("No matching retained activity in either period");
    await expect(root.locator("table")).toHaveCount(0);
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    app.fail(true);
    await restoreLegacySearch(page, periodQuery);
    await expect(page.locator("#periodComparisonStatus")).toContainText("stored revision changed");
    await expect(root.locator("[data-period-side]")).toHaveCount(0);
    app.fail(false);
    await root.getByRole("button", { name: "Retry comparison read" }).click();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    let release;
    app.delay(input => input.scenarioIds.length === 0 ? new Promise(resolve => { release = resolve; }) : undefined);
    await restoreLegacySearch(page, "no match again");
    await expect.poll(() => Boolean(release)).toBe(true);
    await restoreLegacySearch(page, periodQuery);
    await expect(root.locator('[data-period-side="later"]')).toContainText("Exact matching records (2)");
    release(); app.delay(null);
    await expect(root.locator('[data-period-side="later"]')).toContainText("Exact matching records (2)");
    await expect(page.locator("#pageAction")).not.toBeVisible();
    await page.getByRole("button", { name: "Stop comparing" }).click();
    await expect(page.locator("#activityTitle")).toHaveText("Activity");
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
    await expect(page.locator('[data-analyze-mode],#callSortControls')).toHaveCount(0);
});

test("an in-flight comparison is invalidated during an unchanged stored reread and can restart afterward", { timeout: 30000 }, async t => {
    const app = await setup(t), { page } = app;
    await openComparison(app);
    let releaseComparison, releaseSnapshot;
    app.delay(() => new Promise(resolve => { releaseComparison = resolve; }));
    await restoreLegacySearch(page, "request 0");
    await expect.poll(() => Boolean(releaseComparison)).toBe(true);
    app.delaySnapshot(() => new Promise(resolve => { releaseSnapshot = resolve; }));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => Boolean(releaseSnapshot)).toBe(true);
    await expect(page.locator("#periodComparisonStatus")).toContainText("updating or stale");
    await expect(page.locator("#periodComparison [data-period-side]")).toHaveCount(0);
    releaseComparison(); app.delay(null);
    releaseSnapshot(); app.delaySnapshot(null);
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("Exact matching records (2)");
});

test("a permission-basis observation clears displayed findings while the accepted snapshot remains deferred", { timeout: 30000 }, async t => {
    const app = await setup(t, { polling: true }), { page } = app;
    await openComparison(app);
    const snapshots = () => app.requests.filter(item => item.route === "/api/snapshot").length;
    const before = snapshots();
    await page.locator("#periodComparisonTitle").focus();
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
    await expect(page.locator('[data-period-side="later"]')).toContainText("Exact matching records (1)");
    await selectActivityOption(page, "outcomeFilter", "all");
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("Exact matching records (3)");
    let release;
    app.delay(() => new Promise(resolve => { release = resolve; }));
    await restoreLegacySearch(page, "request 0");
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.locator("#outcomeFilter-control").click();
    const choice = page.locator('.select-popup .select-option[data-value="failure"]');
    await choice.click();
    await expect(choice).toHaveAttribute("aria-selected", "false");
    release(); app.delay(null);
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await expect(page.locator("#outcomeFilter-control")).toHaveAttribute("aria-expanded", "true");
    await expect(choice).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Escape");
    await expect(page.locator("#outcomeFilter-control")).toContainText("All results");
    await page.locator("#outcomeFilter-control").click();
    await expect(page.locator('.select-popup .select-option[data-value="failure"] .select-option-count')).toHaveText("A: 1; B: 0");
    await page.keyboard.press("Escape");
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
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("Exact matching records (3)");
    await expect(page.locator('[data-period-side="later"]')).toContainText("Exact matching records (4)");
});
