import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture as sourceFixture, selectActivityOption, chooseTheme, automaticScoreOffSummary } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_TOOLBAR_PROOFS;
const records = ["/me/events", "/me/messages", "/me/drive"].map((endpoint, index) => {
    const record = sourceFixture(`synthetic-toolbar-${index}`);
    record.capturedAt = `2026-09-${10 + index}T12:00:00Z`;
    record.toolCalls[0].startedAt = record.capturedAt;
    record.toolCalls[0].requestedApiPath = endpoint;
    record.toolCalls[0].requestArgs = { path: endpoint };
    return record;
});

async function fixture(run, contextOptions = {}) {
    const rejected = [], errors = [];
    const before = process.env.WORKIQ_TOOLBAR_BEFORE
        ? await readFile(process.env.WORKIQ_TOOLBAR_BEFORE, "utf8") : null;
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && (req.url === "/" || req.url === "/before" && before)) {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-toolbar-proof'; style-src 'unsafe-inline'; font-src data:; connect-src 'self'; base-uri 'none'");
            return res.end(req.url === "/before" ? before : renderHtmlShell("a".repeat(64), "toolbar-proof"));
        }
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST" && req.url === "/api/evaluation/automatic/summary") return res.end(JSON.stringify(automaticScoreOffSummary()));
        if (req.method !== "POST" || req.url !== "/api/snapshot") {
            rejected.push(`${req.method} ${req.url}`);
            res.writeHead(403).end('{"error":"Toolbar tests allow only synthetic snapshot reads."}');
            return;
        }
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        res.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [],
            coverage: { since: "2026-09-01", until: "2026-09-30", notes: ["Synthetic toolbar fixture."] },
            analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
        browser = await chromium.launch();
        const context = await browser.newContext({
            colorScheme: "light", reducedMotion: "reduce", timezoneId: "America/Los_Angeles", ...contextOptions,
        });
        context.setDefaultTimeout(5000);
        const origin = `http://127.0.0.1:${server.address().port}`;
        await context.addInitScript(() => {
            Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
                readText: () => { throw new Error("Toolbar proof must not read clipboard."); },
                writeText: () => { throw new Error("Toolbar proof must not write clipboard."); },
            } });
        });
        context.on("page", (page) => {
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("request", (request) => {
                if (new URL(request.url()).origin !== origin) rejected.push(request.url());
            });
        });
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, origin, before });
        assert.deepEqual(errors, [], "No browser errors");
        assert.deepEqual(rejected, [], "No private, clipboard, export, import or external operations");
    } finally {
        await browser?.close();
        await new Promise((resolve) => server.close(resolve));
    }
}

async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
}

