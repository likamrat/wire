import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";

async function setup(t, { reducedMotion = "reduce" } = {}) {
    const cleanup = [], record = fixture("guide-access");
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const before = await loadBoardState(context), requests = [], errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw Error("Providers are forbidden in guide access proof."); },
            readSource() { throw Error("Source reads are forbidden in guide access proof."); },
        },
    });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        let token = Object.freeze({});
        window.guidePublicationFixture = {
            publicationToken: () => token,
            isCurrent: value => value != null && value === token,
            withdraw: () => { token = null; },
            fresh: () => { token = Object.freeze({}); },
        };
        const original = window.fetch;
        window.guideFixtureFetches = 0;
        window.fetch = function (...args) { window.guideFixtureFetches++; return original.apply(this, args); };
    });
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison", "/api/session", "/api/session/release",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        requests.push(url.pathname);
        if (url.pathname !== "/") return route.continue();
        const response = await route.fetch();
        let html = await response.text();
        // Only the publication boundary and test handle are supplied here. The guide,
        // caller, data reads, native controls and exact-table renderer remain real.
        const options = "publicationToken: () => api.publicationToken(), isCurrent: token => api.isCurrent(token),";
        const handle = "let readingIntent = 0;";
        assert.equal(html.split(options).length, 2);
        assert.equal(html.split(handle).length, 2);
        html = html.replace(options, `publicationToken: () => window.guidePublicationFixture.publicationToken(),
        isCurrent: token => window.guidePublicationFixture.isCurrent(token),`);
        html = html.replace(handle, `window.guideAccessFixture = chartReferenceUI; ${handle}`);
        await route.fulfill({ response, body: html });
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    return { page, requests };
}

test("publication withdrawal cancels a native guide glide and retires its completion synchronously", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { reducedMotion: "no-preference" });
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    const result = await page.evaluate(() => {
        const root = document.getElementById("meaning"), held = [];
        const walker = document.createTreeWalker(document.getElementById("chartReferenceData"), NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) held.push(walker.currentNode);
        window.guideAccessFixture.close();
        const motion = root.getAnimations()[0], finish = motion.onfinish;
        const before = { texts: held.map(node => node.data), moving: Boolean(motion), closing: root.hasAttribute("data-closing") };
        window.guidePublicationFixture.withdraw();
        const focused = [], observe = event => focused.push(event.target.id);
        document.addEventListener("focusin", observe);
        window.guideAccessFixture.withdrawAccess();
        document.removeEventListener("focusin", observe);
        const after = { texts: held.map(node => node.data), open: root.open, animations: root.getAnimations().length,
            rows: document.querySelectorAll("#chartReferenceData tr").length, focused };
        window.guidePublicationFixture.fresh();
        window.guideAccessFixture.open();
        finish();
        return { before, after, freshOpen: root.open, freshCapture: Boolean(window.guideAccessFixture.capture()) };
    });
    assert.ok(result.before.moving && result.before.closing && result.before.texts.some(text => text.trim()));
    assert.deepEqual(result.after, { texts: result.before.texts.map(() => ""), open: false, animations: 0, rows: 0, focused: [] });
    assert.ok(result.freshOpen && result.freshCapture, "Retired motion completion cannot close a fresh publication");
});

