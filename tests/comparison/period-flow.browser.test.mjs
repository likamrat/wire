import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../../lib/store.mjs";
import { fixture, privateFixture, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters, chooseTheme } from "../support/helpers.mjs";

const proofs = process.env.WORKIQ_SETTINGS_PROOFS;
async function ready(page) { await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false"); }
async function setup(t, { undated = false } = {}) {
    const records = ["2026-07-01", "2026-08-20", "2026-09-20", "2026-10-01"].map((day, index) => {
        const record = fixture("period-" + index);
        record.sourceSessionId = index === 3 ? "session-b" : "session-a";
        record.sourceSessionName = index === 3 ? "Mail follow-up" : "Calendar follow-up";
        record.userPrompt.text = "Synthetic period request " + index;
        record.userPrompt.sourceTimestamp = record.capturedAt = record.toolCalls[0].startedAt = day + "T12:00:00Z";
        return record;
    });
    if (undated) {
        const row = fixture("undated-call");
        row.capturedAt = "2026-06-02T12:00:00Z";
        records.push(row);
    }
    const { context } = await privateFixture(t, records);
    await replaceEvidence(context, () => ({ records, importCoverage: {
        since: "2026-09-05T07:00:00Z", until: "2026-10-05T12:00:00Z",
        counts: { includedSessions: 2, includedProjects: 1 }, roster: [],
    } }));
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 960 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    await page.clock.setFixedTime(new Date("2026-10-06T15:00:00Z"));
    const errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push({ path: new URL(request.url()).pathname, input: request.postDataJSON() }); });
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); });
    return { page, runtime, context, posts };
}
async function period(page, from, to) {
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(from);
    await page.locator("#toFilter").fill(to);
    await page.locator("#applyDates").focus();
    await page.keyboard.press("Enter");
    await ready(page);
}

test("all retained dates labels the actual evidence, not the last collector window", async t => {
    const { page, runtime, posts } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "4");
    await openAnalyzeFilters(page);
    await expect(page.locator("#dateFilter-control")).toHaveAccessibleName("Dates: All dates");
    await expect(page.locator("#periodResult")).toHaveText("4 Work IQ tool calls (All dates)");
    await period(page, "2026-07-01", "2026-07-01");
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#periodCoverageText")).toContainText("outside the dates WIRE last checked");
    assert.ok(posts.every(row => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(row.path)));
});

test("a restored date route without a range label is custom, never all retained dates", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url + "#home?from=2026-09-01&to=2026-10-05"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.equal(await page.locator("#dateFilter").inputValue(), "custom");
    await selectActivityOption(page,"dateFilter","custom");
    assert.equal(await page.locator("#dateFields").isVisible(), true);
    assert.equal(await page.locator("#fromFilter").inputValue(), "2026-09-01");
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#dateFilter").inputValue(), "custom");
    assert.equal(await page.locator("#activityCount").innerText(), "2");
});

test("a newer submitted period supersedes the pending read", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    await selectActivityOption(page, "dateFilter", "custom");
    let release, entered;
    const hold = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { entered = resolve; });
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().filters.from === "2026-09-01") { entered(); await hold; }
        await route.continue();
    });
    t.after(() => release());
    await page.locator("#fromFilter").fill("2026-09-01");
    await page.locator("#toFilter").fill("2026-10-05");
    await page.locator("#applyDates").click();
    await requested;
    assert.equal(await page.locator("#activityCount").innerText(), "4");
    await selectActivityOption(page,"dateFilter","custom");
    await page.locator("#fromFilter").fill("2026-10-01");
    await page.locator("#toFilter").fill("2026-10-01");
    await page.locator("#applyDates").click();
    await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.from === "2026-09-01");
    release(); await (await late).finished();
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    await expect(page.locator("#dateFilter-control")).toHaveAccessibleName("Dates: Oct 1, 2026");
});

