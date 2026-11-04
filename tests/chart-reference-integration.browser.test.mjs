import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { createTimeContext } from "../lib/time.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { contrast } from "./color-measurements.mjs";

const proof = process.env.WIRE_CHART_GUIDE_PROOFS;
async function captureNative(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    const capture = await page.context().newCDPSession(page);
    const image = await capture.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await capture.detach();
    await writeFile(path.join(proof, name + ".png"), Buffer.from(image.data, "base64"));
}
async function setup(t, records, { reducedMotion = "reduce", hash = "", nativeZoom = false, observeQualification = false, observeGuide = false } = {}) {
    let removeFixture;
    const { context } = await privateFixture({ after: cleanup => { removeFixture = cleanup; } }, records);
    const before = await loadBoardState(context), errors = [], denied = [], requests = [];
    const server = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw new Error("Provider access forbidden in chart guide proof."); },
            readSource() { throw new Error("Source access forbidden in chart guide proof."); },
        },
    });
    const profile = nativeZoom ? await mkdtemp(path.join(os.tmpdir(), "wire-chart-zoom-")) : null;
    const browser = nativeZoom ? await chromium.launchPersistentContext(profile, {
        channel: "chrome", headless: true, viewport: null, timezoneId: "America/New_York", reducedMotion,
        args: ["--window-size=1440,1000"],
    }) : await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await server.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally {
            await removeFixture();
            if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    });
    const page = nativeZoom ? await browser.newPage()
        : await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York", reducedMotion });
    let unzoomed;
    if (nativeZoom) {
        unzoomed = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }));
        await page.goto("chrome://settings/appearance");
        await page.locator("select#zoomLevel").selectOption("2");
    }
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison", "/api/session",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        requests.push(url.pathname);
        if ((observeQualification || observeGuide) && url.pathname === "/") {
            const response = await route.fetch();
            let html = await response.text();
            if (observeQualification) {
                const binding = "readContext: readChartReferenceContext, renderExact:";
                assert.equal(html.split(binding).length, 2);
                html = html.replace(binding, `readContext: () => {
                    const value = readChartReferenceContext(); window.observedGuideQualification = value; return value;
                }, renderExact:`);
            }
            if (observeGuide) {
                const binding = "let readingIntent = 0;";
                assert.equal(html.split(binding).length, 2);
                html = html.replace(binding, `window.nativeGuide = chartReferenceUI; window.nativeSidebarTiming = sidebar.timing; ${binding}`);
            }
            return route.fulfill({ response, body: html });
        }
        return route.continue();
    });
    const firstSnapshot = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.goto(server.url + hash);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    if (nativeZoom) {
        const zoomed = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }));
        assert.ok(Math.abs(zoomed.dpr / unzoomed.dpr - 2) < .01);
        assert.ok(Math.abs(zoomed.width / unzoomed.width - .5) < .01);
        if (proof) { await mkdir(proof, { recursive: true }); await writeFile(path.join(proof, "native-zoom.json"), JSON.stringify({ unzoomed, zoomed })); }
    }
    return { page, requests, snapshot: await (await firstSnapshot).json() };
}

async function exact(page, topic) {
    await page.locator("#openChartReference").click();
    await topicChoice(page, topic);
    await page.locator("#chartReferenceShowData").click();
}

async function topicChoice(page, topic) {
    if (await page.locator("#chartReferenceExact").isVisible()) await page.locator("#chartReferenceBack").click();
    if (await page.locator("#chartReferenceAllTopics").isVisible()) await page.locator("#chartReferenceAllTopics").click();
    await page.locator(`button[data-reference-topic="${topic}"]`).click();
}

async function assertGuideFrame(page, expected) {
    const actual = await page.locator("#meaning").boundingBox();
    for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(actual[key] - expected[key]) < 1, `Stable guide ${key}`);
}

test("the native side guide routes every topic, index and exact view with native Back and focus", { timeout: 60000 }, async t => {
    const { page } = await setup(t, pathRecords());
    await page.locator("#openChartReference").click();
    await page.locator("#meaning").evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    const original = await page.locator("#meaning").boundingBox();
    for (const topic of ["outcomes", "time", "services", "models", "tools", "categories", "paths"]) {
        await page.locator("#chartReferenceAllTopics").click();
        await assertGuideFrame(page, original);
        await page.locator(`button[data-reference-topic="${topic}"]`).click();
        await expect(page.locator("#meaning")).toHaveAttribute("data-reference-topic", topic);
        await assertGuideFrame(page, original);
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#meaning")).toHaveAttribute("data-reference-view", "data");
        await assertGuideFrame(page, original);
        await page.mouse.click(original.x - 4, original.y + 30);
        await expect(page.locator("#meaning")).toHaveAttribute("data-reference-view", "guide");
        await expect(page.locator("#chartReferenceShowData")).toBeFocused();
    }
    await page.mouse.click(original.x - 4, original.y + 30);
    await expect(page.locator("#meaning")).not.toBeVisible();
    await expect(page.locator("#openChartReference")).toBeFocused();
});

