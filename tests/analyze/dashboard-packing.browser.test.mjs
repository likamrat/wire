import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { visualWidgetFixture } from "../appearance/visual-widget-fixture.mjs";
import { fixture, privateFixture, chooseTheme, setLegacyTimeBucket, navigateMain, navigateSettings } from "../support/helpers.mjs";
import { usagePreview } from "./usage-preview-fixture.mjs";

const proof = process.env.WIRE_DASHBOARD_PACKING_PROOFS;
const baselineFile = process.env.WIRE_DASHBOARD_PACKING_BASE;
const widgetSelector = ".analyze-outcome-summary,.analyze-chart-main,#analyzeUsage,#percentageCharts .percentage-card";

function records(kind) {
    if (kind === "zero") return [];
    const source = kind === "sparse" ? [fixture("packing-single")] : visualWidgetFixture().evidence;
    for (const [index, record] of source.entries()) {
        record.userPrompt.sourceEventId ||= `packing-prompt-${index}`;
        const model = kind === "long" ? `deployment/coastal-research-${"long-recorded-name-".repeat(8)}${index % 4}`
            : kind === "dense" ? `deployment/coastal-model-${index % 12}`
                : ["gpt-6-astra", "gpt-5.6-sol", "gpt-6.1-sol"][index % 3];
        record.originalModelEvidence = {
            version: 1, sourceSessionId: record.sourceSessionId, promptEventId: record.userPrompt.sourceEventId,
            promptMessageId: `packing-message-${index}`, partial: false, ambiguous: false,
            responses: [{ eventId: `packing-response-${index}`, apiCallId: `packing-api-${index}`,
                at: record.capturedAt, turnId: `packing-turn-${index}`, model, modelStatus: "recorded" }],
        };
    }
    return source;
}
async function settle(page) {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.playState !== "running" || animation.effect.getComputedTiming().iterations === Infinity));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function setup(t, kind) {
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, records(kind));
    const stored = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw new Error("No providers in dashboard layout proof"); },
            readSource: async () => { throw new Error("No source reads in dashboard layout proof"); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: "en-US", timezoneId: "UTC" });
    const errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], stored[key], key);
        } finally { for (const action of cleanup.reverse()) await action(); }
    });
    await page.goto(runtime.url); await settle(page);
    return page;
}
function geometry() {
    const root = document.querySelector(".analyze-dashboard");
    const box = node => node.getBoundingClientRect().toJSON();
    const cards = [...root.querySelectorAll(".analyze-outcome-summary,.analyze-chart-main,#analyzeUsage,#percentageCharts .percentage-card")]
        .filter(node => node.checkVisibility()).map(node => ({
            key: node.dataset.breakdown || (node.matches(".analyze-outcome-summary") ? "outcomes" : "time"),
            ...box(node), content: node.innerText, rowSpan: node.style.gridRowEnd,
        }));
    const bounds = box(root), list = box(document.querySelector("#activityView"));
    const sections = [...cards, { key: "interactions", ...list }];
    const gaps = sections.map(card => {
        const above = sections.filter(other => other.x < card.right && other.right > card.x && other.bottom <= card.y + .1);
        return { key: card.key, gap: card.y - Math.max(bounds.y, ...above.map(other => other.bottom)) };
    });
    const ring = root.querySelector(".percentage-ring"), legend = root.querySelector("#outcomeChart .percentage-legend");
    const text = [...root.querySelectorAll(".percentage-label,.percentage-value")].filter(node => node.checkVisibility());
    const readings = [...root.querySelectorAll("#percentageCharts .percentage-tool-list")].map(list => ({
        card: list.closest(".percentage-card").dataset.breakdown, width: list.clientWidth,
        rows: [...list.children].map(row => ({
            row: box(row), label: box(row.querySelector(".percentage-label")),
            value: box(row.querySelector(".percentage-value")), track: box(row.querySelector(".percentage-bar-track")),
        })),
    }));
    const widgetHeight = bounds.height - list.height - parseFloat(getComputedStyle(root).columnGap);
    return { cards, bounds, gaps, list, readings, rem:parseFloat(getComputedStyle(document.documentElement).fontSize), widgetHeight, ring: ring && box(ring), legend: legend && box(legend),
        count: document.querySelector("#activityCount").textContent,
        fontLoaded: document.fonts.check('600 30px "Asta Sans"'),
        typography: text.map(node => {
            const css = getComputedStyle(node);
            return { text: node.textContent, font: css.fontFamily, size: css.fontSize, weight: css.fontWeight };
        }),
        tracks: [...root.querySelectorAll("#percentageCharts .percentage-legend")].map(node => {
            const css = getComputedStyle(node);
            return { columns: css.gridTemplateColumns.split(" ").length, gap: parseFloat(css.columnGap) };
        }),
        clipped: text.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
        overflow: document.documentElement.scrollWidth - innerWidth,
        unusedArea: bounds.width * widgetHeight - cards.reduce((sum, card) => sum + card.width * card.height, 0),
    };
}
function assertPacking(value, key) {
    assert.equal(value.fontLoaded, true, key);
    assert.ok(value.overflow <= 1, key);
    assert.deepEqual(value.clipped, [], key);
    for (const {card,width,rows} of value.readings) {
        const paired = width >= 36 * value.rem && card !== "authors" && rows.length >= 4;
        for (let i=0; i<rows.length; i++) {
            const {row,label,value:amount,track}=rows[i];
            if (paired) {
                if (i%2) {
                    assert.ok(Math.abs(row.top-rows[i-1].row.top)<1 && row.left>=rows[i-1].row.right,`${key}/${card}: adjacent ranks share a row`);
                    assert.ok(Math.abs(track.width-rows[i-1].track.width)<1,`${key}/${card}: both bars use equal track widths`);
                }
                assert.ok(track.top>=Math.max(label.bottom,amount.bottom)-1 && amount.left-label.right<=9,`${key}/${card}: bar below its adjacent name and value`);
            } else if (i) assert.ok(row.top>=rows[i-1].row.bottom-1,`${key}/${card}: single list`);
        }
    }
    for (const track of value.tracks) if (track.columns > 1) assert.ok(track.gap >= 8, "Inline labels, bars and values keep their horizontal separation");
    assert.deepEqual(value.cards.map(card => card.key), ["time", "outcomes", "usage", "tools", "services", "models", "authors"]);
    for (const card of value.cards) for (const other of value.cards) if (card !== other) {
        assert.ok(card.right <= other.x + 1 || other.right <= card.x + 1 || card.bottom <= other.y + 1 || other.bottom <= card.y + 1,
            `${key}: ${card.key} and ${other.key} do not overlap`);
    }
    for (const { key: name, gap } of value.gaps) assert.ok(gap >= -.1 && gap <= 18,
        `${key}: ${name} follows the actual card above, not a taller neighboring row (${gap}px)`);
    for (const card of value.cards) assert.ok(["time","outcomes","usage"].includes(card.key)
        ? card.bottom <= value.list.top : card.top >= value.list.bottom, `${key}: Interactions separates the charts from the breakdowns`);
}