test("date apply has a real pending indicator and preserves edits made while its read finishes", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    await selectActivityOption(page, "dateFilter", "custom");
    let release, entered;
    const hold = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { entered = resolve; });
    await page.route("**/api/snapshot", async route => {
        entered(); await hold; await route.continue();
    }, { times: 1 });
    t.after(() => release());
    await page.locator("#fromFilter").fill("2026-09-01");
    await page.locator("#toFilter").fill("2026-10-05");
    await page.locator("#applyDates").click();
    await requested;
    assert.equal(await page.locator("#periodResult").getAttribute("data-pending"), "true");
    assert.equal(await page.locator("#periodResult .pending-indicator").getAttribute("aria-hidden"), "true");
    await selectActivityOption(page,"dateFilter","custom");
    await page.locator("#fromFilter").fill("2026-10-01");
    release(); await ready(page);
    assert.equal(await page.locator("#fromFilter").inputValue(), "2026-10-01", "Unsubmitted edits must not be overwritten by the older applied read");
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.equal(await page.locator("#periodResult").getAttribute("data-pending"), "false");
});

test("custom date validation and pending layout remain usable in both themes at 100 and 200 percent root text", { timeout: 90000 }, async t => {
    const { page, runtime, posts } = await setup(t);
    const measurements = [], directory = process.env.WORKIQ_DATE_PROOFS;
    if (directory) await mkdir(directory, { recursive: true });
    for (const [theme, width, scale] of [["light", 1200, 1], ["dark", 820, 1], ["light", 375, 2], ["dark", 1200, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(new URL("/?range=capture", runtime.url).href); await ready(page); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await selectActivityOption(page, "dateFilter", "custom");
        const count = posts.length;
        assert.equal(await page.locator("#applyDates").isDisabled(), true);
        assert.match(await page.locator("#analyzeCalendarStatus").innerText(), /Choose a start date/);
        assert.equal(posts.length, count, "Empty dates never issue a read or collection");
        await page.locator("#fromFilter").fill("2026-10-01");
        await page.locator("#toFilter").fill("2026-09-01");
        assert.equal(await page.locator("#applyDates").isDisabled(), true);
        assert.match(await page.locator("#analyzeCalendarStatus").innerText(), /End date must be on or after the start/);
        assert.equal(await page.locator("#toFilter").getAttribute("aria-invalid"), "true");
        assert.equal(await page.locator("#activityCount").innerText(), "4");
        const metrics = await page.evaluate(() => {
            const controls = [...document.querySelectorAll("#dateFields input,#dateFields button")].filter(node => node.checkVisibility()).map(node => {
                const rect = node.getBoundingClientRect();
                let intrinsicWidth = 0;
                if (node.matches("input[type=date]")) {
                    const probe = node.cloneNode();
                    probe.removeAttribute("id");
                    probe.style.cssText = "position:fixed;visibility:hidden;inline-size:max-content;min-inline-size:0;max-inline-size:none";
                    node.after(probe);
                    intrinsicWidth = probe.getBoundingClientRect().width;
                    probe.remove();
                }
                return { id: node.id, width: rect.width, height: rect.height, left: rect.left, right: rect.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, intrinsicWidth };
            });
            return { overflow: document.documentElement.scrollWidth - innerWidth, controls, errorVisible: document.querySelector("#dateError").checkVisibility() };
        });
        assert.ok(metrics.overflow <= 1, `${theme}/${width}/${scale}: page overflow`);
        for (const control of metrics.controls) {
            assert.ok(control.height >= 44, JSON.stringify(control));
            assert.ok(control.left >= 0 && control.right <= width + 1, JSON.stringify(control));
            assert.ok(control.scrollWidth <= control.clientWidth + 1, JSON.stringify(control));
            assert.ok(control.width >= control.intrinsicWidth, "The native date segments and picker must fit: " + JSON.stringify(control));
        }
        measurements.push({ theme, width, rootTextScale: scale, ...metrics });
        if (directory) {
            await page.mouse.move(0, 0);
            await page.evaluate(() => { scrollTo(0, 0); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
            await page.screenshot({ path: path.join(directory, `date-fields-${theme}-${width}-${scale}.png`), fullPage: true });
        }
        await page.locator("#toFilter").fill("2026-10-01");
        await page.locator("#applyDates").focus(); await page.keyboard.press("Enter"); await ready(page);
        assert.equal(await page.locator("#activityCount").innerText(), "1");
        assert.equal(await page.locator("#dateError").isVisible(), false);
        assert.equal(await page.locator("#fromFilter").getAttribute("aria-invalid"), "false");
        await expect(page.locator("#dateFilter-control")).toBeFocused();
        assert.doesNotMatch(await page.locator("#dateFields").innerText(), /both dates included|inclusive dates/i);
    }
    assert.ok(posts.every(row => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(row.path)));
    if (directory) await writeFile(path.join(directory, "date-layout-matrix.json"), JSON.stringify(measurements, null, 2));
});

test("Apply dates -> truthful feedback -> matching sessions -> analysis -> deliberate report preview", { timeout: 60000 }, async t => {
    const { page, runtime, context, posts } = await setup(t);
    const before = await loadBoardState(context), original = await readFile(path.join(context.dataDir, "private-evidence", before.evidenceFile));
    await page.goto(runtime.url); await ready(page);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-07-29");
    await page.locator("#toFilter").fill("2026-10-05");
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().filters.from === "2026-07-29") await held;
        await route.continue();
    });
    await page.evaluate(() => {
        window.periodAnnouncements = [];
        new MutationObserver(() => window.periodAnnouncements.push(document.querySelector("#periodResult").textContent))
            .observe(document.querySelector("#periodResult"), { childList: true, subtree: true, characterData: true });
    });
    await page.locator("#applyDates").focus(); await page.keyboard.press("Enter");
    assert.equal(await page.locator("#periodResult").innerText(), "4 Work IQ tool calls (All dates)");
    assert.equal(await page.locator("#periodResult").getAttribute("aria-busy"), "true");
    release(); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("3 Work IQ tool calls (Jul 29–Oct 5, 2026)");
    await expect(page.locator("#dateFilter-control")).toBeFocused();
    assert.equal(await page.locator("#periodCoverageText").innerText(), "The last history check covered only part of this period.");
    await expect(page.locator("#activityListSummary")).toHaveText("3 interactions · 3 matching tool calls");
    await expect(page.locator("#periodHint")).toHaveText("3 interactions; 2 Copilot chats");
    assert.equal(await page.evaluate(() => window.periodAnnouncements.filter(text => text === "3 Work IQ tool calls (Jul 29–Oct 5, 2026)").length), 1);
    assert.doesNotMatch(page.url(), /[?&](from|to)=/);
    await selectActivityOption(page, "chatFilter", "session-a"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    await period(page, "2026-09-01", "2026-10-05");
    await expect(page.locator("#chatFilter")).toHaveValue("session-a");
    await expect(page.locator("#activityCount")).toHaveText("1");
    await closeAnalyzeFilters(page);
    await page.locator("#createSessionReport").click();
    await expect(page.locator("#reportDeskDates")).toHaveAccessibleName("Dates: All retained dates");
    assert.equal(posts.some(row => row.path === "/api/preview"), false);
    const response = page.waitForResponse(r => r.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Prepare preview", exact: true }).click();
    const res = await response, preview = await res.json();
    assert.ok(res.ok(), preview.error);
    assert.deepEqual(posts.find(row => row.path === "/api/preview").input.selection.scenarioIds.sort(), ["period-0", "period-1", "period-2"]);
    assert.equal(preview.records.length, 3);
    await expect(page.locator("#reportStage3")).toBeVisible();
    assert.equal(preview.privacy.reviewerConfirmed, false);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(await readFile(path.join(context.dataDir, "private-evidence", before.evidenceFile)), original);
    assert.ok(!posts.some(row => ["/api/export", "/api/privacy-review", "/api/record", "/api/move", "/api/collection/configure", "/api/collection/now"].includes(row.path)));
});

test("empty periods, failed and late snapshots do not claim coverage or a successful apply", { timeout: 60000 }, async t => {
    const { page, runtime, posts } = await setup(t, { undated: true });
    await page.goto(runtime.url); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("5");
    // This interval contains the undated call's capture, not a call start.
    await period(page, "2026-06-01", "2026-06-03");
    await expect(page.locator("#periodResult")).toHaveText("0 Work IQ tool calls (Jun 1–3, 2026)");
    await expect(page.locator("#activityListSummary")).toHaveText("0 interactions · 0 matching tool calls");
    await expect(page.locator("#periodCoverageText")).toContainText("outside the dates WIRE last checked");
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("5 Work IQ tool calls (All dates)");
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().filters.from === "2026-09-01") return route.fulfill({ status: 500, json: { error: "Synthetic delayed read failed." } });
        await route.continue();
    });
    await period(page, "2026-09-01", "2026-10-05");
    assert.match(await page.locator("#message").innerText(), /Synthetic delayed read failed/);
    await expect(page.locator("#periodResult")).toHaveText("Previous results: 5 Work IQ tool calls (All dates)");
    await expect(page.locator("#periodResult a")).toHaveCount(0);
    await page.unroute("**/api/snapshot");
    await closeAnalyzeFilters(page);
    await page.locator("#analyzeRefresh").click(); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("5 Work IQ tool calls (All dates)");
    await selectActivityOption(page,"dateFilter","custom");
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().filters.from === "2026-08-01") await hold;
        await route.continue();
    });
    await page.locator("#fromFilter").fill("2026-08-01");
    await page.locator("#toFilter").fill("2026-10-05");
    await page.locator("#applyDates").click();
    await page.locator("#resetView").click(); await ready(page);
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.from === "2026-08-01");
    release(); await (await late).finished();
    await expect(page.locator("#periodResult")).toHaveText("5 Work IQ tool calls (All dates)");
    assert.equal(new URL(page.url()).searchParams.has("from"), false);
    assert.ok(posts.every(row => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(row.path)));
});

