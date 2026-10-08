import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { time } from "../lib/time.mjs";
import { fixture, privateFixture, selectActivityOption, chooseTheme, openActivitySessions, navigateMain, revealStoredRefresh } from "./helpers.mjs";

const labels = { week: "Weekly", day: "Daily", month: "Monthly" };
const context = time.normalize({ timeZone: "America/Los_Angeles", locale: "en-US" });
const proofDir = process.env.WORKIQ_HEADING_PROOFS;

function records(dates, session = "heading-chat") {
    return dates.map((date, index) => {
        const record = fixture(`heading-${session}-${index}`);
        record.sourceSessionId = session;
        record.sourceSessionName = "Synthetic heading chat";
        record.capturedAt = date + "T12:00:00Z";
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
}

async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
}

async function setup(t, source) {
    const { context: store } = await privateFixture(t, source);
    const runtime = await startServer(store, createExportController(store), { port: 0 });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({
        timezoneId: context.timeZone, locale: context.locale,
        viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce",
    });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.url().includes("/api/")) requests.push({ path: new URL(request.url()).pathname, input: request.postDataJSON() });
    });
    t.after(() => {
        assert.deepEqual(errors, [], "No browser errors");
        assert.ok(requests.every(request => ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(request.path)), "Only snapshot/status and versioned insight read APIs are used");
    });
    return { page, runtime, store, requests };
}

async function assertTimeline(page, source, bucket, filters = { scope: "history", includeMetadata: false }) {
    await ready(page);
    const title = `Activity over time (${labels[bucket]})`;
    await expect(page.locator("#chartTitle")).toHaveText(title);
    await expect(page.locator("#bucketFilter")).toHaveValue(bucket);
    assert.equal(await page.locator("#chartMeta").count(), 0, "No redundant Calendar dates label");
    assert.match(await page.locator("#displayTimeZoneLink").getAttribute("aria-label"), /America\/Los_Angeles/);
    const analytics = buildActivityAnalytics(source, { bucket, timeContext: context, filters });
    assert.equal(await page.locator("#activityCount").innerText(), String(analytics.totals.count));
    const points = analytics.timeSeries.points;
    if (points.length) {
        const region = page.locator("#chart .dimensional-scroll");
        await expect(region).toHaveAccessibleName(title);
        assert.equal(await region.getAttribute("aria-label"), null, "One heading-backed accessible name");
        assert.equal(await region.getAttribute("aria-labelledby"), "chartTitle");
        assert.deepEqual(await page.locator(".dimensional-time-labels > span").allTextContents(), points.map(point => time.formatDate(point.date, context)));
        assert.equal(await page.locator(".time-slot").count(), points.length);
    } else {
        assert.equal(await page.locator("#chart .dimensional-scroll").count(), 0);
    }
    if (!await page.locator("#tableDisclosure").evaluate(node => node.open)) await page.locator("#tableDisclosure > summary").click();
    if (points.length) {
        const table = page.locator("#countTable table");
        assert.match(await table.locator("caption").innerText(), new RegExp(`by ${bucket}\\.`));
        assert.doesNotMatch(await table.locator("caption").innerText(), /America\/Los_Angeles/);
        assert.equal(await table.locator("thead th").first().innerText(), bucket === "month" ? "Month starting" : bucket === "week" ? "Week starting" : "Date");
        assert.equal(await table.locator("tfoot td").first().innerText(), String(points.reduce((sum, point) => sum + point.total, 0)));
        assert.deepEqual(await table.locator("tbody td:first-child").allTextContents(), points.slice(0, 24).map(point => time.formatDate(point.date, context, true)));
        assert.deepEqual(await table.locator("tbody td:nth-child(2)").allTextContents(), points.slice(0, 24).map(point => String(point.total)));
    } else {
        assert.match(await page.locator("#countTable").innerText(), /No chart rows/);
    }
}

