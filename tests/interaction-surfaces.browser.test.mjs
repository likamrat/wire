import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { fixture, privateFixture, chooseTheme, openAnalyzeFilters } from "./helpers.mjs";
import { contrast, measureControlSurface } from "./color-measurements.mjs";

const proofs = process.env.WIRE_INTERACTION_SURFACE_PROOFS;
const settle = async page => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.playState !== "running" || animation.effect.getComputedTiming().iterations === Infinity));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, `${name}.png`) });
}
function controlContrast(paint, name) {
    assert.ok(contrast(paint.ink, paint.face) >= 4.5, `${name}: readable label`);
    assert.ok(Math.max(contrast(paint.face, paint.backdrop), contrast(paint.border, paint.backdrop)) >= 3,
        `${name}: perceptible action face or edge`);
}
async function tooltipPaint(page, surface) {
    const tooltip = page.getByRole("tooltip", { includeHidden: true });
    const paint = await tooltip.evaluate((node, selector) => {
        const css = getComputedStyle(node);
        return { text: node.textContent, background: css.backgroundColor, ink: css.color, border: css.borderTopColor,
            surface: getComputedStyle(document.querySelector(selector)).backgroundColor,
            fontSize: parseFloat(css.fontSize), box: node.getBoundingClientRect().toJSON(),
            scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
    }, surface);
    // Sample actual underlay paint, including the modal backdrop outside its panel.
    await tooltip.evaluate(node => { node.style.visibility = "hidden"; });
    let underlay;
    try { underlay = await page.screenshot(); }
    finally { await tooltip.evaluate(node => node.style.removeProperty("visibility")); }
    paint.underlay = await page.evaluate(async ({ png, box }) => {
        const image = await createImageBitmap(new Blob([Uint8Array.from(atob(png), char => char.charCodeAt(0))]));
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); image.close();
        const sx = canvas.width / innerWidth, sy = canvas.height / innerHeight;
        const points = [[box.left + box.width / 2, box.top + 1], [box.left + box.width / 2, box.bottom - 1],
            [box.left + 1, box.top + box.height / 2], [box.right - 1, box.top + box.height / 2]];
        return points.map(([x, y]) => `rgb(${[...context.getImageData(Math.floor(x * sx), Math.floor(y * sy), 1, 1).data].slice(0, 3).join(",")})`);
    }, { png: underlay.toString("base64"), box: paint.box });
    return paint;
}
async function native(t) {
    const records = [12, 4, 1].map((total, group) => {
        const record = fixture(`interaction-surfaces-${group}`);
        record.userPrompt.text = `Synthetic interaction surface ${group + 1}`;
        record.followUpPrompts = [];
        record.capturedAt = `2026-10-${String(1 + group * 7).padStart(2, "0")}T12:00:00.000Z`;
        record.toolCalls = Array.from({ length: total }, (_, index) => ({
            ...record.toolCalls[0], toolCallId: `surface-${group}-${index}`, startEventId: `surface-start-${group}-${index}`,
            startedAt: record.capturedAt, toolSucceeded: index !== 0, reportedOutcome: index === 0 ? "failed" : "succeeded",
        }));
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw new Error("No providers in contrast proof"); },
            readSource: async () => { throw new Error("No source reads in contrast proof"); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US", timezoneId: "UTC" });
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
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup.reverse()) await action(); }
    });
    return { page, url: runtime.url };
}

