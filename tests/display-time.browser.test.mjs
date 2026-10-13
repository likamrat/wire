import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { time } from "../lib/time.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, privateFixture, selectActivityOption, navigateMain, navigateSettings, revealStoredRefresh } from "./helpers.mjs";
import { chooseReportScope, reportContents } from "./report-journey-helpers.mjs";

const key = "workiq-evidence.time-zone";
const instants = ["2026-03-08T07:59:59Z", "2026-03-08T08:00:00Z", "2026-03-08T09:59:59Z", "2026-03-08T10:00:00Z", "2026-03-09T06:59:59Z", "2026-03-09T07:00:00Z"];
const records = instants.map((value, index) => {
    const record = fixture("display-time-" + index);
    record.userPrompt.text = "SYNTHETIC unchanged 2026-03-08T08:00:00Z";
    record.toolCalls[0].startedAt = value;
    return record;
});
async function ready(page) {
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
}
async function setup(t, init, sourceRecords = records) {
    const cleanups = [];
    const { context } = await privateFixture({ after: action => cleanups.push(action) }, sourceRecords);
    const before = await loadBoardState(context);
    const source = await readFile(path.join(context.dataDir, "private-evidence", before.evidenceFile));
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    const profile = await browser.newContext({ timezoneId: "America/Los_Angeles", locale: "en-US", viewport: { width: 1466, height: 1000 }, reducedMotion: "reduce" });
    if (init) await profile.addInitScript(init);
    const page = await profile.newPage(), requests = [], errors = [];
    page.on("request", r => { if (r.url().includes("/api/")) requests.push({ path: new URL(r.url()).pathname, input: r.postDataJSON() }); });
    page.on("pageerror", e => errors.push(e.message));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await readFile(path.join(context.dataDir, "private-evidence", before.evidenceFile)), source);
            assert.deepEqual(errors, []);
            assert.ok(!requests.some(r => /collection\/(configure|enabled|now)|\/export$|\/record$/.test(r.path)));
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    await page.goto(runtime.url + "#home?bucket=day");
    await ready(page);
    return { page, profile, runtime, context, requests, before };
}
async function selectZone(page, zone) {
    if (!await page.locator("#displayTimeZone-control").isVisible()) {
        await navigateMain(page, "settings"); await ready(page);
        await navigateSettings(page, "display");
    }
    await selectActivityOption(page, "displayTimeZone", zone);
    await ready(page);
}
function lastSnapshot(requests) { return requests.filter(r => r.path === "/api/snapshot").at(-1).input; }

test("display preference governs calendar data, reset, reload, navigation and new frozen report context", { timeout: 90000 }, async t => {
    const { page, requests, runtime } = await setup(t);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, "No default preference write");
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "America/Los_Angeles");
    await page.locator("#meaning>summary").click();
    assert.deepEqual(await page.locator("#countTable tbody td:nth-child(2)").allTextContents(), ["1", "4", "1"]);
    const homeUrl = page.url();
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "display");
    assert.match(page.url(), /section=display/);
    await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toBeVisible();
    await selectZone(page, "UTC");
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "UTC");
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), "UTC");
    await page.goBack(); await ready(page);
    await page.goBack(); await ready(page);
    assert.equal(page.url(), homeUrl);
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "UTC");
    assert.deepEqual(await page.locator("#countTable tbody td:nth-child(2)").allTextContents(), ["4", "2"]);
    await page.goForward(); await ready(page);
    await page.goForward(); await ready(page);
    assert.equal(await page.locator("#displayTimeZone").inputValue(), "UTC");
    await page.reload(); await ready(page);
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "UTC");
    await selectZone(page, time.zone("Asia/Kolkata"));
    assert.equal(lastSnapshot(requests).timeContext.timeZone, time.zone("Asia/Kolkata"));
    await selectZone(page, "");
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "America/Los_Angeles");
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, "Reset removes override");
    await page.goto(runtime.url + "#home?bucket=day&range=custom&from=2026-03-07&to=2026-03-07"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    await selectZone(page, "UTC");
    await navigateMain(page, "home"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "0");
    assert.equal(lastSnapshot(requests).filters.from, "2026-03-07");
    assert.equal(lastSnapshot(requests).filters.to, "2026-03-07");
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "UTC", "Reset to Home does not reset display preference");
    await navigateMain(page, "reports"); await ready(page);
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator("#exportBtn").click();
    await expect(page.locator("#reportReviewBody .attestation input[data-review-control]")).toBeVisible();
    assert.equal(requests.findLast(r => r.path === "/api/preview").input.options.timeContext.timeZone, "UTC");
    await selectZone(page, "America/Los_Angeles");
    await navigateMain(page, "reports"); await ready(page);
    await reportContents(page);
    assert.equal(await page.getByRole("button", { name: "3. Save locally", exact: true }).isDisabled(), true);
});

