import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { frontendRecords } from "./frontend-fixture.mjs";
import { chooseTheme, navigateMain, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";

const proofs = process.env.WIRE_FRONTEND_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function setup(t, frontend = "react") {
    const cleanup = [], errors = [], requests = [];
    const app = await searchFixture({ after: work => cleanup.push(work) }, { records: frontendRecords(), reply: false, frontend });
    const before = await loadBoardState(app.context);
    const browser = await chromium.launch(process.env.WIRE_FRONTEND_BROWSER ? { channel: process.env.WIRE_FRONTEND_BROWSER } : {});
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "no-preference" });
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => {
        window.frontendMeasurements = { acceptedViewMs: null, inputToFrameMs: null, queryToResultsMs: null, longTasks: [] };
        let queryAt = null;
        const observer = new MutationObserver(() => {
            const measured = window.frontendMeasurements;
            if (measured.acceptedViewMs === null && document.getElementById("workspace")?.getAttribute("aria-busy") === "false"
                && document.querySelector("#activityList .request-card-open")) measured.acceptedViewMs = performance.now();
            if (queryAt !== null && measured.queryToResultsMs === null && document.querySelector(".wire-search-hit")) {
                measured.queryToResultsMs = performance.now() - queryAt;
            }
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true });
        document.addEventListener("input", event => {
            if (event.target.id !== "wireSearch") return;
            const started = performance.now();
            queryAt = started;
            window.frontendMeasurements.queryToResultsMs = null;
            requestAnimationFrame(() => {
                if (queryAt === started) window.frontendMeasurements.inputToFrameMs = performance.now() - started;
            });
        }, { capture: true });
        if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
            new PerformanceObserver(list => window.frontendMeasurements.longTasks.push(
                ...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })),
            )).observe({ type: "longtask", buffered: true });
        }
    });
    page.on("pageerror", error => errors.push(error.message));
    const allowed = new Set(["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/overview",
        "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/search/events", "/api/search/query",
        "/api/search/open", "/api/search/cancel", "/api/search/close", "/api/period-comparison", "/api/trends",
        "/api/report-artifacts/list"]);
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !allowed.has(url.pathname)) {
            errors.push(`Unexpected request: ${url.pathname}`);
            return route.abort();
        }
        requests.push(url.pathname);
        return route.continue();
    });
    t.after(async () => {
        await browser.close();
        try {
            assert.deepEqual(await loadBoardState(app.context), before);
            assert.deepEqual(errors, []);
        } finally { for (const work of cleanup.reverse()) await work(); }
    });
    const response = await page.goto(app.runtime.url + "#analyze?range=custom&from=2026-11-10&to=2026-11-16");
    const htmlBytes = Buffer.byteLength(await response.text());
    await ready(page);
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(8);
    await page.evaluate(() => document.fonts.ready);
    await chooseTheme(page, "light");
    return { ...app, page, requests, htmlBytes, browserVersion: browser.version() };
}
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running"));
    await page.screenshot({ path: path.join(proofs, `${name}.png`) });
}

test("the selected evaluation layout retains complete membership, native reading, paging and peer routes", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t);
    await expect(page.locator("#activityListSummary")).toContainText("240 interactions");
    const heading = await page.locator("#pageTitle").boundingBox();
    assert.ok(heading.width > 60 && heading.height > 25, "Analyze keeps its visible page heading.");
    const order = await page.evaluate(() => {
        const box = id => document.getElementById(id).getBoundingClientRect();
        return { overview: box("homeView").top, rows: box("activityView").top, breakdowns: box("frontendBreakdowns").top };
    });
    assert.ok(order.overview < order.rows && order.rows < order.breakdowns);
    await expect(page.locator("#frontendHeadingActions #openAnalyzeFilters")).toBeVisible();
    await expect(page.locator("#analyzeScopeCaption")).not.toContainText("Nov 10");
    await expect(page.locator("#activityListScope")).toBeHidden();
    await expect(page.locator("#analyzeScopeStatus")).toContainText("Checked history is unknown");
    await capture(page, "react-analyze-light");
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#activityPager")).toContainText("9-16 of 240");
    const link = page.locator("#activityList .request-card-open").first();
    const origin = page.url(), name = await link.getAttribute("aria-label"), reads = requests.filter(url => url === "/api/snapshot").length;
    await link.evaluate(node => { window.retainedActivityLink = node; });
    await link.click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await capture(page, "react-reader-light");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page).toHaveURL(origin);
    await expect(page.locator("#activityPager")).toContainText("9-16 of 240");
    await expect(page.locator("#activityList .request-card-open").first()).toHaveAttribute("aria-label", name);
    if (requests.filter(url => url === "/api/snapshot").length === reads) {
        assert.equal(await page.evaluate(() => window.retainedActivityLink === document.querySelector("#activityList .request-card-open")), true);
    }
    for (const destination of ["trends", "reports", "settings", "compare"]) {
        await navigateMain(page, destination);
        await expect(page.locator("#frontendBreakdowns")).toBeHidden();
    }
    await navigateMain(page, "analyze");
    await ready(page);
    await expect(page.locator("#frontendBreakdowns")).toBeVisible();
    await chooseTheme(page, "dark");
    await page.locator("#activityList .request-card-open").first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await capture(page, "react-reader-dark");
    await page.locator("#closeContextSidebar").click();
    await page.setViewportSize({ width: 768, height: 1000 });
    await page.evaluate(() => scrollTo(0, 0));
    await capture(page, "react-analyze-narrow");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.evaluate(() => { window.originalBrand = document.getElementById("shellBrand"); window.originalSearch = document.getElementById("wireSearch"); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#navigationToggle").click();
    await expect(page.locator("#navigationDrawer")).toBeVisible();
    await page.locator("#closeNavigation").click();
    await capture(page, "react-analyze-mobile");
    assert.equal(await page.evaluate(() => document.getElementById("shellBrand") === window.originalBrand
        && document.getElementById("wireSearch") === window.originalSearch), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; scrollTo(0, 0); });
    await capture(page, "react-analyze-enlarged");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
});

