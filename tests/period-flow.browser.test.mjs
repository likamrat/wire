import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, selectActivityOption, navigateMain, chooseTheme, revealStoredRefresh } from "./helpers.mjs";
import { reportContents } from "./report-journey-helpers.mjs";

const proofs = process.env.WORKIQ_SETTINGS_PROOFS;
async function ready(page) { await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false"); }
async function setup(t) {
    const records = ["2026-07-01", "2026-08-20", "2026-09-20", "2026-10-01"].map((day, index) => {
        const record = fixture("period-" + index);
        record.sourceSessionId = index === 3 ? "session-b" : "session-a";
        record.sourceSessionName = index === 3 ? "Mail follow-up" : "Calendar follow-up";
        record.userPrompt.text = "Synthetic period request " + index;
        record.userPrompt.sourceTimestamp = record.capturedAt = record.toolCalls[0].startedAt = day + "T12:00:00Z";
        return record;
    });
    const { context } = await privateFixture(t, records);
    await replaceEvidence(context, () => ({ records, importCoverage: {
        since: "2026-09-05T07:00:00Z", until: "2026-10-05T12:00:00Z",
        counts: { includedSessions: 2, includedProjects: 1 }, roster: [],
    } }));
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 960 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
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
    await page.locator("#meaning > summary").click();
    assert.equal(await page.locator("#periodLabel").innerText(), "Jul 1 - Oct 1");
    assert.equal(await page.locator("#dateFilter-control").innerText(), "All dates");
    assert.ok(posts.every(row => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(row.path)));
});

test("a restored date route without a range label is custom, never all retained dates", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url + "#home?from=2026-09-01&to=2026-10-05"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.equal(await page.locator("#dateFilter").inputValue(), "custom");
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
    await page.locator("#fromFilter").fill("2026-10-01");
    await page.locator("#toFilter").fill("2026-10-01");
    await page.locator("#applyDates").click();
    await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    release();
    await page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.from === "2026-09-01");
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator("#fromFilter").inputValue(), "2026-10-01");
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
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(runtime.url); await ready(page); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.locator("#dateFilter-control").focus();
        await page.keyboard.press("c"); await page.keyboard.press("Enter");
        if (await page.locator("#dateFilter").inputValue() !== "custom") await selectActivityOption(page, "dateFilter", "custom");
        const count = posts.length;
        await page.locator("#applyDates").click();
        assert.match(await page.locator("#dateError").innerText(), /Choose both dates/);
        assert.equal(await page.locator("#fromFilter").getAttribute("aria-invalid"), "true");
        assert.equal(posts.length, count, "Empty dates never issue a read or collection");
        await page.locator("#fromFilter").fill("2026-10-01");
        await page.locator("#toFilter").fill("2026-09-01");
        await page.locator("#applyDates").click();
        assert.match(await page.locator("#dateError").innerText(), /Start date must not follow/);
        assert.equal(await page.locator("#activityCount").innerText(), "4");
        const metrics = await page.evaluate(() => {
            const controls = [...document.querySelectorAll("#dateFields input,#dateFields button")].map(node => {
                const rect = node.getBoundingClientRect();
                return { id: node.id, width: rect.width, height: rect.height, left: rect.left, right: rect.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, fontSize: parseFloat(getComputedStyle(node).fontSize) };
            });
            return { overflow: document.documentElement.scrollWidth - innerWidth, controls, errorVisible: document.querySelector("#dateError").checkVisibility() };
        });
        assert.ok(metrics.overflow <= 1, `${theme}/${width}/${scale}: page overflow`);
        for (const control of metrics.controls) {
            assert.ok(control.height >= 44, JSON.stringify(control));
            assert.ok(control.left >= 0 && control.right <= width + 1, JSON.stringify(control));
            assert.ok(control.scrollWidth <= control.clientWidth + 1, JSON.stringify(control));
            if (["fromFilter", "toFilter"].includes(control.id)) assert.ok(control.width >= control.fontSize * 10, "Native segmented date and calendar need text-scaled room: " + JSON.stringify(control));
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
        assert.equal(await page.locator("#applyDates").evaluate(node => node === document.activeElement), true);
        assert.match(await page.locator("#dateHint").innerText(), /Los Angeles time.*same date twice.*retained evidence/);
    }
    assert.ok(posts.every(row => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(row.path)));
    if (directory) await writeFile(path.join(directory, "date-layout-matrix.json"), JSON.stringify(measurements, null, 2));
});