test("real chart and modal hover information have one readable, distinct surface in both themes", async t => {
    const { page, url } = await native(t), measurements = [];
    for (const theme of ["light", "dark"]) {
        await page.goto(url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await chooseTheme(page, theme); await settle(page);
        await page.locator(".flat-time-segment").first().hover();
        await expect(page.getByRole("tooltip")).toBeVisible(); await settle(page);
        measurements.push({ theme, kind: "chart", ...await tooltipPaint(page, ".analyze-chart-main") });
        await capture(page, `${theme}-chart-tooltip`);
        await page.keyboard.press("Escape");
        await openAnalyzeFilters(page);
        await page.locator('#analyzeViewControls [data-chart="workload"]').hover();
        await expect(page.getByRole("tooltip")).toBeVisible(); await settle(page);
        measurements.push({ theme, kind: "modal", ...await tooltipPaint(page, "#analyzeFilterDialog") });
        await capture(page, `${theme}-modal-tooltip`);
    }
    if (proofs) await writeFile(path.join(proofs, "tooltip-paint.json"), JSON.stringify(measurements, null, 2));
    for (const value of measurements) {
        assert.ok(contrast(value.ink, value.background) >= 4.5, `${value.theme} ${value.kind}: text contrast`);
        assert.ok(contrast(value.background, value.surface) >= 3, `${value.theme} ${value.kind}: popup separates from its surface`);
        for (const underlay of value.underlay) assert.ok(
            Math.max(contrast(value.background, underlay), contrast(value.border, underlay)) >= 3,
            `${value.theme} ${value.kind}: face or edge separates from actual composited ${underlay}`);
        assert.ok(value.fontSize >= 14, "Use the screen's readable small-text role rather than caption-sized help");
    }
});

test("chart hover placement preserves neighboring count labels and native data", async t => {
    const { page, url } = await native(t);
    await page.goto(url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false"); await settle(page);
    const counts = await page.locator(".dimensional-count").allTextContents();
    await page.locator(".flat-time-segment").first().hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    const overlap = await page.evaluate(() => {
        const tip = document.querySelector('[role="tooltip"]').getBoundingClientRect();
        return [...document.querySelectorAll(".dimensional-count,.dimensional-time-labels>span,.flat-time-axis>span")]
            .filter(node => node.checkVisibility()).flatMap(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                const box = range.getBoundingClientRect();
                return tip.left < box.right && tip.right > box.left && tip.top < box.bottom && tip.bottom > box.top ? [node.textContent] : [];
            });
    });
    assert.deepEqual(overlap, [], "Hover information must not cover the chart's count/date labels");
    assert.deepEqual(await page.locator(".dimensional-count").allTextContents(), counts);
    assert.match(await page.getByRole("tooltip").innerText(), /Worked: 11 of 12 Work IQ tool calls/);
});

test("Filters actions and choice highlights remain distinct without changing their 320ms outer glide", async t => {
    const { page, url } = await native(t), measurements = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        const trigger = page.locator("#openAnalyzeFilters");
        await trigger.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await settle(page);
        const rest = await trigger.evaluate(measureControlSurface); controlContrast(rest, "Filters at rest");
        await trigger.hover(); await settle(page);
        const hover = await trigger.evaluate(measureControlSurface);
        measurements.push({ theme, width, scale, rest, hover });
        controlContrast(hover, "Filters hover");
        assert.ok(hover.borderWidth >= 2 && contrast(hover.border, rest.border) >= 2, "Filters has a perceptible hover highlight");
        assert.equal(hover.box.width, rest.box.width); assert.equal(hover.box.height, rest.box.height);
        await capture(page, `${theme}-${width}-${scale}-filters-hover`);
        await page.evaluate(() => {
            window.filterGlides = [];
            const animate = Element.prototype.animate;
            Element.prototype.animate = function (frames, options) {
                if (this.id === "analyzeFilterDialog") window.filterGlides.push(options.duration);
                return animate.call(this, frames, options);
            };
        });
        await trigger.click(); await expect(page.locator("#analyzeFilterDialog")).toBeVisible(); await settle(page);
        const choice = page.locator("#dateFilter-control");
        await choice.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await settle(page);
        controlContrast(await choice.evaluate(measureControlSurface), "Date choice at rest");
        await choice.hover(); await settle(page);
        const choiceHover = await choice.evaluate(measureControlSurface);
        controlContrast(choiceHover, "Date choice hover"); assert.ok(choiceHover.borderWidth >= 2);
        await choice.click();
        const option = page.locator('.select-popup-filter .select-option:not([aria-disabled=true])').nth(1);
        await option.hover(); await settle(page);
        const paint = await option.evaluate(measureControlSurface);
        assert.ok(paint.focusWidth >= 2 && contrast(paint.focus, paint.face) >= 3, "Hovered option has a visible highlight");
        assert.ok(contrast(paint.ink, paint.face) >= 4.5);
        await capture(page, `${theme}-${width}-${scale}-filters-choice`);
        await page.keyboard.press("Escape");
        await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator("#analyzeFilterDialog")).not.toBeVisible();
        assert.deepEqual(await page.evaluate(() => window.filterGlides), [320, 320]);
    }
    if (proofs) await writeFile(path.join(proofs, "filters-paint.json"), JSON.stringify(measurements, null, 2));
});

