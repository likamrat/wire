import test from "node:test";
import assert from "node:assert/strict";
import { chooseReportScope } from "./report-journey-helpers.mjs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, selectActivityOption, navigateMain, chooseTheme, openActivitySessions, revealStoredRefresh } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_OUTCOME_PROOFS;
function records() {
    const mixed = fixture("a-mixed");
    mixed.sourceSessionName = "Synthetic results session";
    mixed.userPrompt.text = "MIXED_PRIVATE: compare recorded results " + "with a deliberately long request excerpt ".repeat(14);
    mixed.toolCalls = [true, false, null].map((toolSucceeded, index) => ({
        ...structuredClone(mixed.toolCalls[0]), toolCallId: `mixed-${index}`, startEventId: `mixed-start-${index}`,
        startedAt: `2026-09-0${index + 1}T12:00:00Z`, toolSucceeded, reportedOutcome: "unknown",
        apiResults: index === 0 ? [{ index: 0, statusCode: 200 }, { index: 1, statusCode: 429 }, { index: 2 }] : [],
    }));
    const pure = (id, succeeded, projectId = "test-project") => {
        const source = fixture(id);
        source.userPrompt.text = "Synthetic " + id + " request";
        source.sourceSessionName = "Synthetic results session";
        source.projectId = projectId;
        source.project = projectId ? "Synthetic project" : null;
        source.toolCalls[0] = { ...source.toolCalls[0], startedAt: "2026-09-02T12:00:00Z", toolSucceeded: succeeded, reportedOutcome: "unknown" };
        return source;
    };
    const code = pure("code-only", null);
    code.toolCalls = [];
    code.graphActivities = [null, "code", 503].map((status, index) => ({
        activityId: "graph-" + index, sourceSessionId: code.sourceSessionId, scenarioId: code.scenarioId, toolCallId: "shell-" + index, startEventId: "graph-start-" + index, method: "GET",
        startedAt: "2026-09-02T12:00:00Z", tool: "shell",
        evidenceLevel: status === "code" ? "code-reference" : status === null ? "requested-direct-graph" : "output-visible-http",
        endpoint: { path: "/me/messages", method: "GET", apiVersion: "v1.0", queryShape: [] },
        workload: "Mail", httpStatus: typeof status === "number" ? status : null,
        statusBasis: typeof status === "number" ? "explicit-output-status" : "none",
        requestCount: null, countUnit: "recorded-request-site", confidence: "high", synthetic: false,
        sourceKind: "inline-command", requestBasis: "request-command",
        fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
    }));
    const alias = { ...structuredClone(mixed), scenarioId: "legacy-mixed", isLegacy: true };
    return [mixed, pure("all-worked", true), pure("failure-only", false), pure("no-completion", null, null), code, alias];
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await openActivitySessions(page);
}
async function setup(t, source = records()) {
    const cleanup = [];
    const { context: store } = await privateFixture({ after: action => cleanup.push(action) }, source);
    const stateName = (await readdir(store.dataDir)).find(name => name.endsWith(".state.json"));
    const before = await readFile(path.join(store.dataDir, stateName));
    const runtime = await startServer(store, createExportController(store), { port: 0 });
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, locale: "en-US", timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    const errors = [], posts = [];
    context.on("page", page => {
        page.setDefaultTimeout(8000);
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    });
    await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw new Error("No clipboard reads permitted in context proof."); },
        writeText() { throw new Error("No clipboard writes permitted in context proof."); },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await readFile(path.join(store.dataDir, stateName)), before);
            assert.deepEqual(errors, []);
            assert.ok(posts.every(url => ["/api/snapshot", "/api/assessment/detail", "/api/assessment/overview"].includes(url)), "Context navigation is read-only");
        } finally { for (const action of cleanup) await action(); }
    });
    if (proofDir) await mkdir(proofDir, { recursive: true });
    return { context, url: runtime.url, posts };
}
const mixedCard = page => page.locator("#activityList .request-row").filter({ hasText: "MIXED_PRIVATE" });
async function outcomes(locator) {
    return locator.locator("[data-outcome]").evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.outcome, Number(node.dataset.count)])));
}
async function captureViews(page, prefix) {
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator(".recorded-results:visible").evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().right <= innerWidth && node.scrollWidth <= node.clientWidth + 1)), true, `${prefix} results must fit their actual visible container at ${width}px`);
        await page.evaluate(() => window.scrollTo(0, 0));
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `${prefix}-${theme}-${width}.png`), fullPage: true });
    }
}