test("time headings follow all applied scales through deep links, history, refresh and live revision", { timeout: 90000 }, async t => {
    let source = records(["2026-09-30", "2026-10-02"]);
    const { page, runtime, store, requests } = await setup(t, source);
    await page.goto(runtime.url + "#home?bucket=month");
    await assertTimeline(page, source, "month");
    assert.deepEqual(await page.locator(".dimensional-time-labels > span").allTextContents(), ["Sep 1", "Oct 1"]);
    assert.deepEqual(await page.locator("#bucketFilter option").allTextContents(), Object.values(labels));
    await navigateMain(page, "activity");
    await ready(page);
    await openActivitySessions(page);
    await page.locator("#activityList input[type=checkbox]").first().check();
    await navigateMain(page, "home");
    await assertTimeline(page, source, "month");
    const picker = page.locator("#bucketFilter-control");
    await picker.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await ready(page);
    await expect(picker).toBeFocused();
    await assertTimeline(page, source, "week");
    for (const bucket of ["day", "week", "month", "day", "month"]) {
        await selectActivityOption(page, "bucketFilter", bucket);
        await ready(page);
        await expect(page.locator("#bucketFilter-control")).toBeFocused();
        await assertTimeline(page, source, bucket);
    }
    await page.goBack();
    await assertTimeline(page, source, "day");
    await page.goForward();
    await assertTimeline(page, source, "month");
    await navigateMain(page, "activity");
    await ready(page);
    await openActivitySessions(page);
    assert.equal(await page.locator("#activityList input[type=checkbox]:checked").count(), 1, "Report selection survives scale changes and history navigation");
    await navigateMain(page, "home");
    await page.reload();
    await assertTimeline(page, source, "month");
    await navigateMain(page, "activity");
    await ready(page);
    await openActivitySessions(page);
    await page.locator("#activityList input[type=checkbox]").first().check();
    await navigateMain(page, "home");
    await (await revealStoredRefresh(page)).click();
    await assertTimeline(page, source, "month");
    source = [...source, ...records(["2026-10-05"], "new-heading-chat")];
    await replaceEvidence(store, () => ({ records: source }));
    await page.locator("#chartTitle").click();
    await expect(page.locator("#activityCount")).toHaveText("3", { timeout: 15000 });
    await assertTimeline(page, source, "month");
    for (const [chart, title] of [["workload", "Services involved"], ["endpoint", "API paths requested"]]) {
        await page.locator(`[data-chart=${chart}]`).click();
        await ready(page);
        await expect(page.locator("#chartTitle")).toHaveText(title);
        await expect(page.locator("#bucketControl")).toBeHidden();
    }
    await page.locator("[data-chart=time]").click();
    await assertTimeline(page, source, "month");
    await navigateMain(page, "activity");
    await ready(page);
    await openActivitySessions(page);
    assert.equal(await page.locator("#activityList input[type=checkbox]:checked").count(), 1, "Report selection survives scale changes and live updates");
    assert.ok(requests.filter(request => request.path === "/api/snapshot").every(request =>
        JSON.stringify(request.input.filters) === JSON.stringify({ scope: "history", includeMetadata: false })), "Scale changes never alter period or evidence scope");
});

test("pending, failed and superseded scale reads never relabel previously applied buckets", { timeout: 60000 }, async t => {
    const source = records(["2026-09-30", "2026-10-02"]);
    const { page, runtime } = await setup(t, source);
    await page.goto(runtime.url + "#home?bucket=month");
    await assertTimeline(page, source, "month");
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    let arrived;
    const pending = new Promise(resolve => { arrived = resolve; });
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().bucket !== "day") return route.continue();
        arrived();
        await held;
        await route.continue();
    });
    await selectActivityOption(page, "bucketFilter", "day");
    await pending;
    assert.equal(await page.locator("#workspace").getAttribute("aria-busy"), "true");
    await expect(page.locator("#chartTitle")).toHaveText("Activity over time (Monthly)");
    await expect(page.locator("#chart .dimensional-scroll")).toHaveAccessibleName("Activity over time (Monthly)");
    assert.deepEqual(await page.locator(".dimensional-time-labels > span").allTextContents(), ["Sep 1", "Oct 1"]);
    assert.match(await page.locator("#countTable caption").innerText(), /by month/);
    await selectActivityOption(page, "bucketFilter", "week");
    await assertTimeline(page, source, "week");
    const finished = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().bucket === "day");
    release();
    await finished;
    await assertTimeline(page, source, "week");
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", route => route.request().postDataJSON().bucket === "month"
        ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Synthetic unavailable scale read"}' })
        : route.continue());
    await selectActivityOption(page, "bucketFilter", "month");
    await assertTimeline(page, source, "week");
    assert.match(await page.locator("#message").innerText(), /could not update|last recorded snapshot/i);
    await page.unroute("**/api/snapshot");
    await selectActivityOption(page, "bucketFilter", "day");
    await assertTimeline(page, source, "day");
});