async function measure(page) {
    return page.locator(".chart-heading").evaluate((heading) => {
        const rect = (node) => {
            if (!node || node.hidden) return null;
            const box = node.getBoundingClientRect(), style = getComputedStyle(node);
            return {
                x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
                font: style.fontSize, color: style.color, background: style.backgroundColor,
                border: style.borderTopWidth, radius: style.borderTopLeftRadius,
            };
        };
        const baseline = (node) => {
            const marker = document.createElement("span");
            marker.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;align-self:baseline";
            node.append(marker);
            const y = marker.getBoundingClientRect().y;
            marker.remove();
            return y;
        };
        const title = heading.querySelector("h2"), control = heading.querySelector("#bucketControl");
        const meta = heading.querySelector("#chartMeta"), select = heading.querySelector("#bucketFilter-control") || heading.querySelector("select");
        const periodBaseline = () => {
            const labelText = [...control.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
            if (!labelText) return baseline(control);
            const label = document.createElement("span");
            label.textContent = labelText.textContent;
            labelText.replaceWith(label);
            const y = baseline(label);
            label.replaceWith(labelText);
            return y;
        };
        return {
            heading: rect(heading), title: rect(title), control: rect(control), select: rect(select),
            meta: rect(meta), help: rect(heading.querySelector(".ux-help")),
            titleBaseline: baseline(title), controlBaseline: control.hidden ? null : periodBaseline(),
            metaBaseline: meta ? baseline(meta) : null, label: meta?.textContent,
            pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        };
    });
}

function contained(box, container, label) {
    if (!box) return;
    assert.ok(box.x >= container.x - 1 && box.right <= container.right + 1, `${label}: horizontal bounds`);
    assert.ok(box.y >= container.y - 1 && box.bottom <= container.bottom + 1, `${label}: vertical bounds`);
}

function contrast(foreground, background) {
    const luminance = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
}

test("chart headers keep compact period controls, readable timezone and consistent baselines", { timeout: 60000 }, async () => fixture(async ({ context, origin, before }) => {
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        for (const state of before ? ["before", "after"] : ["after"]) {
            await page.goto(origin + (state === "before" ? "/before" : "/"));
            await ready(page);
            await chooseTheme(page, theme);
            await page.locator(".chart-heading").scrollIntoViewIfNeeded();
            await page.mouse.move(0, 0);
            const metrics = await measure(page);
            measurements.push({ state, theme, width, view: "time", ...metrics });
            if (proofDir) {
                await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `${state}-${theme}-${width}.png`) });
                await page.locator(".chart-heading").screenshot({ path: path.join(proofDir, `${state}-${theme}-${width}-toolbar.png`) });
            }
            if (state === "before") continue;
            assert.equal(metrics.select.font, "14px");
            assert.equal(metrics.meta, null, "Calendar dates is redundant with the scale and expanded help");
            assert.equal(metrics.help, null, "No separate chart info button");
            assert.equal(metrics.select.border, "0px", "No inflated outline");
            assert.equal(metrics.select.background, "rgba(0, 0, 0, 0)", "Unpainted resting hit area");
            assert.equal(metrics.select.height, 44, "Styled select keeps touch-sized height");
            assert.ok(metrics.select.width >= 76 && metrics.select.width <= 96, "Selected word and chevron have restrained width");
            assert.match(await page.locator("#chartReadingNotes").textContent(), /Weeks start Monday.*display time zone/);
            assert.match(await page.locator("#displayTimeZone option:checked").textContent(), /America\/Los_Angeles/);
            assert.ok(metrics.pageWidth <= width, "No document overflow");
            for (const [key, box] of Object.entries(metrics).filter(([, value]) => value?.width)) contained(box, metrics.heading, key);
            if (metrics.heading.width > 576) {
                assert.ok(Math.abs(metrics.titleBaseline - metrics.controlBaseline) < 1, "Desktop title shares baseline");
                assert.ok(metrics.title.right <= metrics.control.x, "Title does not collide with selector");
                assert.equal(metrics.heading.height, 44, "Desktop header remains one 44px line");
            } else {
                assert.ok(metrics.title.bottom <= metrics.select.y, "Narrow title has its own intact line");
                assert.ok(metrics.heading.height <= 78, "Narrow title plus one control line stays compact");
            }
            const background = await page.locator(".chart-panel").evaluate((node) => getComputedStyle(node).backgroundColor);
            for (const box of [metrics.title, metrics.select]) {
                assert.ok(contrast(box.color, background) >= 4.5, "Both theme text colors pass AA");
            }
            const relativeBounds = (value) => ({
                x: value.select.x - value.heading.x, y: value.select.y - value.heading.y,
                width: value.select.width, height: value.select.height,
            });
            const bounds = relativeBounds(metrics);
            for (const value of ["day", "month", "week"]) {
                await selectActivityOption(page, "bucketFilter", value);
                await ready(page);
                const current = await measure(page);
                assert.deepEqual(relativeBounds(current), bounds, "Granularity changes neither size nor placement within the header");
                assert.equal(await page.locator("#bucketFilter").inputValue(), value);
            }
            for (const view of ["workload", "endpoint"]) {
                await page.locator(`[data-chart=${view}]`).click();
                await ready(page);
                const current = await measure(page);
                measurements.push({ state, theme, width, view, ...current });
                assert.equal(current.control, null, "Time-only selector hides in comparison views");
                contained(current.title, current.heading, `${view} title`);
                contained(current.meta, current.heading, `${view} count description`);
                assert.ok(current.pageWidth <= width);
                if (proofDir) await page.locator(".chart-heading").screenshot({ path: path.join(proofDir, `after-${theme}-${width}-${view}.png`) });
            }
        }
        await page.close();
    }
    if (proofDir) await writeFile(path.join(proofDir, "geometry.json"), JSON.stringify(measurements, null, 2));
}));

