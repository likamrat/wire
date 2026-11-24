import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, setLegacyTimeBucket, selectActivityOption, closeAnalyzeFilters, navigateMain } from "./helpers.mjs";
import { reviewRecords } from "./frontend-fixture.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";

const counts = [12, 34, 8, 137, 56, 17, 21];
function chartRecords(length = counts.length) {
    return Array.from({ length }, (_, index) => {
        const record = fixture(`time-overflow-${index}`);
        const stamp = new Date(Date.UTC(2026, 1, 2 + index * 7, 12)).toISOString();
        record.capturedAt = stamp;
        record.userPrompt = { text: "Find the invented coastal survey schedule.", status: "full",
            provenance: "human-authored", authorship: { actor: "user", basis: "source-user" }, sourceTimestamp: stamp };
        record.followUpPrompts = [];
        record.toolCalls = Array.from({ length: counts[index % counts.length] }, (_, call) => ({
            ...record.toolCalls[0], toolCallId: `overflow-call-${index}-${call}`, startEventId: `overflow-start-${index}-${call}`,
            startedAt: stamp, apiResults: [], toolSucceeded: call === 2 ? null : call !== 1,
            reportedOutcome: call === 2 ? "unknown" : call === 1 ? "failed" : "succeeded",
        }));
        return record;
    });
}
const ready = async page => {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
};
async function setup(t, records = chartRecords(), options = {}) {
    const original = structuredClone(records), errors = [], denied = [], cleanup = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const stored = await loadBoardState(context);
    const access = options.enforced ? await createCopilotRuntimeAccess(context) : undefined;
    const runtime = await startServer(context, createExportController(context), { port: 0, access, frontend: options.frontend, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw new Error("No providers in daily timeline proof."); },
            readSource() { throw new Error("No source reads in daily timeline proof."); } } });
    const origin = new URL(runtime.url).origin;
    const browser = await chromium.launch({ channel: process.env.WIRE_FRONTEND_BROWSER, ignoreDefaultArgs: ["--hide-scrollbars"] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, timezoneId: options.timeZone ?? "UTC",
        locale: "en-US", reducedMotion: "reduce" });
    const proof = options.trace && process.env.WIRE_OVERFLOW_PROOFS;
    if (proof) {
        await mkdir(proof, { recursive: true });
        await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin && url.pathname === "/api/app-update" && request.method() === "POST"
            && request.postDataJSON()?.action === "status") return route.continue();
        if (url.origin !== origin || request.method() !== "GET" && ![
            "/api/session", "/api/snapshot", "/api/collection/status", "/api/collection/sources/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison", "/api/trends", "/api/access/watch",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        if (url.pathname === "/api/snapshot") options.reads?.push(request.postDataJSON());
        return route.continue();
    });
    t.after(async () => {
        try {
            if (proof) await page.context().tracing.stop({ path: path.join(proof, options.trace + ".zip") });
            await browser.close(); await runtime.close();
            const after = await loadBoardState(context);
            if (proof) {
                const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
                await writeFile(path.join(proof, options.trace + "-receipt.json"), JSON.stringify({
                    test: t.name, browser: browser.version(), frontend: options.frontend, url: runtime.url,
                    fixture: hash(records), storedBefore: hash(stored), storedAfter: hash(after), errors, denied, stopped: true,
                    build: JSON.parse(await readFile(new URL("../dist/client/wire-build.json", import.meta.url), "utf8")),
                }, null, 2));
            }
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], stored[key], key);
            assert.deepEqual(records, original); assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { await access?.close(); for (const fn of cleanup) await fn(); }
    });
    const snapshot = options.snapshots ? page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok()) : null;
    await page.goto(runtime.url + (options.route ?? "#analyze?bucket=week")); await ready(page); await chooseTheme(page, "dark"); await ready(page);
    if (snapshot) options.snapshots.push(await (await snapshot).json());
    return page;
}

