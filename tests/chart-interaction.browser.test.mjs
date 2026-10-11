import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, chooseTheme, automaticScoreOffSummary, selectActivityOption } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofDir = process.env.WORKIQ_CHART_INTERACTION_PROOFS;
const ready = page => page.locator('#workspace[aria-busy="false"]').waitFor();

function originalSource() {
    const record = fixture("chart-interaction");
    record.userPrompt.text = "Invented chart interaction request";
    record.toolCalls = Array.from({ length: 11 }, (_, index) => ({
        ...record.toolCalls[0], toolCallId: `chart-call-${index}`, startEventId: `chart-start-${index}`,
        toolSucceeded: index < 8, reportedOutcome: index < 8 ? "succeeded" : "failed",
    }));
    return [record];
}

function variedSource() {
    const endpoints = [["/me/calendar"], ["/me/messages"], ["/me/drive"], ["/teams"], ["/me/contacts"],
        ["/me/planner/tasks"], ["/me/onenote"], ["/me/messages", "/me/calendar"], []];
    return [200, 20, 2, 1, 1, 1, 1, 1, 1].map((total, group) => {
        const record = fixture(`interaction-${group}`);
        record.userPrompt.text = `Invented interaction request ${group}`;
        record.capturedAt = group ? "2026-09-30T12:00:00Z" : "2026-09-01T12:00:00Z";
        record.toolCalls = Array.from({ length: total }, (_, index) => ({
            ...record.toolCalls[0], toolCallId: `interaction-${group}-${index}`, startEventId: `interaction-start-${group}-${index}`,
            startedAt: record.capturedAt, tool: group % 2 ? "workiq-fetch" : "workiq-call_function",
            requestArgs: { entityUrls: endpoints[group] }, requestedApiPath: endpoints[group].length === 1 ? endpoints[group][0] : null,
            toolSucceeded: group === 2 ? false : group === 8 ? undefined : true,
            reportedOutcome: group === 2 ? "failed" : group === 8 ? undefined : "succeeded",
        }));
        return record;
    });
}

