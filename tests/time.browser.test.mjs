import test from "node:test";
import assert from "node:assert/strict";
import { reportContents, cancelReportPreview } from "./report-journey-helpers.mjs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, moveCard } from "../lib/store.mjs";
import { time } from "../lib/time.mjs";
import { fixture, privateFixture, selectActivityOption, chooseTheme, openActivitySessions } from "./helpers.mjs";

const instants = ["2026-03-08T07:59:59Z", "2026-03-08T08:00:00Z", "2026-03-08T09:59:59Z", "2026-03-08T10:00:00Z", "2026-03-09T06:59:59Z", "2026-03-09T07:00:00Z"];
function records() {
    return instants.map((value, index) => {
        const s = fixture("timezone-" + index);
        s.userPrompt.text = "SYNTHETIC timezone original 2026-03-08T08:00:00Z";
        s.userPrompt.sourceTimestamp = value;
        s.toolCalls[0].startedAt = value;
        s.toolCalls[0].completedAt = new Date(Date.parse(value) + 2000).toISOString();
        s.toolCalls[0].durationMs = 2000;
        s.toolCalls[0].requestArgs = { entityUrls: ["/me/calendarView?startDateTime=2026-03-08T08:00:00Z"] };
        return s;
    });
}
async function setup(t, pdfRenderer, source = records()) {
    const savedZone = process.env.TZ;
    process.env.TZ = "UTC";
    t.after(() => { if (savedZone === undefined) delete process.env.TZ; else process.env.TZ = savedZone; });
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC");
    const { context } = await privateFixture(t, source);
    for (const s of source) await moveCard(context, s.scenarioId, "ready_to_export");
    const controller = createExportController(context, undefined, pdfRenderer);
    const runtime = await startServer(context, controller, { port: 0 });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    return { context, controller, runtime, browser };
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await openActivitySessions(page);
}
function observe(page) {
    const requests = [], errors = [];
    page.on("request", r => { if (r.url().includes("/api/")) requests.push({ path: new URL(r.url()).pathname, input: r.postDataJSON() }); });
    page.on("pageerror", e => errors.push(e.message));
    return { requests, errors };
}

for (const [zone, day, start, end, hours] of [
    ["UTC", "2026-03-08", "2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z", 24],
    ["America/Los_Angeles", "2026-03-08", "2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z", 23],
    ["America/Los_Angeles", "2026-11-01", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z", 25],
    ["Asia/Kolkata", "2026-10-04", "2026-10-03T18:30:00.000Z", "2026-10-04T18:30:00.000Z", 24],
]) test(`same-day date inputs apply exact ${hours}-hour half-open boundaries: ${zone} ${day}`, async t => {
    const stamps = [Date.parse(start) - 1, Date.parse(start), Date.parse(end) - 1, Date.parse(end)];
    const source = stamps.map((stamp, i) => {
        const record = fixture(`civil-boundary-${i}`);
        record.toolCalls[0].startedAt = new Date(stamp).toISOString();
        return record;
    });
    const { browser, runtime } = await setup(t, undefined, source);
    const page = await browser.newPage({ timezoneId: zone, locale: "en-US" }), { requests, errors } = observe(page);
    let snapshot;
    page.on("response", async response => { if (response.url().endsWith("/api/snapshot") && response.ok()) snapshot = await response.json(); });
    await page.goto(runtime.url); await ready(page);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(day); await page.locator("#toFilter").fill(day);
    await page.locator("#applyDates").click(); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.deepEqual(snapshot.analytics.dateRange, { from: start, to: end, toExclusive: true });
    assert.equal((Date.parse(end) - Date.parse(start)) / 3600000, hours);
    assert.deepEqual(snapshot.analytics.rows.map(row => row.toolCallId).sort(), ["test-call-civil-boundary-1", "test-call-civil-boundary-2"]);
    for (const bucket of ["day", "week", "month"]) {
        await selectActivityOption(page, "bucketFilter", bucket); await ready(page);
        assert.equal(await page.locator("#activityCount").innerText(), "2");
        assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "2");
        assert.deepEqual(snapshot.analytics.dateRange, { from: start, to: end, toExclusive: true });
    }
    assert.ok(requests.every(row => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(row.path)));
    assert.deepEqual(errors, []);
});

