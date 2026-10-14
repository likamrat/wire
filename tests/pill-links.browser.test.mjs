import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, revealStoredRefresh } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_PILL_PROOFS;
const pillSelector = "a.button-link,a.result-link,.primary-navigation a,.app-header nav a";
const slice = "layer=tool&scope=all&from=2026-09-30&to=2026-09-30&service=Calendar&project=test-project";

async function resultPaint(locator) {
    return locator.evaluate(node => {
        const style = getComputedStyle(node), face = getComputedStyle(node, "::before"), box = node.getBoundingClientRect();
        const owner = node.closest(".recorded-results").getBoundingClientRect();
        return {
            outerFill: style.backgroundColor, faceFill: face.backgroundColor, ink: style.color,
            height: box.height, width: box.width, radius: face.borderRadius,
            paintHeight: box.height - parseFloat(face.top) - parseFloat(face.bottom),
            paintWidth: box.width - parseFloat(face.left) - parseFloat(face.right),
            inset: parseFloat(face.top), decoration: style.textDecorationLine,
            focus: node.matches(":focus-visible"), outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
            neighbors: [...node.closest(".recorded-results").querySelectorAll(".recorded-result")].map(sibling => {
                const rect = sibling.getBoundingClientRect();
                return { x: rect.x - owner.x, y: rect.y - owner.y, width: rect.width, height: rect.height };
            }),
        };
    });
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t, { empty = false, touch = false } = {}) {
    const row = fixture("pill-request");
    row.sourceSessionName = "Synthetic pill chat";
    row.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
    row.toolCalls.push({ ...structuredClone(row.toolCalls[0]), toolCallId: "pill-failure", startEventId: "pill-failure-start",
        toolSucceeded: false, reportedOutcome: "failed", apiResults: [{ index: 0, statusCode: 403 }] });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, empty ? [] : [row]), before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: touch ? 375 : 1200, height: 950 }, hasTouch: touch,
        timezoneId: "America/Los_Angeles", reducedMotion: "reduce",
    });
    const errors = [], posts = [], urls = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        urls.push(request.url());
        if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
    });
    await page.addInitScript(() => {
        const push = history.pushState;
        window.pillPushCount = 0;
        history.pushState = function (...args) { window.pillPushCount++; return push.apply(this, args); };
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(posts.every(url => ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url)), "Navigation must not mutate the store");
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#home?" + slice); await ready(page);
    return { page, runtime, urls };
}
async function decoration(locator) {
    return locator.evaluate(node => [node, ...node.querySelectorAll("*")].map(item => ({
        tag: item.tagName, decoration: getComputedStyle(item).textDecorationLine,
    })));
}
async function assertPillStates(page, locator) {
    await page.mouse.move(0, 0); await locator.evaluate(node => node.blur());
    assert.ok((await decoration(locator)).every(item => item.decoration === "none"), "Resting anchor and descendants");
    await locator.hover();
    assert.ok((await decoration(locator)).every(item => item.decoration === "none"), "Hover anchor and descendants");
    await page.mouse.down();
    assert.ok((await decoration(locator)).every(item => item.decoration === "none"), "Pressed anchor and descendants");
    await page.mouse.move(0, 0); await page.mouse.up();
    await locator.focus(); await page.keyboard.press("Shift");
    assert.ok((await decoration(locator)).every(item => item.decoration === "none"), "Focused anchor and descendants");
    const focused = await locator.evaluate(node => {
        const style = getComputedStyle(node);
        return node.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
    });
    assert.equal(focused, true, "Keyboard focus is visible");
    assert.equal(await locator.locator("a,button,input,select,[tabindex]").count(), 0, "One control, no nested interaction");
    assert.equal(await locator.evaluate(node => node.tagName === "A" && node.hasAttribute("href") && node.tabIndex === 0), true);
}
async function hitPoint(locator, part) {
    await locator.scrollIntoViewIfNeeded();
    return locator.evaluate((node, part) => {
        const box = node.getBoundingClientRect(), before = getComputedStyle(node, "::before");
        const inset = before.content !== "none" ? parseFloat(before.top) || 0 : 0;
        let x = box.left + 5, y = box.top + box.height / 2;
        if (part === "corner") {
            const bottom = before.content !== "none" ? parseFloat(before.bottom) || 0 : 0;
            const radius = Math.min((box.height - inset - bottom) / 2, box.width / 2);
            x = box.left + radius * .4; y = box.top + inset + radius * .4;
        }
        if (part === "icon") {
            const icon = node.querySelector("svg").getBoundingClientRect();
            x = icon.left + icon.width / 2; y = icon.top + icon.height / 2;
        }
        if (part === "label") {
            const range = document.createRange();
            const text = node.querySelector(".recorded-result-label") || [...node.childNodes].find(item => item.nodeType === Node.TEXT_NODE);
            range.selectNodeContents(text);
            const label = range.getClientRects()[0];
            x = label.left + label.width / 2; y = label.top + label.height / 2;
        }
        return { x, y, ownsHit: document.elementFromPoint(x, y)?.closest("a") === node };
    }, part);
}
async function activate(page, locator, part, touch = false) {
    const expected = await locator.getAttribute("href"), before = await page.evaluate(() => window.pillPushCount);
    const point = await hitPoint(locator, part);
    assert.equal(point.ownsHit, true, `${part} belongs to the native anchor`);
    if (touch) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
    await ready(page);
    assert.equal(new URL(page.url()).hash, expected);
    assert.equal(await page.evaluate(() => window.pillPushCount), before + 1, "Exactly one history push");
    return expected;
}
async function bounds(locator) {
    return locator.evaluate(node => {
        const box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
        const rects = [...range.getClientRects()];
        return { width: box.width, height: box.height, font: parseFloat(getComputedStyle(node).fontSize),
            clipped: rects.some(r => r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom),
            outsidePage: box.left < 0 || box.right > innerWidth, overflow: document.documentElement.scrollWidth - innerWidth };
    });
}
function assertBounds(metrics, label) {
    assert.equal(metrics.clipped, false, `${label}: content fits anchor`);
    assert.equal(metrics.outsidePage, false, label);
    assert.ok(metrics.height >= 44, `${label}: 44px target`);
    assert.ok(metrics.overflow <= 1, `${label}: no page overflow`);
    assert.ok(metrics.width < 500, `${label}: content-sized pill, not a stretched row`);
}