async function setup(t, source = originalSource()) {
    const original = structuredClone(source), requests = [], errors = [], snapshots = [];
    const reads = ["/api/snapshot", "/api/evaluation/automatic/summary"];
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "chart-interaction-fixture")); return;
        }
        let text = ""; for await (const part of req) text += part;
        requests.push({ route: req.url, input: JSON.parse(text) });
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/evaluation/automatic/summary") {
            res.end(JSON.stringify(automaticScoreOffSummary())); return;
        }
        if (req.url !== "/api/snapshot") {
            res.statusCode = 403; res.end('{"error":"Only invented snapshot reads are allowed."}'); return;
        }
        const analytics = { ...buildActivityAnalytics(source, JSON.parse(text)), revision: 1 };
        snapshots.push(analytics);
        res.end(JSON.stringify({ revision: 1, scenarios: source, exports: [], coverage: { notes: [] }, analytics }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(source, original); assert.deepEqual(errors, []);
        assert.ok(requests.every(request => reads.includes(request.route)), JSON.stringify(requests.map(request => request.route)));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    if (proofDir) await mkdir(proofDir, { recursive: true });
    return { page, requests, snapshots };
}

async function paintedPoint(mark) {
    await mark.scrollIntoViewIfNeeded();
    return mark.evaluate(node => {
        const r = node.getBoundingClientRect();
        for (let y = r.top + 2; y < r.bottom; y += 3) for (let x = r.left + 2; x < r.right; x += 3) {
            if (document.elementFromPoint(x, y) === node) return { x, y };
        }
        throw new Error("The chart mark has no reachable painted surface");
    });
}

const configurations = [
    { theme: "light", width: 1600, text: 100 },
    { theme: "dark", width: 1600, text: 100 },
    { theme: "light", width: 375, text: 200 },
    { theme: "dark", width: 375, text: 200 },
];
async function configure(page, { theme, width, text }) {
    await page.setViewportSize({ width, height: 1100 });
    await chooseTheme(page, theme);
    await page.evaluate(text => { document.documentElement.style.fontSize = `${text}%`; }, text);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function facts(page) {
    return page.locator("#homeView").evaluate(root => ({
        total: root.querySelector(".percentage-section").dataset.total,
        legends: [...root.querySelectorAll(".percentage-legend-row")].map(node => [node.dataset.category, node.dataset.count, node.dataset.percentage, node.textContent]),
        geometry: [...root.querySelectorAll(".percentage-face,.dimensional-column,.flat-time-column")].map(node =>
            ["d", "data-category", "data-start", "data-end", "data-count", "data-exact-fraction", "data-total", "data-maximum", "data-front-height"]
                .map(key => node.getAttribute(key))),
    }));
}
async function pointerFocus(node) {
    return node.evaluate(node => ({
        focused: node === document.activeElement, visible: node.matches(":focus-visible"),
        outline: getComputedStyle(node).outlineStyle,
    }));
}
async function keyboardFocus(page, target, indicator = target) {
    await page.mouse.move(1, 1);
    await target.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await target.evaluate(node => node === document.activeElement && node.matches(":focus-visible")), true);
    const state = await indicator.evaluate(node => {
        const css = getComputedStyle(node), r = node.getBoundingClientRect();
        let parent = node, background;
        while (parent) {
            background = getComputedStyle(parent).backgroundColor;
            if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") break;
            parent = parent.parentElement;
        }
        const header = document.querySelector(".app-header").getBoundingClientRect();
        return { outline: css.outlineStyle, width: parseFloat(css.outlineWidth), color: css.outlineColor, background,
            height: r.height, visible: r.top >= header.bottom && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
    });
    assert.equal(state.outline, "solid"); assert.ok(state.width >= 2);
    assert.ok(contrast(state.color, state.background) >= 3, "Keyboard indicator keeps visible contrast");
    assert.ok(state.height >= 44); assert.equal(state.visible, true, "Focus stays on screen, not under the sticky header");
}
async function cancelPress(page, face, surface, name) {
    const point = await paintedPoint(face), target = face.locator("..");
    await page.mouse.move(point.x, point.y);
    const before = await capture(page, surface, `${name}-hover`);
    await page.mouse.down();
    const down = await capture(page, surface, `${name}-down`);
    assert.deepEqual(await pointerFocus(target), { focused: true, visible: false, outline: "none" });
    assert.ok(down.black <= before.black + 20, `${name}: pointer down cannot paint a black bounding rectangle`);
    await page.mouse.move(1, 1); await page.mouse.up();
    const released = await capture(page, surface, `${name}-released`);
    assert.equal(await target.evaluate(node => node === document.activeElement), true, "Canceled press retains ordinary browser focus");
    assert.ok(released.black <= before.black + 20, `${name}: pointer release cannot leave a black rectangle`);
    await target.evaluate(node => node.blur());
    const blurred = await capture(page, surface, `${name}-blur`);
    assert.ok(blurred.black <= before.black + 20);
}
async function drillAndReturn(page, control, expectedCount, snapshots, painted = false) {
    const before = await facts(page), home = page.url(), href = await control.getAttribute("href");
    if (painted) {
        const point = await paintedPoint(control.locator(".percentage-face,.dimensional-front,.flat-time-segment").first());
        await page.mouse.click(point.x, point.y);
    } else await page.keyboard.press("Enter");
    await page.waitForURL(url => url.hash === href); await ready(page);
    assert.equal(snapshots.at(-1).totals.count, expectedCount, "Drilldown uses exact records, not enlarged geometry");
    assert.match(await page.locator("#viewingContext").innerText(), new RegExp(`${expectedCount} Work IQ tool calls?`));
    await page.goBack(); await ready(page);
    assert.equal(page.url(), home);
    assert.deepEqual(await facts(page), before, "Return preserves counts, canonical shares and geometric allocation");
}

test("donut link surfaces and semantic keyboard labels retain their distinct focus across themes and text sizes", { timeout: 60000 }, async t => {
    const { page, snapshots } = await setup(t, variedSource());
    for (const config of configurations) {
        await configure(page, config);
        const name = `${config.theme}-${config.width}-text${config.text}`;
        const outcome = page.locator('[data-percentage-card="outcomes"]'), service = page.locator('[data-percentage-card="composition"]');
        const before = await facts(page);
        assert.equal(before.total, "228");
        for (const key of ["Unknown", "Multiple workloads", "group:other"]) {
            assert.equal(await service.locator(`.percentage-legend-row[data-category="${key}"]`).count(), 1,
                `${key} keeps its distinct attribution in the interaction fixture`);
        }
        const tiny = outcome.locator('.percentage-slice[data-category="failure"]');
        assert.equal(await tiny.getAttribute("data-count"), "2");
        assert.ok(await tiny.evaluate(node => Number(node.dataset.end) - Number(node.dataset.start) >= .03 - 1e-12));
        assert.equal(await outcome.locator('.percentage-slice[data-count="0"]').count(), 0);
        for (const [kind, face] of [
            ["tiny-top", tiny],
            ["front-wall", outcome.locator('.percentage-outer-wall[data-category="failure"]')],
            ["inner-wall", outcome.locator('.percentage-inner-wall[data-category="success"]').first()],
            ["service-top", service.locator(".percentage-slice").first()],
        ]) await cancelPress(page, face, (kind === "service-top" ? service : outcome).locator(".percentage-ring"), `${name}-${kind}`);
        assert.deepEqual(await facts(page), before);

        const label = outcome.locator('[data-category="failure"] .percentage-label');
        await keyboardFocus(page, label);
        assert.match(await label.getAttribute("aria-label"), /2 of 228 Work IQ tool calls.*View requests/);
        assert.equal(await outcome.locator('.percentage-face.percentage-active:not([data-category="failure"])').count(), 0);
        assert.ok(await outcome.locator('.percentage-face.percentage-active[data-category="failure"]').count() > 0);
        if (proofDir) await proofCapture(page, outcome, `${name}-keyboard-label`);
        await drillAndReturn(page, label, 2, snapshots);
        await drillAndReturn(page, tiny.locator(".."), 2, snapshots, true);

        const serviceFace = service.locator(".percentage-slice").first();
        const serviceCount = Number(await serviceFace.getAttribute("data-count"));
        const serviceKey = await serviceFace.getAttribute("data-category");
        const serviceLabel = service.locator(`.percentage-legend-row[data-category="${serviceKey}"] .percentage-label`);
        await keyboardFocus(page, serviceLabel);
        await drillAndReturn(page, serviceLabel, serviceCount, snapshots);
        await drillAndReturn(page, serviceFace.locator(".."), serviceCount, snapshots, true);

        const grouped = service.locator('[data-category="group:other"] .percentage-label');
        assert.equal(await grouped.getAttribute("href"), null);
        await keyboardFocus(page, grouped);
        assert.match(await grouped.getAttribute("aria-label"), /Grouped categories/);
        const route = page.url();
        await page.keyboard.press("Enter");
        assert.equal(page.url(), route, "Informational Other does not invent a filter");
        assert.ok(await service.locator('.percentage-active[data-category="group:other"]').count() > 0);
        await page.keyboard.press("Tab");
        await page.mouse.move(1, 1);
        assert.equal(await service.locator('.percentage-face.percentage-active').count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
});

test("column/timeline/service/API links and passive tool bars do not share the SVG proxy defect", { timeout: 60000 }, async t => {
    const { page, snapshots } = await setup(t, variedSource());
    for (const config of configurations) {
        await configure(page, config);
        const name = `${config.theme}-${config.width}-text${config.text}`;
        for (const mode of ["time", "workload", "endpoint"]) {
            await page.locator(`[data-chart="${mode}"]`).click(); await ready(page);
            const action = page.locator("#chart .time-column,#chart .dimensional-action").first();
            const face = action.locator(".dimensional-front,.flat-time-segment").first(), column = action.locator(".dimensional-column,.flat-time-column");
            const count = Number(await column.getAttribute("data-total"));
            assert.equal(await column.locator("a").count(), 0, "Columns use an HTML action, not SVG focus proxies");
            const point = await paintedPoint(face);
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            assert.deepEqual(await pointerFocus(action), { focused: true, visible: false, outline: "none" });
            if (proofDir) await column.screenshot({ path: path.join(proofDir, `${name}-${mode}-down.png`) });
            await page.mouse.move(1, 1); await page.mouse.up();
            await keyboardFocus(page, action, action.locator(".dimensional-count"));
            if (proofDir) await proofCapture(page, page.locator(".chart-panel"), `${name}-${mode}-keyboard`);
            await drillAndReturn(page, action, count, snapshots);
            await drillAndReturn(page, action, count, snapshots, true);
            if (mode === "time") {
                assert.ok(await page.locator(".time-zero").count() > 0, "Dated gap covers unpainted zero buckets");
                assert.equal(await page.locator(".time-zero svg,.time-zero a,.time-zero button").count(), 0);
            }
        }
        const service = page.locator('[data-percentage-card="composition"]');
        await service.getByRole("button", { name: "Tool names", exact: true }).click();
        const route = page.url(), before = await facts(page);
        assert.equal(await service.locator(".percentage-label[href],.percentage-ring").count(), 0);
        const bars = await service.locator(".percentage-bar").evaluateAll(nodes => nodes.map(node => ({
            count: +node.dataset.count, fraction: +node.dataset.fraction,
            percent: parseFloat(node.style.width),
        })));
        assert.equal(bars.reduce((sum, bar) => sum + bar.count, 0), 228);
        for (const bar of bars) {
            assert.ok(Math.abs(bar.fraction - bar.count / 228) < 1e-12);
            assert.ok(Math.abs(bar.percent - bar.fraction * 100) < .0001, "CSSOM-rounded paint width agrees with the exact share");
        }
        const bar = service.locator(".percentage-bar").first();
        await bar.hover(); await bar.click();
        assert.equal(page.url(), route); assert.deepEqual(await facts(page), before);
        const switcher = service.getByRole("button", { name: "Tool names", exact: true });
        await keyboardFocus(page, switcher);
        await page.keyboard.press("Space");
        assert.equal(await switcher.getAttribute("aria-pressed"), "true");
        if (proofDir) await proofCapture(page, service, `${name}-tool-bars`);
        await service.getByRole("button", { name: "Activity categories", exact: true }).click();
    }
    await selectActivityOption(page, "outcomeFilter", "partial"); await ready(page);
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "0");
    assert.equal(await page.locator(".percentage-face,.percentage-bar,.dimensional-column,.flat-time-column").count(), 0);
    assert.equal(await page.locator(".percentage-empty").count(), 2);
});

async function proofCapture(page, target, name) {
    const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    const box = await target.boundingBox();
    const clip = { ...box, x: box.x + scroll.x, y: box.y + scroll.y };
    await page.evaluate(() => scrollTo(0, 0));
    try { await page.screenshot({ path: path.join(proofDir, `${name}.png`), fullPage: true, clip }); }
    finally { await page.evaluate(({ x, y }) => scrollTo(x, y), scroll); }
}

async function capture(page, target, name) {
    const image = await target.screenshot();
    if (proofDir) await writeFile(path.join(proofDir, `${name}.png`), image);
    return page.evaluate(async bytes => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let black = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 26 && data[i + 1] < 26 && data[i + 2] < 26 && data[i + 3] > 250) black++;
        bitmap.close();
        return { black, width: canvas.width, height: canvas.height };
    }, [...image]);
}

test("clicking a navy donut never paints the spurious black rectangle", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await chooseTheme(page, "dark");
    const ring = page.locator(".percentage-ring").first();
    const failed = ring.locator('.percentage-slice[data-category="failure"]');
    const point = await paintedPoint(failed);
    await page.mouse.move(point.x, point.y);
    const before = await capture(page, ring, "donut-before");
    await page.mouse.down();
    const down = await capture(page, ring, "donut-pointer-down");
    const focus = await failed.evaluate(node => ({
        active: document.activeElement === node, visible: node.matches(":focus-visible"),
        outline: getComputedStyle(node).outline, transform: getComputedStyle(node.parentElement).transform,
        owner: document.activeElement.outerHTML.slice(0, 250),
        ownerOutline: getComputedStyle(document.activeElement).outline,
        ownerVisible: document.activeElement.matches(":focus-visible"),
    }));
    await page.mouse.up();
    await page.goBack(); await ready(page);
    const after = await capture(page, ring, "donut-after-return");
    if (proofDir) await writeFile(path.join(proofDir, "reproduction.json"), JSON.stringify({ before, down, after, focus }, null, 2));
    assert.ok(down.black <= before.black + 20,
        `Pointer down painted ${down.black - before.black} new black pixels over the navy donut: ${JSON.stringify(focus)}`);
    assert.equal(focus.ownerVisible, false);
    assert.match(focus.ownerOutline, / none /, "Pointer focus must not acquire the native SVG bounding-box outline");
    assert.equal(after.black, 0, "Returning to the donut leaves no stale black rectangle");
});

