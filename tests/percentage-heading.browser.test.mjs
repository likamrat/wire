import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { fixture, chooseTheme, selectActivityOption, automaticScoreOffSummary } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofDir = process.env.WORKIQ_HEADING_PROOFS;
const baseline = process.env.WORKIQ_HEADING_BASELINE;
const record = fixture("heading-proof");
record.userPrompt.text = "SYNTHETIC ONLY: percentage chart heading.";
record.followUpPrompts = [];
record.toolCalls = Array.from({ length: 223 }, (_, i) => {
    const endpoint = i < 180 ? "/me/messages" : "/me/calendar";
    return {
        ...record.toolCalls[0], toolCallId: `heading-call-${i}`, startEventId: `heading-start-${i}`,
        startedAt: "2026-09-30T12:00:00Z", requestedApiPath: endpoint, requestArgs: { entityUrls: [endpoint] },
        toolSucceeded: i < 195 ? true : i < 222 ? false : undefined,
        reportedOutcome: i < 195 ? "succeeded" : i < 222 ? "failed" : undefined,
    };
});
const collection = {
    state: "paused", revision: 1, configVersion: 1, connected: true,
    config: { approved: true, enabled: false, windowDays: 30, pollSeconds: 300,
        appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state" },
    lastCheckedAt: "2026-09-30T12:00:00Z", cadence: { pollSeconds: 300 }, metrics: {},
    discovery: { counts: { sessions: 1, dispositions: { eligible: 1 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
    historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, affected: 0, pending: 0 },
};
async function ready(page) {
    await page.waitForFunction(() => document.querySelector(".percentage-section") &&
        document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}
async function inspect(page) {
    return page.locator(".percentage-section").evaluate(root => {
        const box = node => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        return {
            total: +root.dataset.total, layer: root.dataset.layer,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            cards: [...root.querySelectorAll(".percentage-card")].map(card => {
                const heading = card.querySelector("h3"), unit = card.querySelector(".percentage-denominator");
                return {
                    heading: heading.textContent, unit: unit.textContent, inlineUnit: unit.parentElement === heading,
                    namedByHeading: card.getAttribute("aria-labelledby") === heading.id,
                    unitCount: heading.querySelectorAll(".percentage-denominator").length,
                    headingBox: box(heading), unitBox: box(unit), titleBox: box(heading.firstElementChild || heading),
                    headerBox: box(card.querySelector(".percentage-card-heading")), contentBox: box(card.querySelector(".percentage-content")),
                    unitColor: getComputedStyle(unit).color, background: getComputedStyle(card).backgroundColor,
                    unitRects: [...unit.getClientRects()].map(r => ({ x: r.x, right: r.right })),
                    caption: [...card.children].some(node => node.classList.contains("percentage-denominator")),
                    explanation: card.querySelector("details").textContent,
                    controls: [...card.querySelectorAll("button")].map(node => box(node)),
                };
            }),
            invariant: {
                rings: [...root.querySelectorAll(".percentage-ring")].map(node => node.outerHTML),
                legends: [...root.querySelectorAll(".percentage-legend")].map(node => node.outerHTML),
                materials: [...root.querySelectorAll(".percentage-face,stop,.percentage-glint,.percentage-rim")].map(node => {
                    const css = getComputedStyle(node);
                    return [css.fill, css.fillOpacity, css.stopColor, css.stroke, css.strokeOpacity, css.opacity, css.filter];
                }),
            },
        };
    });
}

test("percentage units share headings without an enlargement caption, preserving charts and responsive controls", { timeout: 90000 }, async t => {
    const variants = [];
    if (baseline) variants.push(["before", (await import(pathToFileURL(path.join(baseline, "lib", "render.mjs")))).renderHtmlShell]);
    variants.push(["after", renderHtmlShell]);
    const browser = await chromium.launch(), comparisons = new Map(), measurements = [];
    t.after(() => browser.close());
    if (proofDir) await mkdir(proofDir, { recursive: true });
    for (const [phase, render] of variants) {
        const context = await browser.newContext({ reducedMotion: "reduce", deviceScaleFactor: 1 });
        try {
            const page = await context.newPage(), errors = [], denied = [];
            let source = [record], revision = 1;
            page.on("pageerror", error => errors.push(error.message));
            await page.route("**/*", async route => {
                const request = route.request(), url = new URL(request.url());
                if (url.origin === "http://percentage-heading.test" && request.method() === "GET" && url.pathname === "/") {
                    return route.fulfill({ contentType: "text/html", body: render("a".repeat(64), "heading-proof") });
                }
                if (url.origin === "http://percentage-heading.test" && request.method() === "POST") {
                    if (url.pathname === "/api/snapshot") {
                        const analytics = { ...buildActivityAnalytics(source, request.postDataJSON()), revision };
                        return route.fulfill({ json: { revision, scenarios: source, exports: [], coverage: { notes: [] }, collection, analytics } });
                    }
                    if (url.pathname === "/api/evaluation/automatic/summary") return route.fulfill({ json: automaticScoreOffSummary() });
                }
                denied.push(`${request.method} ${request.url()}`);
                return route.abort("blockedbyclient");
            });
            for (const theme of ["light", "dark"]) for (const width of [1920, 375]) for (const scale of [1, 2]) {
                await page.setViewportSize({ width, height: 1100 });
                await page.goto(`http://percentage-heading.test/?fixture=${theme}-${width}-${scale}#home?chart=workload`);
                await ready(page); await chooseTheme(page, theme);
                await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
                await ready(page); await page.mouse.move(0, 0);
                const actual = await inspect(page), key = `${theme}-${width}-${scale}`;
                assert.equal(actual.total, 223);
                assert.equal(actual.overflow, false);
                if (phase === "before") comparisons.set(key, actual.invariant);
                else {
                    if (comparisons.has(key)) assert.deepEqual(actual.invariant, comparisons.get(key), "Exact chart paths, labels, links and computed materials stay unchanged");
                    for (const [i, card] of actual.cards.entries()) {
                        assert.equal(card.heading, `${i ? "Activity-category share" : "Recorded outcomes"} (Work IQ tool calls)`);
                        assert.equal(card.inlineUnit, true);
                        assert.equal(card.namedByHeading, true);
                        assert.equal(card.unitCount, 1);
                        assert.equal(card.caption, false);
                        assert.doesNotMatch(card.heading, /small slices/i);
                        assert.match(card.explanation, /Small slices are enlarged for visibility/);
                        assert.ok(contrast(card.unitColor, card.background) >= 4.5);
                        assert.ok(card.headerBox.bottom <= card.contentBox.y + 1);
                        assert.ok(card.unitRects.every(r => r.x >= card.headingBox.x - 1 && r.right <= card.headingBox.right + 1));
                        assert.ok(card.controls.every(r => r.height >= 44 && r.x >= card.headerBox.x - 1 && r.right <= card.headerBox.right + 1));
                        if (width === 1920 && scale === 1) {
                            assert.ok(card.unitBox.x >= card.titleBox.right, "Unit sits beside its title when there is room");
                            assert.ok(card.unitBox.y < card.titleBox.bottom);
                        }
                    }
                    if (width === 1920 && scale === 1) assert.equal(actual.cards[0].contentBox.y, actual.cards[1].contentBox.y, "Removing the fourth subgrid track retains aligned charts");
                }
                if (proofDir) {
                    await page.evaluate(() => window.scrollTo(0, 0));
                    const clip = await page.locator(".percentage-section").boundingBox();
                    await page.screenshot({ path: path.join(proofDir, `${phase}-${key}-charts.png`), clip, fullPage: true });
                    if (scale === 1) await page.screenshot({ path: path.join(proofDir, `${phase}-${key}-page.png`), fullPage: true });
                }
                measurements.push({ phase, theme, width, scale, ...actual, invariant: undefined });
            }
            if (phase === "after") {
                const composition = page.locator('[data-percentage-card=composition]');
                await composition.getByRole("button", { name: "Tool names", exact: true }).click();
                assert.equal(await composition.locator("h3").textContent(), "Tool-name share (Work IQ tool calls)");
                assert.equal(await composition.locator("h3 .percentage-denominator").count(), 1);
                await composition.getByRole("button", { name: "Activity categories", exact: true }).click();
                const results = createRecordedResults();
                for (const layer of results.layers) {
                    await selectActivityOption(page, "layerFilter", layer); await ready(page);
                    const current = await inspect(page), unit = results.unit(layer, current.total);
                    assert.ok(current.cards.every(card => card.unit === `(${unit})` && card.inlineUnit));
                    assert.equal(current.overflow, false);
                    for (const card of current.cards) {
                        assert.equal(card.namedByHeading, true);
                        assert.equal(card.unitCount, 1);
                        assert.ok(card.unitRects.every(r => r.x >= card.headingBox.x - 1 && r.right <= card.headingBox.right + 1));
                        assert.ok(card.headerBox.bottom <= card.contentBox.y + 1);
                        assert.ok(card.controls.every(r => r.height >= 44 && r.right <= card.headerBox.right + 1));
                    }
                    measurements.push({ phase: "unit", layer, theme: "dark", width: 375, scale: 2, ...current, invariant: undefined });
                    if (proofDir) {
                        await page.evaluate(() => window.scrollTo(0, 0));
                        const clip = await page.locator(".percentage-section").boundingBox();
                        await page.screenshot({ path: path.join(proofDir, `unit-${layer}-dark-375-2.png`), clip, fullPage: true });
                    }
                }
                await selectActivityOption(page, "layerFilter", "tool"); await ready(page);
                source = [{ ...record, toolCalls: record.toolCalls.slice(0, 1) }]; revision++;
                await page.reload(); await ready(page);
                assert.equal(await composition.locator("h3").textContent(), "Activity-category share (Work IQ tool call)");
                source = []; revision++;
                await page.reload(); await ready(page);
                assert.equal(await page.locator(".percentage-ring").count(), 0);
                assert.equal(await composition.locator("h3").textContent(), "Activity-category share (Work IQ tool calls)");
            }
            assert.deepEqual(errors, []);
            assert.deepEqual(denied, [], "Only synthetic read-only responses are allowed");
        } finally { await context.close(); }
    }
    if (proofDir) await writeFile(path.join(proofDir, "heading-measurements.json"), JSON.stringify(measurements, null, 2));
});
