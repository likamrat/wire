import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { buildAssessmentModel, assessmentOverview } from "../lib/assessment-read-model.mjs";
import { fixture, exportCatalogFor, chooseTheme, navigateMain, navigateSettings, openActivitySessions } from "./helpers.mjs";
import { reportContents, chooseReportScope } from "./report-journey-helpers.mjs";

const proofs = process.env.WIRE_HELP_GEOMETRY_PROOFS;
const records = [fixture("synthetic-help-geometry")];
const render = process.env.WIRE_HELP_GEOMETRY_BASELINE
    ? (await import(pathToFileURL(path.join(process.env.WIRE_HELP_GEOMETRY_BASELINE, "lib", "render.mjs")))).renderHtmlShell : renderHtmlShell;

async function setup(t, options = {}) {
    const rejected = [], errors = [];
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records, exports: [] };
    const model = buildAssessmentModel(state);
    const collection = { state: "not-configured", revision: 1, configVersion: 0, connected: false, config: null,
        suggestedSource: { appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state" }, cadence: { pollSeconds: 5 }, metrics: {}, historyIssues: [] };
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            return res.end(render("a".repeat(64), "help-geometry"));
        }
        if (req.method === "GET" && req.url === "/favicon.ico") return res.writeHead(204).end();
        if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
            res.setHeader("Content-Type", "text/javascript");
            return res.end(await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url)));
        }
        if (req.method === "POST" && ["/api/collection/status", "/api/record/status"].includes(req.url)) {
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify(req.url === "/api/record/status" ? { attempt: null }
                : collection));
        }
        if (req.method === "POST" && req.url === "/api/evaluation/automatic/summary") {
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify({ schemaVersion: 1, snapshot: { state: "off", reason: "not-approved", approval: { state: "disabled" } } }));
        }
        if (req.method === "POST" && ["/api/assessment/overview", "/api/assessment/detail", "/api/assessment/consent"].includes(req.url)) {
            let text = ""; for await (const part of req) text += part;
            const input = JSON.parse(text);
            const data = req.url.endsWith("/consent") ? { consent: model.consent, source: model.source, capabilities: model.capabilities }
                : req.url.endsWith("/detail") ? model.details.get(input.interactionRef) : assessmentOverview(state, model, input.interactionRefs);
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify({ schemaVersion: 1, basis: model.basis, data }));
        }
        if (req.method === "POST" && req.url === "/api/snapshot") {
            let text = ""; for await (const part of req) text += part;
            const input = JSON.parse(text);
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify({ revision: 1, scenarios: records, exports: [], exportCatalog: exportCatalogFor(records), collection,
                assessment: { schemaVersion: 1, basis: model.basis, catalog: model.catalog, overview: model.overview,
                    consent: model.consent, source: model.source, capabilities: model.capabilities },
                coverage: { since: "2026-09-01", until: "2026-09-30", notes: ["Synthetic help geometry only."] },
                analytics: { ...buildActivityAnalytics(records, input), revision: 1 } }));
        }
        rejected.push(`${req.method} ${req.url}`);
        res.writeHead(403).end('{"error":"Synthetic help proof allows status and snapshot reads only."}');
    });

    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", ...options });
    await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { rejected.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw new Error("No clipboard access in geometry proof."); },
        writeText() { throw new Error("No clipboard access in geometry proof."); },
    } }));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(rejected, []); assert.deepEqual(errors, []);
    });
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
    if (proofs) await mkdir(proofs, { recursive: true });
    return page;
}

async function filterGaps(page) {
    return page.locator(".period-controls .help-heading").evaluateAll(headings => headings.map(heading => {
        const label = heading.querySelector("label"), help = heading.querySelector(".ux-help");
        const range = document.createRange(); range.selectNodeContents(label);
        const text = range.getClientRects()[range.getClientRects().length - 1];
        const glyph = help.querySelector("svg path").getBoundingClientRect(), target = help.getBoundingClientRect();
        return { label: label.textContent, gap: glyph.left - text.right, targetWidth: target.width, targetHeight: target.height,
            centerDelta: (glyph.top + glyph.bottom - text.top - text.bottom) / 2 };
    }));
}

