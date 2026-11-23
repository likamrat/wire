import test from "node:test";
import { openDatePicker } from "./analytics-date-picker.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { currentStatePayload } from "../lib/server.mjs";
import { loadBrowserAssets } from "../lib/browser-assets.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildTrends } from "../lib/trends.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { assessmentOverview, cachedAssessmentModel } from "../lib/assessment-read-model.mjs";
import { fixture, UNBOUND_FIXTURE_BOOTSTRAP, automaticScoreOffSummary, fulfillFixtureUpdateStatus, navigateSettings, restoreLegacySearch, selectActivityOption } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const visiblePanel = page => page.locator(".trends-panel:visible");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const day = "2026-09-30";
const privateTrends = "/trends?privateView=required";
const builds = new Map();
test.before(async () => {
    for (const renderer of ["react", "bundled"]) builds.set(renderer, await loadBrowserAssets({ renderer }));
});
async function setup(t, frontend, records) {
    const url = "http://127.0.0.1:51891", capability = "a".repeat(64), assets = builds.get(frontend);
    const state = { boardId: "invented-slice", pseudonymKey: randomBytes(32).toString("hex"), revision: 1, evidence: records,
        cards: Object.fromEntries(records.map(r => [r.scenarioId, { workflowState: "new", history: [] }])),
        exports: [], importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } };
    const before = structuredClone(state); let revision = state.revision;
    const collection = { state: "disconnected", revision: state.revision, configVersion: 0, connected: false, config: null,
        historyCoverage: null, historyIssues: [], metrics: {}, cadence: null };
    const browser = await chromium.launch({ channel: process.env.WIRE_FRONTEND_BROWSER });
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    const reads = [], errors = [], denied = [];
    t.after(async () => {
        try { await browser.close(); assert.deepEqual(state, before); }
        finally { assert.deepEqual(errors, []); assert.deepEqual(denied, []); }
    });
    page.on("pageerror", e => errors.push(e.message));
    page.setDefaultTimeout(5000);
    // Nothing connects to the address: use the real build and both production projections entirely in memory.
    await page.route("**/*", async route => {
        if (await fulfillFixtureUpdateStatus(route, url)) return;
        const request = route.request(), address = new URL(request.url()), p = address.pathname;
        if (address.origin === url && request.method() === "GET") {
            if (request.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: renderHtmlShell(capability, "fixture", UNBOUND_FIXTURE_BOOTSTRAP, assets) });
            const asset = assets.get(p); if (asset) return route.fulfill({ contentType: asset.type, body: asset.bytes });
            if (/^\/assets\/(?:assessment-contract|report-result-contract|period-comparison-math|report-outcome-comparison|report-metric-comparison|wire-report-metric-adapter)\.mjs$/.test(p)
                || p === "/web/recorded-results.mjs") return route.fulfill({ contentType: "text/javascript", body: await readFile(new URL(".." + p.replace("/assets/", "/lib/"), import.meta.url)) });
            if (p === "/favicon.svg" || p === "/favicon.ico") return route.fulfill({ status: 204 });
        }
        if (address.origin === url && request.method() === "POST") {
            const body = request.postDataJSON(), json = value => route.fulfill({ json: value });
            if (p === "/api/snapshot") return json({ ...await currentStatePayload({ sessionId: "memory-only" }, { ...state, revision }, body), collection: { ...collection, revision } });
            if (p === "/api/collection/status") return json({ ...collection, revision });
            if (p === "/api/trends") { reads.push(body); return json(buildTrends({ ...state, revision }, body)); }
            if (p === "/api/period-comparison") return json(buildPeriodComparison({ ...state, revision }, body));
            if (p === "/api/assessment/overview" || p === "/api/assessment/detail") {
                const model = cachedAssessmentModel({ ...state, revision });
                return json({ schemaVersion: 1, basis: model.basis, data: p.endsWith("/overview")
                    ? assessmentOverview(state, model, body.interactionRefs) : model.details.get(body.interactionRef) });
            }
            if (p === "/api/session") return json({ capability, runtimeId: UNBOUND_FIXTURE_BOOTSTRAP.runtimeId, accessBootstrap: UNBOUND_FIXTURE_BOOTSTRAP });
            if (p === "/api/evaluation/automatic/summary") return json(automaticScoreOffSummary());
            if (p === "/api/report-artifacts/list") return json({ artifacts: [] });
        }
        denied.push(p); return route.abort();
    });
    return { page, reads, url, advanceRevision: () => { revision++; } };
}
function records() {
    return ["fetch", "retrieve"].map((tool, i) => {
        const r = fixture(`invented-trend-origin-${i}`), at = day + "T18:00:00Z";
        Object.assign(r.userPrompt, { sourceEventId: `prompt-${i}`, sourceTimestamp: at, authorship: { actor: "user", basis: "source-user" } });
        r.originalModelEvidence = { version: 1, sourceSessionId: r.sourceSessionId, promptEventId: `prompt-${i}`, promptMessageId: `message-${i}`,
            partial: false, ambiguous: false, responses: [{ eventId: `reply-${i}`, apiCallId: `model-${i}`, at, turnId: `turn-${i}`, model: "Juniper", modelStatus: "recorded" }] };
        Object.assign(r.toolCalls[0], { tool: "workiq-" + tool, startedAt: at, completedAt: day + "T18:00:01Z", durationMs: 1000,
            toolSucceeded: Boolean(i), reportedOutcome: i ? "succeeded" : "failed" });
        return r;
    });
}
async function pageEntryFixture(t) {
    const app = await setup(t, "react", records());
    await app.page.addInitScript(() => {
        if (localStorage.getItem("wire.page-defaults.v1.analyzeRange") !== null) return;
        for (const [key, value] of Object.entries({ analyzeRange: "30", trendChart: "services", compareDays: "14" }))
            localStorage.setItem("wire.page-defaults.v1." + key, JSON.stringify(value));
        localStorage.setItem("workiq-evidence.time-zone", "America/New_York");
    });
    // Already Oct 1 in the display zone, still Sep 30 in the device zone.
    await app.page.clock.setFixedTime(new Date("2026-10-01T04:30:00Z"));
    return app;
}
test("page defaults: direct Analyze and sidebar Trends use real scopes; selections, handoffs and reload win", async t => {
    const { page, url, reads } = await pageEntryFixture(t);
    await page.goto(url + "/"); await ready(page);
    await expect(page.locator("#dateFilter")).toHaveValue("30");
    await expect(page.locator("#fromFilter")).toHaveValue("2026-09-02");
    await expect(page.locator("#toFilter")).toHaveValue("2026-10-01");
    await page.locator("nav [data-nav=trends]").click();
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "services");
    await expect(page).toHaveURL(url + "/trends?measure=services");
    const index = page.getByRole("navigation", { name: "Trend measures" });
    await index.getByRole("button", { name: "Prompt authors", exact: true }).click();
    await page.reload(); await expect(visiblePanel(page)).toHaveAttribute("data-family", "authors");
    await page.goto(url + "/?authors=user"); await ready(page);
    await expect(page.locator("#dateFilter")).toHaveValue("capture");
    const count = reads.length;
    await page.locator("#analyze-trend-tools").click();
    await page.getByRole("button", { name: "Open trend", exact: true }).click();
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "tools");
    assert.deepEqual(reads.slice(count).map(read => read.filters), [{ author: "user" }]);
    await page.getByRole("button", { name: "Back to Analyze" }).click();
    await expect(page).toHaveURL(url + "/?authors=user");
    await page.goto(url + "/trends");
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "services");
    await page.locator("nav [data-nav=analyze]").click(); await ready(page);
    await expect(page.locator("#dateFilter")).toHaveValue("30");
    await selectActivityOption(page, "dateFilter", "capture");
    await page.reload(); await ready(page);
    await expect(page.locator("#dateFilter")).toHaveValue("capture");
});
test("page defaults: direct and sidebar Compare start on complete civil days; Back and explicit pairs win", async t => {
    const { page, url } = await pageEntryFixture(t);
    async function checkSelected(days) {
        const panel = await openDatePicker(page, "compare");
        await expect(panel.getByRole("button", { name: `Last ${days} days`, exact: true })).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.press("Escape");
    }
    async function check14() {
        await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
        await checkSelected(14);
        const p = new URL(page.url()).searchParams;
        assert.deepEqual(["aFrom", "aTo", "bFrom", "bTo"].map(key => p.get(key)),
            ["2026-09-03", "2026-09-16", "2026-09-17", "2026-09-30"]);
    }
    await page.goto(url + "/trends?section=guide");
    await expect(page.locator(".trends-guide")).toBeVisible();
    await page.locator("#comparePeriods").click(); await check14();
    await openDatePicker(page, "compare", "Last 7 days");
    await checkSelected(7);
    await page.reload(); await checkSelected(7);
    await page.goBack(); await check14();
    await page.goBack(); await expect(page.locator(".trends-guide")).toBeVisible();
    await page.goto(url + "/compare"); await check14();
    await page.goBack(); await expect(page.locator(".trends-guide")).toBeVisible();
    const bounded = url + `/trends?measure=tools&period=custom&from=${day}&to=${day}`;
    await page.goto(bounded);
    await page.locator("#trendsComparePeriods").click();
    await page.getByRole("button", { name: "Open comparison" }).click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    assert.equal(new URL(page.url()).searchParams.get("bFrom"), day);
    assert.equal(new URL(page.url()).searchParams.get("bTo"), day);
    await page.getByRole("button", { name: "Back to Trends" }).click();
    await expect(page).toHaveURL(bounded);
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "tools");
});
test("page defaults: changing a preference updates the next untouched sidebar entry, not browser Back", async t => {
    const { page, url } = await pageEntryFixture(t);
    await page.goto(url + "/trends");
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "services");
    const original = page.url();
    await page.locator("nav [data-nav=settings]").click();
    await navigateSettings(page, "trends");
    await selectActivityOption(page, "defaultTrendChart", "models");
    const sidebar = page.locator("nav [data-nav=trends]");
    await expect(sidebar).toHaveAttribute("href", "/trends?measure=models");
    await sidebar.click();
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "models");
    await page.goBack(); await page.goBack(); await page.goBack();
    await expect(page).toHaveURL(original);
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "services");
});
for (const frontend of ["react", "bundled"]) {
    test(`${frontend}: compatible widget scope reaches exact calls; Back and Forward retain the widget and chosen trend`, async t => {
        const { page, reads, url } = await setup(t, frontend, records());
        await page.goto(`${url}/?range=custom&from=${day}&to=${day}&source=github-copilot&services=Calendar&authors=user`);
        await ready(page);
        const tool = page.locator('[data-percentage-card="tools"] a').filter({ hasText: "fetch" }).first();
        await tool.click(); await ready(page);
        await page.locator("#activityList .request-card-open,#activityList .request-link").first().click(); await ready(page);
        await page.locator("#requestReportToggle").click();
        await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
        await page.goBack(); await ready(page);
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
        const home = page.url(), link = page.locator("#analyze-trend-tools"), count = reads.length;
        await expect(page.locator("a.analyze-trend-link:visible")).toHaveCount(6);
        await expect(link).toHaveAttribute("href", "/trends");
        await link.evaluate(node => node.scrollIntoView({ block: "center" }));
        await link.focus(); await frames(page);
        const y = (await link.boundingBox()).y;
        await link.press("Enter");
        await expect(visiblePanel(page)).toHaveAttribute("data-family", "tools");
        assert.equal(page.url(), url + privateTrends);
        assert.equal(reads.length - count, 1, "no intermediate default read");
        assert.deepEqual(reads.at(-1).filters, { tool: "workiq-fetch", author: "user", service: "Calendar" });
        assert.equal(reads.at(-1).from, day); assert.equal(reads.at(-1).to, day);
        assert.equal(reads.at(-1).timeContext.timeZone, "America/Los_Angeles");
        assert.doesNotMatch(await page.evaluate(() => JSON.stringify(history.state)), /workiq-fetch|Calendar|2026-09-30|invented-trend-origin/);
        await expect(visiblePanel(page).locator("[data-trend-mark][aria-pressed=true]").first()).toBeVisible();
        await visiblePanel(page).getByRole("button", { name: "View 1 call" }).click();
        await page.locator(".trends-evidence-row a").click();
        await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", /invented-trend-origin-0/);
        await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
        await page.goBack(); await ready(page);
        await expect(visiblePanel(page)).toHaveAttribute("data-family", "tools");
        const sheet = page.locator(".trends-dialog[open]"); if (await sheet.count()) await page.keyboard.press("Escape");
        await page.getByRole("navigation", { name: "Trend measures" }).getByRole("button", { name: "Services", exact: true }).click();
        await expect(visiblePanel(page)).toHaveAttribute("data-family", "services");
        await page.getByRole("button", { name: "Back to Analyze" }).click(); await ready(page);
        await expect(link).toBeFocused(); assert.equal(page.url(), home);
        assert.ok(Math.abs((await link.boundingBox()).y - y) < 3, "activating widget retains its position");
        await page.goForward(); await ready(page); await expect(visiblePanel(page)).toHaveAttribute("data-family", "services");
        await page.goBack(); await ready(page); await expect(link).toBeFocused();
    });
}
for (const frontend of ["react", "bundled"]) {
    test(`${frontend}: all six Analyze widgets open their own daily evidence and return to the exact activating link`, async t => {
        const { page, url, reads } = await setup(t, frontend, records());
        await page.goto(`${url}/?range=custom&from=${day}&to=${day}&source=github-copilot`); await ready(page);
        const origin = page.url();
        for (const [family, size] of [["rhythm", 2], ["tools", 2], ["services", 2], ["authors", 2], ["models", 2], ["problems", 1]]) {
            const link = page.locator(`#analyze-trend-${family}`), before = reads.length;
            await link.evaluate(node => node.scrollIntoView({ block: "center" })); await link.focus(); await frames(page);
            const top = (await link.boundingBox()).y;
            await link.press("Enter");
            if (family === "problems") {
                const consent = page.locator(".analyze-trend-decision[open]");
                await expect(consent).toContainText("affected interactions"); assert.equal(reads.length, before);
                await consent.getByRole("button", { name: "Open trend" }).click();
            }
            await expect(visiblePanel(page)).toHaveAttribute("data-family", family);
            await expect(visiblePanel(page).getByRole("heading", { level: 2 })).toBeFocused();
            assert.equal(reads.length - before, 1, family); assert.equal(page.url(), url + privateTrends);
            await visiblePanel(page).getByRole("button", { name: `View ${size} call${size === 1 ? "" : "s"}` }).click();
            const calls = page.locator(".trends-evidence-row a"); await expect(calls).toHaveCount(size);
            await calls.filter({ hasText: "workiq-fetch" }).click();
            await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:invented-trend-origin-0");
            await page.goBack(); await ready(page); await expect(page.locator("#contextSidebar")).not.toBeVisible();
            await expect(visiblePanel(page)).toHaveAttribute("data-family", family);
            if (await page.locator(".trends-dialog[open]").count()) await page.keyboard.press("Escape");
            if (family === "tools") await page.goBack();
            else await page.getByRole("button", { name: "Back to Analyze" }).click();
            await ready(page); await expect(link).toBeFocused(); assert.equal(page.url(), origin);
            assert.ok(Math.abs((await link.boundingBox()).y - top) < 3, family);
        }
    });
}
test("qualified outcome transition cancels in place, accepts only supported scope, never carries data into a copied URL", async t => {
    const { page, url, reads } = await setup(t, "react", records());
    await page.goto(url + "/?result=success&authors=user,unknown&services=Calendar,Mail&bucket=week"); await ready(page);
    const link = page.getByRole("link", { name: "View trend: Errors & failures", exact: true });
    await link.click();
    const decision = page.getByRole("dialog"), original = page.url();
    for (const text of ["affected interactions", "Outcome filter does not carry over", "all prompt authors", "all services", "last 7 days"]) {
        await expect(decision).toContainText(text);
    }
    await page.keyboard.press("Escape"); await expect(link).toBeFocused();
    assert.equal(page.url(), original); assert.equal(reads.length, 0);
    await link.click(); await decision.getByRole("button", { name: "Open trend" }).click();
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "problems");
    assert.deepEqual(reads.at(-1).filters, {}); assert.equal(page.url(), url + privateTrends);
    const beforeReload = reads.length;
    await page.reload(); await ready(page);
    assert.equal(reads.length, beforeReload, "reload cannot replace a bound home scope with all calls");
    await page.getByRole("button", { name: "Open this view without the private selection" }).click();
    await expect(page.locator(".trends-landing")).toBeVisible();
    await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Back to Analyze" })).toHaveCount(0);
    await page.goto(url + "/?layer=reported-api"); await ready(page);
    await expect(page.locator("a.analyze-trend-link:visible")).toHaveCount(0);
});