test("normal Analyze shows seven daily populations totaling 244 rather than two implicit weekly sums", { timeout: 60000 }, async t => {
    const reads = [], snapshots = [], expected = [35, 35, 34, 34, 34, 34, 38];
    const page = await setup(t, reviewRecords(), { frontend: process.env.WIRE_TEST_FRONTEND ?? "react",
        route: "#analyze", reads, snapshots, trace: "daily-normal-path" });
    await chooseTheme(page, "light"); await page.setViewportSize({ width: 1440, height: 1000 }); await ready(page);
    const initial = await measure(page);
    await capture(page, process.env.WIRE_DAILY_BASELINE ? "daily-before" : "daily-after-desktop", initial);
    assert.equal(reads[0].bucket, "day");
    assert.deepEqual(initial.counts.map(row => parseInt(row.text.replaceAll(",", ""), 10)), expected);
    assert.equal(initial.marks.reduce((sum, row) => sum + row.total, 0), 244);
    const points = snapshots[0].analytics.timeSeries.points;
    assert.equal(new Set(points.flatMap(point => point.drilldownIds)).size, 244);
    const paintedOutcomes = await page.locator(".time-slot").evaluateAll(nodes => nodes.map(node =>
        Object.fromEntries([...node.querySelectorAll(".flat-time-segment")].map(segment => [segment.dataset.segment, Number(segment.dataset.count)]))));
    for (const [index, counts] of paintedOutcomes.entries()) for (const outcome of ["success", "failure", "unknown", "partial", "other", "transport"])
        assert.equal(counts[outcome] ?? 0, points[index][outcome], `${points[index].date}/${outcome}: exact recorded outcomes`);
    assert.deepEqual(initial.dates.map(row => row.text), ["Nov 10", "Nov 11", "Nov 12", "Nov 13", "Nov 14", "Nov 15", "Nov 16"]);
    for (const [width, scale, theme] of [[1440, 1, "light"], [390, 1, "dark"], [1024, 2, "light"]]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme); await ready(page);
        const geometry = await measure(page);
        assert.equal(geometry.viewport.pageOverflow, 0);
        assert.deepEqual(geometry.marks.map(mark => mark.total), expected);
        const ink = geometry.dates.map(row => row.ink);
        for (let index = 1; index < ink.length; index++) assert.ok(ink[index].x - ink[index - 1].right >= 8,
            "Every adjacent date has readable separation rather than overlapping or disappearing");
        if (width !== 1440) assert.ok(geometry.scrollWidth > geometry.clientWidth, "Daily dates scroll locally instead of regrouping");
        for (const index of [0, 3, 6]) {
            const action = page.locator(".time-column").nth(index);
            await action.focus();
            const visible = await action.evaluate(node => {
                const mark = node.getBoundingClientRect(), clip = node.closest(".flat-time-scroll").getBoundingClientRect();
                return mark.left >= clip.left && mark.right <= clip.right;
            });
            assert.ok(visible, "Keyboard focus reveals each dated action");
        }
        await capture(page, `daily-after-${width}-text${scale}-${theme}`, await measure(page));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; }); await ready(page);
    await page.locator("#openChartReference").click();
    await page.locator('#chartReferenceTopics button[data-reference-topic="time"]').click();
    await expect(page.locator("#chartReferenceExplanation")).toContainText("Individual calendar days by default");
    await page.locator("#chartReferenceShowData").click();
    const exact = page.locator("#chartReferenceData .exact-data-table");
    await expect(exact.locator("caption")).toContainText("by day");
    assert.deepEqual(await exact.locator("tbody td:nth-child(2)").allTextContents(), expected.map(String));
    await expect(exact.locator("tfoot td").first()).toHaveText("244");
    const drilledResponse = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await exact.getByRole("link", { name: /Nov 15, 2026: 34/ }).click(); await ready(page);
    const drilled = await (await drilledResponse).json();
    assert.deepEqual(drilled.analytics.rows.map(row => row.id).sort(), [...points.find(point => point.date === "2026-11-15").drilldownIds].sort());
    const params = new URL(page.url()).searchParams;
    assert.equal(params.has("from") || params.has("to"), false);
    await expect(page.locator("#activityCount")).toHaveText("34");
    await page.goBack(); await ready(page);
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await setLegacyTimeBucket(page, "week"); await ready(page);
    assert.deepEqual((await measure(page)).marks.map(row => row.total), [206, 38]);
    await setLegacyTimeBucket(page, "month"); await ready(page);
    assert.deepEqual((await measure(page)).marks.map(row => row.total), [244]);
});