test("the real reader report action remains recognizable at rest, hover, press and keyboard focus", async t => {
    const { page, url } = await native(t), measurements = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await page.locator("#activityList .request-card-open").first().click();
        const action = page.getByRole("button", { name: "Add to report", exact: true });
        await expect(action).toBeVisible(); await settle(page);
        await page.mouse.move(0, 0);
        for (const state of ["rest", "hover", "pressed", "focus"]) {
            if (state === "hover") await action.hover();
            if (state === "pressed") await page.mouse.down();
            if (state === "focus") { await page.mouse.move(0, 0); await action.focus(); await page.keyboard.press("Shift"); }
            await settle(page);
            const paint = await action.evaluate(measureControlSurface);
            measurements.push({ theme, width, scale, state, ...paint });
            await capture(page, `${theme}-${width}-${scale}-reader-action-${state}`);
            if (state === "pressed") {
                await page.mouse.move(0, 0); await page.mouse.up();
                await page.evaluate(() => getSelection()?.removeAllRanges());
            }
        }
        await expect(action).toHaveText("Add to report");
    }
    if (proofs) await writeFile(path.join(proofs, "reader-action-paint.json"), JSON.stringify(measurements, null, 2));
    for (const value of measurements) {
        assert.equal(value.disabled, false);
        controlContrast(value, `${value.theme} ${value.state}`);
        if (value.state === "focus") {
            assert.ok(value.focusWidth >= 2);
            assert.ok(contrast(value.focus, value.backdrop) >= 3);
        }
    }
});

test("chart guide topics and return actions keep the shared hover highlight despite local quiet fills", async t => {
    const { page, url } = await native(t);
    await page.goto(url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const hasIndex = await page.locator("#chartReferenceAllTopics").count() === 1;
    const sizes = hasIndex ? [[1440, 100], [375, 200]] : [[1440, 100]];
    for (const theme of ["light", "dark"]) for (const [width, scale] of sizes) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await page.locator("#openChartReference").click(); await settle(page);
        if (hasIndex) await page.locator("#chartReferenceAllTopics").click();
        const topic = page.locator(".chart-reference-topic").first();
        async function highlight(control, name) {
            await control.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await settle(page);
            const rest = await control.evaluate(measureControlSurface);
            await control.hover(); await settle(page);
            const hover = await control.evaluate(measureControlSurface);
            controlContrast(hover, name);
            assert.ok(hover.borderWidth >= 2, `${name} shares the perceptible hover edge`);
            assert.equal(hover.box.width, rest.box.width); assert.equal(hover.box.height, rest.box.height);
            await capture(page, `${theme}-${width}-${scale}-guide-${name}`);
        }
        await highlight(topic, "topic");
        await topic.click(); await settle(page);
        if (hasIndex) await highlight(page.locator("#chartReferenceAllTopics"), "return");
        await highlight(page.locator("#chartReferenceShowData"), "exact-data");
        await page.locator("#chartReferenceShowData").click(); await settle(page);
        await highlight(page.locator("#chartReferenceBack"), "back");
        await page.locator("#closeChartReference").click(); await settle(page);
    }
});

test("reader timestamp details use the same keyboard-readable hover surface instead of an unthemed title", async t => {
    const { page, url } = await native(t);
    await page.goto(url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#activityList .request-card-open").first().click();
    await page.locator("#requestContent .reader-call-toggle").first().click();
    const stamp = page.locator("#requestContent time").first();
    for (const details of await stamp.locator("xpath=ancestor::details").all()) {
        if (!await details.evaluate(node => node.open)) await details.locator(":scope>summary").click();
    }
    await expect(stamp).toBeVisible();
    assert.equal(await stamp.getAttribute("title"), null);
    assert.equal(await stamp.getAttribute("tabindex"), "0");
    await page.keyboard.press("Shift"); await stamp.focus();
    await expect(page.getByRole("tooltip")).toHaveText(await stamp.getAttribute("datetime"));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).not.toBeVisible();
    await expect(stamp).toBeFocused();
});

test("collection timestamp hover details remain available through keyboard focus without checking a source", async t => {
    const { page, url } = await native(t);
    await page.route("**/api/collection/status", async route => {
        const response = await route.fetch(), status = await response.json();
        await route.fulfill({ response, json: { ...status,
            lastCheckedAt: "2026-10-12T12:00:00.000Z", lastNewDataAt: "2026-10-11T12:00:00.000Z" } });
    });
    await page.goto(url + "#collection-status");
    for (const [id, label] of [["collectionChecked", "Last local check:"], ["collectionNewActivity", "Last newly collected activity:"]]) {
        const stamp = page.locator("#" + id);
        await expect(stamp).toBeVisible();
        await expect(stamp).toHaveAttribute("tabindex", "0");
        assert.equal(await stamp.getAttribute("title"), null);
        await page.keyboard.press("Shift"); await stamp.focus();
        await expect(page.getByRole("tooltip")).toContainText(label);
        await page.keyboard.press("Escape");
    }
});