test("closed primary help glyphs have a compact visible gap, not target-sized whitespace", async t => {
    const page = await setup(t);
    await chooseTheme(page, "dark");
    await page.locator("#filters").scrollIntoViewIfNeeded();
    const measurements = await filterGaps(page);
    t.diagnostic(JSON.stringify(measurements));
    if (proofs) {
        await page.screenshot({ path: path.join(proofs, "home-closed.png"), fullPage: true });
        await page.locator("#filters").screenshot({ path: path.join(proofs, "home-filters.png") });
        await writeFile(path.join(proofs, "filter-gaps.json"), JSON.stringify(measurements, null, 2));
    }
    assert.equal(measurements.length, 3);
    assert.equal(await page.getByRole("combobox", { name: "When", exact: true }).count(), 1, "Inline flow preserves the field's accessible name");
    for (const item of measurements) {
        assert.ok(item.gap >= 4 && item.gap <= 8, `${item.label}: visible text-to-path gap ${item.gap}px must stay within 4-8px`);
        assert.ok(item.targetWidth >= 44 && item.targetHeight >= 44, `${item.label}: retain a 44px target`);
    }
});

async function visibleHelpGeometry(page) {
    return page.locator(".ux-help:visible").evaluateAll(buttons => buttons.map(button => {
        const box = node => {
            const r = node.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const combined = button.classList.contains("metadata-help-with-label");
        const parent = combined ? button.querySelector(".metadata-label") : button.closest(".metadata-label") || button.parentElement;
        const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
        let last = null;
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!combined && button.contains(node)) break;
            if (node.textContent.trim() && (combined || node.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)) last = node;
        }
        let text = null;
        if (last) {
            const range = document.createRange();
            range.selectNodeContents(last);
            const rect = [...range.getClientRects()].at(-1);
            if (rect) text = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        }
        const glyph = box(button.querySelector(combined ? ".metadata-tail-end>svg path" : "svg path")), target = box(button);
        return { name: button.getAttribute("aria-label"), family: parent.className || parent.tagName,
            gap: text ? glyph.left - text.right : null, text, glyph, target };
    }));
}

test("help geometry inventory across normal Home, Activity, details, report and Settings renderers", { timeout: 45000 }, async t => {
    const page = await setup(t), measurements = [];
    async function capture(view) {
        await page.locator("#workspace[aria-busy=false]").waitFor();
        if (view.startsWith("home-") || view.startsWith("activity-") || view.startsWith("details-")) {
            await page.locator(".assessment-grid:visible").first().waitFor();
        }
        const geometry = await visibleHelpGeometry(page);
        measurements.push({ view, geometry });
        await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
        if (proofs) await page.screenshot({ path: path.join(proofs, `${view}.png`), fullPage: true });
    }
    for (const theme of ["dark", "light"]) for (const width of [1200, 820, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await navigateMain(page, "home");
        await capture(`home-${theme}-${width}-${scale}`);
        await navigateMain(page, "activity");
        await openActivitySessions(page);
        await capture(`activity-${theme}-${width}-${scale}`);
        await page.locator("#activityList .request-link").first().click();
        const technical = page.locator(".journey-item").first().locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Technical details$/ }) }).first();
        if (await technical.getAttribute("open") === null) await technical.locator(":scope>summary").click();
        await capture(`details-${theme}-${width}-${scale}`);
        await navigateMain(page, "reports");
        await chooseReportScope(page, "all");
        await reportContents(page);
        await capture(`report-${theme}-${width}-${scale}`);
        await navigateMain(page, "settings");
        await navigateSettings(page, "collection");
        await capture(`settings-${theme}-${width}-${scale}`);
    }
    if (proofs) await writeFile(path.join(proofs, "all-gaps.json"), JSON.stringify(measurements, null, 2));
    for (const { view, geometry } of measurements) for (const item of geometry) {
        assert.ok(item.gap >= 4 && item.gap <= 8, `${view}/${item.name}: ${item.gap}px visible gap`);
        assert.ok(item.target.width >= 44 && item.target.height >= 44, `${view}/${item.name}: 44px target`);
        assert.ok(item.glyph.top < item.text.bottom && item.glyph.bottom > item.text.top, `${view}/${item.name}: glyph stays on the final text line`);
        assert.ok(Math.abs(item.glyph.top + item.glyph.height / 2 - (item.text.top + item.text.bottom) / 2) <= 2, `${view}/${item.name}: text/glyph centers align`);
    }
    t.diagnostic(`${measurements.length} renderer states; ${measurements.reduce((sum, item) => sum + item.geometry.length, 0)} help anchors measured`);
});