test("styled period picker retains keyboard selection, dismissal, focus and contextual help", { timeout: 30000 }, async () => fixture(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.goto(origin);
    await ready(page);
    const select = page.getByRole("combobox", { name: "Time scale", exact: true });
    await select.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "bucketFilter-control");
    assert.equal(await select.evaluate((node) => getComputedStyle(node, "::before").outlineStyle), "solid");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await ready(page);
    assert.equal(await page.locator("#bucketFilter").inputValue(), "day");
    assert.match(page.url(), /bucket=day/);
    await select.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await ready(page);
    assert.equal(await page.locator("#bucketFilter").inputValue(), "month");
    const before = await page.locator("#bucketFilter").inputValue(), route = page.url();
    await select.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#bucketFilter").inputValue(), before, "Escape keeps current selection");
    assert.equal(await page.evaluate(() => document.activeElement.id), "bucketFilter-control", "Escape returns styled picker focus");
    await select.click();
    await page.locator("#chartTitle").click();
    assert.equal(await page.locator("#bucketFilter").inputValue(), before, "Outside click keeps current selection");
    assert.equal(page.url(), route, "Dismissing the picker does not apply a route");
    const help = page.locator("#meaning>summary");
    await help.focus();
    await page.keyboard.press("Enter");
    assert.equal(await help.evaluate((node) => node === document.activeElement), true);
    const reading = page.locator("#meaningReading>summary");
    await reading.focus(); await reading.press("Enter");
    assert.match(await page.locator("#chartReadingNotes").innerText(), /display time zone/);
    assert.equal(await reading.evaluate(node => node === document.activeElement), true);
    await reading.press("Enter");
    assert.equal(await page.locator("#chartReadingNotes").isVisible(), false);
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), true);
}));

