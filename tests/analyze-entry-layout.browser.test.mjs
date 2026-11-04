import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { chooseTheme, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

async function setup(t, { nativeZoom = false } = {}) {
    const app = await authorFilterFixture(t, { serviceCases: true });
    const errors = [], denied = [], reads = [];
    const profile = nativeZoom ? await mkdtemp(path.join(os.tmpdir(), "wire-entry-zoom-")) : null;
    const browser = nativeZoom ? await chromium.launchPersistentContext(profile, {
        channel: "chrome", headless: true, viewport: null, reducedMotion: "reduce", args: ["--window-size=1440,1000"],
    }) : await chromium.launch();
    app.closeClient(async () => {
        await browser.close();
        if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    });
    const page = nativeZoom ? await browser.newPage()
        : await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
    let unzoomed;
    if (nativeZoom) {
        unzoomed = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }));
        await page.goto("chrome://settings/appearance");
        await page.locator("select#zoomLevel").selectOption("2");
    }
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list", "/api/period-comparison"];
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(url.pathname);
            return route.abort();
        }
        if (url.pathname === "/api/snapshot" || url.pathname === "/api/period-comparison") reads.push(url.pathname);
        return route.continue();
    });
    await page.goto(app.runtime.url);
    await ready(page);
    return { ...app, page, reads, unzoomed };
}

async function geometry(page, compare = false) {
    return page.evaluate(compare => {
        const box = node => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const guide = document.getElementById("openChartReference"), filters = document.getElementById("openAnalyzeFilters");
        const control = node => {
            const bounds = box(node), face = getComputedStyle(node, "::before"), style = getComputedStyle(node);
            const icon = node.querySelector(".wire-icon"), label = node.querySelector(".analyze-entry-label");
            return { ...bounds, font: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
                paintTop: face.content === "none" ? 0 : parseFloat(face.top),
                paintBottom: face.content === "none" ? 0 : parseFloat(face.bottom),
                overflow: node.scrollWidth - node.clientWidth,
                icon: icon ? box(icon) : null, label: label ? box(label) : null };
        };
        const anchor = document.querySelector(compare ? "#periodComparisonResults" : ".analyze-chart-grid");
        return { guide: control(guide), filters: control(filters), anchor: box(anchor),
            row: box(document.getElementById("analyzeToolbar")), overflow: document.documentElement.scrollWidth - innerWidth };
    }, compare);
}

