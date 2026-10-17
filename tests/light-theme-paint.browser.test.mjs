import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { visualWidgetFixture } from "./visual-widget-fixture.mjs";
import { contrast, distance, hue, measureChartPaint } from "./color-measurements.mjs";

const proof = process.env.WIRE_LIGHT_PAINT_PROOFS;
const ready = async page => {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
};

test("screen outcome fades retain full-widget geometry, semantics and navigation in both themes", async t => {
    const cleanups = [];
    const { context } = await privateFixture({ after: cleanup => cleanups.push(cleanup) }, visualWidgetFixture().evidence);
    const before = await loadBoardState(context), errors = [], denied = [], measurements = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw new Error("No providers in paint proof"); },
            readSource: async () => { throw new Error("No source reads in paint proof"); } } });
    const browser = await chromium.launch();
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === new URL(runtime.url).origin) return route.continue();
        denied.push(route.request().url()); return route.abort();
    });
    if (proof) await mkdir(proof, { recursive: true });
    async function capture(name) {
        if (!proof) return;
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(proof, `${name}-page.png`), fullPage: true });
        await page.locator(".analyze-dashboard").screenshot({ path: path.join(proof, `${name}-widgets.png`) });
        await page.locator(".analyze-outcome-summary").screenshot({ path: path.join(proof, `${name}-outcomes.png`) });
    }
    await page.goto(runtime.url); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("247");
    let canonical, membership;
    for (const theme of ["light", "dark"]) {
        await page.goto(runtime.url); await ready(page);
        await chooseTheme(page, theme); await ready(page);
        for (const [name, width, scale] of [["normal", 1440, 100], ["narrow", 375, 100], ["large", 1440, 200], ["narrow-large", 375, 200]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => document.documentElement.style.fontSize = `${scale}%`, scale);
            await page.mouse.move(0, 0); await ready(page);
            const geometry = await page.locator("#outcomeChart .percentage-slice").evaluateAll(nodes => nodes.map(node => ({
                category: node.dataset.category, count: +node.dataset.count, fraction: +node.dataset.exactFraction,
                start: +node.dataset.start, end: +node.dataset.end, d: node.getAttribute("d"),
                href: node.parentElement.getAttribute("href"),
            })));
            canonical ??= geometry;
            assert.deepEqual(geometry, canonical, "Theme and text size cannot alter paths, counts or destinations");
            const rows = await page.locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
                category: node.dataset.category || node.dataset.serviceBasis, count: node.dataset.count,
                text: node.textContent, href: node.querySelector("a")?.getAttribute("href"),
                width: node.querySelector(".percentage-bar")?.style.width,
            })));
            membership ??= rows;
            assert.deepEqual(rows, membership, "Overlapping services, operations and tool memberships stay unchanged");
            assert.deepEqual(Object.fromEntries(geometry.map(row => [row.category, row.count])), { success: 212, failure: 33, unknown: 2 });
            for (const row of geometry) {
                assert.equal(row.fraction, row.count / 247);
                assert.ok(Math.abs(row.end - row.start - row.fraction) < 1e-14);
            }
            const marks = await page.evaluate(measureChartPaint, "#outcomeChart .percentage-slice,.flat-time-segment,.percentage-bar");
            for (const mark of marks) {
                assert.ok(mark.local && mark.gradient && mark.colors.length === 2);
                assert.equal(mark.opacity, 1);
                for (const color of mark.colors) assert.ok(contrast(color, mark.background) >= 3, JSON.stringify(mark));
            }
            for (const category of ["success", "failure"]) {
                const matching = marks.filter(mark => mark.category === category);
                assert.ok(matching.length > 1, "Ring and time columns share the same outcome paint");
                for (const mark of matching) assert.deepEqual(mark.colors, matching[0].colors);
                if (theme === "light") {
                    assert.ok(distance(...matching[0].colors) >= 13, `${category}: visible tonal range, not near-solid ink`);
                    assert.ok(contrast(matching[0].colors[0], "#ffffff") < 4, `${category}: restrained lighter face`);
                } else assert.deepEqual(matching[0].colors, category === "success"
                    ? ["rgb(131, 212, 148)", "rgb(82, 141, 94)"]
                    : ["rgb(242, 139, 130)", "rgb(190, 99, 92)"], "Accepted dark paint is unchanged");
            }
            const layout = await page.evaluate(() => ({
                overflow: document.documentElement.scrollWidth - innerWidth,
                clipped: [...document.querySelectorAll("#outcomeChart .percentage-label,#outcomeChart .percentage-value")]
                    .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
                filter: getComputedStyle(document.querySelector("#analyzePopulation")).backgroundColor,
            }));
            assert.ok(layout.overflow <= 1); assert.deepEqual(layout.clipped, []);
            if (theme === "light") assert.equal(layout.filter, "rgb(255, 255, 255)");
            measurements.push({ theme, name, geometry, marks, layout });
            await capture(`${theme}-${name}`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.removeProperty("font-size")); await ready(page);
        const label = page.locator('#outcomeChart [data-category="failure"] .percentage-label');
        const slice = page.locator('#outcomeChart .percentage-slice[data-category="failure"]');
        async function activePaint() {
            const paint = await slice.evaluate(node => {
                const css = getComputedStyle(node);
                return { fill: css.fill, filter: css.filter, path: node.getAttribute("d") };
            });
            if (theme === "light") {
                assert.match(paint.fill, /^url\(/, "Light hover/focus retains the local fade, not a flat red sector");
                assert.equal(paint.filter, "brightness(0.9)");
            } else {
                assert.equal(paint.fill, "rgb(242, 139, 130)");
                assert.equal(paint.filter, "none");
            }
            assert.equal(paint.path, canonical.find(row => row.category === "failure").d);
        }
        await label.hover();
        await expect(slice).toHaveClass(/percentage-active/);
        await activePaint();
        await capture(`${theme}-hover`);
        await page.mouse.move(0, 0); await label.focus();
        const focus = await label.evaluate(node => {
            const css = getComputedStyle(node);
            return { ink: css.color, ring: css.outlineColor, width: parseFloat(css.outlineWidth) };
        });
        assert.ok(focus.width >= 2);
        await activePaint();
        const background = theme === "light" ? "#ffffff" : "#222222";
        assert.ok(contrast(focus.ink, background) >= 4.5); assert.ok(contrast(focus.ring, background) >= 3);
        await capture(`${theme}-focus`);
        await page.keyboard.press("Enter"); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("33");
        await expect(page.locator("#outcomeChart .percentage-slice")).toHaveCount(1);
        await expect(page.locator("#outcomeChart .percentage-slice")).toHaveAttribute("data-exact-fraction", "1");
        await capture(`${theme}-selected`);
        await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("247");
        await page.locator("#outcomeFilter-control").click();
        const statuses = await page.locator(".select-popup .select-option").evaluateAll(nodes => nodes.map(node => {
            const cue = node.querySelector(".result-legend-icon");
            return { id: node.dataset.value, icon: cue.querySelector("svg").dataset.lucideIcon, color: getComputedStyle(cue).color };
        }));
        assert.deepEqual(statuses.map(row => row.icon), ["check", "circle-x", "circle-question-mark", "circle-dashed", "info", "unplug"]);
        assert.equal(statuses[1].color, statuses[5].color);
        assert.equal(new Set(statuses.slice(0, 5).map(row => row.color)).size, 5);
        assert.ok(hue(statuses[1].color) < 15);
        assert.ok(hue(statuses[0].color) > 100 && hue(statuses[0].color) < 150);
        await page.keyboard.press("Escape");
        measurements.push({ theme, statuses, focus });
        await page.getByRole("button", { name: "By path or operation", exact: true }).click(); await ready(page);
        const comparisons = await page.evaluate(measureChartPaint, ".flat-comparison-segment");
        assert.ok(comparisons.length > 0);
        for (const mark of comparisons) {
            assert.ok(mark.gradient && mark.colors.length === 2);
            if (["success", "failure"].includes(mark.category)) {
                for (const color of mark.colors) assert.ok(contrast(color, mark.background) >= 3, JSON.stringify(mark));
                const ring = measurements.find(row => row.theme === theme && row.name === "normal").marks
                    .find(row => row.category === mark.category);
                assert.deepEqual(mark.colors, [...ring.colors].reverse(), "CSS comparison bars reuse the SVG outcome stops");
            }
        }
        await capture(`${theme}-comparison`);
        await page.getByRole("button", { name: "Over time", exact: true }).click(); await ready(page);
        await selectActivityOption(page, "outcomeFilter", "partial"); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("0");
        await expect(page.locator("#outcomeChart .percentage-slice")).toHaveCount(0);
        if (proof) await page.screenshot({ path: path.join(proof, `${theme}-empty.png`), fullPage: true });
        await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    }
    await page.emulateMedia({ forcedColors: "active" });
    const label = page.locator('#outcomeChart [data-category="failure"] .percentage-label');
    await label.focus();
    const forced = await page.locator('#outcomeChart .percentage-slice[data-category="failure"]').evaluate(node => {
        const css = getComputedStyle(node);
        return { fill: css.fill, filter: css.filter };
    });
    assert.doesNotMatch(forced.fill, /^url\(/);
    assert.equal(forced.filter, "none", "System colors must not be dimmed by light-mode emphasis");
    if (proof) await writeFile(path.join(proof, "measurements.json"), JSON.stringify(measurements, null, 2));
});
