import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";

const proofs = process.env.WORKIQ_CHOOSER_PROOFS;
const slice = "layer=tool&scope=all&from=2026-09-01&to=2026-10-05&range=custom&service=Calendar&result=success&project=test-project";
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t) {
    const records = Array.from({ length: 3 }, (_, index) => {
        const row = fixture(`chooser-${index}`);
        row.sourceSessionId = `chooser-chat-${index % 2}`;
        row.sourceSessionName = `Synthetic chooser chat ${index % 2}`;
        row.toolCalls[0].startedAt = index === 2 ? "2026-10-01T12:00:00Z" : "2026-09-20T12:00:00Z";
        return row;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ url: request.url(), method: request.method() }));
    await page.addInitScript(() => {
        const push = history.pushState;
        window.chooserPushes = 0;
        history.pushState = function (...args) { window.chooserPushes++; return push.apply(this, args); };
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(request => request.method !== "POST" || ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(new URL(request.url).pathname)), "Placement and navigation only read snapshots, status and versioned insight projections");
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#home?" + slice); await ready(page);
    return { page, runtime, requests };
}
async function measure(page) {
    return page.evaluate(() => {
        const box = node => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
        };
        const text = node => {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), rects = [];
            while (walker.nextNode()) {
                if (!walker.currentNode.textContent.trim() || getComputedStyle(walker.currentNode.parentElement).visibility === "hidden") continue;
                const range = document.createRange(); range.selectNodeContents(walker.currentNode);
                rects.push(...[...range.getClientRects()].filter(r => r.width).map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })));
            }
            return rects;
        };
        const summary = document.querySelector("#periodResult").parentElement, action = document.querySelector("#pageAction");
        const lines = [...summary.querySelectorAll("p")].flatMap(text), summaryBox = box(summary), chooser = box(action);
        return {
            summary: summaryBox, chooser, lines, label: text(action),
            sideBySide: chooser.y < summaryBox.bottom,
            horizontalGap: chooser.x - Math.max(...lines.map(r => r.right)),
            verticalGap: chooser.y - summaryBox.bottom,
            outcome: box(document.querySelector(".home-result-filter")),
            chart: box(document.querySelector(".chart-panel")),
            font: parseFloat(getComputedStyle(action).fontSize),
            decoration: getComputedStyle(action).textDecorationLine,
            overflow: document.documentElement.scrollWidth - innerWidth,
            viewport: innerWidth,
            summaryScroll: summary.scrollWidth - summary.clientWidth,
            feedback: box(document.querySelector("#periodFeedback")),
        };
    });
}
function assertPlacement(m, label) {
    assert.ok(m.overflow <= 1, `${label}: document overflow`);
    assert.ok(m.summaryScroll <= 1, `${label}: summary overflow`);
    assert.ok(m.chooser.height >= 44, `${label}: native target`);
    assert.ok(m.chooser.x >= m.feedback.x - 1 && m.chooser.right <= m.feedback.right + 1, `${label}: chooser inside its context`);
    assert.equal(m.decoration, "none", `${label}: pill is not underlined`);
    assert.ok(m.label.every(r => r.x >= m.chooser.x && r.right <= m.chooser.right + 1 && r.y >= m.chooser.y && r.bottom <= m.chooser.bottom + 1), `${label}: readable full label`);
    if (m.sideBySide) {
        assert.ok(Math.abs(m.chooser.x - m.summary.right - 20) <= 1, `${label}: adjacent content-sized group`);
        assert.ok(m.horizontalGap <= 20 + m.font * 6, `${label}: no large blank span after text`);
    } else {
        assert.ok(Math.abs(m.chooser.x - m.summary.x) <= 1, `${label}: stacked left alignment`);
        assert.ok(Math.abs(m.verticalGap - 12) <= 1, `${label}: compact stacked spacing`);
    }
    assert.ok(m.outcome.x >= m.feedback.x - 1 && m.outcome.right <= m.feedback.right + 1, `${label}: result field fits the shared filter region`);
    assert.ok(m.outcome.bottom <= m.feedback.y, `${label}: result filtering precedes the applied summary and chooser`);
}