test("the native guide uses the sidebar glide, reverses continuously and tears down immediately", { timeout: 30000 }, async t => {
    const { page } = await setup(t, pathRecords(), { reducedMotion: "no-preference", observeGuide: true });
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator("#openChartReference").click();
        const entering = await page.locator("#meaning").evaluate(node => {
            const animation = node.getAnimations()[0];
            animation.pause(); animation.currentTime = 80;
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, timing: animation.effect.getTiming(), shared: window.nativeSidebarTiming };
        });
        assert.equal(entering.timing.duration, entering.shared.duration);
        assert.equal(entering.timing.easing, "cubic-bezier(0.2, 0, 0, 1)");
        await captureNative(page, `glide-${width}-opening`);
        await page.locator("#meaning").evaluate(node => node.getAnimations()[0].finish());
        await page.waitForFunction(() => document.getElementById("meaning").getAnimations().length === 0);
        const settled = await page.locator("#meaning").boundingBox();
        assert.ok(entering.x > settled.x);
        for (const key of ["y", "width", "height"]) assert.equal(entering[key], settled[key]);
        await page.locator("#closeChartReference").click();
        const reversal = await page.evaluate(() => {
            const root = document.getElementById("meaning"), exiting = root.getAnimations()[0];
            exiting.pause(); exiting.currentTime = 90;
            const before = root.getBoundingClientRect().x;
            window.nativeGuide.refresh();
            const staysClosing = root.hasAttribute("data-closing") && root.getAnimations()[0] === exiting;
            window.nativeGuide.open();
            const entering = root.getAnimations()[0];
            entering.pause(); entering.currentTime = 0;
            return { before, after: root.getBoundingClientRect().x, staysClosing };
        });
        assert.equal(reversal.staysClosing, true, "A background refresh must not reopen a guide the user is dismissing");
        assert.ok(Math.abs(reversal.before - reversal.after) < 1);
        await captureNative(page, `glide-${width}-reversal`);
        await page.evaluate(() => window.nativeGuide.leave());
        await expect(page.locator("#meaning")).not.toBeVisible();
        assert.equal(await page.locator("#meaning").evaluate(node => node.getAnimations().length), 0);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#openChartReference").click();
    assert.equal(await page.locator("#meaning").evaluate(node => node.getAnimations()[0]?.effect.getTiming().duration), 320);
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#meaning")).not.toBeVisible();
    await expect(page.locator("#openChartReference")).toBeFocused();
});

function pathRecords() {
    const record = fixture("guide-long-table"), base = record.toolCalls[0];
    const paths = [
        "/me/messages", "/me/mailFolders", "/me/calendars", "/me/events", "/me/calendarView",
        "/me/contacts", "/me/contactFolders", "/me/people", "/me/drive", "/me/drive/root/children",
        "/me/drive/sharedWithMe", "/me/drive/recent", "/me/todo/lists", "/me/onenote/notebooks",
        "/me/onenote/sections", "/me/onenote/pages", "/me/joinedTeams", "/me/chats", "/users", "/groups",
        "/directoryRoles", "/organization", "/sites", "/drives", "/teams", "/chats", "/planner/plans",
        "/planner/buckets", "/planner/tasks", "/communications/callRecords", "/auditLogs/signIns",
        "/sites/site/lists/list/items/item/driveItem/children/item/permissions/permission/inheritedFrom",
    ];
    record.toolCalls = paths.map((path, index) => ({
        ...base, toolCallId: `guide-path-${index}`, startEventId: `guide-path-start-${index}`,
        requestArgs: { entityUrls: [path] }, requestedApiPath: path,
        startedAt: `2026-09-${String(21 + index % 7).padStart(2, "0")}T12:00:00.000Z`,
    }));
    return [record];
}

test("native path tables find rows locally, retain all-row totals and restore exact links on Back", { timeout: 30000 }, async t => {
    const records = pathRecords(), analytics = buildActivityAnalytics(records, { layer: "tool" });
    const groups = createActivityProjection(createTimeContext(), createServiceCategories(),
        Object.keys(createRecordedResults().labels("tool"))).groupRows(analytics.rows, "endpoint");
    assert.ok(groups.length > 24, "Exercise multiple real canonical pages");
    const { page, requests } = await setup(t, records);
    await exact(page, "paths");
    const table = page.locator("#countTable");
    await expect(table.locator("tbody tr")).toHaveCount(24);
    await expect(table.locator("tfoot td").first()).toHaveText(String(analytics.totals.count));
    await table.getByRole("button", { name: "Next chart rows", exact: true }).click();
    const lastPageLink = table.locator("tbody a").last(), lastHref = await lastPageLink.getAttribute("href");
    await lastPageLink.click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.goBack();
    await expect(page.locator("#meaning")).toBeVisible();
    await expect(table.locator(`a[href="${lastHref}"]`)).toBeFocused();
    const reads = requests.filter(path => path === "/api/snapshot").length;
    const privateState = () => page.evaluate(() => JSON.stringify({
        hash: location.hash, history: history.state, local: { ...localStorage }, session: { ...sessionStorage },
    }));
    const before = await privateState();
    await page.evaluate(() => {
        window.oldReferenceLink = document.querySelector("#countTable tbody a");
        window.oldReferencePager = document.querySelector('#countTable [data-page-direction="-1"]');
    });
    await page.getByRole("searchbox", { name: "Find in this table", exact: true }).fill("calendar");
    const found = groups.filter(group => group.label.toLowerCase().includes("calendar"));
    await expect(table.locator("tbody tr")).toHaveCount(found.length);
    await expect(table.locator("tfoot td").first()).toHaveText(String(analytics.totals.count));
    await expect(table).toContainText(`${found.length} of ${groups.length} rows found`);
    assert.equal(requests.filter(path => path === "/api/snapshot").length, reads);
    assert.equal(await privateState(), before, "Row finding is not a route, saved filter or private server query");
    assert.deepEqual(await page.evaluate(() => {
        const click = window.oldReferenceLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const middle = window.oldReferenceLink.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
        window.oldReferencePager.click();
        return { click, middle };
    }), { click: false, middle: false });
    await expect(table.locator("tbody tr")).toHaveCount(found.length);
    const target = table.locator("tbody a").first(), href = await target.getAttribute("href");
    await target.click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.goBack();
    await expect(page.getByRole("searchbox", { name: "Find in this table", exact: true })).toHaveValue("calendar");
    await expect(table.locator(`a[href="${href}"]`)).toBeFocused();
    await page.getByRole("searchbox", { name: "Find in this table", exact: true }).fill("INVENTED_NO_ROW");
    await expect(table.locator("tbody tr")).toHaveCount(0);
    await expect(table.locator("tfoot td").first()).toHaveText(String(analytics.totals.count));
    await expect(table).toContainText(`0 of ${groups.length} rows found`);
});