test("closing the interaction reader retires its retained response host", async t => {
    const { page } = await setup(t);
    await page.locator("#activityList .request-card-open").first().click();
    const response = page.locator("#requestContent .reader-response-availability").first();
    await expect(response).toContainText("No assistant reply was saved");
    await response.evaluate(node => { window.retiredResponseHost = node; });
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => ({
        text: window.retiredResponseHost.textContent,
        identity: window.retiredResponseHost.getAttribute("data-context-group"),
        insight: window.retiredResponseHost.getAttribute("data-insight-key"),
    })), { text: "", identity: null, insight: null });
});

test("repeated complete journeys retain one shell and retire prior private presentations", { timeout: 120000 }, async t => {
    const { page } = await setup(t);
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => {
        window.shellNodes = ["wireReactShell", "shellBrand", "navigationContent", "wireAccountEntry", "wireSearch",
            "analyzeFilterPanel", "contextSidebarBody"].map(id => [id, document.getElementById(id)]);
    });
    async function cycle() {
        await selectActivityOption(page, "toolFilter", "workiq-fetch");
        await closeAnalyzeFilters(page); await ready(page);
        await expect(page.locator("#activityListSummary")).toContainText("160 interactions");
        await page.locator("#activityList .request-card-open").first().click();
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        await page.locator("#wireSearch").fill("Cedar");
        const hit = page.locator(".wire-search-hit[data-search-type=interaction]").first();
        await expect(hit).toBeVisible();
        await hit.focus(); await hit.press("Enter");
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.locator("#closeContextSidebar").click();
        await expect(hit).toBeFocused();
        await page.locator("#wireSearchClear").click();
        await selectActivityOption(page, "toolFilter", "all");
        await closeAnalyzeFilters(page); await ready(page);
        await expect(page.locator("#activityListSummary")).toContainText("240 interactions");
        await navigateMain(page, "trends");
        await navigateMain(page, "settings");
        await navigateMain(page, "analyze"); await ready(page);
    }
    async function measure() {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await cdp.send("HeapProfiler.collectGarbage");
        return { ...await cdp.send("Memory.getDOMCounters"), ...await cdp.send("Runtime.getHeapUsage"),
            ...await page.evaluate(() => {
                const types = {}, walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    types[node.nodeType] = (types[node.nodeType] || 0) + 1;
                }
                return { connectedTypes: types };
            }) };
    }
    await cycle();
    const measurements = [{ phase: "warm", ...await measure() }];
    for (const phase of ["first-repeat", "second-repeat"]) {
        for (let count = 0; count < 3; count++) await cycle();
        measurements.push({ phase, ...await measure() });
    }
    const detached = await cdp.send("DOM.getDetachedDomNodes");
    const retiredResponseHosts = detached.detachedNodes.filter(({ treeNode }) => {
        const index = treeNode.attributes?.indexOf("class") ?? -1;
        return index >= 0 && treeNode.attributes[index + 1].split(" ").includes("reader-response-availability");
    }).length;
    assert.equal(retiredResponseHosts, 0, "Closed response presenters must not remain retained by their adapter.");
    assert.equal(await page.evaluate(() => window.shellNodes.every(([id, node]) => document.getElementById(id) === node)), true);
    await expect(page.locator("#wireReactShell")).toHaveCount(1);
    await expect(page.locator("#wireSearch")).toHaveCount(1);
    await expect(page.locator("#contextSidebar")).toHaveCount(1);
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, "lifecycle-measurements.json"), JSON.stringify({ measurements, retiredResponseHosts }, null, 2));
    }
    t.diagnostic(JSON.stringify(measurements));
    assert.deepEqual(measurements.at(-1).connectedTypes, measurements.at(-2).connectedTypes);
    assert.equal(measurements.at(-1).jsEventListeners, measurements.at(-2).jsEventListeners);
    assert.equal(measurements.at(-1).documents, measurements.at(-2).documents);
    await cdp.detach();
});

