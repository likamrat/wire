import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

async function setup(t, { savedReports = true } = {}) {
    const { context } = await privateFixture(t, [fixture("layout-a"), fixture("layout-b")]);
    const controller = createExportController(context);
    for (let index = 0; index < (savedReports ? 6 : 0); index++) {
        const state = await loadBoardState(context), timeContext = { timeZone: "UTC", locale: "en-US" };
        const preview = await controller.preview("screen-layout-fixture", undefined, {
            title: index === 5 ? "Release review - calendar changes and document lookups across the planning exercise" : `Planning exercise ${index + 1}`,
            promptMode: "none", formats: ["html", "json", "markdown"], timeContext,
        }, { kind: "all", revision: state.revision });
        await controller.review("screen-layout-fixture", preview.previewId, true, timeContext);
        await controller.confirm("screen-layout-fixture", preview.previewId, true, timeContext);
    }
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1840, height: 2048 }, reducedMotion: "reduce", timezoneId: "UTC" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    return { page, url: runtime.url };
}

async function settle(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll("#main,#sidebar,#contextSidebar")]
        .every(node => node.getAnimations({ subtree: true }).every(animation => animation.playState !== "running")));
}

async function geometry(page) {
    return page.evaluate(() => {
        const box = node => {
            if (!node?.checkVisibility()) return null;
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom, center: y + height / 2 };
        };
        const rect = selector => box(document.querySelector(selector));
        const face = selector => {
            const node = document.querySelector(selector);
            if (!node?.checkVisibility()) return null;
            const bounds = box(node), css = getComputedStyle(node), before = getComputedStyle(node, "::before");
            const inset = before.content !== "none" && before.display !== "none";
            const top = inset ? parseFloat(before.top) : 0, bottom = inset ? parseFloat(before.bottom) : 0;
            const text = node.matches("input") ? node.value || node.placeholder : node.querySelector(".select-value")?.textContent;
            const canvas = document.createElement("canvas").getContext("2d");
            canvas.font = css.font;
            return { ...bounds, y: bounds.y + top, bottom: bounds.bottom - bottom, height: bounds.height - top - bottom,
                center: bounds.y + top + (bounds.height - top - bottom) / 2,
                font: css.font, ink: node.matches("input:placeholder-shown") ? getComputedStyle(node, "::placeholder").color : css.color,
                fill: inset ? before.backgroundColor : css.backgroundColor,
                text, textWidth: text ? canvas.measureText(text).width : 0,
                paddingLeft: parseFloat(css.paddingLeft), paddingRight: parseFloat(css.paddingRight) };
        };
        const controls = [...document.querySelectorAll("#periodComparisonSetup input,#periodComparisonSetup button,#reportTaskNav a,.saved-library-tools input,.saved-library-tools button")]
            .filter(node => node.checkVisibility()).map(node => ({ id: node.id, ...box(node), overflow: node.scrollWidth > node.clientWidth + 1 }));
        return {
            width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
            heading: rect("#workspace>.page-heading"), title: rect("#pageTitle"),
            population: rect("#analyzePopulation"), evidence: rect("#periodComparison"), library: rect("#bundles"),
            groups: [...document.querySelectorAll(".compare-period-key>p")].map(box),
            activity: face("#comparisonQuickChoice-control"), date: face("#comparisonDates"), filters: face("#openAnalyzeFilters"),
            search: face("#savedReportSearch"), order: face("#savedReportOrder-control"),
            searchIcon: rect(".saved-library-tools .wire-search-icon"), orderIcon: rect("#savedReportOrder-control .select-chevron"),
            controls,
        };
    });
}

async function paintCenters(page, layout) {
    const screenshot = await page.screenshot();
    return page.evaluate(async ({ image, search, order }) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(image), character => character.charCodeAt(0))], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const inkBounds = (bounds, left, right, ink) => {
            const rgb = ink.match(/[\d.]+/g).slice(0, 3).map(Number);
            let top = Infinity, bottom = -Infinity;
            for (let y = Math.ceil(bounds.y + 6); y < Math.floor(bounds.bottom - 6); y++) {
                for (let x = Math.ceil(left); x < Math.floor(right); x++) {
                    const offset = (y * bitmap.width + x) * 4;
                    if (Math.max(...rgb.map((value, index) => Math.abs(pixels[offset + index] - value))) < 35) {
                        top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
                    }
                }
            }
            ctx.font = bounds.font;
            const metrics = ctx.measureText(bounds.text);
            // Descenders differ between "reports" and "first"; compare real ink baselines, not their bounding-box midpoints.
            return { top, bottom, center: (top + bottom) / 2, baseline: top + metrics.actualBoundingBoxAscent };
        };
        return {
            search: inkBounds(search, search.x + search.paddingLeft, search.right - search.paddingRight, search.ink),
            order: inkBounds(order, order.x + order.paddingLeft, order.right - order.paddingRight - 24, order.ink),
        };
    }, { image: screenshot.toString("base64"), search: layout.search, order: layout.order });
}

