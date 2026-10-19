import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, setLegacyTimeBucket } from "./helpers.mjs";

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
async function setup(t, records = chartRecords()) {
    const original = structuredClone(records), errors = [], denied = [], cleanup = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const stored = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const origin = new URL(runtime.url).origin;
    const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, timezoneId: "UTC",
        locale: "en-US", reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        return route.continue();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], stored[key], key);
            assert.deepEqual(records, original); assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url + "#analyze"); await ready(page); await chooseTheme(page, "dark"); await ready(page);
    return page;
}
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
            dates: [...scroll.querySelectorAll(".dimensional-time-labels > span")].map(node => {
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
            assert.ok(count.width >= 44 && count.height >= 44);
            assert.ok(count.x >= scroll.x && count.x + count.width <= scroll.x + scroll.width);
            assert.equal(await action.locator(".dimensional-count").evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 16 * scale);
        }
        if (width === 390 || width === 1440) await capture(page, `narrow-${theme}-${width}-text${scale}`, await measure(page));
    }
    const last = page.locator(".time-column").last();
    await last.focus(); await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText(String(counts.at(-1)));
    assert.equal(new URL(page.url()).hash, original.at(-1).href);
    await page.goBack(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText(String(total));
    await expect(page.locator(".time-column").last()).toBeFocused();
    await page.locator(".time-column .flat-time-segment").first().click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText(String(counts[0]));
    assert.equal(new URL(page.url()).hash, original[0].href);
    await page.goBack(); await ready(page);
    for (const mode of ["workload", "endpoint", "time"]) {
        await page.locator(`[data-chart="${mode}"]`).click(); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText(String(total));
        await expect(page.getByRole("combobox", { name: "Dates", exact: true })).toHaveText(/All dates/);
    }
    assert.deepEqual(await links(), original.map(row => ({ ...row, href: row.href.replace("#analyze?", "#analyze?chart=time&") })));
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
        await capture(page, `dense-${width}-text${scale}`, focused);
    }
});

test("sidebar animation crosses the fit boundary without a false scrollbar or replaced columns", async t => {
    const page = await setup(t);
    await page.setViewportSize({ width: 1440, height: 1080 });
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
        await page.evaluate(async () => {
            await Promise.all(document.getAnimations().map(animation => animation.finished));
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