test("explicit zones govern day, week and month totals across the repeated fall-back hour", { timeout: 90000 }, async t => {
    const fall = ["2026-11-01T06:59:59Z", "2026-11-01T07:00:00Z", "2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z", "2026-11-02T07:59:59Z", "2026-11-02T08:00:00Z"]
        .map((value, index) => ({ ...records[index], toolCalls: [{ ...records[index].toolCalls[0], startedAt: value }] }));
    const { page, requests, runtime } = await setup(t, undefined, fall);
    for (const zone of ["UTC", "America/Los_Angeles", time.zone("Asia/Kolkata")]) {
        await selectZone(page, zone);
        for (const bucket of ["day", "week", "month"]) {
            await page.goto(runtime.url + `#home?bucket=${bucket}&range=custom&from=2026-11-01&to=2026-11-01`);
            await ready(page);
            const config = lastSnapshot(requests), expected = buildActivityAnalytics(fall, config);
            assert.equal(config.timeContext.timeZone, zone);
            assert.equal(await page.locator("#activityCount").innerText(), "4");
            if (!await page.locator("#meaning").evaluate(node => node.open)) await page.locator("#meaning>summary").click();
            assert.deepEqual(await page.locator("#countTable tbody td:nth-child(2)").allTextContents(), expected.timeSeries.points.map(point => String(point.total)));
            assert.equal(await page.locator("#countTable tfoot td").first().innerText(), "4");
            assert.equal(await page.locator("#bucketFilter").inputValue(), bucket);
            if (zone === "America/Los_Angeles") assert.equal(Date.parse(expected.dateRange.to) - Date.parse(expected.dateRange.from), 25 * 3600000);
        }
    }
});

test("changing Display preserves saved report bytes while new previews use the selected zone", { timeout: 30000 }, async t => {
    const { page, context, before } = await setup(t);
    const exports = createExportController(context);
    const selection = { kind: "all", revision: before.revision };
    const preview = await exports.preview("invented-display-proof", undefined,
        { promptMode: "none", formats: ["html"], timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" } }, selection);
    await exports.review("invented-display-proof", preview.previewId, true, preview.timeContext);
    const saved = (await exports.confirm("invented-display-proof", preview.previewId, true, preview.timeContext)).bundle;
    const filesBefore = await Promise.all(Object.values(saved.files).map(file => readFile(file)));
    await selectZone(page, "UTC");
    await navigateMain(page, "reports");
    await chooseReportScope(page, "all");
    const response = page.waitForResponse(value => value.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const fresh = await (await response).json();
    await page.frameLocator("#reportReviewBody iframe").locator("h1").waitFor();
    assert.equal(fresh.timeContext.timeZone, "UTC");
    assert.equal(saved.timeContext.timeZone, "America/Los_Angeles");
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(file => readFile(file))), filesBefore);
    const state = await loadBoardState(context);
    assert.equal(state.exports.length, 1, "Previewing in another zone does not rewrite or save a report");
    assert.deepEqual(state.evidence, before.evidence);
});

test("preference synchronizes same-profile panels without changing another browser context", { timeout: 60000 }, async t => {
    const { page, profile, runtime } = await setup(t);
    const second = await profile.newPage();
    await second.goto(runtime.url); await ready(second);
    const isolated = await profile.browser().newContext({ timezoneId: "America/Los_Angeles" });
    const third = await isolated.newPage();
    try {
        await third.goto(runtime.url); await ready(third);
        await selectZone(page, "UTC");
        await expect(second.locator("#displayTimeZone")).toHaveValue("UTC");
        assert.match(await third.locator("#displayTimeZone option:checked").textContent(), /America\/Los_Angeles/);
        await selectZone(page, "");
        await expect(second.locator("#displayTimeZone option:checked")).toContainText("America/Los_Angeles");
    } finally { await isolated.close(); await second.close(); }
});

test("blocked preference storage warns and keeps the explicit choice panel-local", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t, () => {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key) {
            if (key === "workiq-evidence.time-zone") throw new DOMException("Synthetic denied", "SecurityError");
            return get.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
            if (key === "workiq-evidence.time-zone") throw new DOMException("Synthetic denied", "SecurityError");
            return set.call(this, key, value);
        };
    });
    await expect(page.locator("#timeZoneNotice")).toContainText("cannot be read");
    await selectZone(page, "UTC");
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "UTC");
    await expect(page.locator("#timeZoneNotice")).toContainText("this panel only until reload");
    await page.reload(); await ready(page);
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "America/Los_Angeles");
});