test("full-circle donut modifiers keep native destinations without a post-click rectangle", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await chooseTheme(page, "dark");
    const card = page.locator('[data-percentage-card="composition"]'), ring = card.locator(".percentage-ring");
    const face = ring.locator(".percentage-slice"), proxy = face.locator(".."), label = card.locator(".percentage-label");
    assert.equal(await face.getAttribute("data-count"), "11");
    assert.equal(await face.getAttribute("data-start"), "0"); assert.equal(await face.getAttribute("data-end"), "1");
    assert.equal(await proxy.getAttribute("href"), await label.getAttribute("href"));
    assert.equal(await proxy.getAttribute("tabindex"), "-1", "The visible semantic label is the single keyboard stop");
    const home = page.url(), before = await facts(page), point = await paintedPoint(face);
    await page.mouse.move(point.x, point.y);
    const hover = await capture(page, ring, "full-circle-hover");
    const clickPoint = await paintedPoint(face);
    await proxy.evaluate(node => node.addEventListener("click", event => {
        node.dataset.observedClick = JSON.stringify({ ctrl: event.ctrlKey, prevented: event.defaultPrevented });
    }, { once: true }));
    await page.keyboard.down("Control");
    try { await page.mouse.click(clickPoint.x, clickPoint.y); } finally { await page.keyboard.up("Control"); }
    assert.deepEqual(JSON.parse(await proxy.getAttribute("data-observed-click")), { ctrl: true, prevented: false },
        "Leave modified activation to the browser, not the app router");
    await proxy.evaluate(node => node.removeAttribute("data-observed-click"));
    assert.equal(page.url(), home, "Modified click does not replace the current reading view");
    assert.deepEqual(await facts(page), before);
    assert.deepEqual(await pointerFocus(proxy), { focused: true, visible: false, outline: "none" });
    const clicked = await capture(page, ring, "full-circle-modified-click");
    assert.ok(clicked.black <= hover.black + 20, "Focus retained after modified click does not leave the box");
    await page.mouse.move(1, 1); await proxy.evaluate(node => node.blur());
    await keyboardFocus(page, label);
    assert.ok(await card.locator(".percentage-face.percentage-active").count() > 0);
});