test("browser zone beats UTC server; local buckets, tooltips, inputs, activity times and reset agree", { timeout: 120000 }, async t => {
    const { browser, runtime, context } = await setup(t);
    const baseline = await loadBoardState(context);
    const evidence = await readFile(path.join(context.dataDir, "private-evidence", baseline.evidenceFile));
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kathmandu"]) {
        const page = await browser.newPage({ timezoneId: zone, locale: "en-GB", viewport: { width: 1200, height: 950 }, reducedMotion: "reduce" });
        const { requests, errors } = observe(page);
        await page.goto(runtime.url + "#home?bucket=day"); await ready(page);
        const input = requests.find(r => r.path === "/api/snapshot").input;
        assert.equal(input.timeContext.timeZone, time.zone(zone));
        assert.equal(input.timeContext.locale, "en-GB");
        assert.equal(await page.locator("#activityCount").innerText(), "6");
        if (!await page.locator("#tableDisclosure").evaluate(node => node.open)) await page.locator("#tableDisclosure > summary").click();
        assert.deepEqual(await page.locator("#countTable tbody td:nth-child(2)").allTextContents(), zone === "America/Los_Angeles" ? ["1", "4", "1"] : ["4", "2"]);
        const action = page.locator("#countTable .chart-data-action").nth(zone === "America/Los_Angeles" ? 1 : 0);
        assert.equal(await action.innerText(), "8 Mar 2026");
        await action.click(); await ready(page);
        assert.equal(await page.locator("#fromFilter").inputValue(), "2026-03-08");
        assert.equal(await page.locator("#toFilter").inputValue(), "2026-03-08");
        assert.equal(await page.locator("#activityList .request-row").count(), 4);
        const drill = requests.filter(r => r.path === "/api/snapshot").at(-1).input;
        assert.equal(drill.filters.from, "2026-03-08");
        assert.equal(drill.filters.to, "2026-03-08");
        if (zone === "America/Los_Angeles") {
            const meta = await page.locator("#activityList .request-meta").allTextContents();
            assert.ok(meta.every(text => !text.includes("GMT")), "Request summaries inherit the central display context");
            assert.ok(meta.every(text => text.includes("Message recorded:")));
            await page.locator("#activityList .request-link").first().click();
            await ready(page);
            const requestText = await page.locator("#requestContent").innerText();
            assert.match(await page.locator("#displayTimeZoneLink").getAttribute("aria-label"), /America\/Los_Angeles/);
            assert.doesNotMatch(requestText, /Started:|GMT-7/);
            await page.locator(".journey-item").first().getByText("Technical details", { exact: true }).click();
            assert.match(await page.locator(".journey-item").first().locator("dt").filter({ hasText: /^Started$/ }).locator("+ dd").textContent(), /GMT-7/);
            const reader = page.locator(".request-original .full-text-toggle");
            if (await reader.getAttribute("aria-expanded") === "false") await reader.click();
            assert.equal(await page.locator(".request-original pre").textContent(), records()[0].userPrompt.text);
            await page.getByRole("button", { name: "Add to report", exact: true }).click();
            await page.locator("nav [data-nav=reports]").click();
            await reportContents(page);
            assert.match(await page.locator("#reportTimeContext").innerText(), /America\/Los_Angeles.*en-GB/);
            for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
                await page.setViewportSize({ width, height: 950 });
                await chooseTheme(page, theme);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            }
        }
        await page.getByRole("button", { name: "Reset to Home", exact: true }).click(); await ready(page);
        assert.equal(await page.locator("#activityCount").innerText(), "6");
        assert.equal(requests.filter(r => r.path === "/api/snapshot").at(-1).input.timeContext.timeZone, time.zone(zone));
        await selectActivityOption(page, "bucketFilter", "day"); await ready(page);
        const column = page.locator(".time-column").nth(zone === "America/Los_Angeles" ? 1 : 0);
        await column.focus();
        assert.match(await column.getAttribute("aria-label"), /8 Mar 2026/);
        assert.ok(!(await column.getAttribute("aria-label")).includes(time.zone(zone)), "Bucket name inherits the single header context");
        assert.ok((await page.locator("#displayTimeZoneLink").getAttribute("aria-label")).includes(time.zone(zone)));
        await page.keyboard.press("Escape");
        assert.deepEqual(errors, []);
        assert.ok(requests.every(r => ["/api/snapshot", "/api/assessment/detail", "/api/assessment/overview"].includes(r.path)));
        await page.close();
    }
    assert.deepEqual(await readFile(path.join(context.dataDir, "private-evidence", baseline.evidenceFile)), evidence);
    assert.equal((await loadBoardState(context)).revision, baseline.revision);
});