async function primitives(t) {
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.setContent(`<style>${styles}</style><main style="padding:24px">
        <div id="surface" style="padding:24px;background:var(--paper)">
        <button id="secondary">Secondary action</button><button id="primary" class="primary">Primary action</button>
        <button id="danger" class="danger">Danger action</button><button id="disabled" disabled>Unavailable action</button>
        <button id="help">Explanation</button><button id="after">Next action</button></div>
        <div id="scrollbox" style="height:130px;overflow:auto;margin-top:20px"><div style="height:500px"><button id="clipped">Clipped help</button></div></div>
        <dialog id="modal"><button id="modalHelp">Dialog explanation</button></dialog></main>`);
    await page.evaluate(({ factory, icons }) => {
        window.ux = (0, eval)(`(${factory})`)(icons);
        window.ux.tooltip(document.getElementById("help"), "A complete explanation. ".repeat(120));
        window.ux.tooltip(document.getElementById("after"), "A different explanation");
        window.ux.tooltip(document.getElementById("clipped"), "Help belongs to this visible control");
        window.ux.tooltip(document.getElementById("modalHelp"), "Help in the top-layer dialog");
        window.ux.explainDisabled(document.getElementById("disabled"), "Review the synthetic value before continuing.", { compact: true });
        const quiet = window.ux.utility(document.createElement("button"), "close", "Close explanation");
        quiet.id = "quiet"; quiet.classList.add("quiet");
        document.getElementById("surface").append(quiet);
        window.copied = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => window.copied.push(text) } });
        const copy = window.ux.copyButton({ label: "Copy synthetic value", getText: () => "Synthetic clipboard value" });
        copy.id = "copy"; document.getElementById("surface").append(copy);
    }, { factory: createEvidenceUX.toString(), icons: uxIcons });
    await settle(page);
    return page;
}

test("shared button roles keep contrast on page, reader and floating surfaces without changing disabled semantics", async t => {
    const page = await primitives(t);
    for (const theme of ["light", "dark"]) for (const surface of ["--paper", "--context-paper", "--floating-paper"]) {
        await page.evaluate(({ theme, surface }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            const value = getComputedStyle(document.documentElement).getPropertyValue(surface);
            document.getElementById("surface").style.setProperty("--paper", value);
            document.getElementById("surface").style.setProperty("--pill-fill", value);
        }, { theme, surface });
        for (const id of ["secondary", "primary", "danger"]) {
            await page.mouse.move(0, 0);
            const button = page.locator("#" + id);
            await button.evaluate(node => node.blur()); await settle(page);
            const rest = await button.evaluate(measureControlSurface);
            controlContrast(rest, `${theme} ${surface} ${id}`);
            await button.hover(); await settle(page);
            controlContrast(await button.evaluate(measureControlSurface), `${theme} ${surface} ${id} hover`);
        }
        const disabled = await page.locator("#disabled").evaluate(measureControlSurface);
        assert.equal(disabled.disabled, true);
        assert.ok(contrast(disabled.ink, disabled.face) >= 4.5);
        const quiet = await page.locator("#quiet").evaluate(measureControlSurface);
        assert.ok(contrast(quiet.ink, quiet.face) >= 3, "An intentionally unboxed icon still has a recognizable glyph");
    }
});

test("disabled explanations and copy controls share readable help without stealing their existing actions", async t => {
    const page = await primitives(t);
    await page.locator(".ux-disabled-help").focus();
    await expect(page.getByRole("tooltip")).toHaveText("Review the synthetic value before continuing.");
    await page.keyboard.press("Escape");
    await page.locator("#copy").hover();
    await expect(page.getByRole("tooltip")).toHaveText("Copy synthetic value");
    await page.locator("#copy").click();
    await expect(page.getByRole("tooltip")).not.toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.copied), ["Synthetic clipboard value"]);
    assert.equal(await page.locator("#copy").getAttribute("data-copy-state"), "success");
});