for (const initiallyOpen of [true, false]) test(`native guide withdraws exact/find/source state locally (${initiallyOpen ? "open" : "already closed"})`, { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await selectActivityOption(page, "toolFilter", ["workiq-fetch"]);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await closeAnalyzeFilters(page);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceAllTopics").click();
    await page.locator('button[data-reference-topic="paths"]').click();
    await page.locator("#chartReferenceShowData").click();
    await expect(page.locator("#chartReferenceData")).toContainText("calendarView");
    await page.locator("#chartReferenceFindInput").fill("PRIVATE_GUIDE_FIND");
    await page.evaluate(() => {
        window.retiredGuideFixtureCapture = window.guideAccessFixture.capture();
        window.retainedGuideFixtureTable = document.getElementById("countTable");
        window.retainedGuideFixtureText = [];
        for (const host of [window.retainedGuideFixtureTable, document.getElementById("chartReferenceQualification")]) {
            const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) window.retainedGuideFixtureText.push(walker.currentNode);
        }
        window.retainedGuideFixtureAttributes = [document.getElementById("meaning").getAttributeNode("data-revision"),
            window.retainedGuideFixtureTable.querySelector("[data-view-key]").getAttributeNode("data-view-key")];
        window.retainedGuideFixtureBefore = {
            text: window.retainedGuideFixtureText.map(node => node.data),
            attributes: window.retainedGuideFixtureAttributes.map(attribute => attribute.value),
        };
    });
    assert.equal(await page.evaluate(() => window.retiredGuideFixtureCapture.rowQuery), "PRIVATE_GUIDE_FIND");
    if (!initiallyOpen) await page.locator("#closeChartReference").click();
    const result = await page.evaluate(() => {
        const fetches = window.guideFixtureFetches, href = location.href, length = history.length, focused = [];
        const observe = event => focused.push(event.target.id);
        document.addEventListener("focusin", observe);
        window.guidePublicationFixture.withdraw();
        window.guideAccessFixture.withdrawAccess();
        window.guideAccessFixture.withdrawAccess();
        document.removeEventListener("focusin", observe);
        return { fetches: window.guideFixtureFetches - fetches, navigation: location.href !== href || history.length !== length, focused,
            open: document.getElementById("meaning").open, hidden: document.getElementById("analyzeReference").hidden,
            text: document.getElementById("meaning").textContent, find: document.getElementById("chartReferenceFindInput").value,
            table: window.retainedGuideFixtureTable.textContent,
            heldBefore: window.retainedGuideFixtureBefore,
            heldText: window.retainedGuideFixtureText.map(node => node.data),
            heldAttributes: window.retainedGuideFixtureAttributes.map(attribute => attribute.value),
            sources: ["periodLabel", "meaningMatched", "meaningSources", "periodHint", "takeaway", "meaningBody", "chartReadingNotes", "serviceDefinitions", "percentageData"]
                .map(id => document.getElementById(id).textContent),
            capture: window.guideAccessFixture.capture(), restore: window.guideAccessFixture.restore(window.retiredGuideFixtureCapture) };
    });
    assert.equal(result.fetches, 0);
    assert.equal(result.navigation, false);
    assert.deepEqual(result.focused, []);
    assert.equal(result.open, false); assert.equal(result.hidden, true);
    assert.doesNotMatch(result.text, /PRIVATE_GUIDE_FIND|calendarView/);
    assert.match(result.text, /No usable path was saved\./);
    assert.equal(result.find, ""); assert.equal(result.table, "");
    assert.ok(result.heldBefore.text.some(text => text === "1"), "Hold an actual generated total");
    assert.ok(result.heldBefore.text.some(text => text.includes("Tool:")), "Hold the actual accepted qualification");
    assert.match(result.heldBefore.attributes[1], /^pager:chart-reference:/, "Hold actual generated paging identity");
    assert.deepEqual(result.heldText, result.heldBefore.text.map(() => ""));
    assert.deepEqual(result.heldAttributes, ["", ""]);
    assert.ok(result.sources.every(value => value === ""));
    assert.equal(result.capture, null); assert.equal(result.restore, false);

    await page.evaluate(() => { window.guidePublicationFixture.fresh(); window.guideAccessFixture.refresh(); });
    await expect(page.locator("#meaning")).not.toBeVisible();
    const snapshots = requests.filter(path => path === "/api/snapshot").length;
    await selectActivityOption(page, "outcomeFilter", ["success"]);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await closeAnalyzeFilters(page);
    assert.ok(requests.filter(path => path === "/api/snapshot").length > snapshots, "Recovery uses a fresh existing-owner stored read");
    assert.equal(await page.evaluate(() => window.guideAccessFixture.restore(window.retiredGuideFixtureCapture)), false);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    await expect(page.locator("#chartReferenceFindInput")).toHaveValue("");
    await expect(page.locator("#chartReferenceData")).toContainText("calendarView");
    assert.equal(await page.evaluate(() => window.retainedGuideFixtureText.every(node => node.data === "")
        && window.retainedGuideFixtureAttributes.every(attribute => attribute.value === "")), true,
    "Fresh re-entry does not repopulate retired Text or Attr handles");
});
