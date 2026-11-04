import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { visualWidgetFixture } from "./visual-widget-fixture.mjs";
import { fixture, privateFixture, chooseTheme, setLegacyTimeBucket } from "./helpers.mjs";

const proof = process.env.WIRE_DASHBOARD_PACKING_PROOFS;
const baselineFile = process.env.WIRE_DASHBOARD_PACKING_BASE;
const widgetSelector = ".analyze-outcome-summary,.analyze-chart-main,#percentageCharts .percentage-card";

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
    const cards = [...root.querySelectorAll(".analyze-outcome-summary,.analyze-chart-main,#percentageCharts .percentage-card")]
        .filter(node => node.checkVisibility()).map(node => ({
            key: node.dataset.breakdown || (node.matches(".analyze-outcome-summary") ? "outcomes" : "time"),
            ...box(node), content: node.innerText, rowSpan: node.style.gridRowEnd,
        }));
    const bounds = box(root);
    const gaps = cards.map(card => {
        const above = cards.filter(other => Math.abs(card.x - other.x) < 1 && other.bottom <= card.y + .1);
        return { key: card.key, gap: card.y - Math.max(bounds.y, ...above.map(other => other.bottom)) };
    });
    const ring = root.querySelector(".percentage-ring"), legend = root.querySelector("#outcomeChart .percentage-legend");
    const text = [...root.querySelectorAll(".percentage-label,.percentage-value")].filter(node => node.checkVisibility());
    return { cards, bounds, gaps, ring: ring && box(ring), legend: legend && box(legend),
        count: document.querySelector("#activityCount").textContent,
        listY: box(document.querySelector("#activityListContext")).y,
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
        unusedArea: bounds.width * bounds.height - cards.reduce((sum, card) => sum + card.width * card.height, 0),
    };
}
function assertPacking(value, key) {
    assert.equal(value.fontLoaded, true, key);
    assert.ok(value.overflow <= 1, key);
    assert.deepEqual(value.clipped, [], key);
    for (const track of value.tracks) if (track.columns > 1) assert.ok(track.gap >= 8, "Inline labels, bars and values keep their horizontal separation");
    assert.deepEqual(value.cards.map(card => card.key), ["outcomes", "time", "models", "tools", "services"], "The compact Model summary precedes the longer breakdowns in DOM/reading order");
    for (const card of value.cards) for (const other of value.cards) if (card !== other) {
        assert.ok(card.right <= other.x + 1 || other.right <= card.x + 1 || card.bottom <= other.y + 1 || other.bottom <= card.y + 1,
            `${key}: ${card.key} and ${other.key} do not overlap`);
    }
    for (const { key: name, gap } of value.gaps) assert.ok(gap >= -.1 && gap <= 18,
        `${key}: ${name} follows the actual card above, not a taller neighboring row (${gap}px)`);
    assert.ok(value.listY >= Math.max(...value.cards.map(card => card.bottom)), `${key}: matching records follow all widgets`);
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
                assert.ok(value.bounds.height < before.bounds.height, `${value.key}: shorter total dashboard, not stretched cards`);
            }
        }
    }
});

test("packing survives accepted refresh, grouping, focus, repeated layout and empty views", async t => {
    const page = await setup(t, "reference");
    const cdp = await page.context().newCDPSession(page);
    const tree = await cdp.send("Accessibility.getFullAXTree");
    assert.ok(tree.nodes.some(node => !node.ignored && node.role?.value === "region"
        && node.name?.value === "Tool, service and model breakdowns"), "The shared breakdown region remains in the accessibility tree");
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