test("last 7/30 days include today in browser zone rather than historical coverage end", async t => {
    const { browser, runtime } = await setup(t);
    const page = await browser.newPage({ timezoneId: "America/Los_Angeles", locale: "en-US" });
    await page.clock.setFixedTime(new Date("2026-03-09T06:00:00Z"));
    const { requests, errors } = observe(page);
    await page.goto(runtime.url); await ready(page);
    for (const [days, from] of [["7", "2026-03-02"], ["30", "2026-02-07"]]) {
        await selectActivityOption(page, "dateFilter", days); await ready(page);
        const filters = requests.filter(r => r.path === "/api/snapshot").at(-1).input.filters;
        assert.equal(filters.from, from);
        assert.equal(filters.to, "2026-03-08");
    }
    assert.deepEqual(errors, []);
});

test("focus zone change invalidates in-flight preview and reviewed snapshot without evidence writes", { timeout: 120000 }, async t => {
    let started, release;
    const rendering = new Promise(resolve => { started = resolve; });
    const { browser, runtime, context } = await setup(t, async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const initial = await loadBoardState(context);
    const page = await browser.newPage({ timezoneId: "America/Los_Angeles", locale: "en-US" });
    await page.addInitScript(() => {
        const native = Intl.DateTimeFormat;
        globalThis.testZone = "America/Los_Angeles";
        Intl.DateTimeFormat = new Proxy(native, {
            apply(target, thisArg, args) {
                const formatter = Reflect.apply(target, thisArg, args);
                if (!args.length) {
                    const resolved = formatter.resolvedOptions.bind(formatter);
                    formatter.resolvedOptions = () => ({ ...resolved(), timeZone: globalThis.testZone });
                }
                return formatter;
            },
        });
    });
    const { requests, errors } = observe(page);
    await page.goto(runtime.url + "#activity"); await ready(page);
    await page.locator("#activityList input[type=checkbox]").first().check();
    await page.locator("nav [data-nav=reports]").click();
    await reportContents(page);
    await page.locator("#formatOptions input[value=pdf]").check();
    await page.locator("#exportBtn").click();
    await rendering;
    const refreshed = page.waitForResponse(r => r.url().endsWith("/api/snapshot"));
    await page.evaluate(() => { globalThis.testZone = "UTC"; window.dispatchEvent(new Event("focus")); });
    await refreshed; await ready(page);
    assert.match(await page.locator("#reportJourneyError").innerText(), /timezone|current|updating/i);
    const cancelled = page.waitForResponse(r => r.url().endsWith("/api/cancel-preview"));
    release(Buffer.from("%PDF-synthetic cancelled rendering fixture"));
    await cancelled;
    assert.equal(await page.locator("#reportReviewBody .attestation").count(), 0);
    assert.deepEqual(await readdir(path.join(context.dataDir, "exports")), []);
    assert.equal((await loadBoardState(context)).revision, initial.revision);
    await cancelReportPreview(page);
    await page.locator("#formatOptions input[value=pdf]").uncheck();
    await page.locator("#exportBtn").click();
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    const changed = page.waitForResponse(r => r.url().endsWith("/api/snapshot"));
    await page.evaluate(() => { globalThis.testZone = "Asia/Kathmandu"; window.dispatchEvent(new Event("focus")); });
    await changed; await ready(page);
    assert.equal(await page.getByRole("button", { name: "4. Save", exact: true }).isDisabled(), true);
    assert.ok(!requests.some(r => r.path === "/api/export"));
    assert.equal((await loadBoardState(context)).revision, initial.revision);
    assert.deepEqual(errors, []);
});

test("missing browser zone shows UTC fallback and sends it explicitly", async t => {
    const { browser, runtime } = await setup(t);
    const page = await browser.newPage({ timezoneId: "America/Los_Angeles" });
    await page.addInitScript(() => {
        const native = Intl.DateTimeFormat;
        Intl.DateTimeFormat = new Proxy(native, {
            apply(target, thisArg, args) {
                const f = Reflect.apply(target, thisArg, args);
                if (!args.length) f.resolvedOptions = () => ({ locale: "en-US" });
                return f;
            },
        });
    });
    const { requests, errors } = observe(page);
    await page.goto(runtime.url); await ready(page);
    assert.equal(await page.locator("#timeZoneNotice").isVisible(), true);
    assert.match(await page.locator("#timeZoneNotice").innerText(), /Browser timezone unavailable.*UTC/);
    assert.equal(requests.find(r => r.path === "/api/snapshot").input.timeContext.timeZoneFallback, true);
    assert.match(await page.locator("#displayTimeZoneLink").innerText(), /UTC.*fallback/);
    assert.deepEqual(errors, []);
});

test("local time bucket drilldown preserves the source-session slice and its exact count", async t => {
    const source = records().map((s, i) => ({ ...s, sourceSessionId: i < 3 ? "first-session" : "second-session" }));
    const { browser, runtime } = await setup(t, undefined, source);
    const page = await browser.newPage({ timezoneId: "America/Los_Angeles", locale: "en-US" });
    const { requests, errors } = observe(page);
    await page.goto(runtime.url + "#home?bucket=day&session=first-session&range=custom&from=2026-03-08&to=2026-03-08");
    await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    await page.locator(".time-column").click(); await ready(page);
    assert.deepEqual(requests.filter(r => r.path === "/api/snapshot").at(-1).input.filters.sourceSessionIds, ["first-session"]);
    assert.equal(await page.locator("#activityList .request-row").count(), 2);
    assert.deepEqual(errors, []);
});

test("HTTP boundaries reject invalid zones, naive instants and impossible dates without state changes", async t => {
    const { runtime, context } = await setup(t);
    const origin = runtime.url.slice(0, -1), before = await loadBoardState(context);
    const post = (route, body, capability) => fetch(origin + route, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", ...(capability ? { "X-Board-Capability": capability } : {}) },
        body: JSON.stringify(body),
    });
    const capability = (await (await post("/api/session", {})).json()).capability;
    for (const patch of [
        { timeContext: { timeZone: "GMT-7", locale: "en-US" } },
        { timeContext: { timeZone: "America/NoSuchZone", locale: "en-US" } },
        { timeContext: { timeZone: "UTC", locale: "not_a_locale" } },
        { filters: { from: "2026-01-01T12:00:00" } },
        { filters: { from: "2026-02-30" } },
    ]) assert.equal((await post("/api/snapshot", patch, capability)).status, 400);
    const valid = await post("/api/snapshot", { timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" }, filters: { from: "2026-03-08", to: "2026-03-08" } }, capability);
    assert.equal(valid.status, 200);
    const result = await valid.json();
    assert.equal(result.analytics.totals.count, 4);
    assert.deepEqual(result.analytics.dateRange, { from: "2026-03-08T08:00:00.000Z", to: "2026-03-09T07:00:00.000Z", toExclusive: true });
    assert.equal((await loadBoardState(context)).revision, before.revision);
});
