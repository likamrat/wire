import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { assessmentOverview, buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { automaticScoreOffSummary, chooseTheme, fixture, selectActivityOption, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";
import { visualWidgetFixture } from "./visual-widget-fixture.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { chooseReportScope } from "./report-journey-helpers.mjs";

const proof = process.env.WIRE_VISUAL_WIDGET_PROOFS;
const baseline = process.env.WIRE_VISUAL_WIDGET_BASELINE === "1";
const ready = async page => {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#homeFindings")).not.toHaveAttribute("aria-busy", "true");
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
};
async function setup(t, state = visualWidgetFixture(), { legacy = false } = {}) {
    const original = structuredClone(state), model = buildAssessmentModel(state), reads = [], errors = [], denied = [];
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "wire-visual-widgets-"));
    const contract = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    const collection = { state: "not-configured", revision: state.revision, configVersion: 0, connected: false, config: null,
        cadence: { pollSeconds: 5 }, metrics: {}, historyIssues: [] };
    let fail = false, failOverview = false;
    const server = createServer(async (request, response) => {
        try {
            if (request.method === "GET" && request.url === "/") {
                response.setHeader("Content-Type", "text/html"); response.end(renderHtmlShell("a".repeat(64), "visual-widgets", UNBOUND_FIXTURE_BOOTSTRAP)); return;
            }
            if (request.method === "GET" && request.url === "/assets/assessment-contract.mjs") {
                response.setHeader("Content-Type", "text/javascript"); response.end(contract); return;
            }
            if (request.method === "GET" && request.url?.split("?")[0] === "/favicon.svg") { response.statusCode = 204; response.end(); return; }
            let body = ""; for await (const chunk of request) body += chunk;
            const input = JSON.parse(body || "{}");
            reads.push({ route: request.url, input });
            let data;
            if (request.url === "/api/snapshot") {
                if (fail) { response.statusCode = 503; response.end('{"error":"Invented snapshot read failure"}'); return; }
                data = await currentStatePayload({ dataDir }, state, input);
                data.collection = collection;
            } else if (request.url === "/api/assessment/overview") {
                if (failOverview) { response.statusCode = 503; response.end('{"error":"Invented review read failure"}'); return; }
                data = { schemaVersion: 1, basis: model.basis, data: assessmentOverview(state, model, input.interactionRefs) };
            }
            else if (request.url === "/api/assessment/detail") data = { schemaVersion: 1, basis: model.basis, data: model.details.get(input.interactionRef) };
            else if (request.url === "/api/evaluation/automatic/summary") data = automaticScoreOffSummary();
            else if (request.url === "/api/collection/status") data = collection;
            else { denied.push(request.url); response.statusCode = 403; data = { error: "Read-only fixture only" }; }
            if (legacy) {
                data = structuredClone(data);
                for (const value of [data.assessment?.overview, data.data]) if (value) {
                    delete value.reviewStatuses; delete value.assessmentAttempts;
                }
            }
            response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(data));
        } catch (error) { errors.push(error.stack); response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, timezoneId: "America/Los_Angeles", reducedMotion: "no-preference" });
    page.setDefaultTimeout(7000);
    page.on("pageerror", error => errors.push(error.stack));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === url) return route.continue();
        denied.push(route.request().url()); return route.abort();
    });
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true });
        assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.deepEqual(state, original);
    });
    await page.goto(url); await ready(page);
    return { page, browser, url, state, reads, fail: value => { fail = value; }, failOverview: value => { failOverview = value; } };
}
async function capture(page, name) {
    if (!proof) return;
    assert.equal(await page.evaluate(() => Boolean(window.widgetMotionActive)), false, "Never capture while sampling motion");
    await mkdir(proof, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(proof, `${name}-viewport.png`), animations: "disabled" });
    await page.screenshot({ path: path.join(proof, `${name}-full.png`), fullPage: true, animations: "disabled" });
    const clip = await page.locator(".analyze-dashboard").boundingBox();
    if (clip?.height) await page.screenshot({ path: path.join(proof, `${name}-widgets.png`), fullPage: true, clip, animations: "disabled" });
    await writeFile(path.join(proof, `${name}.txt`), await page.locator("body").ariaSnapshot());
}