test("Compare and Reports use coherent frames and genuinely aligned control paint", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t);
    const output = process.env.WIRE_TASK_LAYOUT_PROOFS;
    if (output) await mkdir(output, { recursive: true });
    const measurements = [], failures = [];
    const check = (condition, message) => { if (!condition) failures.push(message); };
    for (const theme of ["light", "dark"]) for (const [width, height, text, collapsed] of [
        [1840, 2048, 100, true], [1440, 1000, 100, false], [768, 1024, 100, true],
        [390, 844, 100, false], [1440, 1000, 200, true], [390, 844, 200, false],
    ]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(new URL("reports?task=library",url).href);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await chooseTheme(page, theme);
        if (await page.locator("#navigationCollapse").getAttribute("aria-expanded") === String(collapsed))
            await page.locator("#navigationCollapse").click();
        await settle(page);
        await page.setViewportSize({ width, height });
        await page.evaluate(text => { document.documentElement.style.fontSize = text + "%"; }, text);
        for (const screen of ["reports", "compare"]) {
            if (screen === "compare") {
                await page.goto(new URL("compare",url).href);
                await page.evaluate(text => { document.documentElement.style.fontSize = text + "%"; }, text);
                await expect(page.locator("#periodComparisonSetup")).toBeVisible();
                await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
            }
            await settle(page);
            await page.evaluate(() => scrollTo(0, 0));
            const name = `${screen}-${theme}-${width}-${text}-${collapsed ? "collapsed" : "expanded"}`;
            const layout = await geometry(page);
            if (screen === "reports") layout.paint = await paintCenters(page, layout);
            measurements.push({ name, ...layout });
            if (output) await page.screenshot({ path: path.join(output, name + ".png"), fullPage: true });
            check(!layout.overflow, name + ": no horizontal page overflow");
            check(layout.controls.every(control => control.height >= 44 && control.x >= 0 && control.right <= width + 1),
                name + ": all controls retain full, bounded targets");
            const frame = screen === "compare" ? layout.population : layout.library;
            check(Math.abs(layout.heading.x - frame.x) < 1 && Math.abs(layout.heading.width - frame.width) < 1,
                name + ": heading and content use the same measure");
            if (screen === "compare") {
                check(Math.abs(layout.evidence.width - frame.width) < 1, name + ": evidence boundary follows the task frame");
                check(Math.abs(layout.activity.height - layout.date.height) < 1, name + ": date/activity faces share a height");
                check([layout.date,layout.activity].every(face => contrast(face.ink,face.fill) >= 4.5), name + ": both menu labels contrast against their painted faces");
                if (width >= 1400 && text === 100) {
                    check(Math.abs(frame.right - layout.filters.right) < 1 && layout.filters.y >= layout.title.bottom, name + ": commands follow the title at the right edge");
                    check(Math.abs(layout.groups[0].width - layout.groups[1].width) < 1, name + ": equal period columns");
                }
            } else {
                check(layout.search.textWidth <= layout.search.width - layout.search.paddingLeft - layout.search.paddingRight - 2,
                    name + ": complete search placeholder remains readable");
                if (layout.search.x < layout.order.x && layout.order.y < layout.search.bottom) {
                    check(Math.abs(layout.search.center - layout.order.center) < 1, name + ": painted centers align");
                    check(Math.abs(layout.searchIcon.center - layout.orderIcon.center) < 1, name + ": icon centers align");
                    check(Number.isFinite(layout.paint.search.baseline) && Number.isFinite(layout.paint.order.baseline)
                        && Math.abs(layout.paint.search.baseline - layout.paint.order.baseline) <= 1, name + ": actual glyph paint baselines align");
                }
            }
        }
    }
    if (output) await writeFile(path.join(output, "geometry.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(failures, []);
});

for (const reducedMotion of ["reduce", "no-preference"]) test(`relocated Compare entries retain panel geometry, nested dismissal and real focus (${reducedMotion})`, { timeout: 30000 }, async t => {
    const { page, url } = await setup(t, { savedReports: false });
    await page.emulateMedia({ reducedMotion });
    await page.goto(url + "#analyze?compare=periods");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    for (const width of [1840, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await settle(page);
        const trigger = page.locator("#openAnalyzeFilters");
        await trigger.click();
        const dialog = page.locator("#analyzeFilterDialog");
        const timing = await dialog.evaluate(node => node.getAnimations()[0]?.effect.getTiming());
        assert.equal(timing?.duration, 320);
        assert.equal(timing?.easing, "cubic-bezier(0.2, 0, 0, 1)");
        await page.waitForFunction(() => !document.querySelector("#analyzeFilterDialog").getAnimations().length);
        const box = await dialog.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `Filters stays inside ${width}px after the title row wraps`);
        await page.locator("#toolFilter-control").click();
        await expect(page.locator(".select-popup:visible")).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(page.locator(".select-popup:visible")).toHaveCount(0);
        await expect(dialog).toBeVisible();
        await expect(page.locator("#toolFilter-control")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
        await expect(trigger).toBeFocused();
        const dates = page.locator("#comparisonCustomDates");
        const firstFrame = dates.evaluate(node => new Promise(resolve => {
            node.addEventListener("beforetoggle", () => requestAnimationFrame(() => {
                const box = node.getBoundingClientRect(); resolve({ left: box.left, right: box.right });
            }), {once:true});
        }));
        await page.locator("#comparisonDates").click();
        await expect(dates).toBeVisible();
        const menu = await firstFrame;
        assert.ok(menu.left >= 0 && menu.right <= width + 1, `Dates first frame at ${width}px: ${JSON.stringify(menu)}`);
        await page.keyboard.press("Escape");
        await expect(dates).not.toBeVisible();
        await expect(page.locator("#comparisonDates")).toBeFocused();
    }
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), reducedMotion === "reduce");
});