test("Analyze entry controls share the widget edge, target and painted baseline at every supported size", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    const proof = process.env.WIRE_ANALYZE_ENTRY_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    const measurements = [], failures = [];
    for (const theme of ["dark", "light"]) for (const width of [1920, 1440, 768, 390, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: width < 700 ? 844 : 1080 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.evaluate(async () => { await document.fonts.ready; scrollTo(0, 0); });
        const name = `${width}-${scale}-${theme}`, value = await geometry(page);
        measurements.push({ name, ...value });
        if (proof) {
            await page.screenshot({ path: path.join(proof, `${name}-overview.png`) });
            await page.screenshot({ path: path.join(proof, `${name}-full.png`), fullPage: true });
        }
        const { guide, filters, anchor, row } = value;
        const check = (ok, message) => { if (!ok) failures.push(name + ": " + message); };
        check(Math.abs(row.right - anchor.right) <= 1 && Math.abs(filters.right - anchor.right) <= 1, "controls must end at the widget grid edge");
        check(Math.abs(guide.top - filters.top) <= 1 && Math.abs(guide.height - filters.height) <= 1, "one shared target row");
        check(guide.height >= 44 && filters.height >= 44, "44px minimum targets");
        check(guide.paintTop === filters.paintTop && guide.paintBottom === filters.paintBottom, "shared painted baseline");
        check(guide.right + 7 <= filters.left && filters.right <= anchor.right + 1, "separate non-overlapping entries");
        check(guide.left >= anchor.left - 1, "the complete hit area stays inside the widget edge");
        check(anchor.top - row.bottom >= 8 && anchor.top - row.bottom <= 16, "entries remain attached to the widget grid");
        check(guide.fontSize === filters.fontSize && guide.lineHeight === filters.lineHeight, "one control type scale");
        check(guide.overflow <= 1 && filters.overflow <= 1 && value.overflow <= 1, "no clipped controls or page overflow");
        if (filters.label && filters.icon) {
            check(Math.abs((filters.icon.top + filters.icon.bottom) / 2 - (filters.label.top + filters.label.bottom) / 2) <= 1,
                "filter icon and text share the same centerline");
        } else check(false, "Filters has a visible text label, not just a floating funnel");
        await expect(page.locator("#openAnalysisSearch")).toHaveCount(0);
        await expect(page.locator("#wireSearchHome")).toBeVisible();
        await expect(page.locator("#activityListContext button:not([hidden])")).toHaveCount(0);
    }
    if (proof) await writeFile(path.join(proof, "geometry.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(failures, []);
});

test("entry hover, keyboard, active counts and Compare keep their separate native behavior", { timeout: 60000 }, async t => {
    const { page, reads, olderDay, newerDay } = await setup(t);
    const proof = process.env.WIRE_ANALYZE_ENTRY_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    const filter = page.locator("#openAnalyzeFilters"), guide = page.locator("#openChartReference");
    for (const theme of ["dark", "light"]) {
        await chooseTheme(page, theme);
        await page.mouse.move(0, 0);
        const baseline = await geometry(page);
        for (const entry of [guide, filter]) {
            const face = await entry.evaluate(node => getComputedStyle(node, "::before").backgroundColor);
            await entry.hover();
            assert.notEqual(await entry.evaluate(node => getComputedStyle(node, "::before").backgroundColor), face);
            await entry.focus();
            await page.keyboard.press("Tab");
            await page.keyboard.press("Shift+Tab");
            await expect(entry).toBeFocused();
            assert.ok(await entry.evaluate(node => {
                const own = getComputedStyle(node), face = getComputedStyle(node, "::before");
                return [own, face].some(style => style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2);
            }), "Keyboard focus remains visible");
        }
        const hovered = await geometry(page);
        assert.deepEqual(hovered, baseline, "Hover and focus never change geometry");
        const count = reads.length;
        await guide.press("Enter");
        await expect(page.locator("#meaning")).toBeVisible();
        await expect(page.locator("#analyzeFilterDialog")).not.toBeVisible();
        await page.keyboard.press("Escape");
        await expect(guide).toBeFocused();
        await filter.press("Enter");
        await expect(page.locator("#dateFilter-control")).toBeFocused();
        await expect(page.locator("#meaning")).not.toBeVisible();
        await page.keyboard.press("Escape");
        await expect(filter).toBeFocused();
        await page.evaluate(() => scrollTo(0, 20));
        const scroll = await page.evaluate(() => scrollY);
        for (const entry of [guide, filter]) {
            const box = await entry.boundingBox();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.keyboard.press("Escape");
            await expect(entry).toBeFocused();
            await expect.poll(() => page.evaluate(() => scrollY)).toBe(scroll);
        }
        assert.equal(reads.length, count, "Help and panel disclosure do not read evidence");
    }
    await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(filter).toHaveAccessibleName("Filters and view, 2 active filters");
    await expect(page.locator("#analyzeFilterCount")).toHaveText("2");
    await expect(filter).toHaveAccessibleDescription(/Service: Files/);
    await page.setViewportSize({ width: 375, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; scrollTo(0, 0); });
    const active = await geometry(page);
    assert.ok(active.guide.right + 7 <= active.filters.left && active.filters.right <= 375
        && active.guide.left >= active.anchor.left - 1 && active.guide.overflow <= 1
        && active.overflow <= 1 && active.filters.overflow <= 1, JSON.stringify(active));
    if (proof) {
        await page.screenshot({ path: path.join(proof, "375-2-light-active-overview.png") });
        await page.screenshot({ path: path.join(proof, "375-2-light-active-full.png"), fullPage: true });
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.locator("#comparePeriods").click();
    await guide.click();
    await expect(page.locator("#chartReferenceShowData")).toBeDisabled();
    await page.keyboard.press("Escape");
    for (const side of ["A", "B"]) for (const bound of ["From", "To"]) {
        await page.locator(`#comparison${side}${bound}`).fill(side === "A" ? olderDay : newerDay);
    }
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    for (const theme of ["dark", "light"]) for (const width of [1920, 768, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: width < 700 ? 844 : 1080 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; scrollTo(0, 0); }, scale);
        await chooseTheme(page, theme);
        const value = await geometry(page, true);
        assert.ok(Math.abs(value.filters.right - value.anchor.right) <= 1, JSON.stringify(value));
        assert.ok(value.guide.right + 7 <= value.filters.left && value.overflow <= 1);
        assert.ok(value.guide.left >= value.anchor.left - 1 && value.guide.overflow <= 1 && value.filters.overflow <= 1);
        assert.equal(value.guide.height, value.filters.height);
        await expect(filter).toHaveAccessibleName("Filters, 2 active filters");
        if (proof) {
            await page.screenshot({ path: path.join(proof, `${width}-${scale}-${theme}-compare-overview.png`) });
            await page.screenshot({ path: path.join(proof, `${width}-${scale}-${theme}-compare-full.png`), fullPage: true });
        }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.locator("#comparisonRecordsB").click();
    const count = reads.length;
    await guide.click();
    await expect(page.locator("#chartReferenceShowData")).toBeEnabled();
    await page.locator("#chartReferenceShowData").click();
    await expect(page.locator("#comparisonRecordsB")).toBeFocused();
    await expect(page.locator("#comparisonRecordsB")).toHaveAttribute("aria-selected", "true");
    assert.equal(reads.length, count);
});

test("Analyze entry alignment and disclosure remain intact at actual 200% browser zoom", {
    timeout: 30000, skip: !process.env.WIRE_CHART_NATIVE_ZOOM,
}, async t => {
    const { page, unzoomed, reads } = await setup(t, { nativeZoom: true });
    const zoomed = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }));
    assert.ok(Math.abs(zoomed.dpr / unzoomed.dpr - 2) < .01);
    assert.ok(Math.abs(zoomed.width / unzoomed.width - .5) < .01);
    const proof = process.env.WIRE_ANALYZE_ENTRY_PROOFS;
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "native-zoom.json"), JSON.stringify({ unzoomed, zoomed }));
    }
    for (const theme of ["dark", "light"]) {
        await chooseTheme(page, theme);
        await page.evaluate(() => document.fonts.ready);
        const { guide, filters, anchor, overflow } = await geometry(page);
        assert.ok(Math.abs(filters.right - anchor.right) <= 1 && guide.right + 7 <= filters.left);
        assert.equal(guide.height, filters.height);
        assert.ok(overflow <= 1 && guide.overflow <= 1 && filters.overflow <= 1);
        if (proof) {
            const capture = await page.context().newCDPSession(page);
            const image = await capture.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
            await capture.detach();
            await writeFile(path.join(proof, `native-200-${theme}.png`), Buffer.from(image.data, "base64"));
        }
        const count = reads.length;
        await page.locator("#openAnalyzeFilters").click();
        await expect(page.locator("#dateFilter-control")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
        await page.locator("#openChartReference").click();
        await expect(page.locator("#chartReferenceTitle")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#openChartReference")).toBeFocused();
        assert.equal(reads.length, count);
    }
});