test("daily Analyze keeps long-range empty days distinct from undated evidence", { timeout: 45000 }, async t => {
    const source = ["2025-01-01T12:00:00Z", "2026-02-06T12:00:00Z", null].map((stamp, index) => {
        const record = fixture(`daily-gap-${index}`);
        record.capturedAt = stamp; record.toolCalls[0].startedAt = stamp;
        return record;
    });

    const reads = [], snapshots = [];
    const page = await setup(t, source, { frontend: process.env.WIRE_TEST_FRONTEND ?? "react", route: "#analyze", reads, snapshots });
    assert.equal(reads[0].bucket, "day");
    const series = snapshots[0].analytics.timeSeries;
    assert.equal(series.points.length, 90); assert.equal(series.undatedCount, 1);
    assert.equal(series.window.total, 402); assert.equal(series.totals.count, 2);
    await expect(page.locator("#activityCount")).toHaveText("3");
    await expect(page.locator(".dimensional-time-labels > a")).toHaveCount(90);
    await expect(page.locator(".time-zero")).toHaveCount(89);
    await expect(page.locator("#timelineWindow")).toContainText("90 of 402 days");
    assert.ok(await page.locator(".flat-time-scroll *").count() < 500, "DOM work is bounded by the visible calendar window");
    await expect(page.locator("#chartFooter")).toContainText("1 undated record");
    await expect(page.locator(".time-zero").first()).toHaveAttribute("aria-label", /No qualifying records/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".time-column").last().focus();
    await capture(page, "daily-long-gap", await measure(page));
    await page.getByRole("button", { name: "First dates", exact: true }).click(); await ready(page);
    await expect(page.locator(".dimensional-time-labels > a").first()).toHaveText("Jan 1");
    await expect(page.locator("#activityCount")).toHaveText("3");
    await expect(page.locator("#timeline-first")).toBeFocused();
    assert.ok(await page.locator(".flat-time-scroll *").count() < 500);
    assert.equal(new URL(page.url()).searchParams.get("from"), null, "Paging never changes selected evidence dates");
    await page.getByRole("button", { name: "Later dates", exact: true }).click(); await ready(page);
    await expect(page.locator(".time-zero")).toHaveCount(90);
    await expect(page.locator("#activityCount")).toHaveText("3");
    await page.getByRole("button", { name: "Latest dates", exact: true }).click(); await ready(page);
    await page.locator(".time-column").last().focus();
    const target = page.locator(".time-column").last();
    const next = new URLSearchParams((await target.getAttribute("href")).split("?")[1]);
    assert.equal(next.has("from") || next.has("to"), false);
    const windowOrigin = page.url();
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator(".dimensional-time-labels > a")).toHaveCount(1);
    await page.goBack(); await ready(page);
    assert.equal(page.url(), windowOrigin);
    await expect(page.locator("#activityCount")).toHaveText("3");
    await expect(page.locator(".time-column").last()).toBeFocused();
});
function anchorRecords() {
    return ["2016-11-16", "2026-11-16"].map((date, index) => {
        const record = fixture(`anchor-${index}`);
        record.title = index ? "Cedar mail evidence" : "Cedar missing-target evidence";
        record.userPrompt.text = record.title;
        record.followUpPrompts = [];
        record.capturedAt = date + "T12:00:00Z";
        Object.assign(record.toolCalls[0], { startedAt: record.capturedAt, requestArgs: index ? { entityUrls: ["/me/messages"] } : {},
            requestedApiPath: index ? "/me/messages" : null, apiResults: index ? [{ index: 0, path: "/me/messages", statusCode: 200 }] : [] });
        return record;
    });
}

test("removing missing-service context retires the old window without broadening Mail", { timeout: 30000 }, async t => {
    const reads = [], snapshots = [];
    const page = await setup(t, anchorRecords(), { frontend: process.env.WIRE_TEST_FRONTEND ?? "react",
        route: "#analyze?services=Mail&includeMissingService=true", reads, snapshots, trace: "anchor-refinement" });
    await chooseTheme(page, "light");
    await page.getByRole("button", { name: "First dates", exact: true }).click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    await page.evaluate(() => { window.retiredTimelineAction = document.getElementById("timeline-first"); });
    await page.locator("#openAnalyzeFilters").click();
    const narrowedResponse = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.getByRole("button", { name: "Remove missing-service context", exact: true }).click(); await ready(page);
    const narrowed = await (await narrowedResponse).json();
    await closeAnalyzeFilters(page);
    await capture(page, process.env.WIRE_DAILY_BASELINE ? "anchor-before" : "anchor-mail-light", { request: reads.at(-1) });
    assert.equal(new URL(page.url()).searchParams.get("timelineFrom"), null);
    assert.deepEqual(reads.at(-1).filters.services, ["Mail"]);
    assert.equal(reads.at(-1).filters.includeMissingService, false);
    assert.deepEqual(narrowed.analytics.rows.map(row => row.id), snapshots[0].analytics.rows.filter(row => row.scenarioId === "anchor-1").map(row => row.id));
    assert.equal(narrowed.analytics.timeSeries.totals.count, 1);
    assert.equal(narrowed.analytics.timeSeries.window.count, 1);
    assert.equal(narrowed.analytics.timeSeries.window.total, 1);
    const accepted = page.url(), acceptedReads = reads.length;
    await page.evaluate(() => window.retiredTimelineAction.click());
    assert.equal(page.url(), accepted); assert.equal(reads.length, acceptedReads);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator(".time-column")).toHaveCount(1);
    await expect(page.locator(".dimensional-time-labels > a")).toHaveText(["Nov 16"]);
    await page.setViewportSize({ width: 390, height: 844 }); await chooseTheme(page, "dark"); await ready(page);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    await capture(page, "anchor-mail-narrow-dark", await measure(page));
    await page.locator("#openAnalyzeFilters").click();
    await page.locator("#addServiceContext").click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    await closeAnalyzeFilters(page);
    await page.locator('[data-breakdown="services"] a[aria-label^="Mail:"]:visible').first().click(); await ready(page);
    assert.equal(new URL(page.url()).searchParams.get("timelineFrom"), null);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator(".time-column")).toHaveCount(1);
});