test("help popups stay close to the glyph and fit after live text resizing", async t => {
    const page = await setup(t);
    const control = page.getByRole("button", { name: "About When", exact: true });
    await control.focus();
    await page.getByRole("tooltip").waitFor();
    async function geometry() {
        return control.evaluate(button => {
            const icon = button.querySelector("svg").getBoundingClientRect(), tip = document.querySelector("[role=tooltip]").getBoundingClientRect();
            return { icon: { left: icon.left, right: icon.right, top: icon.top, bottom: icon.bottom },
                tip: { left: tip.left, right: tip.right, top: tip.top, bottom: tip.bottom }, width: innerWidth, height: innerHeight };
        });
    }
    function fits(value) {
        const gap = value.tip.top >= value.icon.bottom ? value.tip.top - value.icon.bottom : value.icon.top - value.tip.bottom;
        assert.ok(gap >= 4 && gap <= 10, `Popup-to-glyph gap is ${gap}px, independent of invisible target padding`);
        assert.ok(value.tip.left >= 8 && value.tip.right <= value.width - 8 && value.tip.top >= 8 && value.tip.bottom <= value.height - 8);
    }
    const original = await geometry();
    t.diagnostic(JSON.stringify(original));
    fits(original);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await page.waitForTimeout(80);
    fits(await geometry());
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
});