test("chooser stays beside applied copy rather than growing across full-width charts", { timeout: 90000 }, async t => {
    const { page, runtime } = await setup(t), measurements = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.evaluate(() => {
        document.querySelector("#periodFeedback").style.justifyContent = "space-between";
        const summary = document.querySelector("#periodResult").parentElement;
        summary.style.flex = "1 1 300px";
        summary.style.maxWidth = "none";
    });
    const before = await measure(page);
    assert.ok(before.horizontalGap > 400, "Regression fixture reproduces the detached wide chooser");
    if (proofs) await page.screenshot({ path: path.join(proofs, "before-wide.png"), fullPage: true });
    await page.evaluate(() => {
        document.querySelector("#periodFeedback").style.removeProperty("justify-content");
        const summary = document.querySelector("#periodResult").parentElement;
        summary.style.removeProperty("flex");
        summary.style.removeProperty("max-width");
    });
    const after = await measure(page);
    assertPlacement(after, "wide after");
    assert.equal(after.chart.width, before.chart.width, "Grouping cannot shrink the main/chart width budget");
    assert.equal(after.outcome.width, before.outcome.width, "Outcome filter width stays independent");
    assert.equal(after.lines.length, before.lines.length, "Grouping does not add lines to the applied custom-date copy");
    if (proofs) await page.screenshot({ path: path.join(proofs, "after-wide.png"), fullPage: true });
    await page.goto(runtime.url + "#home?scope=all"); await ready(page);
    assert.equal(new Set((await measure(page)).lines.map(line => Math.round(line.y))).size, 2, "Ordinary desktop count and period remain two visual lines");
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 1600, 2000, 2560, 3440]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const m = await measure(page), label = `${theme}/${width}/${scale}`;
        assertPlacement(m, label);
        assert.ok(m.font >= 14 * scale, `${label}: approved Fluent control role never shrinks to fit`);
        measurements.push({ theme, width, rootTextScale: scale, ...m });
        if (proofs && [375, 820, 1600, 2560].includes(width)) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `chooser-${theme}-${width}-${scale}.png`), fullPage: true });
        }
    }
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width: 2560, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => {
            document.documentElement.style.fontSize = `${scale * 100}%`;
            document.querySelector("#workspace").style.width = "343px";
            document.querySelector("#periodResult").textContent = "123,456 Copilot chats / 987,654 request groups with 9,876,543 Work IQ tool calls.";
            document.querySelector("#periodHint").textContent = "A deliberately long applied scope with a synthetic unbroken identifier " + "Scope".repeat(40);
        }, scale);
        const m = await measure(page);
        assertPlacement(m, `narrow container/${theme}/${scale}`);
        assert.equal(m.sideBySide, false, "Container width, not a wide-host breakpoint, determines stacking");
        measurements.push({ theme, width: 2560, panelWidth: 343, rootTextScale: scale, ...m });
    }
    if (proofs) await writeFile(path.join(proofs, "placement-matrix.json"), JSON.stringify({ before, after, measurements }, null, 2));
});