test("result drilldown, full request, report scope and history retain exact visible context", { timeout: 60000 }, async t => {
    const { context, url, posts } = await setup(t);
    const page = await context.newPage();
    await page.goto(url); await ready(page);
    assert.match(await page.locator("#viewingContext").innerText(), /6 Work IQ tool calls/);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    assert.equal(await page.locator("#homeView").isVisible(), true);
    await navigateMain(page, "activity"); await ready(page);
    assert.match(await page.locator("#viewingContext").innerText(), /2 Work IQ tool calls.*Tool failed/s);
    assert.equal(await page.locator("#activityList .request-row").count(), 2, "Alias-only cards do not duplicate canonical totals");
    assert.deepEqual(await outcomes(mixedCard(page)), { failure: 1 });
    assert.match(await mixedCard(page).innerText(), /1 of 3 Work IQ tool calls in this view/);
    await navigateMain(page, "home"); await ready(page);
    await page.locator(".time-stack").first().click(); await ready(page);
    assert.match(await page.locator("#viewingContext").innerText(), /Tool failed.*Sep/s);
    await page.locator("#activitySearch").fill("MIXED_PRIVATE");
    const filteredUrl = page.url();
    assert.doesNotMatch(filteredUrl, /MIXED_PRIVATE/);
    assert.match(await page.locator("#viewingContext").innerText(), /1 Work IQ tool call.*Private search applied/s);
    const reads = posts.filter(url => url === "/api/snapshot").length;
    await mixedCard(page).locator(".request-link").focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.equal(posts.filter(url => url === "/api/snapshot").length, reads, "Drilldown uses the already-consistent snapshot; insights are a separate cached read");
    assert.equal(new URL(page.url()).hash.includes("session="), false, "Opening a request does not silently narrow the return filter");
    await page.getByText("Originating view and filters", { exact: true }).click();
    assert.match(await page.locator("#viewingContext").innerText(), /Viewing full request from.*Tool failed.*Private search applied/s);
    assert.match(await page.locator("#requestContent").innerText(), /Recorded results/);
    assert.deepEqual(await outcomes(page.locator(".full-request-results [data-result-layer=tool]")), { success: 1, failure: 1, unknown: 1 });
    const journey = page.locator(".journey-item");
    assert.equal(await journey.count(), 3);
    assert.deepEqual(await outcomes(journey.nth(0).locator(".journey-result")), { success: 1 });
    assert.match(await journey.nth(0).innerText(), /Outside current view/);
    assert.match(await journey.nth(1).innerText(), /1 matching Work IQ tool call in current view/);
    await captureViews(page, "request-context");
    await page.reload(); await ready(page);
    await page.getByText("Originating view and filters", { exact: true }).click();
    assert.match(await page.locator("#viewingContext").innerText(), /Private search applied/);
    await page.locator("#pageHeadingActions").getByRole("link", { name: "Back to filtered activity" }).click(); await ready(page);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.split("?")[1])), Object.fromEntries(new URLSearchParams(new URL(filteredUrl).hash.split("?")[1])));
    assert.equal(await page.locator("#activitySearch").inputValue(), "MIXED_PRIVATE");
    await mixedCard(page).locator("input").check();
    await navigateMain(page, "reports"); await ready(page);
    await page.locator("#scopeDetails > summary").click();
    assert.match(await page.locator("#scopeSummary").innerText(), /1 request group:.*3 Work IQ tool calls/s);
    assert.match(await page.locator("#reportMatchingContext").innerText(), /1 matching Work IQ tool call/);
    for (const kind of ["all", "current", "selected"]) {
        await chooseReportScope(page, kind);
        assert.match(await page.locator("#scopeSummary").innerText(), new RegExp(kind === "all" ? "6 Work IQ tool calls" : "3 Work IQ tool calls"));
    }
    await page.locator(".report-scope-details>summary").click();
    assert.deepEqual(await outcomes(page.locator("#reportList [aria-label='Full report request results'][data-result-layer=tool]")), { success: 1, failure: 1, unknown: 1 });
    await captureViews(page, "report-context");
    await page.locator("#reportList .request-link").click(); await ready(page);
    await page.locator("#pageHeadingActions").getByRole("link", { name: "Back to report scope" }).click(); await ready(page);
    assert.equal(await page.locator("[name=reportScope][value=selected]").isChecked(), true);
    await page.goBack(); await ready(page);
    assert.match(new URL(page.url()).hash, /^#request/);
    await page.goForward(); await ready(page);
    assert.match(new URL(page.url()).hash, /^#reports/);
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    assert.doesNotMatch(await page.locator("#viewingContext").innerText(), /Tool failed|Private search applied/);
    assert.equal(await page.locator("#activitySearch").inputValue(), "");
});