test("chooser and every pill anchor family have decoration-free interactive states", { timeout: 60000 }, async t => {
    const { page, runtime } = await setup(t);
    assert.equal(await page.locator("#pageAction").innerText(), "Choose a Copilot chat");
    assert.equal(await page.getByRole("link", { name: "Choose a Copilot chat", exact: true }).count(), 1);
    assert.equal(await page.locator("#periodResult").innerText(), "2 Work IQ tool calls (Sep 30, 2026)");
    assert.equal(await page.locator("#periodHint").innerText(), "Sep 30, 2026 - Sep 30, 2026 · 1 Copilot chat");
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
    await page.locator("#meaning > summary").click();
    assert.equal(await page.locator("#homeInsightScope").isVisible(), true);
    assert.equal(await page.locator("#meaningMatched").innerText(), "2 Work IQ tool calls");
    assert.match(await page.locator("#homeInsightScope").innerText(), /1 request group across all pages.*full retained interaction.*not only matched Work IQ tool calls/);
    await page.locator("#meaning > summary").click();
    await assertPillStates(page, page.locator("#pageAction"));
    await assertPillStates(page, page.locator(".primary-navigation a[data-nav=activity]"));
    await page.locator("#pageAction").click(); await ready(page);
    assert.equal(await page.locator("#pageTitle").innerText(), "Choose a Copilot chat");
    assert.equal(await page.locator("#activityTitle").innerText(), "Choose a Copilot chat");
    for (const outcome of ["success", "failure"]) {
        await assertPillStates(page, page.locator(`.session-summary .result-link[data-outcome=${outcome}]`));
    }
    await page.locator(".session-summary .result-link[data-outcome=success]").click(); await ready(page);
    assert.equal(await page.locator("#pageTitle").innerText(), "Synthetic pill chat", "Recorded names are untouched");
    for (const outcome of ["success", "failure"]) {
        await assertPillStates(page, page.locator(`#sessionAnalysis .result-link[data-outcome=${outcome}]`));
    }
    await assertPillStates(page, page.locator("#contextBack"));
    const ordinary = page.locator(".matched-action .text-link").first();
    await ordinary.hover();
    assert.equal(await ordinary.evaluate(node => getComputedStyle(node).textDecorationLine), "none");
    await page.locator(".matched-action .text-link").first().click(); await ready(page);
    await assertPillStates(page, page.locator("#contextBack"));
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    await navigateMain(page, "reports"); await ready(page);
    await assertPillStates(page, page.locator("#pageAction"));
    assert.equal(await page.locator("#pageAction").innerText(), "Back to activity");
    await navigateMain(page, "settings"); await ready(page);
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    await assertPillStates(page, page.locator(".primary-navigation a[data-nav=settings]"));
    assert.equal(await page.locator("nav [data-nav=reports]").evaluate(node => node.tagName), "A");
    assert.equal(await page.locator("#sidebarExport").count(), 0);
    assert.equal(await page.locator("#reviewSource").evaluate(node => node.tagName), "BUTTON");
    await page.goto(runtime.url + "#home?" + slice); await ready(page);
    // Chromium masks :visited inspection. Revisit and test observable rendering, not history state.
    await page.locator("#pageAction").click(); await ready(page); await page.goBack(); await ready(page);
    await assertPillStates(page, page.locator("#pageAction"));
    const focusedUrl = page.url();
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    assert.equal(page.url(), focusedUrl, "Polling never navigates");
    assert.equal(await page.locator("#pageAction").evaluate(node => node === document.activeElement), true, "Polling retains chooser focus");
});