for (const topic of ["time", "categories"]) test(`native ${topic} exact rows keep canonical membership and date boundaries`, { timeout: 30000 }, async t => {
    const records = pathRecords(), { page, snapshot: initial, requests } = await setup(t, records, {
        hash: topic === "time" ? "#analyze?range=custom&from=2026-09-22&to=2026-09-25&bucket=week" : "",
    });
    await exact(page, topic);
    await expect(page.locator("#countTable tfoot td").first()).toHaveText(topic === "time" ? "19" : "32");
    const target = page.locator("#countTable tbody a").first(), href = await target.getAttribute("href");
    const parameters = new URLSearchParams(href.split("?")[1]);
    const reads = requests.filter(path => path === "/api/snapshot").length;
    const response = topic === "time" ? null : page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await target.click();
    await expect(page.locator("#activityListSummary")).toBeFocused();
    const snapshot = response ? await (await response).json() : initial;
    const expected = buildActivityAnalytics(records, { layer: "tool", groupBy: "workload",
        timeContext: { timeZone: "America/New_York", locale: "en-US" },
        filters: topic === "time" ? { from: parameters.get("from"), to: parameters.get("to") } : { workloads: [parameters.get("service")] },
    });
    assert.deepEqual(new Set(snapshot.analytics.rows.map(row => row.id)), new Set(expected.rows.map(row => row.id)));
    assert.ok(snapshot.analytics.rows.length > 0 && snapshot.analytics.rows.length < 32);
    if (topic === "time") {
        assert.equal(parameters.get("from"), "2026-09-22");
        assert.equal(parameters.get("to"), "2026-09-25", "A Monday-labeled week cannot expand the accepted dates");
        assert.equal(requests.filter(path => path === "/api/snapshot").length, reads, "An unchanged scope only reveals its existing records");
        await page.locator("#openChartReference").click();
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#countTable tfoot td").first()).toHaveText("19");
    } else {
        await page.goBack();
        await expect(page.locator("#countTable").locator(`a[href="${href}"]`)).toBeFocused();
    }
});

async function compare(page, { emptyB = false } = {}) {
    if (!await page.locator("#comparePeriods").isVisible()) await page.locator("#navigationToggle").click();
    await page.locator("#comparePeriods").click();
    for (const [id, value] of [
        ["comparisonAFrom", "2026-03-07"], ["comparisonATo", "2026-03-07"],
        ["comparisonBFrom", emptyB ? "2026-03-11" : "2026-03-08"], ["comparisonBTo", emptyB ? "2026-03-11" : "2026-03-09"],
    ]) await page.locator("#" + id).fill(value);
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await page.locator("#comparisonRecordsB").click();
}

for (const reducedMotion of ["reduce", "no-preference"]) test(`native paired guide restores the selected B exact target (${reducedMotion})`, { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, periodFixture().records, { reducedMotion });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await compare(page);
    const target = page.locator('[data-period-side="later"] tbody tr').last().locator("a");
    const position = () => page.evaluate(() => ({
        y: scrollY, focus: document.activeElement.id, inner: document.getElementById("comparison-record-scroll-B")?.scrollTop ?? null,
    }));
    for (const action of ["close", "back"]) {
        await target.scrollIntoViewIfNeeded(); await target.focus();
        const before = await position();
        assert.ok(before.inner > 0, "Return to a real late B record, not the initial roster viewport");
        await target.click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        if (action === "close") await page.locator("#closeContextSidebar").click(); else await page.goBack();
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
        await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
        await expect.poll(position).toEqual(before);
        const reads = requests.filter(path => path === "/api/period-comparison").length;
        await page.locator("#openChartReference").click();
        await expect(page.locator("#chartReferenceData table")).toHaveCount(0);
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#meaning")).not.toBeVisible();
        await expect.poll(position).toEqual(before);
        await expect(page.locator("#comparisonRecordsB")).toHaveAttribute("aria-selected", "true");
        assert.equal(requests.filter(path => path === "/api/period-comparison").length, reads);
    }
});

test("native paired guide delegates empty B and rejects a changed pair without ordinary fallback", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, periodFixture().records);
    await compare(page, { emptyB: true });
    const reads = requests.filter(path => path === "/api/period-comparison").length;
    await page.locator("#openChartReference").click();
    await captureNative(page, "comparison-guide");
    await page.locator("#chartReferenceShowData").click();
    await expect(page.locator("#comparisonRecordsB")).toBeFocused();
    await expect(page.locator("#comparisonRecordsB")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-period-side="later"]')).toContainText("0 calls across 0 interactions");
    await expect(page.locator('[data-period-side="later"]')).toContainText("No matching activity was found in this period.");
    await page.locator("#openChartReference").click();
    const retiredAction = await page.locator("#chartReferenceShowData").elementHandle();
    await page.locator("#comparisonATo").evaluate(node => {
        node.value = "2026-03-08"; node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await page.locator("#chartReferenceShowData").evaluate(node => node.disabled), true,
        "The pair's null publication withdraws the open guide action immediately");
    await retiredAction.evaluate(node => node.click());
    await retiredAction.dispose();
    await expect(page.locator("#meaning")).toBeVisible();
    await expect(page.locator("#chartReferenceNotice")).toContainText("Comparison records are not available");
    await expect(page.locator("#chartReferenceGuide .chart-reference-qualification")).toHaveCount(0);
    await expect(page.locator("#chartReferenceData table")).toHaveCount(0);
    assert.equal(requests.filter(path => path === "/api/period-comparison").length, reads);
});

