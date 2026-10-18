import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { chooseTheme, navigateMain, navigateSettings, openSourceEditor, selectActivityOption } from "./helpers.mjs";
import { chooseReportScope, reportContents, openReportLibrary, openReportComparison } from "./report-journey-helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { contrast, rgb, shadowPaint } from "./color-measurements.mjs";

const proofs = process.env.WIRE_DEPTH_PROOFS;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("existing screen families share soft depth and themed switches without changing evidence or action ownership", { timeout: 90000 }, async t => {
    const app = await authorFilterFixture(t, { serviceCases: true });
    const entries = [];
    for (const [index, record] of [app.cases.ownMail, app.cases.agentMail].entries()) {
        const state = await loadBoardState(app.context);
        const preview = await app.exports.preview("surface-depth-seed", undefined, {
            title: `Planning review ${index + 1}`, promptMode: "none", formats: ["html", "json"],
        }, { kind: "selected", revision: state.revision, scenarioIds: [record.scenarioId] });
        await app.exports.review("surface-depth-seed", preview.previewId, true);
        entries.push((await app.exports.confirm("surface-depth-seed", preview.previewId, true)).bundle);
    }
    const before = await loadBoardState(app.context), files = entries.flatMap(entry => Object.values(entry.files));
    const originalBytes = await Promise.all(files.map(async file => hash(await readFile(file))));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "no-preference" });
    const errors = [], denied = [], scenes = [], flights = [], paint = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(app.runtime.url).origin || /\/api\/(?:export$|artifact-deletion\/confirm|report-comparison\/save|collection\/(?:configure|now|enabled))/.test(url.pathname)) {
            denied.push(request.method() + " " + url.pathname);
            return route.abort();
        }
        return route.continue();
    });
    app.closeClient(async () => {
        await browser.close();
        const after = await loadBoardState(app.context);
        assert.deepEqual(after.exports, before.exports);
        assert.deepEqual(after.evidence, before.evidence);
        assert.deepEqual(after.collection, before.collection);
        assert.deepEqual(await Promise.all(files.map(async file => hash(await readFile(file)))), originalBytes);
        assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    const ready = () => page.locator('#workspace[aria-busy="false"]').waitFor();
    const settle = () => page.waitForFunction(() => [...document.querySelectorAll("#main,#sidebar,#contextSidebar,.navigation-drawer,.theme-thumb,.select-toggle")]
        .every(node => node.getAnimations({ subtree: true }).every(animation => animation.playState !== "running")));
    async function capture(name, selectors = []) {
        await settle();
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.evaluate(selectors => {
            const roots = selectors.map(selector => document.querySelector(selector)).filter(Boolean);
            return {
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                surfaces: roots.map(node => {
                    const css = getComputedStyle(node), bounds = node.getBoundingClientRect();
                    return { selector: node.id || node.className, fill: css.backgroundColor, ink: css.color,
                        shadow: css.boxShadow, radius: css.borderRadius, font: css.fontFamily,
                        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
                }),
                controls: roots.flatMap(root => [...root.querySelectorAll("button,.select-option")])
                    .filter(node => node.checkVisibility()).map(node => {
                        const bounds = node.getBoundingClientRect();
                        return { name: node.getAttribute("aria-label") || node.textContent.trim(), height: bounds.height,
                            clipped: node.scrollWidth > node.clientWidth + 1 };
                    }),
            };
        }, selectors);
        assert.equal(measured.overflow, false, name);
        assert.deepEqual(measured.controls.filter(control => control.height < 44 || control.clipped), [], name);
        for (const surface of measured.surfaces) {
            assert.ok(surface.bounds.x >= -1 && surface.bounds.x + surface.bounds.width <= page.viewportSize().width + 1,
                `${name}: settled surface and its content stay inside the viewport (${JSON.stringify(surface.bounds)})`);
            assert.notEqual(surface.shadow, "none", name + " raised plane");
            assert.match(surface.font, /^"Asta Sans"/);
            if (surface.fill !== "rgba(0, 0, 0, 0)") assert.ok(contrast(surface.ink, surface.fill) >= 4.5, name);
        }
        scenes.push({ name, ...measured });
        if (proofs) await page.screenshot({ path: path.join(proofs, name + ".png") });
    }
    async function naturalToggle(control, marker, name) {
        await control.evaluate((node, marker) => {
            const target = node.querySelector(marker);
            window.depthFlight = new Promise(resolve => {
                node.addEventListener("click", () => {
                    const start = performance.now(), frames = [];
                    const observe = () => {
                        const css = getComputedStyle(target, marker === ".select-toggle" ? "::after" : null);
                        const box = node.getBoundingClientRect();
                        frames.push({ time: performance.now() - start, transform: css.transform,
                            bounds: { width: box.width, height: box.height },
                            paused: node.getAnimations({ subtree: true }).some(animation => animation.playState === "paused") });
                        if (performance.now() - start < 190) requestAnimationFrame(observe);
                        else resolve(frames);
                    };
                    requestAnimationFrame(observe);
                }, { once: true });
            });
        }, marker);
        await control.click();
        const frames = await page.evaluate(() => window.depthFlight);
        assert.ok(new Set(frames.map(frame => frame.transform)).size >= 3, name + " natural intermediate thumb paint");
        assert.ok(frames.every(frame => !frame.paused));
        assert.ok(frames.every(frame => frame.bounds.width === frames[0].bounds.width && frame.bounds.height === frames[0].bounds.height));
        flights.push({ name, frames });
    }
    async function checkThemeGlyphs() {
        const glyphs = await page.locator("#themePreference").evaluate(node => {
            const active = node.getAttribute("aria-checked") === "true" ? "moon" : "sun";
            return ["moon", "sun"].map(name => ({
                ink: getComputedStyle(node.querySelector(".theme-" + name)).color,
                fill: getComputedStyle(node.querySelector(name === active ? ".theme-thumb" : ".theme-track")).backgroundColor,
            }));
        });
        for (const glyph of glyphs) assert.ok(contrast(glyph.ink, glyph.fill) >= 3, JSON.stringify(glyphs));
    }
    await page.goto(app.runtime.url); await ready();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme); await settle();
        await checkThemeGlyphs();
        await page.evaluate(() => scrollTo(0, 0));
        await capture(`${theme}-analyze`, [".analyze-population", ".analyze-outcome-summary", ".analyze-chart-main"]);
        await page.locator(".analyze-outcome-summary").scrollIntoViewIfNeeded();
        const panelPaint = await shadowPaint(page, ".analyze-outcome-summary", "bottom");
        assert.ok(panelPaint.bands[0].darkening > .5, theme + " widget casts an actual shadow");
        assert.ok(panelPaint.bands.at(-1).darkening < panelPaint.bands[0].darkening, theme + " depth fades");
        paint.push({ theme, surface: "widget", bands: panelPaint.bands });
        await page.locator("#outcomeFilter-control").click();
        await capture(`${theme}-filter`, [".select-popup"]);
        const option = page.locator(".select-popup .select-option").first();
        const switchPaint = await option.evaluate(node => {
            const marker = node.querySelector(".select-toggle"), css = getComputedStyle(marker);
            return { fill: css.backgroundColor, thumb: getComputedStyle(marker, "::after").backgroundColor,
                selected: node.getAttribute("aria-selected"), label: getComputedStyle(node.querySelector(".select-option-label")).color,
                track: { width: marker.getBoundingClientRect().width, height: marker.getBoundingClientRect().height } };
        });
        assert.equal(switchPaint.selected, "true");
        assert.deepEqual(switchPaint.track, { width: 32, height: 20 });
        assert.ok(Math.max(...rgb(switchPaint.fill)) - Math.min(...rgb(switchPaint.fill)) > 40, "Selected fill is not black/white");
        assert.ok(contrast(switchPaint.thumb, switchPaint.fill) >= 3, "Thumb remains visible");
        await naturalToggle(option, ".select-toggle", `${theme}-switch-off`);
        await capture(`${theme}-filter-off`, [".select-popup"]);
        await option.focus(); await page.keyboard.press("Shift");
        await naturalToggle(option, ".select-toggle", `${theme}-switch-on`);
        await page.locator(".select-popup").getByRole("button", { name: "Cancel", exact: true }).click();
        await naturalToggle(page.locator("#themePreference"), ".theme-thumb", `${theme}-theme-switch`);
        await chooseTheme(page, theme); await settle();
        await page.locator('[data-analyze-mode="calls"]').click();
        await capture(`${theme}-calls`, ["#activityList>.activity-card"]);
        await page.locator('[data-analyze-mode="interactions"]').click();
        await page.locator(".request-card-open").first().click();
        await capture(`${theme}-reader`, ["#contextSidebar"]);
        await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
        await capture(`${theme}-reader-folded`, ["#contextSidebar"]);
        await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
        await capture(`${theme}-reader-expanded`, ["#contextSidebar"]);
        const linked = page.locator("#requestContent .reader-linked-context");
        if (await linked.count()) {
            if (!await linked.evaluate(node => node.open)) await linked.locator(":scope>summary").click();
            await settle();
            await linked.locator("li").first().scrollIntoViewIfNeeded();
            await capture(`${theme}-linked-context`, ["#contextSidebar"]);
        }
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        await navigateMain(page, "settings");
        for (const category of ["connection", "privacy", "display", "troubleshooting"]) {
            await navigateSettings(page, category);
            await capture(`${theme}-settings-${category}`, [".settings-content"]);
            if (category === "connection") {
                await openSourceEditor(page);
                await capture(`${theme}-source-permission`, [".settings-content"]);
                await page.locator("#cancelSource").click();
            }
        }
        await navigateSettings(page, "privacy"); await page.locator("#deleteActivity").click();
        await capture(`${theme}-deletion-scope`, ["#deleteDialog"]);
        await page.locator("#deleteAll").check();
        await page.locator("#deletePreview").click();
        await page.locator("#deleteConfirm:not([disabled])").waitFor();
        await capture(`${theme}-confirmation`, ["#deleteDialog"]);
        await page.locator("#deleteCancel").click();
        await navigateMain(page, "collection-status");
        await capture(`${theme}-collection`, ["#collectionStatusView>.settings-section"]);
        await navigateMain(page, "reports");
        await capture(`${theme}-reports`, ["#bundles"]);
        await page.locator(".saved-report-summary").first().click();
        await capture(`${theme}-report-inspector`, ["#contextSidebar", "#bundles"]);
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        await chooseReportScope(page, "all"); await reportContents(page);
        await page.locator('input[name="promptMode"][value="masked"]').check();
        await capture(`${theme}-contents`, ["#contextSidebar", "#reportCreatePanel"]);
        const refused = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator("#exportBtn").click();
        const refusal = await refused;
        assert.equal(refusal.status(), 422);
        await page.locator("#reportJourneyError").waitFor();
        assert.match(await page.locator("#reportJourneyError").textContent(), /required tool prompt\/argument field is missing/);
        await capture(`${theme}-privacy-blocked`, ["#reportCreatePanel"]);
        await chooseReportScope(page, "selected");
        if (await page.locator("#reportClearSelection").isVisible()) await page.locator("#reportClearSelection").click();
        await page.locator("#reportRequestSearch").fill(app.cases.ownMail.content);
        await page.locator('#reportList input[type="checkbox"]').check();
        await reportContents(page);
        const prepared = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator("#exportBtn").click();
        const result = await prepared;
        assert.equal(result.status(), 200, await result.text());
        await page.waitForFunction(() => document.querySelector("#reportsView").dataset.reportPhase === "ready"
            || document.querySelector("#reportJourneyError").checkVisibility());
        assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "ready",
            await page.locator("#reportJourneyError").textContent());
        await capture(`${theme}-review`, ["#reportCreatePanel"]);
        await page.getByRole("tab", { name: /^Files/ }).click();
        await capture(`${theme}-report-files`, ["#reportCreatePanel"]);
        await openReportLibrary(page); await openReportComparison(page);
        for (const [label, entry] of [["Earlier report", entries[0]], ["Later report", entries[1]]]) {
            await page.locator("#comparisonWorkspace").getByRole("combobox", { name: label, exact: true }).click();
            await page.locator(`.select-popup .select-option[data-value="${entry.bundleId}"]`).click();
        }
        const compare = page.locator("#comparisonWorkspace").getByRole("button", { name: "Compare reports", exact: true });
        if (await compare.isVisible()) await compare.click();
        await page.locator("#comparisonWorkspace").getByRole("button", { name: /^(Prepare comparison copy|Return to review)$/ }).click();
        await page.locator("#comparisonWorkspace iframe").waitFor();
        await capture(`${theme}-comparison`, ["#comparisonWorkspace"]);
        await openReportLibrary(page);
        await page.locator("#wireSearch").fill("Invented");
        await page.locator("#wireSearchResults button").first().waitFor();
        await capture(`${theme}-search`, ["#wireSearchPanel"]);
        await page.locator("#wireSearch").press("Escape");
        await page.locator("#wireSearchClear").click();
        await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented temporarily unavailable stored view." } }), { times: 1 });
        const failed = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.status() === 503);
        await page.evaluate(() => dispatchEvent(new Event("online"))); await failed;
        await page.getByText(/Invented temporarily unavailable stored view/).first().waitFor();
        await capture(`${theme}-recovery`, ["#bundles"]);
        await page.evaluate(() => dispatchEvent(new Event("online"))); await ready();
        await navigateMain(page, "analyze");
        await selectActivityOption(page, "layerFilter", "code-reference"); await ready();
        assert.equal(await page.locator("#outcomeFilter-control").isDisabled(), true);
        await capture(`${theme}-disabled-filter`, [".analyze-population"]);
        await selectActivityOption(page, "layerFilter", "tool"); await ready();
        await page.setViewportSize({ width: 375, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await page.locator("#outcomeFilter-control").click();
        await capture(`${theme}-narrow-filter`, [".select-popup"]);
        await page.keyboard.press("Escape");
        await page.locator("#navigationToggle").click();
        await capture(`${theme}-narrow-navigation`, [".navigation-drawer"]);
        await page.keyboard.press("Escape");
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1440, height: 1100 });
    }
    await page.emulateMedia({ forcedColors: "active" });
    await page.locator("#outcomeFilter-control").press("ArrowDown");
    await settle();
    const forced = await page.locator(".select-popup .select-toggle").evaluateAll(nodes => nodes.map(node => ({
        fill: getComputedStyle(node).backgroundColor, thumb: getComputedStyle(node, "::after").backgroundColor,
    })));
    for (const marker of forced) assert.ok(contrast(marker.fill, marker.thumb) >= 3);
    await checkThemeGlyphs();
    const navGlyphs = await page.locator("#sidebar .primary-navigation a>.wire-icon").evaluateAll(nodes => nodes.map(node => {
        let surface = node.parentElement;
        while (surface && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement;
        return { ink: getComputedStyle(node).color, fill: getComputedStyle(surface).backgroundColor };
    }));
    for (const glyph of navGlyphs) assert.ok(contrast(glyph.ink, glyph.fill) >= 3);
    await capture("forced-switches");
    await page.keyboard.press("Escape");
    if (proofs) await writeFile(path.join(proofs, "surface-depth.json"), JSON.stringify({ scenes, flights, paint }, null, 2));
});