for (const frontend of ["react", "bundled"]) {
    test(`${frontend}: home widget trend links share a header row and remain readable with wrapped titles`, async t => {
        const { page, url } = await setup(t, frontend, records());
        await page.goto(`${url}/?range=custom&from=${day}&to=${day}&source=github-copilot`); await ready(page);
        const links = page.locator("a.analyze-trend-link:visible"), proof = process.env.WIRE_TRENDS_PROOFS, checks = [], issues = [];
        await expect(links).toHaveCount(6);
        for (const [width, scale] of [[1600,1],[900,1],[390,2]]) {
            await page.setViewportSize({width,height:900});
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; },scale);
            await page.evaluate(() => document.fonts.ready); await frames(page);
            const rows = await links.evaluateAll(links => links.map(link => {
                const heading = link.parentElement.querySelector("h2,h3");
                const box = n => {const b=n.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};};
                const range = document.createRange(); range.selectNodeContents(heading);
                return {id:link.id, text:link.innerText, accessible:link.getAttribute("aria-label"),
                    title:box(heading), link:box(link), header:box(link.parentElement),
                    card:box(link.closest(".percentage-card,.chart-panel")), titleLines:range.getClientRects().length};
            }));
            checks.push({width,scale,rows});
            const activity = rows.find(row=>row.id === "analyze-trend-rhythm"), result = rows.find(row=>row.id === "analyze-trend-problems");
            if (activity.card.x + activity.card.w <= result.card.x + 2 && Math.abs(activity.card.y-result.card.y)<2)
                if (Math.abs(activity.link.y-result.link.y)>1) issues.push(`${width}: adjacent action tops differ by ${activity.link.y-result.link.y}px`);
            for (const row of rows) {
                if (row.text !== "View trend" || !row.accessible?.startsWith("View trend: ")) issues.push(`${row.id} wording: ${row.text}`);
                if (row.link.h<44 || row.link.x<row.header.x-1 || row.link.x+row.link.w>row.header.x+row.header.w+1)
                    issues.push(`${width} ${row.id}: action outside header or less than 44px tall`);
                if (row.title.x+row.title.w>row.link.x+1 && row.title.y+row.title.h>row.link.y+1 && row.link.y+row.link.h>row.title.y+1)
                    issues.push(`${width} ${row.id}: overlapping title/action`);
            }
            if (proof) {
                await mkdir(proof,{recursive:true});
                await page.locator("#analyze-trend-rhythm").scrollIntoViewIfNeeded();
                await page.screenshot({path:path.join(proof,`home-actions-${frontend}-${width}-${scale}.png`)});
            }
        }
        if (proof) await writeFile(path.join(proof,`home-actions-${frontend}.json`),JSON.stringify(checks));
        assert.deepEqual(issues,[]);
    });
}
test("no retained supported calls: unbounded Analyze offers no widget transfer, ordinary Trends honestly shows an empty period", async t => {
    const { page, url, reads } = await setup(t, "react", []);
    await page.goto(url); await ready(page);
    await expect(page.locator(".analyze-trend-link:visible")).toHaveCount(0);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Trends" }).click();
    await expect(page.locator(".trends-landing .trends-no-activity")).toContainText("No matching calls"); assert.deepEqual(reads.at(-1).filters, {});
    await expect(page.getByRole("button", { name: "Back to Analyze" })).toHaveCount(0);
    assert.equal(page.url(), url + "/trends");
});
test("a changed retained revision cannot silently replace a widget transfer with ordinary Trends", async t => {
    const { page, url, reads, advanceRevision } = await setup(t, "react", records());
    await page.clock.setFixedTime(new Date(day + "T21:00:00Z"));
    await page.goto(`${url}/?range=custom&from=${day}&to=${day}&authors=user`); await ready(page);
    advanceRevision();
    await page.locator("#analyze-trend-authors").click();
    await expect(page.getByRole("heading", { name: "This Analyze scope is no longer current" })).toBeVisible();
    await expect(visiblePanel(page)).toHaveCount(0); assert.equal(reads.length, 0);
    await page.getByRole("button", { name: "Open Trends without this scope" }).click();
    await expect(page.locator(".trends-landing")).toBeVisible();
    await expect.poll(() => reads.length).toBe(1);
    assert.deepEqual(reads.map(read => read.filters), [{}]);
});
test("accepted private Search and weekly grouping stay in Analyze, not in the Trends URL or request", async t => {
    const { page, reads, url } = await setup(t, "react", records());
    await page.goto(`${url}/?range=custom&from=${day}&to=${day}&bucket=week`); await ready(page);
    const query = "SYNTHETIC_PRIVATE_PROMPT";
    await restoreLegacySearch(page, query);
    const link = page.locator("#analyze-trend-rhythm"); await link.click();
    const consent = page.locator(".analyze-trend-decision[open]");
    await expect(consent).toContainText("Search matches do not carry over");
    await expect(consent).toContainText("one count per calendar day");
    await expect(consent).not.toContainText(query); assert.equal(reads.length, 0);
    await consent.getByRole("button", { name: "Open trend" }).click();
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "rhythm");
    assert.ok(!JSON.stringify(reads).includes(query)); assert.equal(page.url(), url + privateTrends);
    assert.ok(!(await page.evaluate(() => JSON.stringify(history.state))).includes(query));
    await page.getByRole("button", { name: "Back to Analyze" }).click(); await ready(page);
    await expect(page.locator("#activitySearch")).toHaveValue(query); await expect(link).toBeFocused();
});

