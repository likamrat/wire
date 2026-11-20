import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { currentStatePayload } from "../lib/server.mjs";
import { loadBrowserAssets } from "../lib/browser-assets.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildTrends } from "../lib/trends.mjs";
import { assessmentOverview, cachedAssessmentModel } from "../lib/assessment-read-model.mjs";
import { fixture, UNBOUND_FIXTURE_BOOTSTRAP, automaticScoreOffSummary, restoreLegacySearch } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const visiblePanel = page => page.locator(".trends-panel:visible");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const day = "2026-09-30";
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
        assert.equal(page.url(), url + "/trends");
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
            assert.equal(reads.length - before, 1, family); assert.equal(page.url(), url + "/trends");
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
    const link = page.getByRole("link", { name: "Related errors trend" });
    await link.click();
    const decision = page.getByRole("dialog"), original = page.url();
    for (const text of ["affected interactions", "Outcome filter does not carry over", "all prompt authors", "all services", "last 7 days"]) {
        await expect(decision).toContainText(text);
    }
    await page.keyboard.press("Escape"); await expect(link).toBeFocused();
    assert.equal(page.url(), original); assert.equal(reads.length, 0);
    await link.click(); await decision.getByRole("button", { name: "Open trend" }).click();
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "problems");
    assert.deepEqual(reads.at(-1).filters, {}); assert.equal(page.url(), url + "/trends");
    await page.reload(); await ready(page);
    await page.getByRole("button", { name: "Open this view without the private selection" }).click();
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "rhythm");
    await expect(page.getByRole("button", { name: "Back to Analyze" })).toHaveCount(0);
    await page.goto(url + "/?layer=reported-api"); await ready(page);
    await expect(page.locator("a.analyze-trend-link:visible")).toHaveCount(0);
});
test("no retained supported calls: unbounded Analyze offers no widget transfer, ordinary Trends honestly shows an empty period", async t => {
    const { page, url, reads } = await setup(t, "react", []);
    await page.goto(url); await ready(page);
    await expect(page.locator(".analyze-trend-link:visible")).toHaveCount(0);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Trends" }).click();
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "rhythm"); assert.deepEqual(reads.at(-1).filters, {});
    await expect(page.getByRole("button", { name: "Back to Analyze" })).toHaveCount(0);
    assert.equal(page.url(), url + "/trends");
});
test("a changed retained revision cannot silently replace a widget transfer with ordinary Trends", async t => {
    const { page, url, reads, advanceRevision } = await setup(t, "react", records());
    await page.goto(`${url}/?range=custom&from=${day}&to=${day}&authors=user`); await ready(page);
    advanceRevision();
    await page.locator("#analyze-trend-authors").click();
    await expect(page.getByRole("heading", { name: "This Analyze scope is no longer current" })).toBeVisible();
    await expect(visiblePanel(page)).toHaveCount(0); assert.equal(reads.length, 0);
    await page.getByRole("button", { name: "Open Trends without this scope" }).click();
    await expect(visiblePanel(page)).toHaveAttribute("data-family", "rhythm");
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
    assert.ok(!JSON.stringify(reads).includes(query)); assert.equal(page.url(), url + "/trends");
    assert.ok(!(await page.evaluate(() => JSON.stringify(history.state))).includes(query));
    await page.getByRole("button", { name: "Back to Analyze" }).click(); await ready(page);
    await expect(page.locator("#activitySearch")).toHaveValue(query); await expect(link).toBeFocused();
});