async function clickOutside(page, dialog) {
    const box = await dialog.boundingBox();
    assert.ok(box.x > 16 || box.y > 16, "The modal has reachable outside space");
    const point = box.x > 16 ? { x: box.x - 8, y: box.y + 20 } : { x: box.x + 20, y: box.y - 8 };
    await page.mouse.click(point.x, point.y);
}

test("Filters and chart guide consume nested Escape and outside clicks before their parent", { timeout: 30000 }, async t => {
    const { page, reads } = await setup(t);
    const dialog = page.locator("#analyzeFilterDialog"), guide = page.locator("#meaning");
    const count = reads.length, url = page.url();
    await page.locator("#openAnalyzeFilters").click();
    await page.locator("#outcomeFilter-control").click();
    await page.locator('.select-popup [data-value="failure"]').click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".select-popup")).not.toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.locator("#outcomeFilter-control")).toBeFocused();
    await expect(page.locator("#analyzeFilterCount")).not.toBeVisible();
    await page.locator("#toolFilter-control").click();
    await clickOutside(page, dialog);
    await expect(page.locator(".select-popup")).not.toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.locator("#toolFilter-control")).toBeFocused();
    await clickOutside(page, dialog);
    await expect(dialog).not.toBeVisible();
    await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
    assert.equal(reads.length, count);
    assert.equal(page.url(), url, "Dismissal cannot click a chart or navigation control through the backdrop");
    await page.locator("#openChartReference").click();
    const box = await guide.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x - 8, box.y + 30);
    await page.mouse.up();
    await expect(guide).toBeVisible();
    await page.locator("#chartReferenceTitle").click();
    await expect(guide).toBeVisible();
    await clickOutside(page, guide);
    await expect(guide).not.toBeVisible();
    await expect(page.locator("#openChartReference")).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    await page.keyboard.press("Escape");
    await expect(guide).toBeVisible();
    await expect(page.locator("#chartReferenceExact")).not.toBeVisible();
    await expect(page.locator("#chartReferenceShowData")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(guide).not.toBeVisible();
    assert.equal(reads.length, count);
    await page.locator(".request-card-open").first().click();
    const reader = page.locator("#contextSidebar");
    await expect(reader).toBeVisible();
    assert.equal(await reader.evaluate(node => node.matches(":modal")), true);
    await reader.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    const narrowReader = await reader.boundingBox();
    assert.equal(narrowReader.x, 0);
    assert.equal(narrowReader.width, 390, "The settled narrow reader has no outside space to click");
    await page.keyboard.press("Escape");
    await expect(reader).not.toBeVisible();
    await ready(page);
    assert.equal(page.url(), url);
    await page.setViewportSize({ width: 768, height: 844 });
    await page.locator(".request-card-open").first().click();
    await expect(reader).toBeVisible();
    assert.equal(await reader.evaluate(node => node.matches(":modal")), true);
    await reader.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    await clickOutside(page, reader);
    await expect(reader).not.toBeVisible();
    await ready(page);
    assert.equal(page.url(), url);
});