test("accepted filters retire old row handlers and preserve the prior scope during a failed read", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#activityList .request-card-open").first().evaluate(node => {
        window.retiredActivityLink = node;
        window.retiredActivityName = node.getAttributeNode("aria-label");
    });

    await selectActivityOption(page, "toolFilter", "workiq-fetch");
    await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#activityListSummary")).toContainText("160 interactions");
    const location = page.url();
    assert.equal(await page.evaluate(() => window.retiredActivityName.value), "");
    await page.evaluate(() => window.retiredActivityLink.click());
    assert.equal(page.url(), location, "A removed row cannot reopen a retired selection.");
    const accepted = await page.locator("#activityListSummary").textContent();
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented stored read unavailable." } }), { times: 1 });
    await selectActivityOption(page, "toolFilter", "workiq-retrieve");
    await closeAnalyzeFilters(page);
    await expect(page.locator("#message")).toContainText("Invented stored read unavailable.");
    await expect(page.locator("#activityListSummary")).toHaveText(accepted);
});

test("a failed activity presenter remains explicit through later accepted reads", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await page.evaluate(() => {
        const append = Element.prototype.append;
        Element.prototype.append = function (...nodes) {
            if (this.classList.contains("frontend-record-slot")) {
                Element.prototype.append = append;
                throw new Error("Invented activity mounting failure.");
            }
            return append.apply(this, nodes);
        };
    });
    await selectActivityOption(page, "toolFilter", "workiq-fetch");
    await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#message")).toContainText("Reload this panel.");
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(0);
    await selectActivityOption(page, "toolFilter", "workiq-retrieve");
    await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#message")).toBeVisible();
    await expect(page.locator("#message")).toContainText("Recorded activity could not be displayed safely.");
    await expect(page.locator("#activityListSummary")).toHaveText("Recorded activity unavailable.");
});

test("a delayed filter read cannot reclaim a newer peer destination or its accepted origin", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    let release, observed, delivered;
    const gate = new Promise(resolve => { release = resolve; });
    const held = new Promise(resolve => { observed = resolve; });
    const sent = new Promise(resolve => { delivered = resolve; });
    let intercepted = false;
    await page.route("**/api/snapshot", async route => {
        if (intercepted) return route.continue();
        intercepted = true;
        const response = await route.fetch();
        observed();
        await gate;
        await route.fulfill({ response });
        delivered();
    });
    try {
        await selectActivityOption(page, "toolFilter", "workiq-fetch");
        await closeAnalyzeFilters(page);
        await held;
        await expect(page.locator("#activityListSummary")).toContainText("240 interactions");
        await navigateMain(page, "settings");
        await expect(page.locator("#pageTitle")).toHaveText("Settings");
        release(); await sent;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator("#pageTitle")).toHaveText("Settings");
        await navigateMain(page, "analyze"); await ready(page);
        await expect(page.locator("#activityListSummary")).toContainText("240 interactions");
    } finally { release(); }
});

test("literal Search opens its exact interaction and returns to the current query through the React view", { timeout: 45000 }, async t => {
    const { page } = await setup(t), input = page.locator("#wireSearch");
    const origin = page.url();
    await input.fill("Cedar");
    const hit = page.locator(".wire-search-hit[data-search-type=interaction]").first();
    await expect(hit).toBeVisible();
    await expect(hit.locator("mark").first()).toHaveText(/Cedar/i);
    assert.equal(page.url(), origin);
    await hit.focus(); await hit.press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await expect(page.locator("#requestContent")).toContainText("Cedar");
    await page.locator("#closeContextSidebar").click();
    await expect(input).toHaveValue("Cedar");
    await expect(hit).toBeFocused();
    await capture(page, "react-search-return");
    await input.fill("no retained text matches this invented phrase");
    await expect(page.locator(".wire-search-hit")).toHaveCount(0);
    assert.ok(!page.url().includes("Cedar"));
});

test("delivery measurements distinguish the bundled control from the React evaluation without inventing a speed budget", { timeout: 45000 }, async t => {
    const measurements = [];
    for (const frontend of ["bundled", "react"]) {
        const { page, htmlBytes, browserVersion } = await setup(t, frontend);
        await page.locator("#wireSearch").fill("Cedar");
        await expect(page.locator(".wire-search-hit").first()).toBeVisible();
        measurements.push({ frontend, browser: process.env.WIRE_FRONTEND_BROWSER ?? "chromium", htmlBytes, browserVersion, ...await page.evaluate(() => {
            const navigation = performance.getEntriesByType("navigation")[0];
            const scripts = performance.getEntriesByType("resource").filter(entry => new URL(entry.name).pathname.startsWith("/assets/client/"));
            return { ...window.frontendMeasurements, domInteractiveMs: navigation.domInteractive, domContentLoadedMs: navigation.domContentLoadedEventEnd,
                clientAssetBytes: scripts.reduce((sum, entry) => sum + entry.decodedBodySize, 0) };
        }) });
    }
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, "delivery-measurements.json"), JSON.stringify(measurements, null, 2));
    }
    t.diagnostic(JSON.stringify(measurements));
});