test("compiled Trends restores explicit period and measure via URL, reload and Back without a default read", async t => {
    const { page, url, reads } = await setup(t, "react", records());
    await page.clock.setFixedTime(new Date("2026-11-20T05:30:00Z")); // Nov 19 in the display zone
    await page.goto(url + "/trends?measure=models&period=14");
    const panel = visiblePanel(page), index = page.getByRole("navigation", { name: "Trend measures" });
    await expect(panel).toHaveAttribute("data-family", "models");
    assert.deepEqual(reads.map(({ from, to }) => [from, to]), [["2026-11-06", "2026-11-19"]]);
    await index.getByRole("button", { name: "Services", exact: true }).click();
    await expect(page).toHaveURL(url + "/trends?measure=services&period=14");
    assert.equal(reads.length, 1, "presentation alone must not reread the projection");
    await page.locator("#trendsPeriod").click();
    await page.getByRole("button", { name: "Last 30 days", exact: true }).click();
    await expect(page).toHaveURL(url + "/trends?measure=services&period=30");
    await page.reload(); await expect(panel).toHaveAttribute("data-family", "services");
    assert.deepEqual(reads.map(r => [r.from, r.to, r.timeContext.timeZone]), [
        ["2026-11-06", "2026-11-19", "America/Los_Angeles"],
        ["2026-10-21", "2026-11-19", "America/Los_Angeles"],
        ["2026-10-21", "2026-11-19", "America/Los_Angeles"],
    ]);
    await page.goBack(); await expect(page).toHaveURL(url + "/trends?measure=services&period=14");
    await expect.poll(() => reads.at(-1).from).toBe("2026-11-06");
    await page.goBack(); await expect(panel).toHaveAttribute("data-family", "models");
    await page.locator("#trendsPeriod").click();
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.getByLabel("Trends from", { exact: true }).fill(day);
    await page.getByLabel("Trends to", { exact: true }).fill(day);
    await page.getByRole("button", { name: "Apply dates", exact: true }).click();
    const custom = `${url}/trends?measure=models&period=custom&from=${day}&to=${day}`;
    await expect(page).toHaveURL(custom);
    await page.reload(); await expect(panel).toHaveAttribute("data-family", "models");
    assert.deepEqual([reads.at(-1).from, reads.at(-1).to], [day, day]);
});