test("an accepted empty native view has qualified zero counts rather than stale prior values", { timeout: 30000 }, async t => {
    const { page } = await setup(t, pathRecords(), { hash: "#analyze?range=custom&from=2027-01-01&to=2027-01-02" });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#openChartReference").click();
        await expect(page.locator(".chart-reference-group-heading")).toContainText("0 Work IQ tool calls");
        await captureNative(page, `${theme}-empty-guide`);
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("0");
        await expect(page.locator("#chartReferenceData")).toContainText("Not applicable");
        await expect(page.locator("#chartReferenceData a")).toHaveCount(0);
        await captureNative(page, `${theme}-empty-exact`);
        await page.locator("#closeChartReference").click();
    }
    for (const layer of ["direct-request", "recorded-http"]) {
        await page.goto(new URL(page.url()).origin + "#analyze?layer=" + layer);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#layerFilter")).toHaveValue(layer);
        await expect(page.locator("#activityCount")).toHaveText("0");
        await expect(page.locator("#chart")).toContainText(layer === "direct-request" ? "No Graph request sites were recorded" : "No HTTP statuses were recorded");
        await page.locator("#openChartReference").click();
        if (layer === "recorded-http") await expect(page.locator("#chartReferenceExplanation")).toContainText("subset of recorded Graph request sites, not extra requests");
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("0");
        await page.locator("#chartReferenceSource>summary").press("Enter");
        await expect(page.locator("#layerFilter")).toHaveValue(layer);
        await page.locator("#closeChartReference").click();
    }
});

for (const change of ["reading", "pair"]) test(`the native guide return yields to newer ${change} before its frame commits`, { timeout: 30000 }, async t => {
    const { page } = await setup(t, periodFixture().records);
    await compare(page);
    await page.locator("#openChartReference").click();
    await page.evaluate(() => {
        window.originalGuideFrame = window.requestAnimationFrame;
        window.originalGuideCancel = window.cancelAnimationFrame;
        window.heldGuideFrames = new Map();
        let id = 1000000000;
        window.requestAnimationFrame = callback => { window.heldGuideFrames.set(++id, callback); return id; };
        window.cancelAnimationFrame = id => {
            if (!window.heldGuideFrames.delete(id)) window.originalGuideCancel(id);
        };
    });
    try {
        await page.locator("#chartReferenceShowData").click();
        assert.ok(await page.evaluate(() => window.heldGuideFrames.size > 0));
        if (change === "reading") {
            await page.locator('.primary-navigation [data-nav="analyze"]').focus();
            await page.evaluate(() => addEventListener("wheel", event => { window.guideWheelObserved = event.isTrusted; }, { once: true }));
            await page.mouse.wheel(0, 80);
            await page.waitForFunction(() => window.guideWheelObserved, { }, { polling: 10 });
        } else await page.locator("#comparisonATo").evaluate(node => {
            node.value = "2026-03-08"; node.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.evaluate(() => new Promise(resolve => window.originalGuideFrame(() => window.originalGuideFrame(resolve))));
        const before = await page.evaluate(() => ({ y: scrollY, focus: document.activeElement.id }));
        await page.evaluate(() => {
            window.requestAnimationFrame = window.originalGuideFrame;
            window.cancelAnimationFrame = window.originalGuideCancel;
            for (const callback of window.heldGuideFrames.values()) requestAnimationFrame(callback);
            window.heldGuideFrames.clear();
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (change === "reading") assert.deepEqual(await page.evaluate(() => ({ y: scrollY, focus: document.activeElement.id })), before);
        else await expect(page.locator("#message")).toContainText("The comparison records are no longer current");
        await expect(page.locator("#meaning")).not.toBeVisible();
    } finally {
        await page.evaluate(() => {
            window.requestAnimationFrame = window.originalGuideFrame;
            window.cancelAnimationFrame = window.originalGuideCancel;
        });
    }
});

test("the native guide keeps all six accepted evidence layers and their execution limits", { timeout: 30000 }, async t => {
    const events = [
        { id: "guide-prompt", type: "user.message", timestamp: "2026-09-30T12:00:00Z", data: { content: "Invented chart guide example" } },
        { id: "guide-start", type: "tool.execution_start", timestamp: "2026-09-30T12:00:01Z", data: {
            toolName: "powershell", toolCallId: "guide-graph", arguments: { command: "curl https://graph.microsoft.com/v1.0/me/messages" },
        } },
    ];
    const references = structuredClone(events);
    references[1].data.arguments.command = "git diff # https://graph.microsoft.com/v1.0/me/messages";
    const records = [fixture("guide-layer"), ...extractGraphActivities(events, { sessionId: "guide-request" }).scenarios,
        ...extractGraphActivities(references, { sessionId: "guide-code" }).scenarios];
    const { page } = await setup(t, records), results = createRecordedResults();
    for (const layer of results.layers) {
        if (layer !== "tool") {
            const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
            await page.evaluate(layer => { location.hash = "#analyze?layer=" + layer; }, layer);
            await read;
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        }
        const count = buildActivityAnalytics(records, { layer }).totals.count;
        await page.locator("#openChartReference").click();
        await expect(page.locator(".chart-reference-group-heading")).toContainText(`${count} ${results.unit(layer, count)}`);
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText(String(count));
        if (layer === "code-reference") {
            await expect(page.locator("#chartReferenceData tbody tr")).toHaveCount(1);
            await expect(page.locator("#chartReferenceData")).toContainText("Execution not observed");
            await expect(page.locator("#chartReferenceData")).not.toContainText("HTTP 2xx");
        }
        await page.locator("#closeChartReference").click();
    }
});

async function inspectGuide(page, name) {
    const layout = await page.evaluate(() => {
        const root = document.getElementById("meaning"), rect = root.getBoundingClientRect();
        return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1,
            dialogOverflow: root.scrollWidth > root.clientWidth + 1,
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            height: innerHeight, font: getComputedStyle(root).fontFamily, loaded: document.fonts.check('16px "Asta Sans"') };
    });
    assert.equal(layout.overflow, false, JSON.stringify({ name, ...layout }));
    assert.equal(layout.dialogOverflow, false, JSON.stringify({ name, ...layout }));
    assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height, name);
    assert.ok(layout.loaded && layout.font.includes("Asta Sans"), "Use the actually loaded WIRE font");
    if (proof) {
        await mkdir(proof, { recursive: true });
        await captureNative(page, name);
        await writeFile(path.join(proof, name + ".json"), JSON.stringify(layout));
    }
    const controls = page.locator("#meaning button:visible,#meaning a:visible,#meaning input:visible,#meaning summary:visible");
    for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index);
        if (await control.isDisabled()) continue;
        await control.focus();
        const visible = await control.evaluate(node => {
            const r = node.getBoundingClientRect(), root = document.getElementById("meaning").getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { id: node.id, text: node.textContent, width: r.width, height: r.height,
                full: r.top >= root.top + 3 && r.bottom <= root.bottom - 3 && r.left >= root.left + 3 && r.right <= root.right - 3,
                hit: hit === node || node.contains(hit) };
        });
        assert.ok(visible.full && visible.hit, JSON.stringify({ name, ...visible }));
        assert.ok(visible.height >= 44, JSON.stringify({ name, ...visible }));
    }
}