test("Filters keeps service and date restrictions through history settings and Back in both themes", { timeout: 90000 }, async t => {
    const { page, runtime, posts } = await setup(t);
    if (proofs) await mkdir(proofs, { recursive: true });
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 960 });
        await page.goto(runtime.url); await ready(page); await chooseTheme(page, theme);
        await openAnalyzeFilters(page);
        await expect(page.locator("#dateFilter-control")).toBeVisible();
        await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
        await expect(page.locator("#filterChips")).toContainText("Calendar");
        await period(page, "2026-07-29", "2026-10-05");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator("#serviceFilter").inputValue(), "Calendar");
        measurements.push({ theme, width, panel: await page.locator("#analyzeFilterDialog").boundingBox() });
        if (proofs) {
            await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofs, `period-flow-${theme}-${width}.png`), fullPage: true });
        }
        await page.locator("#periodHistoryLink").click();
        await expect(page).toHaveURL(/\/settings\?.*section=connection.*setting=history-window/);
        assert.equal(await page.locator("#collectionWindow-control").evaluate(node => node === document.activeElement), true);
        await page.goBack(); await ready(page);
        await expect(page.locator("#periodResult")).toHaveText("3 Work IQ tool calls (Jul 29–Oct 5, 2026)");
        await expect(page.locator("#serviceFilter")).toHaveValue("Calendar");
    }
    if (proofs) await writeFile(path.join(proofs, "period-controls.json"), JSON.stringify(measurements, null, 2));
    assert.ok(posts.every(row => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/assessment/consent"].includes(row.path)),
        JSON.stringify(posts.map(row => row.path)));
});