test("Overview opens the dated error chart; section navigation retains the chart, scope and Back focus", async t => {
    const { page, url, reads } = await setup(t, "react", records());
    await page.goto(`${url}/trends?section=overview&period=custom&from=${day}&to=${day}`);
    const nav = page.getByRole("navigation", { name: "Trends sections" });
    const guide = nav.getByRole("button", { name: "Chart guide" });
    const point = page.locator(".trends-landing [data-trend-mark]").first();
    await expect(nav.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await expect(point).toHaveAccessibleName(/Errors & failures, 1 interaction$/);
    await point.focus(); await point.press("Enter");
    const chart = page.locator(".trends-panel:visible");
    await expect(chart).toHaveAttribute("data-family", "problems");
    await expect(chart.getByRole("button", { name: "View 1 call" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Charts" })).toHaveAttribute("aria-current", "page");
    const chartAddress = page.url();
    await guide.focus(); await guide.press("Enter");
    await expect(guide).toHaveAttribute("aria-current", "page"); await expect(chart).toHaveCount(0);
    for (const action of [() => guide.hover(), () => guide.focus()]) {
        await action();
        const underline = await guide.evaluate(n => getComputedStyle(n).borderBottom);
        assert.match(underline, /^3px solid /); assert(!underline.includes("rgba(0, 0, 0, 0)"));
    }
    await page.locator(".trends-guide nav").getByRole("button",{name:"Errors & failures"}).click();
    await expect(page.locator(".trends-guide article")).toContainText("Unknown results are not failures");
    await page.setViewportSize({ width: 390, height: 820 });
    await page.evaluate(() => document.documentElement.style.fontSize = "150%");
    assert(await nav.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
    await page.goBack(); await expect(page).toHaveURL(chartAddress);
    await expect(guide).toBeFocused(); await expect(chart.getByRole("button", { name: "View 1 call" })).toBeVisible();
    assert.equal(reads.length, 1);
    await page.goForward(); await expect(guide).toHaveAttribute("aria-current", "page");
    await page.reload(); await expect(guide).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".trends-guide")).toBeVisible();
});

test("compiled Trends keeps explicit filters tab-bound, never broadens on expired reload or carries them to a new visit", async t => {
    const { page, url, reads } = await setup(t, "react", records());
    const publicRoute = `${url}/trends?measure=tools&period=custom&from=${day}&to=${day}`;
    await page.goto(publicRoute);
    const panel = visiblePanel(page);
    await expect(panel).toHaveAttribute("data-family", "tools");
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await selectActivityOption(page, "trendsTool", "workiq-fetch");
    await selectActivityOption(page, "trendsService", "Calendar");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect(page).toHaveURL(publicRoute + "&privateView=required");
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(history.state)), /workiq-fetch|Calendar/);
    const filters = { tool: "workiq-fetch", service: "Calendar" };
    assert.deepEqual(reads.at(-1).filters, filters);
    const entry = page.locator("#trendsView .filter-entry");
    await expect(entry).toHaveAccessibleName("2 filters applied");
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(page).toHaveURL(publicRoute);
    await expect(entry).toHaveText("Filters");
    await page.goBack(); await expect(page).toHaveURL(publicRoute + "&privateView=required");
    await expect.poll(() => reads.at(-1).filters).toEqual(filters);
    await expect(entry).toHaveText("2 filters applied");
    const privateCount = reads.length;
    await page.reload();
    const recover = page.getByRole("button", { name: "Open this view without the private selection" });
    await expect(recover).toBeVisible();
    await expect(entry).toBeHidden();
    assert.equal(reads.length, privateCount);
    await recover.click(); await expect(page.locator(".trends-landing")).toBeVisible();
    await expect.poll(() => reads.length).toBe(privateCount + 1);
    await expect(page).toHaveURL(url + "/trends");
    assert.deepEqual(reads.at(-1).filters, {});
    await expect(entry).toHaveText("Filters");
});

test("compiled Trends refuses ambiguous or unsupported deep links instead of reading all calls", async t => {
    const { page, url, reads } = await setup(t, "react", records());
    for (const query of ["period=7&period=30", "period=custom&from=2026-02-31&to=2026-03-01", "tool=workiq-fetch"]) {
        await page.goto(`${url}/trends?${query}`);
        await expect(page.getByRole("heading", { name: "This Trends selection is unavailable" })).toBeVisible();
        await expect(visiblePanel(page)).toHaveCount(0);
        assert.equal(reads.length, 0);
        assert.doesNotMatch(await page.evaluate(() => JSON.stringify(history.state)), /workiq-fetch|02-31/);
    }
});

test("compiled Trends keeps an implicit historical week adaptive across measure selection and reload, but binds an explicit historical week", async t => {
    const { page, url, reads } = await setup(t, "react", records());
    await page.clock.setFixedTime(new Date("2026-11-20T05:30:00Z"));
    await page.goto(url + "/trends");
    const index = page.getByRole("navigation", { name: "Trend measures" }), panel = visiblePanel(page);
    await expect.poll(() => reads.at(-1)?.to).toBe(day);
    await page.getByRole("button", { name: "Charts", exact: true }).click();
    await index.getByRole("button", { name: "Services", exact: true }).click();
    const adaptive = url + "/trends?measure=services";
    await expect(page).toHaveURL(adaptive);
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(history.state)), /2026-09-30|privateView/);
    const count = reads.length;
    await page.reload(); await expect(panel).toHaveAttribute("data-family", "services");
    await expect.poll(() => reads.slice(count).map(r => r.to)).toEqual(["2026-11-19", day]);
    await page.locator("#trendsPeriod").click();
    await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
    await expect(page).toHaveURL(adaptive + "&period=7");
    await page.getByRole("button", { name: /^Show week ending / }).click();
    await expect(page).toHaveURL(adaptive + "&privateView=required");
    assert.equal(reads.at(-1).to, day);
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(history.state)), /2026-09-30/);
    const privateCount = reads.length;
    await page.reload(); await expect(page.getByRole("button", { name: "Open this view without the private selection" })).toBeVisible();
    assert.equal(reads.length, privateCount);
});