test("the whole native guide reflows in both themes, long tables, phone, tablet and 200% text", { timeout: 60000 }, async t => {
    const { page } = await setup(t, pathRecords());
    for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        await chooseTheme(page, theme);
        for (const [name, width, height, size] of [
            ["wide", 1440, 1000, ""], ["tablet", 768, 1000, ""], ["phone", 390, 844, ""],
            ["text200", 390, 844, "200%"], ["landscape", 844, 390, ""],
        ]) {
            await page.setViewportSize({ width, height });
            await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
            await page.locator("#openChartReference").click();
            await topicChoice(page, "outcomes");
            await page.locator("#meaning").evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
            const frame = await page.locator("#meaning").boundingBox();
            await page.locator("#chartReferenceTitle").focus();
            await inspectGuide(page, `${theme}-${name}-guide`);
            await page.locator("#chartReferenceAllTopics").click();
            await assertGuideFrame(page, frame);
            await inspectGuide(page, `${theme}-${name}-index`);
            await topicChoice(page, "paths");
            await assertGuideFrame(page, frame);
            await page.locator("#chartReferenceShowData").click();
            await page.locator("#chartReferenceDataTitle").focus();
            await inspectGuide(page, `${theme}-${name}-paths`);
            await assertGuideFrame(page, frame);
            await page.locator("#closeChartReference").click();
            await expect(page.locator("#openChartReference")).toBeFocused();
        }
    }
});

test("narrow enlarged exact path tables expose every column through native keyboard scrolling", { timeout: 30000 }, async t => {
    const { page } = await setup(t, pathRecords());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await exact(page, "paths");
    const table = page.locator("#countTable");
    const before = await page.evaluate(() => ({
        url: location.href, count: document.getElementById("activityCount").textContent,
        text: document.getElementById("countTable").textContent, revision: document.getElementById("meaning").dataset.revision,
    }));
    await page.locator("#chartReferenceFindInput").click();
    await page.keyboard.press("Tab");
    await expect(table).toBeFocused();
    await table.evaluate(node => {
        window.exactTableScrollEnds = 0;
        node.addEventListener("scrollend", () => { window.exactTableScrollEnds++; });
    });
    const seen = new Set();
    const inspect = () => table.evaluate(node => {
        const clip = node.getBoundingClientRect(), modal = document.getElementById("meaning").getBoundingClientRect();
        const textBox = cell => {
            const range = document.createRange(); range.selectNodeContents(cell);
            return range.getBoundingClientRect();
        };
        const headers = [...node.querySelectorAll("thead th")], values = [...node.querySelector("tbody tr").cells];
        return { left: node.scrollLeft, maximum: node.scrollWidth - node.clientWidth, ends: window.exactTableScrollEnds,
            columns: headers.map((header, index) => ({ index, label: header.textContent,
                visible: [header, values[index]].every(cell => {
                    const box = textBox(cell);
                    return box.left >= clip.left && box.right <= clip.right && box.top >= modal.top && box.bottom <= modal.bottom;
                }) })) };
    });
    for (let step = 0; step < 60; step++) {
        const current = await inspect();
        assert.ok(current.maximum > 0, "This fixture must require local horizontal scrolling");
        for (const column of current.columns) if (column.visible) seen.add(column.index);
        if (current.left >= current.maximum - 1) break;
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(ends => window.exactTableScrollEnds > ends, current.ends);
        await expect(table).toBeFocused();
    }
    const last = await inspect();
    assert.deepEqual(last.columns.filter(column => !seen.has(column.index)), [], "Every header and first-row value must be readable");
    assert.deepEqual(await page.evaluate(() => ({
        url: location.href, count: document.getElementById("activityCount").textContent,
        text: document.getElementById("countTable").textContent, revision: document.getElementById("meaning").dataset.revision,
    })), before);
});