test("pending and failed zone reads keep Settings tied to the old applied snapshot and retry atomically", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    await navigateMain(page, "settings"); await ready(page); await navigateSettings(page, "display");
    let release, begun;
    const started = new Promise(resolve => { begun = resolve; });
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().timeContext.timeZone !== "UTC") return route.continue();
        begun();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic unavailable snapshot" }) });
    });
    await selectActivityOption(page, "displayTimeZone", "UTC");
    await started;
    assert.match(await page.locator("#displayTimeEffective").innerText(), /America\/Los_Angeles/);
    release(); await ready(page);
    assert.match(await page.locator("#displayTimeEffective").innerText(), /America\/Los_Angeles/);
    await expect(page.locator("#message")).toContainText("last recorded snapshot");
    await page.unroute("**/api/snapshot");
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await expect(page.locator("#displayTimeZone")).toHaveValue("UTC");
    await expect(page.locator("#displayTimeEffective")).toBeHidden();
});

test("automatic zone follows device changes; override persists through focus and live snapshots", { timeout: 60000 }, async t => {
    const { page, requests, context } = await setup(t, () => {
        const native = Intl.DateTimeFormat;
        globalThis.testZone = "America/Los_Angeles";
        Intl.DateTimeFormat = new Proxy(native, { apply(target, thisArg, args) {
            const format = Reflect.apply(target, thisArg, args);
            if (!args.length) {
                const resolved = format.resolvedOptions.bind(format);
                format.resolvedOptions = () => ({ ...resolved(), timeZone: globalThis.testZone });
            }
            return format;
        } });
    });
    await selectActivityOption(page, "dateFilter", "7"); await ready(page);
    assert.equal(lastSnapshot(requests).filters.to, time.day(new Date().toISOString(), "America/Los_Angeles"));
    const changed = page.waitForResponse(r => r.url().endsWith("/api/snapshot"));
    await page.evaluate(() => { globalThis.testZone = "UTC"; window.dispatchEvent(new Event("focus")); });
    await changed; await ready(page);
    assert.equal(lastSnapshot(requests).filters.to, time.day(new Date().toISOString(), "UTC"));
    await selectZone(page, "America/Los_Angeles");
    await page.evaluate(() => { globalThis.testZone = "Asia/Kolkata"; window.dispatchEvent(new Event("focus")); });
    await navigateMain(page, "analyze"); await ready(page);
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "America/Los_Angeles");
    assert.equal(lastSnapshot(requests).filters.to, time.day(new Date().toISOString(), "America/Los_Angeles"));
    await navigateMain(page, "home"); await ready(page);
    await page.locator("#resetView").click(); await ready(page);
    const next = [...records, { ...fixture("display-time-live"), toolCalls: [{ ...fixture("display-time-live").toolCalls[0], startedAt: instants[1] }] }];
    await replaceEvidence(context, () => ({ records: next, importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    await expect(page.locator("#activityCount")).toHaveText("7", { timeout: 15000 });
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "America/Los_Angeles");
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "America/Los_Angeles");
});

test("invalid saved zone and unavailable list are visible; controls use existing keyboard typeahead", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t, () => {
        localStorage.setItem("workiq-evidence.time-zone", "CST");
        Intl.supportedValuesOf = undefined;
    });
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "America/Los_Angeles");
    await expect(page.locator("#timeZoneNotice")).toContainText("invalid or unavailable");
    await navigateMain(page, "settings"); await ready(page); await navigateSettings(page, "display");
    await expect(page.locator("#displayTimeHelp")).toContainText("full time zone list");
    await page.locator("#displayTimeZone-control").focus();
    await page.keyboard.type("UTC");
    await expect(page.locator(".select-option[data-active=true]")).toContainText("UTC");
    await page.keyboard.press("Enter"); await ready(page);
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "UTC");
    await expect(page.locator("#timeZoneNotice")).toBeHidden();
    assert.equal(await page.evaluate(() => document.activeElement.id), "displayTimeZone-control");
    await page.evaluate(() => {
        const select = document.querySelector("#displayTimeZone"), invalid = new Option("Invalid fixture", "CST");
        select.append(invalid); select.value = "CST"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await ready(page);
    await expect(page.locator("#timeZoneNotice")).toContainText("Choose a valid");
    assert.equal(lastSnapshot(requests).timeContext.timeZone, "UTC");
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), "UTC");
});