test("Filters glide reversibly and preserve drafts and sidebar policy across motion media changes", { timeout: 30000 }, async t => {
    const { page, reads, olderDay } = await setup(t);
    const proof = process.env.WIRE_ANALYZE_ENTRY_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const dialog = page.locator("#analyzeFilterDialog"), trigger = page.locator("#openAnalyzeFilters");
    const count = reads.length;
    await trigger.click();
    const animation = await dialog.evaluate(node => {
        const animation = node.getAnimations().find(item => item.effect.target === node);
        animation.pause(); animation.currentTime = 120;
        const matrix = new DOMMatrix(getComputedStyle(node).transform);
        return { duration: animation.effect.getTiming().duration, easing: animation.effect.getTiming().easing,
            transform: getComputedStyle(node).transform, opacity: getComputedStyle(node).opacity, x: matrix.m41, y: matrix.m42 };
    });
    assert.equal(animation.duration, 320);
    assert.equal(animation.easing, "cubic-bezier(0.2, 0, 0, 1)");
    assert.equal(Number(animation.opacity), 1);
    assert.ok(animation.x > 40); assert.equal(animation.y, 0);
    if (proof) await page.screenshot({ path: path.join(proof, "filter-opening-midpoint.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    const exit = await dialog.evaluate(node => {
        const animation = node.getAnimations().find(item => item.effect.target === node);
        animation.pause(); animation.currentTime = 0;
        return { start: animation.effect.getKeyframes()[0].transform, opacity: getComputedStyle(node).opacity };
    });
    assert.equal(exit.start, animation.transform, "Reversal starts at the painted position, not a reset endpoint");
    assert.equal(Number(exit.opacity), Number(animation.opacity));
    if (proof) await page.screenshot({ path: path.join(proof, "filter-reversed-midpoint.png") });
    await trigger.evaluate(node => node.click());
    await expect(page.locator("#dateFilter-control")).toBeFocused();
    await dialog.evaluate(node => node.getAnimations().filter(item => item.effect.target === node).forEach(item => item.finish()));
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute("data-closing", "");
    await expect(page.locator("#analyzeFilterPanel")).not.toHaveAttribute("inert", "");
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(olderDay);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(page.locator("#fromFilter")).toHaveValue(olderDay);
    await dialog.evaluate(node => {
        window.heldFilterMotion = node.getAnimations().find(item => item.effect.target === node);
        window.heldFilterMotion.pause(); window.heldFilterMotion.currentTime = 80;
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await dialog.evaluate(node => node.getAnimations().includes(window.heldFilterMotion)), true);
    await dialog.evaluate(() => window.heldFilterMotion.finish());
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await trigger.click();
    await expect(dialog).toBeVisible();
    assert.equal(await dialog.evaluate(node => node.getAnimations().find(item => item.effect.target === node)?.effect.getTiming().duration), 320);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    assert.equal(reads.length, count);
});

test("Filter fields use a shared column measure and compact paint without shrinking targets", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    for (const theme of ["dark", "light"]) {
        await chooseTheme(page, theme);
        await page.locator("#openAnalyzeFilters").click();
        await page.locator("#moreFiltersToggle").click();
        const fields = await page.locator("#analyzeFilterPanel .select-trigger-filter").evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect(), face = getComputedStyle(node, "::before");
            return { id: node.id, width: rect.width, height: rect.height, top: face.top, bottom: face.bottom };
        }));
        assert.equal(fields.length, await page.locator("#filters select").count());
        assert.ok(fields.every(field => Math.abs(field.width - fields[0].width) <= 1), JSON.stringify(fields));
        assert.ok(fields.every(field => field.height >= 44 && field.top === "4px" && field.bottom === "4px"), JSON.stringify(fields));
        const proof = process.env.WIRE_ANALYZE_ENTRY_PROOFS;
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, `filter-proportions-${theme}.png`) });
        }
        await page.locator("#moreFiltersToggle").click();
        await page.keyboard.press("Escape");
    }
});