test("out-of-range short and long timeline links retain keyboard recovery and Back", { timeout: 45000 }, async t => {
    const page = await setup(t, anchorRecords(), { frontend: process.env.WIRE_TEST_FRONTEND ?? "react", route: "#analyze", trace: "anchor-deep-links" });
    const origin = new URL(page.url()).origin;
    for (const short of [true, false]) for (const timelineFrom of ["1900-01-01", "2030-01-01"]) {
        const bucket = short && timelineFrom === "2030-01-01" ? "month" : null;
        const parameters = new URLSearchParams({ timelineFrom, ...(bucket ? { bucket } : {}), ...(short ? { services: "Mail", includeMissingService: "false" } : {}) });
        const response = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
        await page.goto(origin + "/#analyze?" + parameters);
        const outside = await (await response).json(); await ready(page);
        assert.equal(outside.analytics.timeSeries.window.count, 0);
        assert.equal(outside.analytics.timeSeries.window.total, short ? 1 : 3653);
        assert.equal(outside.analytics.timeSeries.totals.count, short ? 1 : 2);
        await expect(page.locator("#activityCount")).toHaveText(short ? "1" : "2");
        await expect(page.locator("#chart")).toContainText("No dated records in this window");
        await expect(page.getByRole("button", { name: "First dates", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Latest dates", exact: true })).toHaveAttribute("aria-disabled", "false");
        if (short && timelineFrom === "1900-01-01") {
            await page.setViewportSize({ width: 390, height: 844 }); await chooseTheme(page, "dark"); await ready(page);
            await capture(page, "anchor-short-recovery-controls", { window: outside.analytics.timeSeries.window });
        }
        const recoveredResponse = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
        await page.locator("#timeline-first").focus(); await page.keyboard.press("Enter"); await ready(page);
        const recovered = await (await recoveredResponse).json();
        assert.equal(recovered.analytics.timeSeries.window.count, short ? 1 : 90);
        assert.equal(recovered.analytics.timeSeries.window.offset, 0);
        assert.equal(recovered.analytics.timeSeries.totals.count, short ? 1 : 2);
        assert.deepEqual(recovered.analytics.rows.map(row => row.id), outside.analytics.rows.map(row => row.id));
        await expect(page.locator(".time-column")).toHaveCount(1);
        await expect(page.locator("#timeline-first")).toBeFocused();
        await expect(page.locator("#activityCount")).toHaveText(short ? "1" : "2");
        if (short && timelineFrom === "1900-01-01") await capture(page, "anchor-short-recovered", await measure(page));
        await page.goBack(); await ready(page);
        assert.equal(new URL(page.url()).searchParams.has("timelineFrom"), false);
        await expect(page.locator("#chart")).toContainText("No dated records in this window");
        await expect(page.locator("#timeline-first")).toBeFocused();
        await page.locator("#timeline-latest").focus(); await page.keyboard.press("Enter"); await ready(page);
        await expect(page.locator(".time-column")).toHaveCount(1);
        await expect(page.locator("#timeline-latest")).toBeFocused();
        await expect(page.locator("#activityCount")).toHaveText(short ? "1" : "2");
        const accepted = new URL(page.url()).searchParams;
        assert.equal(accepted.has("services") || accepted.has("bucket"), false);
        await expect(page.locator("#serviceAssociationFilter")).toHaveValue(short ? "Mail" : "all");
    }
});

test("outside anchors do not invent recovery dates for genuinely empty or undated populations", { timeout: 30000 }, async t => {
    const undated = fixture("anchor-undated");
    undated.capturedAt = null;
    Object.assign(undated.toolCalls[0], { tool: "workiq-retrieve", startedAt: null });
    const page = await setup(t, [...anchorRecords(), undated], { frontend: process.env.WIRE_TEST_FRONTEND ?? "react", route: "#analyze" });
    const origin = new URL(page.url()).origin;
    for (const tool of ["workiq-ask", "workiq-retrieve"]) for (const timelineFrom of ["1900-01-01", "2030-01-01"]) {
        const response = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
        await page.goto(origin + "/#analyze?" + new URLSearchParams({ tool, timelineFrom }));
        const value = await (await response).json(); await ready(page);
        assert.equal(value.analytics.timeSeries.window, null);
        assert.equal(value.analytics.timeSeries.points.length, 0);
        await expect(page.locator("#timelineWindow")).toHaveCount(0);
        await expect(page.locator("#activityCount")).toHaveText(tool === "workiq-ask" ? "0" : "1");
        await expect(page.locator("#chart")).toContainText(tool === "workiq-ask" ? "No matching activity" : "Dates unavailable");
        assert.equal(value.analytics.timeSeries.undatedCount, tool === "workiq-ask" ? 0 : 1);
    }
});

test("timeline windows retire held reads and actions on scope changes and withdrawal", { timeout: 45000 }, async t => {
    const source = ["2016-11-16", "2026-11-16"].map((date, index) => {
        const record = fixture(`window-authority-${index}`);
        record.capturedAt = date + "T12:00:00Z"; record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    const page = await setup(t, source, { frontend: process.env.WIRE_TEST_FRONTEND ?? "react", route: "#analyze", enforced: true });
    let release, held = false;
    t.after(() => release?.());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        if (held) { held = false; await new Promise(resolve => { release = resolve; }); }
        await route.fulfill({ response });
    });
    await page.evaluate(() => { window.retiredTimelineAction = document.getElementById("timeline-first"); });
    held = true;
    await page.getByRole("button", { name: "First dates", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-11-16");
    await page.locator("#toFilter").fill("2026-11-16");
    await page.locator("#filters button[type=submit]").click(); await ready(page);
    release(); release = null;
    await expect(page.locator("#timelineWindow")).toHaveCount(0);
    await expect(page.locator("#activityCount")).toHaveText("1");
    const accepted = page.url();
    await page.evaluate(() => window.retiredTimelineAction.click());
    assert.equal(page.url(), accepted);
    await selectActivityOption(page, "dateFilter", "capture"); await ready(page); await closeAnalyzeFilters(page);
    held = true;
    await page.getByRole("button", { name: "First dates", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.evaluate(() => {
        window.heldTimelineText = [];
        const walker = document.createTreeWalker(document.getElementById("timelineWindow"), NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) window.heldTimelineText.push(walker.currentNode);
        window.retiredTimelineAction = document.getElementById("timeline-first");
    });
    const origin = new URL(page.url()).origin;
    const post = async (path, body, capability) => {
        const response = await fetch(origin + path, { method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1",
                ...(capability ? { "X-Board-Capability": capability } : {}) }, body: JSON.stringify(body) });
        assert.equal(response.status, 200); return response.json();
    };
    const session = await post("/api/session", {});
    const status = await fetch(origin + "/api/access/status", {
        headers: { "X-Board-Capability": session.capability },
    }).then(response => response.json());
    await post("/api/access/command", { schemaVersion: 1, action: "wire-sign-out",
        operationId: randomUUID(), generation: status.generation }, session.capability);
    await expect(page.locator("#workspace")).toBeHidden();
    assert.equal(await page.evaluate(() => window.heldTimelineText.length > 0
        && window.heldTimelineText.every(node => node.data === "")), true);
    release();
    await page.evaluate(() => window.retiredTimelineAction.click());
    await expect(page.locator("#workspace")).toBeHidden();
    await post("/api/session/release", {}, session.capability);
});

test("Analyze range and navigation changes preserve an explicit interval while new views stay daily", { timeout: 45000 }, async t => {
    const reads = [];
    const page = await setup(t, reviewRecords(), { frontend: process.env.WIRE_TEST_FRONTEND ?? "react", route: "#analyze", reads });
    await selectActivityOption(page, "dateFilter", "30"); await ready(page);
    assert.equal(reads.at(-1).bucket, "day");
    await setLegacyTimeBucket(page, "week"); await ready(page);
    await selectActivityOption(page, "dateFilter", "capture"); await ready(page);
    assert.equal(reads.at(-1).bucket, "week", "All dates must not discard an explicitly chosen interval");
    await selectActivityOption(page, "dateFilter", "custom"); await ready(page);
    await page.locator("#fromFilter").fill("2026-11-10");
    await page.locator("#toFilter").fill("2026-11-16");
    await page.locator("#filters button[type=submit]").click(); await ready(page);
    assert.equal(reads.at(-1).bucket, "week", "Custom dates only replace the population range");
    await closeAnalyzeFilters(page);
    await navigateMain(page, "trends");
    await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "analyze"); await ready(page);
    assert.equal(reads.at(-1).bucket, "week");
    assert.deepEqual((await measure(page)).marks.map(row => row.total), [206, 38]);
    await navigateMain(page, "compare");
    await expect(page.locator("#periodComparison")).toBeVisible();
    await page.locator("#openAnalyzeFilters").click();
    await selectActivityOption(page, "comparisonBucket", "month");
    await expect(page.locator("#comparisonBucket")).toHaveValue("month");
    await navigateMain(page, "analyze"); await ready(page);
    assert.deepEqual((await measure(page)).marks.map(row => row.total), [206, 38],
        "Compare's explicit Month choice cannot replace Analyze's independent Week choice");
    await selectActivityOption(page, "dateFilter", "30"); await ready(page);
    assert.equal(reads.at(-1).bucket, "week");
});

async function measure(page) {
    return page.locator(".flat-time-scroll").evaluate(scroll => {
        const rect = node => {
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        const style = getComputedStyle(scroll), plot = scroll.querySelector(".flat-time-plot");
        return {
            viewport: { width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale,
                rootFont: getComputedStyle(document.documentElement).fontSize,
                pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth },
            panel: rect(scroll.closest(".chart-panel")), scroll: rect(scroll), plot: rect(plot),
            clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth, scrollLeft: scroll.scrollLeft,
            overflowX: style.overflowX, scrollbarHeight: scroll.offsetHeight - scroll.clientHeight,
            minimum: getComputedStyle(plot).minWidth, overflowing: scroll.dataset.overflow,
            description: scroll.getAttribute("aria-description"),
            axis: [...scroll.querySelectorAll(".flat-time-axis > span")].map(node => ({ text: node.textContent, ...rect(node) })),
            counts: [...scroll.querySelectorAll(".dimensional-count")].map(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                return { text: node.textContent, ...rect(node), ink: rect(range),
                    fontSize: getComputedStyle(node).fontSize, fontFamily: getComputedStyle(node).fontFamily };
            }),
            dates: [...scroll.querySelectorAll(".dimensional-time-labels > a")].map(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                return { text: node.textContent, ...rect(node), ink: rect(range) };
            }),
            marks: [...scroll.querySelectorAll(".flat-time-column")].map(node => ({
                total: +node.dataset.total, maximum: +node.dataset.maximum, extent: +node.dataset.plotHeight,
                encodedHeight: +node.getAttribute("height"), ...rect(node),
            })),
        };
    });
}
async function capture(page, name, geometry) {
    if (!process.env.WIRE_OVERFLOW_PROOFS) return;
    const directory = process.env.WIRE_OVERFLOW_PROOFS;
    await mkdir(directory, { recursive: true });
    await page.locator(".analyze-chart-main").screenshot({ path: path.join(directory, `${name}-widget.png`) });
    await page.screenshot({ path: path.join(directory, `${name}-context.png`), fullPage: true });
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(geometry, null, 2));
}
async function captureFocus(page, name, bounds) {
    if (!process.env.WIRE_OVERFLOW_PROOFS) return;
    const directory = process.env.WIRE_OVERFLOW_PROOFS;
    await mkdir(directory, { recursive: true });
    const chart = await measure(page), cdp = await page.context().newCDPSession(page);
    const image = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    await cdp.detach();
    await writeFile(path.join(directory, name + ".png"), Buffer.from(image.data, "base64"));
    await writeFile(path.join(directory, name + ".json"), JSON.stringify({ bounds, chart, afterCapture: await measure(page) }, null, 2));
}

test("a fitted seven-bucket Analyze chart has no horizontal scrollbar and keeps every label and column", async t => {
    const page = await setup(t);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".dimensional-count" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert.ok(fonts.some(font => font.familyName.startsWith("Asta Sans") && font.isCustomFont && font.glyphCount > 0), JSON.stringify(fonts));
    await cdp.detach();
    for (const theme of ["dark", "light"]) for (const expanded of [true, false]) {
        await chooseTheme(page, theme);
        const toggle = page.locator("#navigationCollapse");
        if (await toggle.getAttribute("aria-expanded") !== String(expanded)) await toggle.click();
        await ready(page);
        const geometry = await measure(page);
        await capture(page, `fitted-${theme}-${expanded ? "expanded" : "collapsed"}`, geometry);
        assertChart(geometry, counts);
        assert.ok(geometry.scrollWidth <= geometry.clientWidth, JSON.stringify(geometry));
        for (const item of [...geometry.counts, ...geometry.dates]) {
            assert.ok(item.ink.x >= geometry.scroll.x && item.ink.right <= geometry.scroll.right);
        }
        assert.notEqual(geometry.overflowX, "scroll", "A fitted time chart must not force an empty native horizontal track");
        assert.equal(geometry.scrollbarHeight, 0, "The fitted chart must not reserve native horizontal scrollbar height");
    }
});

function assertChart(geometry, expected) {
    assert.deepEqual(geometry.counts.map(row => row.text), expected.map(count => `${count} calls`));
    assert.equal(geometry.marks.length, expected.length);
    assert.equal(geometry.dates.length, expected.length);
    assert.equal(geometry.viewport.pageOverflow, 0);
    assert.deepEqual(geometry.axis.map(row => row.text), [String(Math.max(...expected)), "0"]);
    for (const item of [...geometry.counts, ...geometry.dates]) {
        assert.ok(item.ink.x >= item.x && item.ink.right <= item.right, "Labels stay inside their own lane");
        assert.ok(item.ink.x >= geometry.plot.x && item.ink.right <= geometry.plot.right, "All label ink stays inside the plot");
        assert.ok(item.ink.y >= geometry.plot.y && item.ink.bottom <= geometry.plot.bottom, "No clipped label headroom");
    }
    for (const item of geometry.axis) assert.ok(item.x >= geometry.plot.x && item.right <= geometry.plot.right);
    for (const [index, mark] of geometry.marks.entries()) {
        assert.equal(mark.total, expected[index]);
        assert.equal(mark.encodedHeight, expected[index] / Math.max(...expected) * 200);
        assert.ok(Math.abs(mark.height - mark.encodedHeight) < 1 / 32, "Actual paint remains linear within layout rounding");
        assert.equal(mark.width, 84);
        assert.ok(mark.x >= geometry.plot.x && mark.right <= geometry.plot.right);
        assert.ok(Math.abs(mark.bottom - geometry.marks[0].bottom) < 1 / 32, "Columns share the zero baseline");
    }
}

test("native overflow appears only when needed and resize keeps all date targets reachable", async t => {
    const page = await setup(t);
    const links = () => page.locator(".time-column").evaluateAll(nodes => nodes.map(node => ({
        href: node.getAttribute("href"), label: node.getAttribute("aria-label"),
    })));
    const original = await links(), total = counts.reduce((sum, count) => sum + count, 0);
    for (const theme of ["dark", "light"]) for (const [width, scale] of [[1920, 1], [1440, 1], [768, 1], [390, 2], [1920, 1]]) {
        await page.setViewportSize({ width, height: 1080 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
        await chooseTheme(page, theme); await ready(page);
        const geometry = await measure(page), overflow = geometry.scrollWidth > geometry.clientWidth;
        assertChart(geometry, counts);
        assert.equal(geometry.overflowX, "auto");
        assert.equal(geometry.overflowing, String(overflow));
        assert.equal(geometry.scrollbarHeight > 0, overflow, "Real native scrolling, not hidden/clipped overflow");
        assert.equal(Boolean(geometry.description), overflow);
        assert.deepEqual(await links(), original);
        await expect(page.locator("#activityCount")).toHaveText(String(total));
        for (let index = 0; index < counts.length; index++) {
            const action = page.locator(".time-column").nth(index);
            await action.focus();
            const scroll = await page.locator(".flat-time-scroll").boundingBox();
            const count = await action.locator(".dimensional-count").boundingBox();
            const mark = await action.boundingBox();
            if (width === 768 && index === 4) await captureFocus(page, `native-focus-${theme}-768`, { scroll, count, mark });
            assert.ok(count.width >= 44 && count.height >= 44);
            assert.ok(count.x >= scroll.x && count.x + count.width <= scroll.x + scroll.width);
            assert.ok(mark.x >= scroll.x && mark.x + mark.width <= scroll.x + scroll.width);
            assert.equal(await action.locator(".dimensional-count").evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 16 * scale);
        }
        if (width === 390 || width === 1440) await capture(page, `narrow-${theme}-${width}-text${scale}`, await measure(page));
    }
    const last = page.locator(".time-column").last();
    await last.focus(); await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText(String(counts.at(-1)));
    assert.equal(page.url(), new URL(original.at(-1).href, page.url()).href);
    await page.goBack(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText(String(total));
    await expect(page.locator(".time-column").last()).toBeFocused();
    await page.locator(".dimensional-time-labels > a").first().click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText(String(counts[0]));
    assert.equal(page.url(), new URL(original[0].href, page.url()).href);
    await page.goBack(); await ready(page);
    const filterEntry = page.locator("#openAnalyzeFilters");
    if (await filterEntry.count()) await filterEntry.click();
    for (const mode of ["workload", "endpoint", "time"]) {
        await page.locator(`[data-chart="${mode}"]`).click(); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText(String(total));
        await expect(page.locator("#periodResult")).toContainText("All dates");
    }
    const identity = row => {
        const [view, query] = row.href.split("?");
        const parameters = new URLSearchParams(query); parameters.sort();
        return { ...row, href: view + "?" + parameters };
    };
    assert.deepEqual((await links()).map(identity), original.map(row => identity({ ...row, href: row.href + "&chart=time" })));
});

test("genuinely dense time bins keep a native scroller and the final column at wide and enlarged narrow widths", async t => {
    const expected = Array.from({ length: 45 }, (_, index) => counts[index % counts.length]);
    const page = await setup(t, chartRecords(expected.length));
    await setLegacyTimeBucket(page, "week"); await ready(page);
    for (const [width, scale] of [[1920, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 1080 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await ready(page);
        const geometry = await measure(page);
        assertChart(geometry, expected);
        assert.ok(geometry.scrollWidth > geometry.clientWidth);
        assert.equal(geometry.overflowX, "auto");
        assert.ok(geometry.scrollbarHeight > 0);
        await page.locator(".time-column").last().focus();
        const focused = await measure(page);
        assert.ok(focused.scrollLeft > 0);
        assert.ok(focused.counts.at(-1).x >= focused.scroll.x && focused.counts.at(-1).right <= focused.scroll.right);
        assert.ok(focused.marks.at(-1).x >= focused.scroll.x && focused.marks.at(-1).right <= focused.scroll.right);
        await capture(page, `dense-${width}-text${scale}`, focused);
    }
});

test("sidebar animation crosses the fit boundary without a false scrollbar or replaced columns", async t => {
    const page = await setup(t);
    // The side-by-side outcome column moves the same chart fit boundary 192px wider.
    await page.setViewportSize({ width: 1632, height: 1080 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await ready(page);
    const first = await page.locator(".time-column").first().elementHandle();
    const samples = [];
    for (const expanded of [false, true]) {
        await page.evaluate(() => {
            window.chartFrames = [];
            const sample = () => {
                const scroll = document.querySelector(".flat-time-scroll");
                window.chartFrames.push({ width: scroll.clientWidth, content: scroll.scrollWidth,
                    track: scroll.offsetHeight - scroll.clientHeight });
                window.chartFrame = requestAnimationFrame(sample);
            };
            window.chartFrame = requestAnimationFrame(sample);
        });
        await page.locator("#navigationCollapse").click();
        await ready(page);
        await page.evaluate(async () => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            cancelAnimationFrame(window.chartFrame);
        });
        const frames = await page.evaluate(() => window.chartFrames);
        assert.ok(new Set(frames.map(frame => frame.width)).size > 3, "Exercise real intermediate sidebar widths");
        for (const frame of frames) assert.equal(frame.track > 0, frame.content > frame.width);
        const geometry = await measure(page);
        assertChart(geometry, counts);
        assert.equal(geometry.scrollWidth > geometry.clientWidth, expanded);
        assert.equal(await page.locator(".time-column").first().evaluate((node, original) => node === original, first), true);
        samples.push({ expanded, frames });
    }
    if (process.env.WIRE_OVERFLOW_PROOFS) await writeFile(path.join(process.env.WIRE_OVERFLOW_PROOFS, "sidebar-frames.json"), JSON.stringify(samples, null, 2));
});

test("fractional scrollports reveal the complete focused column and count in both directions", async t => {
    const page = await setup(t);
    // Leave room outside the deliberately fixed-width widget so a synthetic width
    // doesn't push the page beyond the viewport at 200% text.
    await page.setViewportSize({ width: 1200, height: 1080 });
    await page.locator(".analyze-chart-main").evaluate(node => { node.style.width = "532.078125px"; });
    await ready(page);
    assert.equal((await page.locator(".flat-time-scroll").boundingBox()).width, 490.078125);
    let step = 0;
    for (const index of [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 0]) {
        const action = page.locator(".time-column").nth(index);
        await action.focus();
        const bounds = await action.evaluate(control => {
            const scroll = control.closest(".dimensional-scroll");
            return { clip: scroll.getBoundingClientRect().toJSON(), count: control.querySelector(".dimensional-count").getBoundingClientRect().toJSON(),
                mark: control.getBoundingClientRect().toJSON(), scrollLeft: scroll.scrollLeft };
        });
        if (index === 4) await captureFocus(page, `fractional-focus-${step < 7 ? "forward" : "backward"}`, bounds);
        for (const box of [bounds.count, bounds.mark]) {
            assert.ok(box.left >= bounds.clip.left && box.right <= bounds.clip.right, JSON.stringify({ index, bounds }));
        }
        step++;
    }
    for (const theme of ["dark", "light"]) for (const index of [0, 4, 6]) {
        await chooseTheme(page, theme);
        const action = page.locator(".time-column").nth(index);
        await action.focus();
        for (const [width, scale] of [[322.078125, 2], [532.078125, 1]]) {
            await page.evaluate(({ width, scale }) => {
                document.querySelector(".analyze-chart-main").style.width = width + "px";
                document.documentElement.style.fontSize = `${scale * 100}%`;
            }, { width, scale });
            await ready(page);
            await expect(action).toBeFocused();
            const geometry = await measure(page);
            assertChart(geometry, counts);
            for (const box of [geometry.counts[index], geometry.marks[index]]) {
                assert.ok(box.x >= geometry.scroll.x && box.right <= geometry.scroll.right);
            }
        }
    }
    const action = page.locator(".time-column").last(), scroll = page.locator(".flat-time-scroll");
    await action.focus();
    const offset = await scroll.evaluate(node => node.scrollLeft);
    const clip = await scroll.boundingBox();
    await page.mouse.move(clip.x + clip.width / 2, clip.y + clip.height / 2);
    await page.mouse.wheel(-60, 0);
    await page.waitForFunction(offset => document.querySelector(".flat-time-scroll").scrollLeft < offset, offset);
    const moved = await scroll.evaluate(node => node.scrollLeft);
    await ready(page);
    assert.equal(await scroll.evaluate(node => node.scrollLeft), moved, "Focus does not reclaim deliberate horizontal scrolling");
    await expect(action).toBeFocused();

    const href = await action.getAttribute("href"), originalUrl = page.url();
    const popupPromise = page.context().waitForEvent("page");
    await action.locator(".dimensional-count").click({ modifiers: ["Control"] });
    const popup = await popupPromise;
    try {
        await expect(popup.locator("#periodResult")).toContainText("Work IQ tool call");
        assert.equal(new URL(popup.url()).pathname, new URL(href, originalUrl).pathname);
        assert.equal(page.url(), originalUrl, "Modified date links retain native new-tab navigation");
    } finally { await popup.close(); }
});