test("whole dashboard packs sparse, populated and long-label widgets without reserved empty bands", async () => {
    const measurements = [], reference = baselineFile ? JSON.parse(await readFile(baselineFile, "utf8")) : [];
    if (proof) await mkdir(proof, { recursive: true });
    for (const kind of ["sparse", "reference", "dense", "long"]) {
        const cleanup = [];
        try {
            const page = await setup({ after: action => cleanup.push(action) }, kind);
            let original;
            const views = kind === "reference" ? [[1920, 100], [1440, 100], [1388, 100], [375, 100]]
                : kind === "long" ? [[1440, 100], [375, 200]] : [[1440, 100]];
            for (const theme of ["light", "dark"]) for (const [width, scale] of views) {
                await page.setViewportSize({ width, height: 1100 }); await chooseTheme(page, theme);
                await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; scrollTo(0, 0); }, scale);
                await settle(page);
                const key = `${kind}-${theme}-${width}-${scale}`, value = await page.evaluate(geometry);
                const content = value.cards.map(({ key, content }) => ({ key, content }));
                original ??= content;
                assert.deepEqual(content, original, `${key}: layout changes neither content nor counts`);
                measurements.push({ key, kind, theme, width, scale, ...value });
                if (proof) {
                    await page.screenshot({ path: path.join(proof, `${key}-context.png`), fullPage: true });
                    await page.locator(".analyze-dashboard").screenshot({ path: path.join(proof, `${key}-dashboard.png`) });
                }
            }
        } finally { for (const action of cleanup.reverse()) await action(); }
    }
    if (proof) await writeFile(path.join(proof, "geometry.json"), JSON.stringify(measurements, null, 2));
    for (const value of measurements) {
        assertPacking(value, value.key);
        const before = reference.find(row => row.key === value.key);
        if (before) {
            const byKey = rows => rows.map(({ key, content }) => ({ key, content })).sort((a, b) => a.key.localeCompare(b.key));
            const byText = rows => rows.slice().sort((a, b) => a.text.localeCompare(b.text));
            assert.deepEqual(byKey(value.cards), byKey(before.cards), "Packing preserves all widget content");
            assert.deepEqual(byText(value.typography), byText(before.typography), "Packing does not shrink or restyle the data");
        }
        if (value.width >= 1440 && value.scale === 100) assert.ok(value.legend.x >= value.ring.right + 15, value.key);
        if (value.kind === "reference" && value.width >= 1440) {
            if (before) {
                assert.ok(value.unusedArea < before.unusedArea * .6, `${value.key}: remove at least 40% of unused dashboard area`);
                assert.ok(value.widgetHeight < (before.widgetHeight ?? before.bounds.height), `${value.key}: shorter widget area, not stretched cards`);
            }
        }
    }
});