test("default, empty, single, many-day and selected-chat headings keep the same data scope", { timeout: 90000 }, async t => {
    const dates = Array.from({ length: 35 }, (_, index) => time.addDays("2026-09-01", index));
    const source = [...records(dates), ...records(["2026-09-15"], "other-heading-chat")];
    const { page, runtime, requests } = await setup(t, source);
    await page.goto(runtime.url);
    await assertTimeline(page, source, "week");
    const cases = [
        { route: "session=heading-chat", filters: { sourceSessionIds: ["heading-chat"] } },
        { route: "range=custom&from=2026-09-02&to=2026-09-02", filters: { from: "2026-09-02", to: "2026-09-02" } },
        { route: "range=custom&from=2026-11-01&to=2026-11-02", filters: { from: "2026-11-01", to: "2026-11-02" } },
    ];
    for (const item of cases) {
        await page.goto(runtime.url + "#home?bucket=month&" + item.route);
        const filters = { scope: "history", includeMetadata: false, ...item.filters };
        for (const bucket of ["month", "day", "week"]) {
            if (bucket !== "month") await selectActivityOption(page, "bucketFilter", bucket);
            await assertTimeline(page, source, bucket, filters);
            assert.deepEqual(requests.filter(request => request.path === "/api/snapshot").at(-1).input.filters, filters);
        }
    }
    await page.goto(runtime.url + "#activity?session=heading-chat&bucket=day");
    await ready(page);
    await expect(page.locator("#sessionAnalysis")).toBeVisible();
    await page.locator("#breadcrumbs a").first().click();
    await assertTimeline(page, source, "day", { scope: "history", includeMetadata: false, sourceSessionIds: ["heading-chat"] });
    assert.ok(new URL(page.url()).hash.includes("session=heading-chat"));
    await page.goBack();
    await ready(page);
    await expect(page.locator("#sessionAnalysis")).toBeVisible();
    await page.goForward();
    await assertTimeline(page, source, "day", { scope: "history", includeMetadata: false, sourceSessionIds: ["heading-chat"] });
});

test("scale heading and controls reflow in both themes at narrow, laptop, wide and 200 percent text", { timeout: 90000 }, async t => {
    const source = records(["2026-09-30", "2026-10-02"]);
    const { page, runtime } = await setup(t, source);
    const measurements = [];
    if (proofDir) await mkdir(proofDir, { recursive: true });
    await page.goto(runtime.url + "#home?bucket=month");
    await assertTimeline(page, source, "month");
    for (const theme of ["light", "dark"]) for (const width of [375, 1200, 1800]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const boxes = await page.locator(".chart-heading").evaluate(heading => {
            const rect = node => {
                const { x, y, right, bottom, width, height } = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                return { x, y, right, bottom, width, height, fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) };
            };
            return {
                heading: rect(heading), title: rect(heading.querySelector("h2")),
                control: rect(heading.querySelector("#bucketControl")),
                select: rect(heading.querySelector("#bucketFilter-control")),
                documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
            };
        });
        measurements.push({ theme, width, scale, ...boxes });
        for (const [name, box] of Object.entries(boxes).filter(([, value]) => value?.width)) {
            assert.ok(box.x >= boxes.heading.x - 1 && box.right <= boxes.heading.right + 1, `${theme}/${width}/${scale}: ${name} horizontal containment`);
            assert.ok(box.y >= boxes.heading.y - 1 && box.bottom <= boxes.heading.bottom + 1, `${theme}/${width}/${scale}: ${name} vertical containment`);
        }
        const separate = (a, b) => a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1;
        assert.ok(separate(boxes.title, boxes.control), "Title and period control never overlap");
        assert.ok(boxes.documentWidth <= boxes.viewport, "No document overflow");
        assert.ok(boxes.title.fontSize >= 18 * scale, "Title respects text enlargement");
        assert.ok(boxes.control.fontSize >= 12 * scale, "Period label uses the approved caption role and respects text enlargement");
        assert.ok(boxes.select.fontSize >= 14 * scale, "Period control uses the approved control role and respects text enlargement");
        assert.equal(await page.locator("#chartMeta,.chart-heading .ux-help").count(), 0);
        assert.match(await page.locator("#chartReadingNotes").textContent(), /Weeks start Monday.*display time zone/);
        if (proofDir) await page.locator(".chart-heading").screenshot({ path: path.join(proofDir, `heading-${theme}-${width}-${scale}x.png`) });
    }
    if (proofDir) await writeFile(path.join(proofDir, "heading-layout.json"), JSON.stringify(measurements, null, 2));
});