test("pill padding, icon, label, touch and keyboard preserve one native route and private context", { timeout: 60000 }, async t => {
    const { page, runtime, urls } = await setup(t, { touch: true });
    const home = runtime.url + "#home?" + slice;
    for (const part of ["padding", "corner", "label"]) {
        await page.goto(home); await ready(page);
        await activate(page, page.locator("#pageAction"), part, part === "corner");
        await page.goBack(); await ready(page);
        assert.equal(page.url(), home);
    }
    await page.locator("#main").focus();
    const tabStops = [];
    while (!await page.locator("#pageAction").evaluate(node => node === document.activeElement) && tabStops.length < 32) {
        await page.keyboard.press("Tab");
        tabStops.push(await page.evaluate(() => document.activeElement.id));
    }
    assert.ok(tabStops.includes("fromFilter") && tabStops.includes("toFilter") && tabStops.includes("applyDates"), "Restored custom dates expose both native segmented inputs and Apply in Tab order");
    assert.ok(tabStops.length < 32, "Chooser is reachable after fresh-data controls and the visible custom dates: " + tabStops.join(", "));
    await page.keyboard.press("Enter"); await ready(page);
    assert.match(page.url(), /#activity/);
    await page.locator("#activitySearch").fill("Synthetic pill chat");
    const activity = page.url();
    for (const part of ["padding", "corner", "icon", "label"]) {
        const pill = page.locator(".session-summary .result-link[data-outcome=success]");
        await activate(page, pill, part, part === "icon");
        const params = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
        for (const [key, value] of new URLSearchParams(slice)) assert.equal(params.get(key), value);
        assert.equal(params.get("session"), "test-session"); assert.equal(params.get("result"), "success");
        await page.goBack(); await ready(page);
        assert.equal(page.url(), activity);
        assert.equal(await page.locator("#activitySearch").inputValue(), "Synthetic pill chat");
    }
    const native = page.locator(".session-summary .result-link[data-outcome=failure]");
    const href = await native.getAttribute("href"), original = page.url();
    await native.click({ button: "right" });
    assert.equal(page.url(), original, "Context-menu gesture never navigates the source tab");
    await page.keyboard.press("Escape");
    const popupPromise = page.context().waitForEvent("page");
    await native.click({ modifiers: ["Control"] });
    const popup = await popupPromise;
    try {
        await popup.waitForLoadState(); await ready(popup);
        assert.equal(new URL(popup.url()).hash, href);
        assert.equal(await popup.locator("#activitySearch").inputValue(), "", "New tab gets only explicit URL scope");
        assert.equal(page.url(), original);
    } finally { await popup.close(); }
    await page.locator("#navigationToggle").click();
    await activate(page, page.locator(".primary-navigation a[data-nav=settings]"), "icon", true);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), "Synthetic pill chat");
    assert.ok(urls.every(url => !decodeURIComponent(url).includes("Synthetic pill chat")));
});