test("shared help stays inside every viewport edge and respects forced-color boundaries", async t => {
    const page = await primitives(t), target = page.locator("#after");
    for (const theme of ["light", "dark"]) for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
        await page.keyboard.press("Escape"); await page.mouse.move(450, 350);
        await page.evaluate(({ theme, corner }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            const target = document.getElementById("after");
            target.style.cssText = `position:fixed;${corner.startsWith("top") ? "top" : "bottom"}:8px;${corner.endsWith("left") ? "left" : "right"}:8px`;
        }, { theme, corner });
        await target.hover(); await expect(page.getByRole("tooltip")).toBeVisible();
        const box = await page.getByRole("tooltip").boundingBox();
        assert.ok(box.x >= 8 && box.y >= 8 && box.x + box.width <= 892 && box.y + box.height <= 692, `${theme} ${corner}`);
    }
    await page.emulateMedia({ forcedColors: "active" });
    const paint = await page.getByRole("tooltip").evaluate(node => {
        const css = getComputedStyle(node);
        return { ink: css.color, paper: css.backgroundColor, border: css.borderTopColor, width: parseFloat(css.borderTopWidth), adjust: css.forcedColorAdjust };
    });
    assert.ok(contrast(paint.ink, paint.paper) >= 4.5);
    assert.ok(paint.width >= 1 && contrast(paint.border, paint.paper) >= 3);
    assert.equal(paint.adjust, "auto");
    await capture(page, "forced-colors-tooltip");
});

test("focused help stays in view, follows reflow, and closes when its anchor is fully clipped", async t => {
    const page = await primitives(t);
    await page.locator("#after").focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.evaluate(() => {
        const band = document.createElement("div"); band.style.height = "160px";
        document.getElementById("surface").prepend(band);
    });
    await settle(page);
    const button = await page.locator("#after").boundingBox(), tip = await page.getByRole("tooltip").boundingBox();
    assert.ok(tip.y >= button.y + button.height || tip.y + tip.height <= button.y, "Reflow cannot leave help covering its owner");
    assert.ok(Math.min(Math.abs(tip.y - button.y - button.height), Math.abs(button.y - tip.y - tip.height)) <= 9,
        "Help follows the moved owner instead of remaining at its earlier coordinates");
    await page.keyboard.press("Escape");
    await page.locator("#clipped").focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.locator("#scrollbox").evaluate(node => { node.scrollTop = 200; });
    await expect(page.getByRole("tooltip")).not.toBeVisible();
});

test("long help is readable at narrow 200% text with keyboard scrolling and fresh-scroll reset", async t => {
    const page = await primitives(t);
    await page.setViewportSize({ width: 375, height: 600 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
        await page.locator("#help").focus();
        await expect(page.getByRole("tooltip")).toBeVisible(); await settle(page);
        const box = await page.getByRole("tooltip").boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 375 && box.y >= 0 && box.y + box.height <= 600);
        const scroll = await page.evaluate(() => scrollY);
        await page.keyboard.press("PageDown");
        assert.ok(await page.getByRole("tooltip").evaluate(node => node.scrollTop > 0), "Keyboard users can read beyond the first help screen");
        assert.equal(await page.evaluate(() => scrollY), scroll, "Reading help does not page the underlying interface");
        await capture(page, `${theme}-long-help-375-200`);
        await page.keyboard.press("Escape");
        await page.locator("#after").focus();
        await expect(page.getByRole("tooltip")).toHaveText("A different explanation");
        assert.equal(await page.getByRole("tooltip").evaluate(node => node.scrollTop), 0);
    }
});

test("shared help preserves top-layer ownership, Escape and stale-getter withdrawal", async t => {
    const page = await primitives(t);
    await page.locator("#modal").evaluate(node => node.showModal());
    await page.locator("#modalHelp").focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    assert.equal(await page.getByRole("tooltip").evaluate(node => node.parentElement.id), "modal");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).not.toBeVisible();
    assert.equal(await page.locator("#modal").evaluate(node => node.open), true);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        const target = document.getElementById("after");
        window.ux.tooltip(target, () => {
            window.ux.withdrawAccess([target]);
            return "WITHDRAWN_INFORMATION_MUST_NOT_APPEAR";
        });
    });
    await page.locator("#after").focus();
    await expect(page.getByRole("tooltip")).not.toBeVisible();
    assert.equal(await page.locator('[aria-describedby~="evidence-tooltip"]').count(), 0);
    assert.equal(await page.locator("body").textContent().then(text => text.includes("WITHDRAWN_INFORMATION_MUST_NOT_APPEAR")), false);
});