test("Time scale label has a modest external gap without inflating its picker", { timeout: 60000 }, async () => fixture(async ({ context, origin }) => {
    const page = await context.newPage(), measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1200 });
        await page.goto(origin);
        await ready(page);
        await chooseTheme(page, theme);
        await page.evaluate((scale) => document.documentElement.style.fontSize = `${16 * scale}px`, scale);
        const control = page.locator("#bucketControl");
        const picker = page.getByRole("combobox", { name: "Time scale", exact: true });
        await control.scrollIntoViewIfNeeded();
        const pair = {};
        for (const state of ["before", "after"]) {
            await control.evaluate((node, state) => {
                if (state === "before") node.style.gap = "4px";
                else node.style.removeProperty("gap");
            }, state);
            pair[state] = await control.evaluate((node) => {
                const box = (element) => {
                    const { x, y, right, bottom, width, height } = element.getBoundingClientRect();
                    return { x, y, right, bottom, width, height };
                };
                const textBottom = (element) => {
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    return range.getBoundingClientRect().bottom;
                };
                const label = node.querySelector(".bucket-label"), trigger = node.querySelector(".select-trigger");
                const style = getComputedStyle(trigger), labelBox = box(label), triggerBox = box(trigger);
                return {
                    label: labelBox, trigger: triggerBox, control: box(node), heading: box(node.closest(".chart-heading")),
                    visibleLabel: getComputedStyle(label).clipPath === "none",
                    gap: triggerBox.x - labelBox.right,
                    font: style.fontSize, padding: style.padding, radius: style.borderRadius,
                    textOffset: textBottom(label) - textBottom(trigger.querySelector(".select-value")),
                    labelledBy: trigger.getAttribute("aria-labelledby"), labelId: label.closest("label").id,
                    overflow: document.documentElement.scrollWidth > innerWidth,
                };
            });
            if (proofDir) await control.screenshot({ path: path.join(proofDir, `gap-${state}-${theme}-${width}-${scale}.png`) });
        }
        const { before, after } = pair;
        measurements.push({ theme, width, scale, ...pair });
        if (after.visibleLabel) {
            assert.equal(before.gap, 4, "Reproduce the previous label-to-trigger gap");
            assert.equal(after.gap, 8, "Give the visible label exactly one small external gap");
            assert.ok(Math.abs(after.textOffset) <= 1, "Label and selected text retain their baseline");
            assert.equal(after.textOffset, before.textOffset, "Spacing cannot change optical alignment");
        }
        for (const key of ["width", "height"]) {
            assert.equal(after.trigger[key], before.trigger[key], `External spacing cannot inflate picker ${key}`);
            assert.equal(after.heading[key], before.heading[key], `External spacing cannot inflate toolbar ${key}`);
        }
        for (const key of ["font", "padding", "radius"]) assert.equal(after[key], before[key]);
        assert.equal(after.font, `${14 * scale}px`);
        assert.ok(after.trigger.height >= 44);
        if (scale === 1) assert.equal(after.trigger.height, 44);
        assert.equal(after.overflow, false, "Association remains usable without document overflow");
        assert.ok(after.labelledBy.split(" ").includes(after.labelId), "The visible or clipped label still names the picker");
        contained(after.control, after.heading, "Time scale field");
        contained(after.trigger, after.control, "Time scale trigger");
        await picker.focus();
        await picker.press("ArrowDown");
        const popup = await page.locator(".select-popup").boundingBox(), anchor = await picker.boundingBox();
        assert.ok(Math.abs(popup.x - Math.max(8, Math.min(anchor.x, width - popup.width - 8))) <= 1, "Popup stays anchored to the trigger");
        await picker.press("Escape");
        assert.equal(await picker.getAttribute("aria-expanded"), "false");
        assert.equal(await picker.evaluate((node) => node === document.activeElement), true);
    }
    if (proofDir) await writeFile(path.join(proofDir, "gap-geometry.json"), JSON.stringify(measurements, null, 2));
}));

test("touch targets and long dynamic zones remain usable without overlapping or clipping", { timeout: 30000 }, async () => fixture(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(origin);
    await ready(page);
    const select = page.getByRole("combobox", { name: "Time scale", exact: true });
    const help = page.locator("#meaning>summary");
    const initial = await measure(page);
    assert.equal(initial.select.height, 44);
    assert.ok((await help.boundingBox()).height >= 44);
    assert.equal(initial.help, null);
    await select.tap();
    await page.keyboard.press("Escape");
    await selectActivityOption(page, "bucketFilter", "month");
    await ready(page);
    assert.equal(await page.locator("#bucketFilter").inputValue(), "month");
    await help.tap();
    await page.locator("#meaningReading>summary").tap();
    assert.equal(await page.locator("#chartReadingNotes").isVisible(), true);
    assert.match(await page.locator("#displayTimeZone option:checked").textContent(), /America\/North_Dakota\/New_Salem/);
    assert.doesNotMatch(await page.locator("#chartReadingNotes").innerText(), /America\/North_Dakota\/New_Salem/);
    await help.tap();
    for (const size of ["16px", "20px"]) {
        await page.evaluate((value) => document.documentElement.style.fontSize = value, size);
        const metrics = await measure(page);
        for (const key of ["title", "select", "meta", "help"]) contained(metrics[key], metrics.heading, key);
        assert.ok(metrics.pageWidth <= 375, "Long zone does not create horizontal scrolling");
        assert.equal(metrics.meta, null, "Display zone remains in the header, not duplicated here");
    }
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.evaluate(() => {
        document.documentElement.style.fontSize = "16px";
        document.querySelector(".chart-panel").style.width = "360px";
    });
    const narrowPanel = await measure(page);
    assert.ok(narrowPanel.title.bottom <= narrowPanel.select.y, "A narrow panel stays compact even inside a wide viewport");
    for (const key of ["title", "select", "meta", "help"]) contained(narrowPanel[key], narrowPanel.heading, key);
}, { hasTouch: true, timezoneId: "America/North_Dakota/New_Salem" }));