test("long chooser and navigation pills fit both themes, narrow/wide screens and 200% text", { timeout: 90000 }, async t => {
    const { page, runtime } = await setup(t), measurements = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 1920]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.keyboard.press("Escape");
        await assertPillStates(page, page.locator("#pageAction"));
        const metrics = await bounds(page.locator("#pageAction"));
        assertBounds(metrics, `${theme}/${width}/${scale}: chooser`);
        if (proofs) await page.locator("#periodActions").screenshot({ path: path.join(proofs, `chooser-${theme}-${width}-${scale}x.png`) });
        if (width === 375) await page.locator("#navigationToggle").click();
        const clippedNav = await page.locator(".primary-navigation a").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).flatMap(node => {
            const box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
            return [...range.getClientRects()].filter(r => r.width && (r.left < box.left || r.right > box.right + 1 || r.bottom > box.bottom + 1)).map(() => node.textContent);
        }));
        assert.deepEqual(clippedNav, [], `${theme}/${width}/${scale}: navigation text fits its pill`);
        await assertPillStates(page, page.locator(".primary-navigation a[data-nav=activity]"));
        if (width === 375) await page.keyboard.press("Escape");
        await page.locator("#pageAction").click(); await ready(page);
        const resultMetrics = [];
        for (const outcome of ["success", "failure"]) {
            const result = page.locator(`.session-summary .result-link[data-outcome=${outcome}]`);
            await assertPillStates(page, result);
            const metric = await bounds(result);
            assertBounds(metric, `${theme}/${width}/${scale}: ${outcome}`);
            resultMetrics.push({ outcome, ...metric });
        }
        await page.locator(".session-summary .result-link[data-outcome=success]").click(); await ready(page);
        await assertPillStates(page, page.locator("#sessionAnalysis .result-link[data-outcome=success]"));
        await page.locator(".matched-action .text-link").first().click(); await ready(page);
        await assertPillStates(page, page.locator("#contextBack"));
        const requestAction = await bounds(page.locator("#contextBack"));
        assertBounds(requestAction, `${theme}/${width}/${scale}: request`);
        if (!await page.locator("#pageAction").isVisible()) await page.getByRole("button", { name: "Add to report", exact: true }).click();
        await page.getByRole("link", { name: "Review selection", exact: true }).click(); await ready(page);
        await assertPillStates(page, page.locator("#pageAction"));
        const reportAction = await bounds(page.locator("#pageAction"));
        assertBounds(reportAction, `${theme}/${width}/${scale}: reports`);
        measurements.push({ theme, width, scale, ...metrics, resultMetrics, requestAction, reportAction });
        await page.goto(runtime.url + "#home?" + slice); await ready(page);
    }
    if (proofs) await writeFile(path.join(proofs, "pill-bounds.json"), JSON.stringify(measurements, null, 2));
});