test("packing survives accepted refresh, grouping, focus, repeated layout and empty views", async t => {
    const page = await setup(t, "reference");
    const cdp = await page.context().newCDPSession(page);
    const tree = await cdp.send("Accessibility.getFullAXTree");
    assert.ok(tree.nodes.some(node => !node.ignored && node.role?.value === "region"
        && node.name?.value === "Tool, service, model and prompt breakdowns"), "The shared breakdown region remains in the accessibility tree");
    const first = page.locator("#outcomeChart .percentage-label").first();
    await first.focus();
    const identity = await page.locator(widgetSelector).elementHandles();
    const before = await page.evaluate(geometry);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
    }, { times: 1 });
    const regroup = setLegacyTimeBucket(page, "month");
    let pending;
    try {
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        pending = await page.evaluate(geometry);
        assert.equal(pending.count, before.count, "Pending refresh keeps the accepted count");
        assertPacking(pending, "pending refresh");
    } finally { release(); await regroup; }
    await settle(page);
    const grouped = await page.evaluate(geometry);
    assert.equal(grouped.count, before.count);
    assertPacking(grouped, "grouped");
    for (const [index, original] of identity.entries()) {
        assert.equal(await page.locator(widgetSelector).nth(index).evaluate((node, original) => node === original, original), true);
    }
    await page.evaluate(() => {
        window.packingMutations = [];
        window.packingObserver = new MutationObserver(changes => window.packingMutations.push(...changes.map(change => change.attributeName)));
        window.packingObserver.observe(document.querySelector(".analyze-dashboard"), { attributes: true, subtree: true, attributeFilter: ["style"] });
    });
    await page.evaluate(() => new Promise(resolve => {
        let frames = 0; const sample = () => ++frames === 8 ? resolve() : requestAnimationFrame(sample); sample();
    }));
    assert.deepEqual(await page.evaluate(() => { window.packingObserver.disconnect(); return window.packingMutations; }), [],
        "Settled packing does not oscillate or rewrite unchanged spans");
    if (proof) await writeFile(path.join(proof, "refresh-geometry.json"), JSON.stringify({ before, pending, grouped }, null, 2));
    const empty = await setup(t, "zero");
    await expect(empty.locator(".analyze-dashboard")).not.toBeVisible();
    await expect(empty.locator("#activityCount")).toHaveText("0");
});