test("native chooser placement preserves scope, one activation, Back, private search and polling focus", { timeout: 60000 }, async t => {
    const { page, runtime, requests } = await setup(t), home = page.url();
    for (const width of [1600, 375]) for (const activation of ["padding", "keyboard"]) {
        await page.setViewportSize({ width, height: 1100 });
        const chooser = page.locator("#pageAction"), expected = await chooser.getAttribute("href");
        assert.equal(await page.getByRole("link", { name: "Choose a Copilot chat", exact: true }).count(), 1);
        const pushes = await page.evaluate(() => window.chooserPushes);
        if (activation === "padding") {
            await chooser.scrollIntoViewIfNeeded();
            const point = await chooser.evaluate(node => {
                const r = node.getBoundingClientRect(), x = r.left + 5, y = r.top + r.height / 2;
                return { x, y, hit: document.elementFromPoint(x, y) === node };
            });
            assert.equal(point.hit, true);
            await page.mouse.click(point.x, point.y);
        } else {
            await page.locator("#main").focus();
            const stops = [];
            while (!await chooser.evaluate(node => node === document.activeElement) && stops.length < 40) {
                await page.keyboard.press("Tab");
                stops.push(await page.evaluate(() => document.activeElement.id));
            }
            assert.ok(stops.includes("applyDates") && stops.at(-1) === "pageAction", "Chooser follows period controls in natural Tab order");
            assert.equal(await chooser.evaluate(node => node.matches(":focus-visible") && parseFloat(getComputedStyle(node).outlineWidth) >= 2), true);
            await page.keyboard.press("Enter");
        }
        await ready(page);
        assert.equal(new URL(page.url()).hash, expected);
        assert.equal(await page.evaluate(() => window.chooserPushes), pushes + 1);
        for (const [key, value] of new URLSearchParams(slice)) assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get(key), value);
        assert.equal(await page.locator("#periodActions").isVisible(), false, "Shared Activity summary has no empty chooser row");
        await page.goBack(); await ready(page);
        assert.equal(page.url(), home);
        assert.equal(await page.locator("#fromFilter").inputValue(), "2026-09-01");
        assert.equal(await page.locator("#toFilter").inputValue(), "2026-10-05");
    }
    await page.locator("#pageAction").click(); await ready(page);
    await page.locator("#activitySearch").fill("Synthetic chooser chat 0");
    await navigateMain(page, "home"); await ready(page);
    await page.locator("#pageAction").focus();
    const stable = await page.evaluate(() => {
        window.chooserNode = document.querySelector("#pageAction");
        return { scroll: scrollY, summary: document.querySelector("#periodResult").innerText };
    });
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    assert.deepEqual(await page.evaluate(() => ({
        same: window.chooserNode === document.querySelector("#pageAction"),
        focus: document.activeElement === window.chooserNode,
        scroll: scrollY, summary: document.querySelector("#periodResult").innerText,
    })), { same: true, focus: true, ...stable });
    await page.keyboard.press("Enter"); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), "Synthetic chooser chat 0");
    await page.goBack(); await ready(page);
    assert.ok(requests.every(request => !decodeURIComponent(request.url).includes("Synthetic chooser chat")));
    assert.equal(new URL(page.url()).origin, new URL(runtime.url).origin);
});

test("pending, failed and empty periods use existing chooser guards without leaving orphan space", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    let release, entered;
    const hold = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { entered = resolve; });
    await page.route("**/api/snapshot", async route => { entered(); await hold; await route.continue(); }, { times: 1 });
    t.after(() => release());
    await page.locator("#fromFilter").fill("2026-10-01");
    await page.locator("#applyDates").click(); await requested;
    assert.equal(await page.locator("#pageAction").getAttribute("aria-disabled"), "true");
    const pendingUrl = page.url();
    await page.locator("#pageAction").evaluate(node => node.click());
    assert.equal(page.url(), pendingUrl, "Disabled native navigation cannot use stale scope");
    release(); await ready(page);
    assert.equal(await page.locator("#periodResult").innerText(), "1 Work IQ tool call (Oct 1 - Oct 5, 2026)");
    assert.equal(await page.locator("#applyDates").evaluate(node => node === document.activeElement), true);
    assertPlacement(await measure(page), "accepted period");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 500, json: { error: "Synthetic chooser scope failed." } }), { times: 1 });
    await page.locator("#fromFilter").fill("2026-09-01");
    await page.locator("#applyDates").click(); await ready(page);
    assert.match(await page.locator("#periodResult").innerText(), /^Previous results:/);
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    assert.equal(await page.locator("#periodActions").isVisible(), false);
    await page.locator("#fromFilter").fill("2027-01-01");
    await page.locator("#toFilter").fill("2027-01-01");
    await page.locator("#applyDates").click(); await ready(page);
    assert.equal(await page.locator("#periodResult").innerText(), "0 Work IQ tool calls (Jan 1, 2027)");
    assert.equal(await page.locator("#periodActions").isVisible(), false);
});