test("empty and missing-request routes keep navigation pills and ordinary recovery links distinct", { timeout: 30000 }, async t => {
    const { page, runtime } = await setup(t, { empty: true });
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    await assertPillStates(page, page.locator(".primary-navigation a[data-nav=activity]"));
    await page.locator(".primary-navigation a[data-nav=activity]").click(); await ready(page);
    await page.locator("#collectionNoticeAction").hover();
    assert.equal(await page.locator("#collectionNoticeAction").evaluate(node => getComputedStyle(node).textDecorationLine), "none");
    await page.goto(runtime.url + "#request?request=missing"); await ready(page);
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    await assertPillStates(page, page.locator("#contextBack"));
    assert.equal(await page.locator("#contextBack").innerText(), "Back to activity");
    assert.equal(await page.locator(`${pillSelector}`).evaluateAll(nodes => nodes.every(node => !node.querySelector("a,button,input,select"))), true);
});

test("layered result hover paints only its badge, not the transparent native hit target", { timeout: 30000 }, async t => {
    const { page, runtime } = await setup(t), measurements = [], failures = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) {
        await page.goto(runtime.url + "#activity?" + slice); await ready(page);
        await chooseTheme(page, theme);
        for (const context of ["list", "analysis"]) {
            if (context === "analysis") {
                await page.locator(".session-summary .result-link[data-outcome=success]").click(); await ready(page);
            }
            const root = page.locator(context === "list" ? ".session-summary .recorded-results" : "#sessionAnalysis .recorded-results").first();
            const link = root.locator(".result-link[data-outcome=failure]");
            await link.scrollIntoViewIfNeeded();
            await page.mouse.move(0, 0); await link.evaluate(node => node.blur());
            const baseline = await resultPaint(link);
            assert.ok(baseline.height >= 44 && baseline.paintHeight < baseline.height);
            for (const state of ["rest", "hover", "pressed", "focus"]) {
                if (state === "hover") await link.hover();
                if (state === "pressed") await page.mouse.down();
                if (state === "focus") {
                    await page.mouse.move(0, 0); await link.focus(); await page.keyboard.press("Shift");
                }
                const actual = await resultPaint(link), label = `${theme}/${context}/${state}`;
                measurements.push({ theme, context, state, ...actual });
                if (actual.outerFill !== "rgba(0, 0, 0, 0)") failures.push(`${label}: hit target painted ${actual.outerFill}`);
                assert.equal(actual.width, baseline.width, label);
                assert.equal(actual.height, baseline.height, label);
                assert.equal(actual.paintWidth, baseline.paintWidth, label);
                assert.equal(actual.paintHeight, baseline.paintHeight, label);
                assert.equal(actual.radius, baseline.radius, label);
                assert.deepEqual(actual.neighbors, baseline.neighbors, `${label}: neighbors do not shift`);
                assert.equal(actual.decoration, "none", label);
                assert.ok(contrast(actual.ink, actual.faceFill) >= 4.5, `${label}: readable semantic text`);
                if (state === "focus") assert.ok(actual.focus && actual.outline !== "none" && actual.outlineWidth >= 2);
                if (proofs && ["rest", "hover", "focus"].includes(state)) {
                    await root.screenshot({ path: path.join(proofs, `result-${theme}-${context}-${state}.png`) });
                }
                if (state === "pressed") { await page.mouse.move(0, 0); await page.mouse.up(); }
            }
            await link.evaluate(node => node.blur());
            const worked = root.locator(".result-link[data-outcome=success]");
            const workedBaseline = await resultPaint(worked);
            await worked.hover();
            const workedHover = await resultPaint(worked);
            measurements.push({ theme, context, state: "worked-hover", ...workedHover });
            if (workedHover.outerFill !== "rgba(0, 0, 0, 0)") failures.push(`${theme}/${context}/worked-hover: hit target painted ${workedHover.outerFill}`);
            assert.deepEqual(workedHover.neighbors, workedBaseline.neighbors);
            assert.ok(contrast(workedHover.ink, workedHover.faceFill) >= 4.5);
        }
        await page.locator("#contextBack").click(); await ready(page);
        for (const selector of ["#dateFilter-control", ".filter-chip"]) {
            const layered = page.locator(selector).first();
            await layered.hover();
            assert.equal(await layered.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", selector);
        }
        await page.locator(".session-summary .result-link[data-outcome=success]").click(); await ready(page);
        await page.locator(".matched-action .text-link").first().click(); await ready(page);
        const staticBadge = page.locator(".request-outcome .recorded-result").first();
        const staticFill = await staticBadge.evaluate(node => getComputedStyle(node).backgroundColor);
        await staticBadge.hover();
        assert.equal(await staticBadge.evaluate(node => getComputedStyle(node).backgroundColor), staticFill);
        await page.locator("#contextBack").hover();
        assert.equal(await page.locator("#contextBack").evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)",
            "Navigation actions also keep their outer targets transparent.");
        assert.notEqual(await page.locator("#contextBack").evaluate(node => getComputedStyle(node, "::before").backgroundColor), "rgba(0, 0, 0, 0)",
            "Navigation actions retain hover feedback on their compact face.");
        await navigateMain(page, "home"); await ready(page);
        await page.locator(".percentage-label[href]").first().hover();
        assert.equal(await page.locator(".percentage-label[href]").first().evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)",
            "Chart-adjacent label hover remains independently controlled.");
    }
    if (proofs) await writeFile(path.join(proofs, "result-hover-measurements.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(failures, []);
});