test("mixed tall breakdowns reflow without transient overlap or perpetual span writes", async t => {
    const page = await setup(t, "long");
    await page.setViewportSize({ width: 1920, height: 1100 }); await settle(page);
    await page.evaluate(() => {
        window.collapseFrames = [];
        let remaining = 90;
        function sample() {
            const cards = [...document.querySelectorAll(".analyze-widget")].map(node => node.getBoundingClientRect());
            window.collapseFrames.push(cards.some((a, i) => cards.slice(i + 1).some(b =>
                Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)));
            if (--remaining) requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
    });
    for (const key of ["models", "services", "time", "models", "services", "time", "authors", "authors"]) {
        await page.locator(`#analyzeCollapse-${key}`).click(); await settle(page);
        assertPacking(await page.evaluate(geometry), `after ${key}`);
    }
    assert.ok((await page.evaluate(() => window.collapseFrames)).every(overlap => !overlap), "No overlapping cards during sampled reflow frames");
    if (proof) await writeFile(path.join(proof, "collapse-frames.json"), JSON.stringify(await page.evaluate(() => window.collapseFrames)));
});

for (const frontend of ["bundled", "react"]) test(`${frontend}: every Analyze widget collapses in place without hidden focus or uneven gutters`, async t => {
    const cleanup = [], errors = [], samples = [];
    t.after(async () => { for (const close of cleanup.reverse()) await close(); assert.deepEqual(errors, []); });
    const { runtime } = await usagePreview({ after: close => cleanup.push(close) }, frontend, { paginated: true });
    const browser = await chromium.launch(); cleanup.push(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url); await settle(page);
    const keys = ["time", "outcomes", "usage", "interactions", "tools", "services", "models", "authors"];
    const control = key => page.locator(`#analyzeCollapse-${key}`);
    await expect(page.locator(".analyze-widget-toggle:visible")).toHaveCount(keys.length);
    const original = await page.locator("#activityList article").allTextContents();
    const toolbar = page.locator("#analyzeToolbar"), bulk = toolbar.locator("#analyzeToggleAll");
    for (const [width, scale] of [[1600, 1], [390, 1], [900, 2]]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await control("usage").click();
        await expect(bulk).toHaveAccessibleName("Collapse all");
        const prefs = await page.evaluate(() => JSON.stringify(localStorage));
        await bulk.press("Enter");
        await expect(page.locator(".analyze-widget-toggle[aria-expanded=false]:visible")).toHaveCount(8);
        await expect(bulk).toBeFocused(); await expect(bulk).toHaveAccessibleName("Expand all");
        await control("time").click(); await expect(bulk).toHaveAccessibleName("Collapse all");
        await control("time").click(); await expect(bulk).toHaveAccessibleName("Expand all");
        await bulk.click(); await expect(page.locator(".analyze-widget-toggle[aria-expanded=true]:visible")).toHaveCount(8);
        assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), prefs);
        assert.ok(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        assert.ok(await page.locator("#analyzeResultScope").evaluate(node => node.clientWidth >= Math.min(180, node.parentElement.clientWidth)),
            "The toolbar wraps before squeezing the scope caption into individual letters");
        if (proof) {
            await mkdir(proof, { recursive: true });
            await bulk.hover(); await page.screenshot({ path: path.join(proof, `${frontend}-${width}-collapse-all.png`) });
        }
    }
    const layout = () => page.locator(".analyze-widget").evaluateAll(nodes => {
        const cards = nodes.filter(node => node.checkVisibility()).map(node => ({ key: node.querySelector(".analyze-widget-toggle").id,
            ...node.getBoundingClientRect().toJSON() }));
        return cards.map(card => {
            const above = cards.filter(other => other !== card && other.left < card.right - 1 && other.right > card.left + 1 && other.bottom <= card.top + .1);
            return { ...card, gap: above.length ? card.top - Math.max(...above.map(other => other.bottom)) : null,
                overlap: cards.some(other => other !== card && Math.min(card.right, other.right) - Math.max(card.left, other.left) > 1
                    && Math.min(card.bottom, other.bottom) - Math.max(card.top, other.top) > 1) };
        });
    });
    function assertGutters(cards) {
        for (const card of cards) {
            assert.equal(card.overlap, false, `${card.key}: no overlap`);
            if (card.gap !== null) assert.ok(card.gap >= 15.5 && card.gap <= 17.5,
                `${card.key}: actual card gap is ${card.gap}px`);
        }
    }
    for (const [width, scale, theme] of [[1600, 1, "light"], [390, 1, "dark"], [900, 2, "light"]]) {
        await page.setViewportSize({ width, height: 1100 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        for (const key of keys) {
            const button = control(key);
            await button.scrollIntoViewIfNeeded();
            const before = await button.boundingBox(), preferences = await page.evaluate(() => JSON.stringify(localStorage));
            const originalScroll = await page.evaluate(() => scrollY);
            await button.press("Enter"); await expect(button).toHaveAttribute("aria-expanded", "false");
            await expect(button).toBeFocused();
            const hidden = await button.evaluate(node => node.getAttribute("aria-controls").split(" ").map(id => {
                const body = document.getElementById(id); return { hidden: !body.checkVisibility(), inert: body.inert };
            }));
            assert.ok(hidden.length > 0 && hidden.every(body => body.hidden && body.inert), `${key}: every controlled body is hidden and inert`);
            await settle(page);
            const after = await button.boundingBox();
            const clamped = await page.evaluate(original => Math.max(0, original - Math.max(0, document.documentElement.scrollHeight - innerHeight)), originalScroll);
            assert.ok(Math.abs(after.y - before.y - clamped) <= 1,
                `${key}: activating header moved ${after.y - before.y}px with ${clamped}px required by the page's new end`);
            assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), preferences, "Collapse never creates or changes saved preferences");
            await button.press("Space"); await expect(button).toHaveAttribute("aria-expanded", "true");
            await expect(button).toBeFocused(); await settle(page);
        }
        for (const closed of [["time", "usage"], ["outcomes", "services", "authors"], ["interactions", "models", "tools"]]) {
            for (const key of closed) await control(key).click();
            await settle(page);
            const value = await layout(); samples.push({ frontend, width, scale, closed, cards: value });
            assertGutters(value);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            if (proof && closed.includes("interactions") && scale === 1) {
                await mkdir(proof, { recursive: true });
                await page.screenshot({ path: path.join(proof, `${frontend}-${width}-${closed.join("-")}-collapsed.png`), fullPage: true });
            }
            for (const key of closed) await control(key).click();
        }
    }
    assert.deepEqual(await page.locator("#activityList article").allTextContents(), original, "No card, reading or report action is removed by collapse");
    await page.setViewportSize({ width: 1600, height: 1100 }); await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    const slider = page.locator("#analyzeUsage .usage-date-slider");
    await slider.press("End");
    const selected = await slider.getAttribute("aria-valuetext"), index = await slider.inputValue();
    await control("usage").click(); await navigateMain(page, "settings"); await navigateSettings(page, "analyze");
    await page.locator('#analyzeLayout [data-section="models"] [data-step="-1"]').click();
    await page.getByRole("link", { name: "View Analyze", exact: true }).click(); await settle(page);
    await expect(control("usage")).toHaveAttribute("aria-expanded", "false");
    assertGutters(await layout());
    await control("usage").click();
    await expect(slider).toHaveValue(index); await expect(slider).toHaveAttribute("aria-valuetext", selected);
    await slider.press("Home"); await expect(slider).toHaveValue("0");
    const custom = await layout(); samples.push({ frontend, custom });
    assertGutters(custom);
    await control("usage").click(); await page.reload(); await settle(page);
    await expect(page.locator(".analyze-widget-toggle[aria-expanded=true]:visible")).toHaveCount(8);
    if (proof) await writeFile(path.join(proof, `${frontend}-collapse-geometry.json`), JSON.stringify(samples, null, 2));
});