test("the whole native guide works at actual 200% browser zoom", {
    timeout: 60000, skip: !process.env.WIRE_CHART_NATIVE_ZOOM,
}, async t => {
    const { page } = await setup(t, pathRecords(), { nativeZoom: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#openChartReference").click();
        await topicChoice(page, "outcomes");
        await page.locator("#chartReferenceTitle").focus();
        await inspectGuide(page, `${theme}-zoom200-guide`);
        await topicChoice(page, "paths");
        await page.locator("#chartReferenceShowData").click();
        await page.locator("#chartReferenceDataTitle").focus();
        await inspectGuide(page, `${theme}-zoom200-paths`);
        await page.locator("#closeChartReference").click();
    }
});

async function guideControlPaint(page, locator) {
    await locator.scrollIntoViewIfNeeded();
    const state = await locator.evaluate(node => {
        const css = getComputedStyle(node), paint = getComputedStyle(node, "::before"), box = node.getBoundingClientRect();
        const dialog = document.getElementById("meaning").getBoundingClientRect();
        const ring = css.outlineStyle === "none" ? 0 : parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset);
        return { x: box.x, y: box.y, width: box.width, height: box.height,
            surface: getComputedStyle(document.getElementById("meaning")).backgroundColor, color: css.color,
            outline: { color: css.outlineColor, width: parseFloat(css.outlineWidth), style: css.outlineStyle },
            paint: { display: paint.display, border: paint.borderLeftColor, width: parseFloat(paint.borderLeftWidth) },
            focused: node.matches(":focus-visible"), hover: node.matches(":hover"), pressed: node.getAttribute("aria-pressed"),
            ringVisible: box.left - ring > dialog.left && box.right + ring < dialog.right
                && box.top - ring > dialog.top && box.bottom + ring < dialog.bottom };
    });
    const image = await page.screenshot();
    const fill = await page.evaluate(async ({ image, x, y }) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(image), value => value.charCodeAt(0))]));
        const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0); bitmap.close();
        const scale = canvas.width / innerWidth;
        const pixel = context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data;
        if (pixel[3] !== 255) throw new Error("The control paint sample must be inside the captured viewport.");
        return `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
    }, { image: image.toString("base64"), x: state.x + state.width - 8, y: state.y + state.height / 2 });
    return { ...state, fill };
}

for (const theme of ["light", "dark"]) test(`native guide topic and exact-action feedback separates hover, current and keyboard focus (${theme})`, { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, pathRecords()), measurements = {};
    await chooseTheme(page, theme);
    await page.locator("#openChartReference").click();
    await topicChoice(page, "time");
    await page.locator("#chartReferenceAllTopics").click();
    await page.mouse.move(0, 0);
    const current = page.locator('button[data-reference-topic="time"]'), other = page.locator('button[data-reference-topic="services"]');
    const exact = page.locator("#chartReferenceShowData");
    const capture = async (name, target) => {
        measurements[name] = await guideControlPaint(page, target);
        await captureNative(page, `${theme}-feedback-${name}`);
        if (proof) await writeFile(path.join(proof, `${theme}-feedback.json`), JSON.stringify(measurements, null, 2));
        return measurements[name];
    };
    const reads = requests.filter(path => path === "/api/snapshot").length;
    const idle = await capture("idle", other), selected = await capture("current", current);
    await other.hover();
    const hover = await capture("hover", other);
    assert.ok(hover.hover && contrast(idle.fill, hover.fill) >= 1.1, "Actual topic hover paint must be perceptible, not a hidden pseudo-element");
    assert.ok(selected.paint.display !== "none" && selected.paint.width >= 1 && contrast(selected.paint.border, selected.surface) >= 3,
        "The current topic needs a persistent visible indicator distinct from hover");
    await expect(current).toHaveAttribute("aria-pressed", "true");
    await expect(other).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#chartReferenceTopicTitle")).toHaveText("Activity over time");
    await current.hover();
    const selectedHover = await capture("current-hover", current);
    assert.ok(contrast(selectedHover.paint.border, selectedHover.fill) >= 3, "Hover must not erase the current-topic indicator");

    await current.focus();
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await expect(other).toBeFocused();
    const keyboard = await capture("keyboard", other);
    assert.ok(keyboard.focused && keyboard.outline.style === "solid" && keyboard.outline.width >= 2
        && keyboard.ringVisible && contrast(keyboard.outline.color, keyboard.surface) >= 3, "Keyboard focus must remain distinct and unobscured");
    await page.keyboard.press("Enter");
    await expect(other).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#chartReferenceTopics [aria-pressed=true]")).toHaveCount(1);
    await expect(page.locator("#chartReferenceTopicTitle")).toHaveText("Services and operations");
    await page.mouse.move(0, 0);
    const actionIdle = await capture("action-idle", exact);
    await exact.hover();
    const actionHover = await capture("action-hover", exact);
    assert.ok(actionHover.hover && contrast(actionIdle.fill, actionHover.fill) >= 1.1, "Exact-data action needs visible pointer feedback");
    await page.mouse.move(0, 0);
    for (let step = 0; step < 8 && !await exact.evaluate(node => node === document.activeElement); step++) await page.keyboard.press("Tab");
    await expect(exact).toBeFocused();
    const actionFocus = await capture("action-keyboard", exact);
    assert.ok(actionFocus.focused && actionFocus.outline.width >= 2 && actionFocus.ringVisible
        && contrast(actionFocus.outline.color, actionFocus.surface) >= 3);
    for (const state of Object.values(measurements)) {
        assert.ok(state.width >= 44 && state.height >= 44);
        assert.ok(contrast(state.color, state.fill) >= 4.5, "Control text must remain readable in every state");
    }
    await page.keyboard.press("Enter");
    await expect(page.locator("#chartReferenceData table")).toBeVisible();
    await page.locator("#chartReferenceBack").click();
    await expect(exact).toBeFocused();
    await expect(other).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("#openChartReference")).toBeFocused();
    assert.equal(requests.filter(path => path === "/api/snapshot").length, reads);
});

test("native guide current topic keeps a separate keyboard ring in forced colors", { timeout: 30000 }, async t => {
    const { page } = await setup(t, pathRecords());
    await page.emulateMedia({ forcedColors: "active" });
    await page.locator("#openChartReference").click();
    await topicChoice(page, "time");
    await page.locator("#chartReferenceAllTopics").click();
    const current = page.locator('button[data-reference-topic="time"]');
    const selected = await guideControlPaint(page, current);
    await captureNative(page, "forced-colors-current");
    assert.ok(selected.outline.style === "solid" && selected.outline.width >= 1
        && contrast(selected.outline.color, selected.surface) >= 3, "Forced colors retain the current-topic mark without keyboard focus");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(current).toBeFocused();
    const paint = await guideControlPaint(page, current);
    await captureNative(page, "forced-colors-current-keyboard");
    assert.ok(paint.focused && paint.ringVisible && paint.outline.width >= 2,
        "Current-topic marking must not replace the keyboard ring");
    assert.ok(paint.paint.display !== "none" && contrast(paint.paint.border, paint.fill) >= 3);
});

for (const theme of ["light", "dark"]) test(`native guide groups count and share without losing meaning or wrapping (${theme})`, { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, pathRecords());
    await chooseTheme(page, theme);
    await page.locator("#openChartReference").click();
    const values = page.locator(".chart-reference-definition>.chart-reference-value");
    await expect(values.first()).toHaveText("32 (100%)");
    await expect(values.nth(1)).toHaveText("0 (0%)");
    const measure = value => value.evaluate(node => {
        const share = node.querySelector(".chart-reference-share"), text = document.createRange();
        text.selectNodeContents(node.firstChild);
        const first = text.getBoundingClientRect(), second = share.getBoundingClientRect(), css = getComputedStyle(node);
        return { text: node.textContent, firstTop: first.top, shareTop: second.top, countWidth: first.width, shareWidth: second.width,
            width: node.clientWidth, overflow: node.scrollWidth > node.clientWidth + 1, whitespace: css.whiteSpace,
            countColor: css.color, shareColor: getComputedStyle(share).color, muted: css.getPropertyValue("--muted").trim(),
            countWeight: Number(css.fontWeight), shareWeight: Number(getComputedStyle(share).fontWeight) };
    });
    const first = await measure(values.first());
    assert.ok(Math.abs(first.firstTop - first.shareTop) <= 1, "Count and share start on the same line when they fit");
    assert.ok(first.shareWeight < first.countWeight && first.shareColor !== first.countColor);
    await captureNative(page, `${theme}-grouped-outcomes`);
    await topicChoice(page, "services");
    const services = page.locator(".chart-reference-service .chart-reference-value");
    await expect(services.first()).toHaveText("8 (25%)");
    await expect(page.locator("#chartReferenceExplanation")).toContainText("A record can involve several services, so counts can overlap.");
    await expect(page.locator("#chartReferenceExplanation")).toContainText("2 records have missing service details");
    await captureNative(page, `${theme}-grouped-services`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await topicChoice(page, "outcomes");
    await values.first().scrollIntoViewIfNeeded();
    const enlarged = await measure(values.first());
    assert.equal(enlarged.overflow, false);
    assert.equal(enlarged.whitespace, "normal");
    await captureNative(page, `${theme}-grouped-text200`);
    // Constrain only the existing value slot: each value fits, but the pair must wrap.
    await values.first().evaluate((node, width) => { node.style.inlineSize = `${width}px`; }, Math.max(enlarged.countWidth, enlarged.shareWidth) + 2);
    const wrapped = await measure(values.first());
    assert.ok(wrapped.shareTop > wrapped.firstTop && !wrapped.overflow, "The share wraps without making the pair unbreakable");
    assert.equal(wrapped.text, "32 (100%)");
    await captureNative(page, `${theme}-grouped-wrap-stress`);
    await values.first().evaluate(node => { node.style.removeProperty("inline-size"); });
    await page.locator("#chartReferenceShowData").click();
    await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("32");
    await page.locator("#chartReferenceBack").click();
    await expect(values.first()).toHaveText("32 (100%)");
    assert.equal(requests.filter(path => path === "/api/snapshot").length, 1);
    if (proof) await writeFile(path.join(proof, `${theme}-grouped-values.json`), JSON.stringify({ first, enlarged, wrapped }, null, 2));
});

for (const paired of [false, true]) for (const nativeZoom of [false, true]) test(`native guide qualification parts preserve complete accepted facts and clear null (${paired ? "paired" : "ordinary"}${nativeZoom ? ", native zoom" : ""})`, {
    timeout: 60000, skip: nativeZoom && !process.env.WIRE_CHART_NATIVE_ZOOM,
}, async t => {
    const project = "Invented guide project \u00b7 original punctuation; long cross-team investigation: evidence and delivery";
    const { records } = periodFixture();
    for (const record of records) { record.projectId = "guide-parts-project"; record.project = project; }
    const { page } = await setup(t, records, { observeQualification: true, nativeZoom });
    for (const [id, value] of [["serviceAssociationFilter", "Files"], ["outcomeFilter", ["failure"]], ["projectFilter", "guide-parts-project"]]) {
        await selectActivityOption(page, id, value);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    }
    await closeAnalyzeFilters(page);
    if (paired) await compare(page);
    const measurements = [];
    const sizes = nativeZoom ? [[await page.evaluate(() => innerWidth), "native200"]] : [[1440, 1], [768, 1], [390, 2]];
    for (const theme of ["light", "dark"]) for (const [width, scale] of sizes) {
        if (!nativeZoom) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        }
        await chooseTheme(page, theme);
        await page.locator("#openChartReference").press("Enter");
        const context = await page.evaluate(() => window.observedGuideQualification);
        assert.equal(context.available, true);
        assert.ok(context.qualificationParts.includes(`Copilot project: ${project}`));
        const caption = page.locator("#chartReferenceGuide .chart-reference-qualification").first();
        await expect(caption.locator(".analyze-scope-part")).toHaveCount(context.qualificationParts.length);
        assert.deepEqual(await caption.locator(".analyze-scope-part").evaluateAll(parts => parts.map(part => part.firstChild.textContent)),
            context.qualificationParts);
        assert.equal(await caption.textContent(), context.qualification);
        assert.match(await caption.ariaSnapshot(), /Copilot project: Invented guide project/);
        const geometry = await caption.evaluate(node => {
            const bounds = node.getBoundingClientRect();
            return { overflow: document.documentElement.scrollWidth - innerWidth, clipped: node.scrollWidth - node.clientWidth,
                bounds: { left: bounds.left, right: bounds.right },
                lines: [...node.querySelectorAll(".analyze-scope-part")].flatMap(part => {
                    const text = document.createRange(); text.selectNodeContents(part.firstChild);
                    return [...text.getClientRects()].map(line => ({ left: line.left, right: line.right }));
                }) };
        });
        assert.ok(geometry.overflow <= 1 && geometry.clipped <= 1);
        assert.ok(geometry.lines.every(line => line.left >= geometry.bounds.left - 1 && line.right <= geometry.bounds.right + 1));
        await captureNative(page, `${paired ? "paired" : "ordinary"}-qualification-${theme}-${width}-${scale}-top`);
        await caption.click({ position: { x: 6, y: 6 } });
        await caption.scrollIntoViewIfNeeded();
        await captureNative(page, `${paired ? "paired" : "ordinary"}-qualification-${theme}-${width}-${scale}`);
        const lastFact = caption.locator(".analyze-scope-part").last();
        await lastFact.scrollIntoViewIfNeeded();
        const fullyReadable = await lastFact.evaluate(node => {
            const range = document.createRange(); range.selectNodeContents(node.firstChild);
            const bounds = document.getElementById("meaning").getBoundingClientRect();
            return [...range.getClientRects()].every(line => line.left >= bounds.left && line.right <= bounds.right
                && line.top >= bounds.top && line.bottom <= bounds.bottom);
        });
        assert.equal(fullyReadable, true, "The complete retained name remains readable through native dialog scrolling");
        await captureNative(page, `${paired ? "paired" : "ordinary"}-qualification-${theme}-${width}-${scale}-end`);
        measurements.push({ theme, width, scale, parts: context.qualificationParts, text: context.qualification, geometry });
        if (!paired) {
            await page.locator("#chartReferenceShowData").click();
            const exact = page.locator("#chartReferenceQualification .chart-reference-scope");
            assert.equal(await exact.textContent(), context.qualification);
            assert.deepEqual(await exact.locator(".analyze-scope-part").evaluateAll(parts => parts.map(part => part.firstChild.textContent)),
                context.qualificationParts);
            await page.locator("#chartReferenceBack").click();
            await expect(page.locator("#chartReferenceShowData")).toBeFocused();
        }
        await page.locator("#meaning").press("Escape");
    }
    if (!nativeZoom) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    }
    if (!paired) {
        await expect(page.locator("#comparePeriods:visible, #navigationToggle:visible").first()).toBeVisible();
        if (!await page.locator("#comparePeriods").isVisible()) await page.locator("#navigationToggle").click();
        await page.locator("#comparePeriods").click();
    }
    await page.locator("#openChartReference").click();
    if (paired) await page.locator("#comparisonATo").evaluate(node => {
        node.value = "2026-03-08"; node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(page.locator("#chartReferenceGuide .chart-reference-qualification")).toHaveCount(0);
    await expect(page.locator("#chartReferenceQualification")).toHaveText("");
    const unavailable = await page.evaluate(() => window.observedGuideQualification);
    assert.equal(unavailable.available, false);
    assert.deepEqual(unavailable.qualificationParts, []);
    assert.equal(unavailable.qualification, "");
    await expect(page.locator("#chartReferenceShowData")).toBeDisabled();
    if (proof) await writeFile(path.join(proof, `${paired ? "paired" : "ordinary"}-qualification${nativeZoom ? "-zoom200" : ""}.json`), JSON.stringify(measurements, null, 2));
});