test("result badge transparent padding remains clickable by pointer and narrow touch after re-render", { timeout: 30000 }, async t => {
    for (const touch of [false, true]) {
        const { page } = await setup(t, { touch });
        await chooseTheme(page, "dark");
        await navigateMain(page, "activity"); await ready(page);
        const link = page.locator(".session-summary .result-link[data-outcome=failure]");
        await link.scrollIntoViewIfNeeded();
        const expected = await link.getAttribute("href"), before = await page.evaluate(() => window.pillPushCount);
        const point = await link.evaluate(node => {
            const rect = node.getBoundingClientRect(), face = getComputedStyle(node, "::before");
            const x = rect.x + rect.width / 2, y = rect.y + 2;
            return { x, y, outsidePaint: 2 < parseFloat(face.top), owned: document.elementFromPoint(x, y)?.closest("a") === node };
        });
        assert.ok(point.outsidePaint && point.owned, "The unpainted padding belongs to the same native link.");
        if (touch) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
        await ready(page);
        assert.equal(new URL(page.url()).hash, expected);
        assert.equal(await page.evaluate(() => window.pillPushCount), before + 1);
        const current = page.locator("#sessionAnalysis .result-link[data-outcome=failure]");
        await (await revealStoredRefresh(page)).click(); await ready(page);
        if (touch) await current.tap(); else await current.hover();
        await ready(page);
        assert.equal((await resultPaint(current)).outerFill, "rgba(0, 0, 0, 0)", "No oversized fill persists after activation or re-render.");
        if (proofs && touch) await page.locator("#sessionAnalysis .recorded-results").first().screenshot({ path: path.join(proofs, "result-narrow-touch.png") });
        if (!touch) {
            const worked = page.locator("#sessionAnalysis .result-link[data-outcome=success]");
            const destination = await worked.getAttribute("href"), pushes = await page.evaluate(() => window.pillPushCount);
            await worked.focus(); await page.keyboard.press("Enter"); await ready(page);
            assert.equal(new URL(page.url()).hash, destination);
            assert.equal(await page.evaluate(() => window.pillPushCount), pushes + 1);
        }
        await page.goBack(); await ready(page);
        assert.ok(await page.locator(".result-link").count() > 0);
    }
});