test("normal report help preserves checkbox targets, selection and layout for keyboard and touch", { timeout: 30000 }, async t => {
    const page = await setup(t, { hasTouch: true });
    await navigateMain(page, "reports");
    await chooseReportScope(page, "all");
    await reportContents(page);
    const results = [];
    for (const theme of ["dark", "light"]) for (const [width, scale] of [[1200, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        for (const name of ["HTML", "PDF", "JSON", "Markdown"]) {
            const control = page.getByRole("button", { name: `About ${name}`, exact: true });
            await control.scrollIntoViewIfNeeded();
            const read = () => page.locator("#formatOptions").evaluate(root => {
                const box = node => {
                    const r = node.getBoundingClientRect();
                    return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height };
                };
                return [...root.querySelectorAll(".field-help-choice")].map(row => ({
                    label: box(row.querySelector("label")), help: box(row.querySelector(".ux-help")),
                    checkbox: box(row.querySelector("input")), selected: row.querySelector("input").checked,
                }));
            });
            const before = await read();
            for (const item of before) {
                assert.ok(item.label.height >= 44 && item.label.width >= 44, "Checkbox label is a 44px target");
                assert.ok(item.help.width >= 44 && item.help.height >= 44, "Help is a distinct 44px target");
                assert.ok(item.label.x + item.label.width <= item.help.x, "Checkbox label and help never overlap");
            }
            await control.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
            assert.equal(await control.evaluate(node => node === document.activeElement), true, "Tab reaches help after checkbox");
            await page.getByRole("tooltip").waitFor();
            assert.match(await control.getAttribute("aria-describedby"), /evidence-tooltip/);
            assert.equal(await control.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
            assert.deepEqual(await read(), before, "Focus help cannot change selection or shift controls");
            await page.keyboard.press("Escape");
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            await control.press("Enter"); await page.getByRole("tooltip").waitFor();
            assert.deepEqual(await read(), before);
            await page.keyboard.press("Escape");
            await control.tap(); await page.getByRole("tooltip").waitFor();
            assert.deepEqual(await read(), before, "Help tap does not select or deselect the checkbox");
            const tip = await page.getByRole("tooltip").evaluate(node => {
                const r = node.getBoundingClientRect(), style = getComputedStyle(node), range = document.createRange();
                range.selectNodeContents(node);
                const text = range.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
                    paddingX: parseFloat(style.paddingLeft), paddingY: parseFloat(style.paddingTop), textWidth: text.width, textHeight: text.height,
                    lineHeight: parseFloat(style.lineHeight), fontSize: parseFloat(style.fontSize),
                    overflowX: node.scrollWidth - node.clientWidth, overflowY: node.scrollHeight - node.clientHeight, viewportWidth: innerWidth, viewportHeight: innerHeight };
            });
            assert.ok(tip.left >= 8 && tip.right <= width - 8 && tip.top >= 8 && tip.bottom <= 992, "Popup stays inside viewport");
            assert.ok(tip.overflowX <= 1 && tip.overflowY <= 1, "Existing explanations fit without clipping");
            assert.ok(tip.height - tip.textHeight <= 2 * tip.paddingY + tip.lineHeight - tip.fontSize + 3, `No empty vertical popup space: ${JSON.stringify(tip)}`);
            assert.ok(tip.width - tip.textWidth <= 2 * tip.paddingX + 35, "Content-fit width, not a blank wide popup");
            if (proofs && name === "Markdown") await page.screenshot({ path: path.join(proofs, `report-help-${theme}-${width}-${scale}.png`) });
            results.push({ theme, width, scale, name, before, tip });
            await page.keyboard.press("Escape");
            await control.tap(); await page.getByRole("tooltip").waitFor();
            await page.locator("#formatOptions>legend").tap({ position: { x: 5, y: 5 } });
            assert.equal(await page.getByRole("tooltip").isVisible(), false, "Outside touch dismisses help");
            assert.deepEqual(await read(), before);
        }
    }
    if (proofs) await writeFile(path.join(proofs, "report-help-interaction.json"), JSON.stringify(results, null, 2));
});

test("field help never orphans or collides while the normal layout crosses its wrap thresholds", { timeout: 30000 }, async t => {
    const page = await setup(t);
    await navigateMain(page, "activity");
    const measurements = [];
    for (const scale of [1, 2]) {
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        for (let width = 320; width <= 1440; width += 20) {
            await page.setViewportSize({ width, height: 1000 });
            const items = await visibleHelpGeometry(page);
            measurements.push({ width, scale, items });
            for (const item of items) {
                assert.ok(item.gap >= 4 && item.gap <= 8, `${width}/${scale}/${item.name}: ${item.gap}px gap`);
                assert.ok(item.glyph.top < item.text.bottom && item.glyph.bottom > item.text.top, "Help remains on its label's final line");
                for (const other of items) {
                    const overlap = item.target.left < other.text.right && item.target.right > other.text.left
                        && item.target.top < other.text.bottom && item.target.bottom > other.text.top;
                    assert.equal(overlap, false, `${width}/${scale}/${item.name} target cannot overlap ${other.name} text`);
                }
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "wrap-thresholds.json"), JSON.stringify(measurements, null, 2));
});

test("long explanation flips at the bottom edge, and Settings action help retains its real control anchor", async t => {
    const page = await setup(t);
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await navigateMain(page, "activity");
    const control = page.getByRole("button", { name: "About Find a Copilot chat or request group", exact: true });
    await control.evaluate(node => scrollBy(0, node.getBoundingClientRect().bottom - innerHeight + 32));
    await control.hover(); await page.getByRole("tooltip").waitFor();
    const nearEdge = await control.evaluate(node => {
        const glyph = node.querySelector("svg").getBoundingClientRect(), tip = document.querySelector("[role=tooltip]").getBoundingClientRect();
        return { gap: glyph.top - tip.bottom, left: tip.left, right: tip.right, top: tip.top, bottom: tip.bottom, glyphTop: glyph.top };
    });
    assert.ok(nearEdge.gap >= 4 && nearEdge.gap <= 10, JSON.stringify(nearEdge));
    assert.ok(nearEdge.left >= 8 && nearEdge.right <= 367 && nearEdge.top >= 8);
    if (proofs) await page.screenshot({ path: path.join(proofs, "long-help-bottom-edge.png") });
    await page.keyboard.press("Escape");
    await navigateMain(page, "settings"); await navigateSettings(page, "connection");
    const action = page.locator("#reviewSource");
    await action.focus(); await page.getByRole("tooltip").waitFor();
    const settings = await action.evaluate(node => {
        const target = node.getBoundingClientRect(), tip = document.querySelector("[role=tooltip]").getBoundingClientRect();
        return { name: node.textContent, width: target.width, height: target.height,
            gap: tip.top >= target.bottom ? tip.top - target.bottom : target.top - tip.bottom };
    });
    assert.ok(settings.width >= 44 && settings.height >= 44 && settings.gap >= 4 && settings.gap <= 10, JSON.stringify(settings));
    if (proofs) await page.screenshot({ path: path.join(proofs, "settings-action-help.png") });
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
});

test("information help keeps hover and pressed targets unpainted without losing focus or interaction", { timeout: 60000 }, async t => {
    const page = await setup(t, { hasTouch: true }), observations = [];
    const readPaint = control => control.evaluate(node => {
        const css = getComputedStyle(node), box = node.getBoundingClientRect(), glyph = node.querySelector("svg").getBoundingClientRect();
        return {
            name: node.getAttribute("aria-label"), background: css.backgroundColor, image: css.backgroundImage, shadow: css.boxShadow,
            color: css.color, ink: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim(),
            outlineStyle: css.outlineStyle, outlineWidth: css.outlineWidth,
            target: { x: box.x, y: box.y + scrollY, width: box.width, height: box.height },
            glyph: { x: glyph.x, y: glyph.y + scrollY, width: glyph.width, height: glyph.height },
            before: getComputedStyle(node, "::before").content, after: getComputedStyle(node, "::after").content,
        };
    });
    const selections = () => page.locator("#workspace").evaluate(root => [...root.querySelectorAll("select,input[type=checkbox],input[type=radio]")]
        .map(node => ({ id: node.id, name: node.name, value: node.value, checked: node.checked,
            selected: node instanceof HTMLSelectElement ? [...node.selectedOptions].map(option => option.value) : null })));
    async function inspect(control, family, context) {
        await page.mouse.move(0, 0);
        await control.scrollIntoViewIfNeeded();
        const before = await readPaint(control), selection = await selections();
        await control.hover();
        await page.getByRole("tooltip").waitFor();
        const hover = await readPaint(control);
        if (proofs && ["field", "format"].includes(family)) {
            await page.screenshot({ path: path.join(proofs, `paint-${family}-${context}.png`) });
        }
        await page.mouse.down();
        const pressed = await readPaint(control);
        await page.mouse.up();
        await page.keyboard.press("Escape");
        await control.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
        assert.equal(await control.evaluate(node => document.activeElement === node), true, "Keyboard returns to the same help control");
        await page.getByRole("tooltip").waitFor();
        const focus = await readPaint(control);
        assert.equal(focus.outlineStyle, "solid", "Keyboard focus remains visibly outlined");
        assert.ok(parseFloat(focus.outlineWidth) >= 2);
        assert.match(await control.getAttribute("aria-describedby"), /evidence-tooltip/);
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        await control.tap(); await page.getByRole("tooltip").waitFor();
        const touch = await readPaint(control);
        await page.locator("#pageTitle").tap({ position: { x: 5, y: 5 } });
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "Outside touch still dismisses");
        assert.deepEqual(await selections(), selection, "Help cannot change filters, report choices or selection");
        for (const state of [hover, pressed, focus, touch]) {
            assert.deepEqual(state.target, before.target, "Pointer, keyboard and touch cannot resize or move the target");
            assert.deepEqual(state.glyph, before.glyph, "Accepted icon spacing stays unchanged");
            assert.ok(state.target.width >= 44 && state.target.height >= 44);
        }
        observations.push({ family, context, before, hover, pressed, focus, touch });
    }
    for (const theme of ["light", "dark"]) for (const width of [1200, 375]) for (const scale of [1, 2]) {
        const context = `${theme}-${width}-${scale}`;
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await navigateMain(page, "home");
        await inspect(page.getByRole("button", { name: "About When", exact: true }), "field", context);
        await inspect(page.locator("#homeInsights").getByRole("button", { name: "About Accuracy", exact: true }), "metric", context);
        await navigateMain(page, "activity"); await openActivitySessions(page);
        await page.locator("#activityList .request-link").first().click();
        await inspect(page.locator(".metadata-help:visible").first(), "metadata", context);
        await inspect(page.locator(".action-service-heading .ux-help").first(), "action-service", context);
        await navigateMain(page, "reports"); await chooseReportScope(page, "all"); await reportContents(page);
        await inspect(page.getByRole("button", { name: "About Export formats", exact: true }), "legend", context);
        await inspect(page.getByRole("button", { name: "About HTML", exact: true }), "format", context);
    }
    if (proofs) await writeFile(path.join(proofs, "help-target-paint.json"), JSON.stringify(observations, null, 2));
    const failures = [];
    for (const observation of observations) for (const phase of ["hover", "pressed", "focus", "touch"]) {
        const paint = observation[phase];
        if (paint.background !== "rgba(0, 0, 0, 0)" || paint.image !== "none" || paint.shadow !== "none" ||
            !["none", "normal"].includes(paint.before) || !["none", "normal"].includes(paint.after)) {
            failures.push(`${observation.context}/${observation.family}/${phase}: ${paint.background}, shadow ${paint.shadow}`);
        }
    }
    t.diagnostic(`${observations.length} normal-renderer help controls; hover, held press, keyboard focus and touch checked`);
    assert.deepEqual(failures, [], "Information help must not paint its invisible hit area");
});