test("request summaries use readable icon/text results in both themes at 375/820/1200", { timeout: 60000 }, async t => {
    const { context, url } = await setup(t), page = await context.newPage(), metrics = [];
    await page.goto(url + "#activity"); await ready(page);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        const cards = page.locator("#activityList .request-row");
        assert.equal(await cards.count(), 4);
        assert.deepEqual(await outcomes(mixedCard(page)), { success: 1, failure: 1, unknown: 1 });
        assert.deepEqual(await outcomes(cards.filter({ hasText: "Synthetic all-worked request" })), { success: 1 });
        assert.deepEqual(await outcomes(cards.filter({ hasText: "Synthetic failure-only request" })), { failure: 1 });
        assert.deepEqual(await outcomes(cards.filter({ hasText: "Synthetic no-completion request" })), { unknown: 1 });
        const measure = await page.evaluate(() => {
            const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
            const sample = [...document.querySelectorAll("#activityList .recorded-result")].map(node => {
                const style = getComputedStyle(node), fg = luminance(style.color);
                const painted = node.matches(".result-link") ? getComputedStyle(node, "::before").backgroundColor : style.backgroundColor;
                const bg = luminance(painted === "rgba(0, 0, 0, 0)" ? getComputedStyle(node.closest(".request-row")).backgroundColor : painted);
                return { size: parseFloat(style.fontSize), contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05), hiddenIcon: node.querySelector("svg").getAttribute("aria-hidden"), fits: node.getBoundingClientRect().right <= innerWidth };
            });
            const link = document.querySelector("#activityList .request-link");
            return { width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, sample,
                previewFits: link.scrollWidth <= link.clientWidth + 1, whiteSpace: getComputedStyle(link).whiteSpace,
                actionLabel: link.textContent,
                excerptDescription: document.getElementById(link.getAttribute("aria-describedby"))?.classList.contains("full-text-preview") };
        });
        assert.ok(measure.overflow <= 1);
        assert.ok(measure.sample.every(s => s.size >= 12 && s.contrast >= 4.5 && s.hiddenIcon === "true" && s.fits));
        assert.equal(measure.previewFits, true); assert.equal(measure.whiteSpace, "normal");
        assert.equal(measure.actionLabel, "View interaction"); assert.equal(measure.excerptDescription, true);
        assert.equal(await mixedCard(page).getByRole("button", { name: "Read prompt", exact: true }).count(), 1);
        metrics.push({ theme, ...measure });
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `results-${theme}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await page.addStyleTag({ content: "html {font-size:200%}" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#activityList .recorded-result").evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().right <= innerWidth && node.scrollWidth <= node.clientWidth + 1)), true);
    if (proofDir) await writeFile(path.join(proofDir, "result-layout-metrics.json"), JSON.stringify(metrics, null, 2));
});

test("partially overlapping request aliases do not double-count matching timeline actions", { timeout: 30000 }, async t => {
    const first = fixture("a-owner"), second = fixture("b-overlap");
    second.toolCalls.unshift(structuredClone(first.toolCalls[0]));
    second.userPrompt.text = "Synthetic overlapping request";
    const { context, url } = await setup(t, [first, second]), page = await context.newPage();
    await page.goto(url + "#activity?scope=all"); await ready(page);
    assert.match(await page.locator("#viewingContext").innerText(), /2 Work IQ tool calls/);
    const card = page.locator("#activityList .request-row").filter({ hasText: "Synthetic overlapping request" });
    assert.match(await card.innerText(), /1 of 2 Work IQ tool calls in this view/);
    await card.locator(".request-link").click(); await ready(page);
    assert.equal(await page.locator(".journey-item .action-context").filter({ hasText: "1 matching" }).count(), 1);
    assert.equal(await page.locator(".journey-item .action-context").filter({ hasText: "Outside current view" }).count(), 1);
    assert.deepEqual(await outcomes(page.locator(".full-request-results [data-result-layer=tool]")), { success: 2 });
});

test("source, project and date deep links preserve distinct API, Graph and nonexecution units", { timeout: 60000 }, async t => {
    const { context, url } = await setup(t), page = await context.newPage();
    await page.goto(url + "#activity?layer=reported-api&result=failure&project=test-project&from=2026-09-01&to=2026-09-01"); await ready(page);
    assert.match(await mixedCard(page).innerText(), /1 of 3 tool-returned API results in this view.*1 Error result/s);
    await mixedCard(page).locator(".request-link").click(); await ready(page);
    assert.deepEqual(await outcomes(page.locator(".journey-result").first()), { success: 1 }, "A failed API unit never overwrites its successful parent tool result");
    await page.goto(url + "#activity?layer=code-reference"); await ready(page);
    assert.match(await page.locator("#activityList").innerText(), /1 Execution not observed/);
    assert.equal(await page.locator("#activityList .card-result-scope").count(), 0);
    assert.doesNotMatch(await page.locator("#activityList").innerText(), /Tool completed|Tool failed/);
    await page.locator("#activityList .request-link").click(); await ready(page);
    assert.match(await page.locator(".journey-item").filter({ hasText: "Graph code reference" }).innerText(), /Execution not observed/);
    await page.goto(url + "#activity?layer=direct-request"); await ready(page);
    assert.match(await page.locator("#activityList").innerText(), /1 HTTP 4xx\/5xx.*1 No status recorded/s);
    assert.equal(await page.locator("#activityList .card-result-scope").count(), 0);
    await selectActivityOption(page, "layerFilter", "recorded-http"); await ready(page);
    assert.match(await page.locator("#viewingContext").innerText(), /1 Graph request site with visible status/);
    await page.goto(url + "#activity?project=unscoped&result=unknown"); await ready(page);
    assert.match(await page.locator("#viewingContext").innerText(), /1 Work IQ tool call.*No result recorded.*Copilot chat without a project/s);
    await selectActivityOption(page, "projectFilter", "test-project"); await ready(page);
    assert.equal(await page.locator("#activityList .request-row").count(), 1);
    await page.locator("#coverage>summary").click();
    await selectActivityOption(page, "scopeFilter", "all"); await ready(page);
    assert.equal(await page.locator("#activityList .request-row").count(), 1);
    assert.match(await page.locator("#viewingContext").innerText(), /Both collections/);
});

test("late or incomplete snapshots cannot relabel old counts as a new view", { timeout: 60000 }, async t => {
    const { context, url } = await setup(t), page = await context.newPage();
    await page.goto(url + "#activity"); await ready(page);
    let release, intercepted;
    const pending = new Promise(resolve => { intercepted = resolve; });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), input = route.request().postDataJSON();
        if (input.filters.outcomes?.[0] === "success") {
            intercepted();
            await new Promise(resolve => { release = resolve; });
        }
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", "success"); await pending;
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    release();
    await page.waitForTimeout(150);
    assert.match(await page.locator("#viewingContext").innerText(), /2 Work IQ tool calls.*Tool failed/s);
    assert.deepEqual(await outcomes(mixedCard(page)), { failure: 1 });
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.requestActivity = { tool: [null] };
        delete snapshot.exportCatalog.requests[0].counts.workIqActions;
        await route.fulfill({ response, json: snapshot });
    });
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.match(await mixedCard(page).innerText(), /full-request count unavailable/);
    await navigateMain(page, "reports"); await ready(page);
    await chooseReportScope(page, "all");
    await page.locator("#scopeDetails > summary").click();
    assert.match(await page.locator("#scopeSummary").innerText(), /unavailable.*not zero/);
    assert.equal(await page.locator("#exportBtn").isDisabled(), true);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.analytics.revision++;
        await route.fulfill({ response, json: snapshot });
    });
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.match(await page.locator("#message").innerText(), /last recorded snapshot.*changed during the read/s);
    assert.match(await page.locator("#viewingContext").innerText(), /2 Work IQ tool calls.*Tool failed/s);
});