test("Apply dates -> truthful feedback -> matching sessions -> analysis -> deliberate report preview", { timeout: 60000 }, async t => {
    const { page, runtime, context, posts } = await setup(t);
    const before = await loadBoardState(context), original = await readFile(path.join(context.dataDir, "private-evidence", before.evidenceFile));
    await page.goto(runtime.url); await ready(page);
    assert.equal(await page.locator("#moreFilters").count(), 0);
    assert.equal(await page.locator("#serviceFilter-control").isVisible(), true);
    assert.equal(await page.locator("#pageAction").isVisible(), true);
    assert.equal(await page.locator("#exploreLink").isVisible(), false);
    assert.equal(await page.locator("#reportSelectionBar").isVisible(), false);
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
    assert.equal(await page.locator("#periodResult").innerText(), "4 Work IQ tool calls");
    assert.equal(await page.locator("#periodResult").getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("#pageAction").getAttribute("aria-disabled"), "true");
    release(); await ready(page);
    assert.equal(await page.locator("#periodResult").innerText(), "3 Work IQ tool calls");
    assert.match(await page.locator("#periodHint").innerText(), /^Jul 29, 2026 - Oct 5, 2026/);
    assert.equal(await page.locator("#applyDates").evaluate(node => node === document.activeElement), true);
    assert.match(await page.locator("#periodCoverageText").innerText(), /Sep 5, 2026 - Oct 5, 2026.*may be missing.*does not collect/);
    assert.match(await page.locator("#homeInsightScope").textContent(), /3 request groups.*full retained interaction/);
    assert.equal(await page.evaluate(() => window.periodAnnouncements.filter(text => text === "3 Work IQ tool calls").length), 1);
    await page.locator("#pageAction").click(); await ready(page);
    assert.equal(await page.locator(".session-group").count(), 2);
    assert.match(page.url(), /from=2026-07-29.*to=2026-10-05/);
    await page.locator('[data-session-id="session-a"] .session-drill').click(); await ready(page);
    assert.equal(await page.locator("#pageTitle").innerText(), "Calendar follow-up");
    assert.match(await page.locator("#periodResult").innerText(), /This Copilot chat: 2 request groups with 2 Work IQ tool calls/);
    await period(page, "2026-09-01", "2026-10-05");
    assert.match(page.url(), /session=session-a/);
    assert.match(await page.locator("#periodResult").innerText(), /This Copilot chat: 1 request group with 1 Work IQ tool call/);
    assert.equal(await page.locator("#applyDates").evaluate(node => node === document.activeElement), true);
    await page.locator("#createSessionReport").click();
    assert.match(await page.locator("#previewSelectionSummary").innerText(), /3 request groups included/, "Session reports keep the deliberate whole-session contract, not only this date slice");
    await reportContents(page);
    await page.locator("#exportBtn").click();
    await page.locator(".attestation input[data-review-control]").waitFor();
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(await readFile(path.join(context.dataDir, "private-evidence", before.evidenceFile)), original);
    assert.ok(!posts.some(row => ["/api/export", "/api/privacy-review", "/api/record", "/api/move", "/api/collection/configure", "/api/collection/now"].includes(row.path)));
});

test("empty periods, failed and late snapshots do not claim coverage or a successful apply", { timeout: 60000 }, async t => {
    const { page, runtime, posts } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    await period(page, "2027-01-01", "2027-01-03");
    assert.equal(await page.locator("#periodResult").innerText(), "0 Work IQ tool calls");
    assert.match(await page.locator("#periodHint").innerText(), /not proof that no activity occurred/);
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    await navigateMain(page, "activity"); await ready(page);
    assert.equal(await page.locator(".session-group").count(), 0, "Unmatched inventory sessions do not contradict period counts");
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(await page.locator("#periodResult").innerText(), "4 Work IQ tool calls");
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().filters.from === "2026-09-01") return route.fulfill({ status: 500, json: { error: "Synthetic delayed read failed." } });
        await route.continue();
    });
    await period(page, "2026-09-01", "2026-10-05");
    assert.match(await page.locator("#message").innerText(), /Synthetic delayed read failed/);
    assert.equal(await page.locator("#periodResult").innerText(), "Previous results: 4 Work IQ tool calls");
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    await page.unroute("**/api/snapshot");
    await (await revealStoredRefresh(page)).click(); await ready(page);
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
    release();
    await page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.from === "2026-08-01");
    assert.equal(await page.locator("#periodResult").innerText(), "4 Work IQ tool calls");
    assert.match(await page.locator("#periodHint").innerText(), /^All retained dates/);
    assert.equal(page.url().endsWith("#home"), true);
    assert.ok(posts.every(row => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(row.path)));
});

test("one filter row keeps refinements/routes and fits both themes", { timeout: 90000 }, async t => {
    const { page, runtime, posts } = await setup(t);
    if (proofs) await mkdir(proofs, { recursive: true });
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 960 });
        await page.goto(runtime.url); await ready(page); await chooseTheme(page, theme);
        const controls = await page.locator(".period-controls button").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).length);
        assert.equal(controls, 14, "Seven selectors and seven help buttons are visible without expansion");
        await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
        assert.match(await page.locator("#filterChips").innerText(), /Service: Calendar/);
        await period(page, "2026-07-29", "2026-10-05");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator("#serviceFilter").inputValue(), "Calendar");
        measurements.push({ theme, width, filterControls: controls });
        if (proofs) {
            await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofs, `period-flow-${theme}-${width}.png`), fullPage: true });
        }
        await page.locator("#periodHistoryLink").click();
        assert.match(page.url(), /#settings.*section=connection.*setting=history-window/);
        assert.equal(await page.locator("#collectionWindow-control").evaluate(node => node === document.activeElement), true);
        await page.goBack(); await ready(page);
        assert.equal(await page.locator("#periodResult").innerText(), "3 Work IQ tool calls");
        assert.equal(await page.locator("#moreFilters").count(), 0);
    }
    if (proofs) await writeFile(path.join(proofs, "period-controls.json"), JSON.stringify(measurements, null, 2));
    assert.ok(posts.every(row => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/assessment/consent"].includes(row.path)),
        JSON.stringify(posts.map(row => row.path)));
});