test("service and operation rows have one inclusive heading without separators or explanatory badges", async t => {
    const { page } = await setup(t), widget = page.locator('[data-breakdown=services]');
    await expect(widget.locator("h3")).toHaveText("Services and operations");
    await expect(widget.locator(".percentage-denominator")).toHaveClass(/visually-hidden/);
    assert.equal(await widget.locator(".percentage-denominator").evaluate(node => getComputedStyle(node).clipPath), "inset(50%)");
    await expect(widget.locator(".percentage-service-separator")).toHaveCount(0);
    await expect(widget.locator('[data-service-basis=Search] .percentage-basis')).toHaveCount(0);
    await expect(widget).not.toContainText("Tool purpose");
    await expect(widget).not.toContainText("may overlap");
    await expect(widget.locator("[data-category=Files] .percentage-label")).toHaveAttribute("aria-label", /37 of 247 Work IQ tool calls \(15%\)/);
    await page.locator("#meaning > summary").click();
    await expect(page.locator("#percentageData [data-view-key='percentage:services:exact']")).toContainText("service totals can overlap");
});

test("rich mixed population stays visual at the normal root in both themes and widths", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    await expect(page.locator("#activityCount")).toHaveText("247");
    await expect(page.locator('[data-breakdown=tools] .percentage-legend-row')).toHaveCount(8);
    await expect(page.locator('#outcomeChart .percentage-legend-row[data-category="failure"]')).toHaveAttribute("data-count", "33");
    await expect(page.locator('#outcomeChart .percentage-legend-row[data-category="unknown"]')).toHaveAttribute("data-count", "2");
    if (!baseline) {
        await expect(page.locator("#periodHint")).toHaveText("79 interactions \u00b7 31 Copilot chats");
        await expect(page.locator("#homeFindings")).toContainText("4 review errors");
        await expect(page.locator("#homeFindings")).toContainText("1 unavailable");
        await expect(page.locator("#homeFindings p")).toHaveCount(0);
        await expect(page.locator("#homeFindings li,[data-breakdown=services] .percentage-coverage")).toHaveCount(0);
        await expect(page.locator('[data-breakdown=services] .percentage-content>.percentage-legend [data-category=Search]')).toHaveCount(0);
        await expect(page.locator('[data-service-basis=Search]')).toHaveAttribute("data-count", "84");
        await expect(page.locator('[data-service-basis=Discovery]')).toHaveAttribute("data-count", "63");
        await expect(page.locator('[data-service-basis=Assistance]')).toHaveAttribute("data-count", "20");
        await expect(page.locator('[data-service-basis=Unknown]')).toHaveAttribute("data-count", "4");
    }
    for (const theme of ["light", "dark"]) for (const width of [1600, 1280, 1024, 390]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme); await ready(page);
        const geometry = await page.evaluate(() => {
            const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
            return { outcomes: box(".analyze-outcome-summary"), chart: box(".analyze-chart-main"),
                tools: box('[data-breakdown="tools"]'), services: box('[data-breakdown="services"]'),
                overflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.ok(geometry.overflow <= 1);
        const clipped = await page.locator(".analyze-dashboard").evaluate(root =>
            [...root.querySelectorAll(".percentage-label,.percentage-value,button,h3,h4")].filter(node => node.checkVisibility())
                .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
        assert.deepEqual(clipped, []);
        for (const [a, b, paired] of [[geometry.outcomes, geometry.chart, width >= 1280], [geometry.tools, geometry.services, width >= 1024]]) {
            if (paired) {
                assert.ok(Math.abs(a.top - b.top) < 2);
                if (a === geometry.outcomes) assert.ok(Math.abs(a.bottom - b.bottom) < 2);
            }
            else assert.ok(b.top >= a.bottom);
        }
        if (!baseline) {
            await expect(page.locator("#chartGrouping")).toHaveCount(0);
            await expect(page.locator('[data-breakdown=services] h4,[data-breakdown=services] .percentage-service-scope')).toHaveCount(0);
            await expect(page.locator('[data-breakdown=services] .percentage-denominator')).toHaveClass(/visually-hidden/);
            await expect(page.locator('[data-service-basis=Search]')).not.toContainText("Tool purpose");
            await expect(page.locator('[data-service-basis=Discovery]')).toContainText("Discovery / preparation");
            await expect(page.locator('[data-service-basis=Unknown]')).toContainText("4 also have recorded targets");
            await expect(page.locator('[data-breakdown=services] .percentage-gap-list')).toHaveCount(0);
            await expect(page.locator('[data-service-basis=Unknown] .percentage-label')).toContainText("Path not recognized");
            await expect(page.locator('[data-service-basis=Assistance]')).toContainText("Copilot assistance");
            if (width >= 1280) assert.ok(geometry.outcomes.width < geometry.chart.width * .65, "The three-outcome summary yields room to dated activity");
            if (width === 1600) {
                assert.ok(geometry.services.height < 570, "Eight bars and two gap reasons fit without the former 640px widget");
                assert.ok(geometry.outcomes.width * geometry.outcomes.height < 190000, "The outcome widget no longer spends a chart-sized area on three values");
            }
            const bars = await page.locator("#percentageCharts .percentage-bar-track").evaluateAll(nodes => nodes.map(track => ({
                width: track.getBoundingClientRect().width, fill: track.firstElementChild.getBoundingClientRect().width,
                fraction: Number(track.firstElementChild.dataset.fraction),
                group: track.closest("[data-breakdown]").dataset.breakdown,
            })));
            for (const bar of bars) assert.ok(Math.abs(bar.fill - bar.width * bar.fraction) < .05, "Every bar uses the actual denominator");
            for (const group of ["tools", "services"]) {
                const widths = bars.filter(bar => bar.group === group).map(bar => bar.width);
                assert.ok(Math.max(...widths) - Math.min(...widths) < 1, "Equal shares have equal physical lengths within each widget");
            }
        }
        await capture(page, `${baseline ? "before" : "after"}-rich-${theme}-${width}`);
        if (proof) await writeFile(path.join(proof, `geometry-${theme}-${width}.json`), JSON.stringify(geometry, null, 2));
        if (!baseline && width === 390) {
            await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await expect(page.locator("#homeFindings")).toContainText("4 review errors");
            await expect(page.locator('[data-service-basis=Unknown]')).toHaveAttribute("data-count", "4");
            await capture(page, `after-rich-${theme}-${width}-200`);
            await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        }
    }
});

test("sparse and dense service widgets retain every target, gap and linear share", { skip: baseline, timeout: 60000 }, async t => {
    const sparse = fixture("widget-sparse");
    sparse.toolCalls = [{ ...sparse.toolCalls[0], tool: "workiq-ask", requestArgs: { question: "Find invented notes" }, requestedApiPath: null }];
    const dense = fixture("widget-dense");
    const paths = ["/me/messages", "/me/calendarView", "/me/drive/root", "/me/chats", "/me/people",
        "/planner/plans", "/me/onenote/notebooks", "/groups", "/search/query"];
    dense.toolCalls = [
        { ...dense.toolCalls[0], requestArgs: { entityUrls: [...paths, "/unrecognized/resource", "https://unsupported.example.invalid/target"] }, requestedApiPath: null },
        { tool: "workiq-get_schema", toolCallId: "dense-prep", startEventId: "dense-prep-start",
            requestArgs: { path: "/me/messages" }, toolSucceeded: true },
        { tool: "workiq-retrieve", toolCallId: "dense-purpose", startEventId: "dense-purpose-start",
            requestArgs: { query: "Invented notes" }, toolSucceeded: true },
    ];
    for (const [name, record] of [["sparse", sparse], ["dense", dense]]) {
        const { page, state } = await setup(t, qualityDisplayFixture({ records: [record] }).state);
        const expected = buildActivityAnalytics(state.evidence), widget = page.locator('[data-breakdown=services]');
        for (const [theme, width, textSize] of [["light", 1600, ""], ["dark", 1280, ""], ["light", 390, ""], ["dark", 390, "200%"]]) {
            await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
            await page.evaluate(size => { document.documentElement.style.fontSize = size; }, textSize); await ready(page);
            await expect(widget.locator("h3")).toHaveCount(1);
            await expect(widget.locator("h4,.percentage-service-scope,details")).toHaveCount(0);
            await expect(widget.locator(".percentage-gap-list dd")).toHaveCount(name === "sparse" ? 0 : 2);
            if (name === "sparse") {
                await expect(widget.locator("[data-category]")).toHaveCount(0);
                await expect(widget.locator("[data-service-basis=Assistance]")).toHaveAttribute("data-count", "1");
                await expect(widget.locator("[data-service-basis=Unknown]")).toHaveCount(0);
                await expect(widget.locator(".percentage-empty")).toHaveCount(0);
            } else {
                await expect(widget.locator("[data-service-basis=Unknown]")).toHaveAttribute("data-count", "1");
                await expect(widget.locator("[data-category]")).toHaveCount(9);
                await expect(widget).toContainText("Reasons overlap");
                await expect(widget.locator("[data-service-basis=Unknown]")).toContainText("1 also have recorded targets");
                const rows = await widget.locator("[data-category]").evaluateAll(nodes => nodes.map(node => ({
                    id: node.dataset.category, count: Number(node.dataset.count),
                    fraction: Number(node.querySelector(".percentage-bar").dataset.fraction),
                })));
                for (const row of rows) {
                    const ids = expected.rows.filter(item => item.serviceAssociation.basis === "recorded-target"
                        && item.serviceAssociation.services.includes(row.id));
                    assert.equal(row.count, ids.length);
                    assert.equal(row.fraction, 1 / 3);
                }
                assert.ok(rows.reduce((sum, row) => sum + row.fraction, 0) > 1, "Overlapping targets are not normalized to 100%");
            }
            const clipped = await widget.evaluate(root => [...root.querySelectorAll(".percentage-label,.percentage-value,dt,dd")]
                .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
            assert.deepEqual(clipped, []);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            if (name === "dense" && width === 1600) {
                const tools = await page.locator('[data-breakdown=tools]').boundingBox(), services = await widget.boundingBox();
                assert.ok(tools.height < services.height * .6, "A short Tools list must not stretch to a dense Services list");
                assert.ok(Math.abs(tools.y - services.y) < 2, "Content-sized widgets still align side by side");
            }
            await capture(page, `after-${name}-${theme}-${width}${textSize ? "-200" : ""}`);
        }
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        if (name === "dense") {
            await widget.locator("[data-category=Mail] .percentage-label").focus();
            await page.keyboard.press("Enter"); await ready(page);
            await expect(page.locator("#activityCount")).toHaveText("1");
            await expect(page.locator("[data-service-basis=Unknown]")).toHaveAttribute("data-count", "1");
            await page.goBack(); await ready(page);
            await expect(page.locator("#activityCount")).toHaveText("3");
        }
    }
});

test("compact links preserve full causes, reviews, unknown reasons and permission definitions outside the donut", { skip: baseline }, async t => {
    const { page } = await setup(t), footer = page.locator("#homeFindings");
    await footer.getByRole("button", { name: "Failure details", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#analyzeReviewDetails")).toHaveAttribute("open", "");
    const findings = page.locator("#homeInsights .assessment-findings");
    for (const [cause, count] of [["unqualified", 23], ["workiq-sign-in-required", 3], ["request-timeout", 3], ["message-excluded", 4]]) {
        await expect(findings.locator(`[data-finding-cause="${cause}"]`)).toContainText(`${count} calls`);
    }
    await expect(findings).toContainText("/mcp auth workiq");
    await expect(findings).toContainText("Not enough saved evidence");
    await expect(findings).toContainText("not a failed verdict (4 requests)");
    await expect(findings).toContainText("Assessment evidence or approval unavailable (1 request)");
    await expect(findings.locator('[data-finding-dimension="accuracy"]')).toContainText("1 correct, 1 not correct");
    await page.locator("#homeInsights .assessment-saved-details > summary").click();
    await expect(page.locator("#homeInsights .assessment-saved-details")).toContainText("Matching the request is not proof of human permission");
    await expect(page.locator("#homeInsights .assessment-saved-details")).toContainText("79");
    await capture(page, "after-rich-review-destination");
    await page.locator("#analyzeReviewDetails > summary").click();
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("212");
    await expect(page.locator('#outcomeChart .percentage-legend-row[data-category=failure]')).toHaveAttribute("data-count", "0");
    await expect(footer).toContainText("33 failed calls");
    await expect(footer.locator("p")).toHaveText("Details include all 247 calls in matching interactions.");
    await capture(page, "after-success-filter-full-interaction-failures");
});

test("service bars drill into exact deduped calls and preserve reader Back, selection and report inputs", { skip: baseline }, async t => {
    const { page, url, state, reads } = await setup(t);
    const analytics = buildActivityAnalytics(state.evidence), expected = key => analytics.rows.filter(row =>
        key === "Assistance" ? row.tool === "workiq-ask" && row.serviceAssociation.gaps.some(gap => gap.reason === "hosted-routing")
            : key === "Search" ? row.serviceAssociation.basis === "tool-purpose"
            : key === "Discovery" ? row.serviceAssociation.status === "not-applicable" : row.serviceAssociation.services.includes(key));
    await page.locator("#activityList input[type=checkbox]").first().check();
    const selection = await page.locator("#activitySelectionSummary").innerText();
    for (const service of ["Files", "Search", "Discovery", "Assistance"]) {
        const selector = service === "Files" ? '[data-breakdown=services] [data-category=Files] .percentage-label'
            : `[data-service-basis=${service}] .percentage-label`;
        await page.locator(selector).click(); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText(String(expected(service).length));
        const last = reads.filter(row => row.route === "/api/snapshot").at(-1);
        const filtered = buildActivityAnalytics(state.evidence, last.input);
        const visible = service === "Files" ? filtered.rows.filter(row => row.serviceAssociation.services.includes("Files")) : filtered.rows;
        assert.deepEqual(new Set(visible.map(row => row.id)), new Set(expected(service).map(row => row.id)));
        await expect(page.locator("#activitySelectionSummary")).toHaveText(selection);
        await page.locator("#activityList .request-link").first().click();
        await expect(page.locator("#requestView")).toBeVisible();
        await page.goBack(); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText(String(expected(service).length));
        await expect(page.locator("#activitySelectionSummary")).toHaveText(selection);
        await page.goBack(); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("247");
    }
    await page.locator("#meaning > summary").click();
    const exact = page.locator("#percentageData [data-view-key='percentage:services:exact']");
    await expect(exact).toContainText("24 records have missing service details; 4 of those also have recorded targets");
    await expect(exact).toContainText("Not in this record: 20");
    await expect(exact).toContainText("Path not recognized: 4");
    await expect(exact.locator("tbody")).toContainText("Search and retrieval");
    await page.locator('#analyzeResultActions a[href^="#reports"]').click();
    await chooseReportScope(page, "selected");
    await expect(page.locator("#scopeSummary")).toContainText("1");
    await expect(page.locator("#scopeCount-all")).toContainText("79");
    assert.equal(reads.some(row => /preview|save|evaluation\/run|approval/.test(row.route)), false);
    await page.goto(url); await ready(page);
});

test("empty, no-match, incomplete and failed reads are not replaced by a reassuring chart", { skip: baseline }, async t => {
    const app = await setup(t), { page, url } = app;
    await page.goto(url + "#analyze?range=custom&from=2025-01-01&to=2025-01-02"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#homeView")).toHaveAttribute("data-empty", "true");
    await expect(page.locator("#periodCoverageText")).toHaveText("Checked history is unknown; this view uses retained activity.");
    await capture(page, "after-no-match");
    await page.goto(url); await ready(page);
    app.failOverview(true);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await expect(page.locator("#homeFindings")).toContainText("Saved findings could not be read");
    await expect(page.locator("#homeFindings")).toContainText("Invented review read failure");
    await expect(page.locator("#activityCount")).toHaveText("33");
    await capture(page, "after-failed-review-read");
    app.failOverview(false); app.fail(true);
    await page.locator("#checkActivity").click();
    await expect(page.locator("#periodHint")).toContainText("The update failed");
    await expect(page.locator("#activityCount")).toHaveText("33");
    await capture(page, "after-stale-snapshot");
});

test("mixed Search evidence keeps separate visual counts and the existing exact aggregate drilldown", { skip: baseline }, async t => {
    const record = fixture("widget-mixed-search");
    record.toolCalls = [
        { tool: "workiq-retrieve", toolCallId: "purpose", startEventId: "purpose-start",
            requestArgs: { query: "Invented survey notes" }, toolSucceeded: true },
        { tool: "workiq-fetch", toolCallId: "target", startEventId: "target-start",
            requestArgs: { entityUrl: "/search/query" }, toolSucceeded: true },
    ];
    const { page } = await setup(t, qualityDisplayFixture({ records: [record] }).state);
    const target = page.locator('[data-breakdown=services] [data-category=Search]');
    await expect(target).toHaveAttribute("data-count", "1");
    await expect(target.locator("a")).toHaveCount(0);
    await expect(page.locator('[data-service-basis=Search]')).toHaveAttribute("data-count", "1");
    await page.locator("#meaning > summary").click();
    const aggregate = page.locator("#percentageData [data-view-key='percentage:services:exact'] tbody tr")
        .filter({ hasText: "Search and retrieval" });
    await expect(aggregate).toContainText("2");
    await expect(aggregate).toContainText("100%");
    await aggregate.locator("a").click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    await page.locator('[data-service-basis=Search] .percentage-bar-track').click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator('[data-breakdown=services] .percentage-content>.percentage-legend [data-category]')).toHaveCount(0);
});

test("legacy coverage and a truly empty collection remain explicit", { skip: baseline }, async t => {
    const { page } = await setup(t, visualWidgetFixture(), { legacy: true });
    await expect(page.locator("#homeFindings")).toContainText("Call context incomplete");
    await expect(page.locator("#homeFindings")).toContainText("Review coverage incomplete");
    await page.locator("#homeFindings").getByRole("button", { name: "Call context incomplete" }).click();
    await expect(page.locator("#homeInsights .assessment-findings")).toContainText("Detailed call-status context is unavailable");
    await capture(page, "after-partial-review-coverage");
    const empty = qualityDisplayFixture({ requests: 0, calls: 0, finalDuration: null }).state;
    const app = await setup(t, empty);
    await expect(app.page.locator("#activityCount")).toHaveText("0");
    await expect(app.page.locator("#homeView")).toHaveAttribute("data-empty", "true");
    await expect(app.page.locator(".percentage-ring:visible")).toHaveCount(0);
    await capture(app.page, "after-empty-collection");
});

test("visual widgets share the population date control rather than carrying separate range pickers", { skip: baseline }, async t => {
    const { page } = await setup(t);
    await expect(page.locator("#dateFilter-control")).toBeVisible();
    await expect(page.locator(".analyze-dashboard [role=combobox]")).toHaveCount(0);
    await expect(page.locator("#activityCount")).toHaveText("247");
});
