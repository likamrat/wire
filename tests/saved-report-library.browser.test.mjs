import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, navigateMain, navigateSettings, chooseTheme } from "./helpers.mjs";
import { chooseReportScope, reportContents, openReportLibrary, openReportComparison, scanReport } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function setup(t, count = 1001, { prepared = false, title } = {}) {
    const records = prepared ? Array.from({ length: 8 }, (_, index) => {
        const record = fixture(`report-layout-${index}`);
        record.userPrompt.text = `Invented planning request ${index + 1}: summarize the release exercise and its next steps.`;
        return record;
    }) : [fixture()];
    const { context } = await privateFixture(t, records), controller = createExportController(context);
    const entries = [];
    if (prepared) t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-16T12:00:00.000Z") });
    if (prepared) for (let index = 0; index < count; index++) {
        t.mock.timers.setTime(Date.parse("2026-10-16T12:00:00.000Z") + index * 120000);
        const state = await loadBoardState(context), timeContext = { timeZone: "UTC", locale: "en-US" };
        const selection = index ? { kind: "selected", revision: state.revision, scenarioIds: records.slice(0, index + 1).map(record => record.scenarioId) }
            : { kind: "all", revision: state.revision };
        const preview = await controller.preview("synthetic-layout-seed", undefined, {
            title: index === count - 1
                ? title ?? "Readiness review - calendar changes, document lookups and unresolved follow-up across the planning exercise"
                : `Planning exercise ${index + 1}`,
            promptMode: ["none", "masked", "original"][index % 3],
            formats: index === count - 1 ? ["json"] : ["html", "pdf", "json", "markdown"], timeContext,
        }, selection);
        await controller.review("synthetic-layout-seed", preview.previewId, true, timeContext);
        entries.push((await controller.confirm("synthetic-layout-seed", preview.previewId, true, timeContext)).bundle);
    }
    else for (let index = 0; index < count + 1; index++) {
        const bundleId = `export-${randomUUID()}`, kind = index === count ? "comparison" : "report";
        const folder = path.join(context.dataDir, "exports", bundleId, "files");
        await mkdir(folder, { recursive: true });
        const name = kind === "report" ? "product-report.html" : "comparison-report.html";
        const html = `<!doctype html><html lang="en"><body><h1>Frozen synthetic ${kind} ${index + 1}</h1><p>SYNTHETIC_PRIVATE_CONTENT_NEVER_SEARCHED</p></body></html>`;
        const manifestName = "coverage-and-redaction-manifest.json";
        const manifest = JSON.stringify({ bundleId, kind, privacyReview: { reviewerConfirmed: true }, files: { [name]: { sha256: hash(html), bytes: Buffer.byteLength(html) } } });
        await writeFile(path.join(folder, name), html); await writeFile(path.join(folder, manifestName), manifest);
        entries.push({
            bundleId, kind, bundleDir: folder, formats: ["html"], promptMode: index % 2 ? "masked" : "none",
            preparedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
            selectionScope: { requestGroups: index + 1 }, privacyReview: { reviewerConfirmed: true },
            manifestHash: hash(manifest), files: { [name]: path.join(folder, name), [manifestName]: path.join(folder, manifestName) },
            ...(kind === "comparison" ? { sourceReports: entries.slice(0, 2).map(entry => ({ bundleId: entry.bundleId })) } : {}),
        });
    }
    if (prepared) t.mock.timers.reset();
    if (!prepared) await updateBoardState(context, state => { state.exports.push(...entries); });
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); runtime.server.closeAllConnections(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(60000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    return { page, context, entries, requests };
}
async function shot(page, name) {
    if (!process.env.WIRE_LIBRARY_PROOFS) return;
    await mkdir(process.env.WIRE_LIBRARY_PROOFS, { recursive: true });
    const modal = Boolean(await page.locator(":modal").count());
    if (!modal) await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(process.env.WIRE_LIBRARY_PROOFS, `${name}.png`), fullPage: !modal });
}

test("six saved reports share a deliberate page frame with tasks, inspector and wide document review", { timeout: 90000 }, async t => {
    const { page, context, entries, requests } = await setup(t, 6, { prepared: true });
    page.setDefaultTimeout(8000);
    const files = entries.flatMap(entry => Object.values(entry.files));
    const originals = await Promise.all(files.map(async file => hash(await readFile(file))));
    const measurements = [], violations = [], external = [];
    const origin = new URL(page.url()).origin;
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    async function capture(name, body, { library = false, wide = false } = {}) {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => Promise.all([...document.querySelectorAll("#main,#sidebar,#contextSidebar")]
            .flatMap(node => node.getAnimations()).map(animation => animation.finished)));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measured = await page.evaluate(({ body, library }) => {
            const box = node => {
                const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
                return { x, y, width, height, right, bottom };
            };
            const textRight = node => {
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), rights = [];
                for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                    if (text.parentElement.closest('svg,[aria-hidden="true"]')) continue;
                    const range = document.createRange(); range.selectNodeContents(text);
                    rights.push(...[...range.getClientRects()].filter(rect => rect.width).map(rect => rect.right));
                }
                return Math.max(...rights);
            };
            const frame = document.querySelector(body), heading = document.querySelector(".page-heading");
            const inspector = document.querySelector("#contextSidebar[open]:has(.saved-report-inspection)");
            const controls = [...document.querySelectorAll("#reportTaskNav a,#savedReportsPanel button,#savedReportsPanel summary,#savedReportSearch,#savedReportOrder-control")]
                .filter(node => node.checkVisibility()).map(node => {
                    const words = [], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                        if (text.parentElement.closest('svg,[aria-hidden="true"]')) continue;
                        for (const match of text.textContent.matchAll(/\S+/g)) {
                            const range = document.createRange();
                            range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
                            const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
                            if (rects.length) words.push({ word: match[0], lines: new Set(rects.map(rect => rect.y)).size,
                                left: Math.min(...rects.map(rect => rect.x)), right: Math.max(...rects.map(rect => rect.right)) });
                        }
                    }
                    return { label: node.getAttribute("aria-label") || node.textContent.trim(), box: box(node), words };
                });
            return { viewport: innerWidth, text: getComputedStyle(document.documentElement).fontSize,
                collapsed: document.querySelector("#navigationCollapse").getAttribute("aria-expanded") === "false",
                main: box(document.querySelector("#main")), heading: box(heading), body: box(frame),
                title: box(document.querySelector("#pageTitle")), controls,
                inspector: inspector ? {
                    title: box(inspector.querySelector(".saved-inspector-title")),
                    titleLine: parseFloat(getComputedStyle(inspector.querySelector(".saved-inspector-title")).lineHeight),
                    close: box(inspector.querySelector("#closeContextSidebar")),
                } : null,
                actions: [...document.querySelectorAll("#reportTaskNav a")].filter(node => node.checkVisibility()).map(box),
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                ...(library ? {
                    search: box(document.querySelector("#savedReportSearch")), order: box(document.querySelector("#savedReportOrder-control")),
                    tools: box(document.querySelector(".saved-library-heading")),
                    position: document.querySelector("#bundleList [data-page-position]").checkVisibility()
                        ? box(document.querySelector("#bundleList [data-page-position]")) : null,
                    pager: box(document.querySelector("#bundleList .list-pager")),
                    rows: [...document.querySelectorAll(".saved-library-row")].map(row => ({
                        box: box(row), identity: box(row.querySelector(".saved-report-identity")),
                        titleLine: parseFloat(getComputedStyle(row.querySelector(".saved-report-name")).lineHeight),
                        identityTextRight: textRight(row.querySelector(".saved-report-identity")),
                        summary: box(row.querySelector(".saved-report-summary")),
                        formats: box(row.querySelector(".saved-report-formats")),
                        pills: [...row.querySelectorAll(".report-format")].map(node => ({
                            ...box(node), text: node.textContent, textRight: textRight(node),
                            role: node.getAttribute("role"), tabIndex: node.tabIndex, weight: getComputedStyle(node).fontWeight,
                        })),
                        open: box(row.querySelector(":scope>button:not(.saved-report-summary),:scope>.saved-report-no-html")),
                    })),
                } : {}) };
        }, { body, library });
        measurements.push({ name, wide, ...measured });
        const fail = (condition, reason) => { if (condition) violations.push(`${name}: ${reason}`); };
        fail(Math.abs(measured.heading.x - measured.body.x) > 1 || Math.abs(measured.heading.width - measured.body.width) > 1,
            `heading ${measured.heading.width}px / body ${measured.body.width}px use different frames`);
        fail(measured.actions.some(action => action.x < measured.body.x - 1 || action.right > measured.body.right + 1), "task actions escape the body frame");
        fail(measured.overflow || measured.controls.some(control => control.box.height < 44
            || control.words.some(word => word.lines !== 1 || word.left < control.box.x - 1 || word.right > control.box.right + 1)),
            "page overflow, a sub-44px target or a fragmented label");
        if (measured.inspector) fail(measured.inspector.close.y > measured.inspector.title.y + measured.inspector.titleLine,
            "Close must remain at the start of a long inspector title, not float halfway down it");
        if (wide) fail(measured.body.width < Math.min(1200, measured.main.width - 48), "document review is constrained to a catalog width");
        if (library) {
            fail(measured.actions.length !== 2, "both report task entries must remain visible");
            fail(measured.rows.some(row => row.open.x < row.summary.right - 1
                ? row.open.y < row.summary.bottom || row.open.y - row.summary.bottom > 8
                : Math.abs(row.open.y + row.open.height / 2 - (row.identity.y + row.titleLine / 2)) > 8),
                "Open must align with the title, or follow the full-width summary on narrow rows");
            const rowsStart = measured.position?.bottom ?? measured.tools.bottom;
            fail(measured.position && measured.position.y - measured.tools.bottom > 16 || measured.rows[0].box.y - rowsStart > 16,
                "controls and rows must not reserve space for retired explanation or headings");
            fail(measured.rows.some(row => row.pills.some(pill => pill.x < row.formats.x || pill.right > row.formats.right + 1
                || pill.textRight > pill.right - 4 || pill.weight !== "400" || pill.role || pill.tabIndex >= 0)),
                "format labels must be readable passive capsules, not clipped controls");
            fail(measured.rows.some(row => Math.abs(row.identity.x - measured.rows[0].identity.x) > 1
                || Math.abs(row.formats.x - measured.rows[0].formats.x) > 1), "report names and file formats must align across rows");
            if (measured.viewport >= 1400 && measured.text === "16px") {
                fail(Math.abs(measured.search.y - measured.order.y) > 1 || measured.order.x - measured.search.right > 24, "search/order controls do not align");
                fail(measured.rows.some(row => row.open.x - row.formats.right > 24), "Open is detached from the file column");
            }
        }
        await shot(page, name);
    }
    assert.equal(entries.length, 6);
    assert.equal(await page.locator("#bundleList .saved-library-row").count(), 6);
    assert.equal(await page.locator("#savedLibraryTitle").textContent(), "Saved reports (6)");
    assert.equal(await page.locator("#savedLibraryHelp,.saved-library-columns,.saved-report-metadata,.saved-report-date,.saved-report-disambiguation").count(), 0);
    assert.equal(await page.locator("#bundleList .list-pager").isVisible(), false, "The heading already counts this unfiltered single page");
    for (const entry of entries) {
        const row = page.locator(`.saved-library-row[data-bundle-id="${entry.bundleId}"]`);
        assert.deepEqual(await row.locator(".report-format").allTextContents(),
            entry.formats.map(format => format === "markdown" ? "Markdown" : format.toUpperCase()));
    }
    for (const theme of ["light", "dark"]) for (const [width, text, collapsed] of [
        [2000, 100, false], [2000, 100, true], [1440, 100, false], [1440, 200, true], [375, 100, false], [375, 200, false],
    ]) {
        await page.setViewportSize({ width: 1440, height: 1100 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        if (await page.locator("#navigationCollapse").getAttribute("aria-expanded") === String(collapsed)) await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: width === 2000 ? 1220 : 1100 });
        await page.evaluate(text => { document.documentElement.style.fontSize = text + "%"; }, text);
        const name = `${theme}-${width}-${text}-${collapsed ? "collapsed" : "expanded"}`;
        await capture("library-" + name, "#bundles", { library: true });
        const inspect = page.locator(".saved-library-row").filter({ has: page.getByRole("button", { name: "Open saved report", exact: true }) }).first().locator(".saved-report-summary");
        await inspect.click();
        await page.locator("#contextSidebar[open]").waitFor();
        assert.equal(await page.locator(".saved-inspector-files p").count(), 0, "Normal file controls need no operation narration");
        await capture("inspector-" + name, "#bundles", { library: true });
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        assert.equal(await inspect.evaluate(node => node === document.activeElement), true);
    }
    await page.setViewportSize({ width: 2000, height: 1220 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await chooseTheme(page, "light");
    await page.locator("#savedLibraryManagement>summary").click();
    await capture("library-management-wide", "#bundles", { library: true });
    await page.locator("#savedLibraryManagement>summary").click();
    await chooseReportScope(page, "all");
    await capture("create-wide", "#reportCreatePanel");
    await reportContents(page);
    await capture("contents-wide", "#reportCreatePanel");
    await scanReport(page);
    await capture("review-wide", "#reportCreatePanel", { wide: true });
    await openReportLibrary(page);
    await openReportComparison(page);
    await page.locator("#comparisonWorkspace select").first().locator("option").nth(1).waitFor({ state: "attached" });
    await capture("comparison-wide", "#comparisonWorkspace");
    for (const [label, entry] of [["Earlier report", entries[0]], ["Later report", entries[1]]]) {
        await page.locator("#comparisonWorkspace").getByRole("combobox", { name: label, exact: true }).click();
        await page.locator(`.select-popup .select-option[data-value="${entry.bundleId}"]`).click();
    }
    await page.locator("#comparisonWorkspace").getByRole("button", { name: "Compare reports", exact: true }).click();
    await page.locator("#comparisonWorkspace").getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    await page.locator("#comparisonWorkspace .comparison-prepared-files iframe").waitFor();
    assert.equal(await page.locator("#comparisonWorkspace .comparison-task-heading").isVisible(), false);
    assert.equal(await page.locator("#pageTitle").evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator("#comparisonWorkspace .report-inspection-tabs").getByRole("button", { name: "Back to comparison choices", exact: true }).isVisible(), true);
    await capture("comparison-review-wide", "#comparisonWorkspace", { wide: true });
    await openReportLibrary(page);
    const htmlEntry = entries.find(entry => entry.formats.includes("html"));
    await page.locator(`.saved-library-row[data-bundle-id="${htmlEntry.bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").locator("h1").waitFor();
    await capture("saved-reader-wide", "#savedReportReader", { wide: true });
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await capture("returned-library-wide", "#bundles", { library: true });
    assert.deepEqual(await Promise.all(files.map(async file => hash(await readFile(file)))), originals);
    assert.equal((await loadBoardState(context)).exports.length, 6);
    assert.equal(requests.some(endpoint => ["/api/export", "/api/report-comparison/save", "/api/artifact-deletion/confirm"].includes(endpoint)), false);
    assert.deepEqual(external, []);
    if (process.env.WIRE_LIBRARY_PROOFS) await writeFile(path.join(process.env.WIRE_LIBRARY_PROOFS, "page-composition.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(violations, [], "Report header/actions/body, row spacing and complete labels must form one coherent page");
});

test("report search shares the compact Search capsule without changing its local scope or field geometry", { timeout: 30000 }, async t => {
    const { page, entries, requests } = await setup(t, 2, { prepared: true });
    const scoped = page.locator("#savedReportSearch"), global = page.locator("#wireSearch");
    const paint = locator => locator.evaluate(node => {
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        return Object.fromEntries(["fontFamily", "fontSize", "lineHeight", "fontWeight", "borderRadius", "paddingInlineStart",
            "paddingInlineEnd", "backgroundImage", "borderWidth"].map(key => [key, style[key]]).concat([["height", box.height]]));
    });
    const settled = () => page.waitForFunction(() => [...document.querySelectorAll("#wireSearch,#savedReportSearch")]
        .every(node => node.getAnimations().every(animation => animation.playState !== "running")));
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale + "%"; }, scale);
        await chooseTheme(page, theme);
        await page.mouse.move(0, 0);
        assert.deepEqual(await paint(scoped), await paint(global), "One shared capsule treatment, not an approximate second design");
        const before = await scoped.boundingBox(), mainBefore = await global.boundingBox();
        if (width === 1440) assert.ok(before.width <= 288 && before.width < mainBefore.width, "The scoped field stays compact beside the order control");
        const descriptions = await scoped.getAttribute("aria-describedby");
        assert.match(await page.locator("#" + descriptions).textContent(), /not report contents/);
        await global.focus(); await settled();
        const globalFocus = await global.evaluate(node => {
            const style = getComputedStyle(node);
            return { color: style.outlineColor, width: style.outlineWidth, offset: style.outlineOffset, shadow: style.boxShadow };
        });
        await scoped.focus(); await settled();
        assert.deepEqual(await scoped.evaluate(node => {
            const style = getComputedStyle(node);
            return { color: style.outlineColor, width: style.outlineWidth, offset: style.outlineOffset, shadow: style.boxShadow };
        }), globalFocus);
        const input = await scoped.elementHandle();
        await scoped.fill("masked");
        assert.equal(await page.locator(".saved-library-row").count(), 1);
        assert.equal(await page.locator(".saved-library-row").getAttribute("data-bundle-id"), entries[1].bundleId);
        assert.equal(await page.locator("#bundleList .list-pager").isVisible(), false, "One filtered page does not repeat its match count as a second range");
        assert.equal(await global.inputValue(), "");
        assert.equal(await scoped.evaluate((node, original) => node === original, input), true);
        const after = await scoped.boundingBox(), clear = page.locator("#clearSavedReportSearch");
        assert.equal(after.width, before.width); assert.equal(after.height, before.height);
        assert.deepEqual(await global.boundingBox(), mainBefore);
        assert.ok(await clear.evaluate(node => {
            const box = node.getBoundingClientRect();
            return box.width >= 44 && box.height >= 44 && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }));
        const glyphs = await page.locator(".saved-library-tools .search-capsule>.wire-search-icon svg,#wireSearchHome .search-capsule>.wire-search-icon svg").evaluateAll(nodes =>
            nodes.map(node => ({ icon: node.dataset.lucideIcon, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
        assert.equal(glyphs.length, 2); assert.deepEqual(glyphs[0], glyphs[1]);
        await shot(page, `scoped-search-${theme}-${width}-${scale}-focus`);
        await clear.click();
        assert.equal(await scoped.inputValue(), "");
        assert.equal(await scoped.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator(".saved-library-row").count(), 2);
        measurements.push({ theme, width, scale, before, after, glyphs, focus: globalFocus });
    }
    await page.emulateMedia({ forcedColors: "active" });
    await settled();
    assert.deepEqual(await paint(scoped), await paint(global));
    assert.equal(requests.some(endpoint => /\/api\/(?:search\/|report\/open|artifact-file|export$)/.test(endpoint)), false);
    if (process.env.WIRE_LIBRARY_PROOFS) await writeFile(path.join(process.env.WIRE_LIBRARY_PROOFS, "scoped-search.json"), JSON.stringify(measurements, null, 2));
});

test("shared controls distinguish pointer, persistent selection, focus, primary and disabled states without moving their targets", { timeout: 60000 }, async t => {
    const { page, context, entries, requests } = await setup(t, 4, { prepared: true });
    const originals = await Promise.all(entries.flatMap(entry => Object.values(entry.files)).map(async file => hash(await readFile(file))));
    const evidence = [];
    await page.setViewportSize({ width: 2000, height: 1220 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#navigationCollapse").click();
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    const settle = locator => locator.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)));
    const settleLayout = () => page.evaluate(() => Promise.all([...document.querySelectorAll("#main,#sidebar,#contextSidebar,.report-inspection-tabs")]
        .flatMap(node => node.getAnimations({ subtree: node.matches(".report-inspection-tabs") })).map(animation => animation.finished)));
    async function capture(name) {
        if (!process.env.WIRE_LIBRARY_PROOFS) return;
        await settleLayout();
        await mkdir(process.env.WIRE_LIBRARY_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_LIBRARY_PROOFS, name + ".png") });
    }
    async function paint(locator) {
        return locator.evaluate(node => {
            const style = getComputedStyle(node), before = getComputedStyle(node, "::before"), box = node.getBoundingClientRect();
            const pseudo = before.content !== "none" && before.display !== "none" && before.zIndex === "-1";
            const face = pseudo ? before : style;
            let background = face.backgroundColor;
            for (let current = pseudo ? node : node.parentElement; current && background === "rgba(0, 0, 0, 0)"; current = current.parentElement) {
                background = getComputedStyle(current).backgroundColor;
            }
            return { background, fill: face.backgroundColor, ink: style.color, edge: style.borderInlineStartColor,
                border: face.borderColor, outline: style.outlineStyle, outlineWidth: style.outlineWidth,
                focused: node.matches(":focus-visible"), hover: node.matches(":hover"), pressed: node.matches(":active"),
                shadow: style.boxShadow, disabled: node.disabled, before: before.content,
                title: node.matches(".saved-report-summary") ? {
                    decoration: getComputedStyle(node.querySelector(".saved-report-name")).textDecorationLine,
                    thickness: getComputedStyle(node.querySelector(".saved-report-name")).textDecorationThickness,
                } : null,
                bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
                paintHeight: box.height - (pseudo ? parseFloat(before.top) + parseFloat(before.bottom) : 0) };
        });
    }
    async function exercise(locator, name, { activate = false } = {}) {
        await settleLayout();
        await locator.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0); await settle(locator);
        const rest = await paint(locator);
        await locator.hover(); await settle(locator);
        const hover = await paint(locator);
        await capture(name + "-hover");
        await page.mouse.down(); await settle(locator);
        const pressed = await paint(locator);
        await capture(name + "-pressed");
        if (!activate) await page.mouse.move(0, 0);
        await page.mouse.up();
        if (!activate) {
            await settle(locator);
            await locator.focus(); await page.keyboard.press("Shift");
            const focus = await paint(locator);
            assert.equal(focus.focused, true, name);
            assert.ok(parseFloat(focus.outlineWidth) >= 2, name);
            assert.deepEqual(focus.bounds, rest.bounds, name);
            await capture(name + "-focus");
            evidence.push({ name, rest, hover, pressed, focus });
        } else evidence.push({ name, rest, hover, pressed });
        assert.equal(hover.hover, true, name); assert.equal(pressed.pressed, true, name);
        assert.deepEqual(rest.bounds, hover.bounds, name); assert.deepEqual(rest.bounds, pressed.bounds, name);
        if (rest.title) {
            assert.equal(rest.fill, "rgba(0, 0, 0, 0)");
            assert.equal(hover.fill, rest.fill); assert.equal(pressed.fill, rest.fill);
            assert.equal(hover.title.decoration, "underline"); assert.equal(hover.title.thickness, "1px");
            assert.equal(pressed.title.decoration, "underline"); assert.equal(pressed.title.thickness, "2px");
        } else {
            assert.notEqual(rest.fill, hover.fill, name);
            assert.notEqual(hover.fill, pressed.fill, name);
        }
        for (const state of [rest, hover, pressed]) {
            assert.ok(contrast(state.ink, state.background) >= 4.5, name + " text contrast");
            assert.ok(state.bounds.height >= 44, name + " target");
        }
        return rest;
    }
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const row = page.locator(".saved-report-summary").first();
        const rest = await exercise(row, theme + "-library", { activate: true });
        await page.locator("#contextSidebar[open]").waitFor();
        await page.evaluate(() => Promise.all(document.querySelector("#contextSidebar").getAnimations().map(animation => animation.finished)));
        await page.mouse.move(0, 0); await settle(row);
        const selected = await paint(row);
        assert.equal(await row.getAttribute("aria-expanded"), "true");
        assert.equal(selected.fill, rest.fill, "Selection is a leading edge, not a persistent gray hover fill");
        assert.notEqual(selected.edge, rest.edge);
        assert.deepEqual(selected.bounds, rest.bounds, "Selecting does not add border/padding to the row");
        await capture(theme + "-library-selected");
        evidence.push({ name: theme + "-selected", ...selected });
        await exercise(page.locator(".saved-inspector-actions .primary"), theme + "-inspector-open");
        await exercise(page.locator(".saved-report-inspection .danger"), theme + "-delete-entry");
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        await exercise(page.locator("#reportCreateLink"), theme + "-create-entry");
        await page.locator("#reportCreateLink").click();
        const disabled = await paint(page.locator("#reportContinue"));
        assert.equal(disabled.disabled, true);
        assert.equal(disabled.fill, "rgba(0, 0, 0, 0)", "Disabled progression does not borrow selected paint");
        await capture(theme + "-empty-selection");
        await page.locator('input[name=reportScope][value=all]').check();
        await exercise(page.locator("#reportContinue"), theme + "-continue");
        await reportContents(page);
        await exercise(page.locator("#exportBtn"), theme + "-prepare");
        await scanReport(page);
        const tab = page.getByRole("tab", { name: "Report", exact: true });
        await tab.focus(); await page.keyboard.press("ArrowRight");
        const textTab = page.getByRole("tab", { name: /^Text/ });
        assert.equal(await textTab.getAttribute("aria-selected"), "true");
        const tabState = await paint(textTab);
        assert.equal(tabState.before, "none");
        assert.match(tabState.shadow, /inset/, "Active report tab keeps its underline instead of global button paint");
        assert.equal(tabState.focused, true);
        await capture(theme + "-review-tabs");
        await openReportLibrary(page);
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        const current = page.locator("#settingsCategoryNav [aria-current=page]");
        await page.mouse.move(0, 0); await settle(current);
        const currentRest = await paint(current);
        await current.hover(); await settle(current);
        const currentHover = await paint(current);
        assert.notEqual(currentRest.fill, currentHover.fill);
        assert.match(currentHover.shadow, /inset/, "Hover retains the current category keyline");
        await capture(theme + "-settings-current-hover");
        await navigateMain(page, "analyze");
        const card = page.locator(".request-card-open").first();
        await exercise(card, theme + "-analyze-card");
        await card.click();
        await page.locator("#contextSidebar[open]").waitFor();
        await page.mouse.move(0, 0); await settle(card);
        await capture(theme + "-analyze-selected");
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        await navigateMain(page, "reports");
        // The completed preview is explicitly abandoned before the next theme's empty-first journey.
        await page.locator("#reportCreateLink").click();
        await page.getByRole("button", { name: "1. Activity", exact: true }).click();
        await page.locator("#reportClearSelection").click();
        await openReportLibrary(page);
    }
    await chooseTheme(page, "light");
    const control = page.locator("#reportCreateLink");
    await page.mouse.move(0, 0); await settle(control);
    const before = await paint(control);
    await control.evaluate(node => {
        window.reportControlFlight = new Promise(resolve => {
            node.addEventListener("pointerenter", () => {
                const started = performance.now(), samples = [];
                const sample = () => {
                    const elapsed = performance.now() - started;
                    const box = node.getBoundingClientRect();
                    samples.push({ elapsed, fill: getComputedStyle(node, "::before").backgroundColor,
                        bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
                        transitions: node.getAnimations({ subtree: true }).map(animation => ({
                            state: animation.playState, duration: animation.effect.getTiming().duration,
                        })) });
                    if (elapsed < 170) requestAnimationFrame(sample);
                    else resolve(samples);
                };
                requestAnimationFrame(sample);
            }, { once: true });
        });
    });
    await control.hover();
    const samples = await page.evaluate(() => window.reportControlFlight);
    const after = await paint(control);
    assert.ok(samples.some(sample => sample.fill !== before.fill && sample.fill !== after.fill), "The natural hover has intermediate paint");
    assert.equal(samples.at(-1).fill, after.fill);
    assert.ok(samples.some(sample => sample.transitions.some(transition => transition.state === "running" && transition.duration === 140)));
    for (const sample of samples) {
        assert.deepEqual(sample.bounds, before.bounds);
        assert.ok(sample.transitions.every(transition => transition.state !== "paused"));
    }
    evidence.push({ name: "natural-unpaused-hover-flight", before, samples, after });
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await control.focus(); await page.keyboard.press("Shift");
    const forced = await paint(control);
    assert.ok(parseFloat(forced.outlineWidth) >= 2);
    assert.deepEqual(await page.locator(".saved-report-summary").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).borderInlineStartWidth)),
        entries.map(() => "0px"), "Forced colors must not paint the reserved selected edge on every row");
    await capture("forced-color-controls");
    await page.locator(".saved-report-summary").first().click();
    assert.equal(await page.locator(".saved-report-summary").first().evaluate(node => getComputedStyle(node).borderInlineStartWidth), "3px");
    assert.equal(await page.locator(".saved-report-summary").nth(1).evaluate(node => getComputedStyle(node).borderInlineStartWidth), "0px");
    await page.mouse.move(0, 0);
    await capture("forced-color-selection");
    assert.deepEqual(await Promise.all(entries.flatMap(entry => Object.values(entry.files)).map(async file => hash(await readFile(file)))), originals);
    assert.equal((await loadBoardState(context)).exports.length, entries.length);
    assert.equal(requests.some(endpoint => ["/api/export", "/api/artifact-deletion/confirm"].includes(endpoint)), false);
    if (process.env.WIRE_LIBRARY_PROOFS) await writeFile(path.join(process.env.WIRE_LIBRARY_PROOFS, "control-states.json"), JSON.stringify(evidence, null, 2));
});

test("the library is an immediately readable list with useful scope identity and a direct return from frozen reading", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, 8);
    page.setDefaultTimeout(8000);
    assert.equal(await page.locator("#bundles").evaluate(node => node.tagName), "SECTION");
    assert.equal(await page.locator("#coverage").isVisible(), false, "Live Analyze coverage must not masquerade as saved-report coverage");
    assert.equal(await page.locator("#bundleList .saved-report").count(), 6);
    assert.equal(await page.locator("#bundleList .list-pager").isVisible(), true);
    await page.getByRole("button", { name: "Next saved items", exact: true }).click();
    assert.match(await page.locator("#bundleList").innerText(), /7-9 of 9 saved items/);
    assert.equal(await page.locator("#bundleList .saved-library-columns").count(), 0);
    await page.locator("#savedReportSearch").fill("SYNTHETIC_PRIVATE_CONTENT_NEVER_SEARCHED");
    assert.match(await page.locator("#bundleList").innerText(), /No saved reports match/);
    await page.locator("#savedReportSearch").fill("HTML");
    assert.equal(await page.locator("#savedReportSearchCount").textContent(), "9 of 9 saved items match.");
    await page.locator("#savedReportSearch").fill("masked");
    assert.equal(await page.locator("#savedReportSearchCount").textContent(), "4 of 9 saved items match.");
    assert.equal(await page.locator("#bundleList .list-pager").isVisible(), false, "The match count already describes this one-page result");
    await page.locator("#clearSavedReportSearch").click();
    assert.match(await page.locator("#bundleList").innerText(), /7-9 of 9 saved items/);
    await page.getByRole("button", { name: "Previous saved items", exact: true }).click();
    assert.equal(await page.locator("#bundleList .saved-library-columns").count(), 0);
    assert.doesNotMatch(await page.locator(".saved-report-summary").nth(1).innerText(), /interactions|Prepared|prompts/);
    assert.match(await page.locator(".saved-report-name").nth(1).textContent(), /Activity report.*2026/, "Untitled legacy copies retain their existing type/time identity");
    assert.doesNotMatch(await page.locator("#bundleList").innerText(), /Report ID:/);
    await page.locator("#savedReportSearch").fill("No prompts");
    const inspect = page.locator(".saved-library-row").filter({ has: page.getByRole("button", { name: "Open saved report", exact: true }) }).first().locator(".saved-report-summary");
    await inspect.click();
    await page.locator("#contextSidebar").waitFor({ state: "visible" });
    assert.equal(requests.includes("/api/report/open"), false, "Selection reads indexed metadata only");
    assert.match(await page.locator("#contextSidebarTitle").innerText(), /Activity report/);
    assert.match(await page.locator("#contextSidebarBody").innerText(), /Prepared/);
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").locator("h1").waitFor();
    assert.equal(await page.locator("#contextSidebar").isVisible(), false);
    assert.equal(await page.locator("#pageTitle").evaluate(node => node === document.activeElement), true);
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.locator("#contextSidebar").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Close saved report details", exact: true }).click();
    const open = page.getByRole("button", { name: "Open saved report", exact: true }).first();
    await open.click();
    await page.frameLocator("#savedReportReader iframe").locator("h1").waitFor();
    assert.equal(await page.locator("#savedReportReader iframe").getAttribute("sandbox"), "");
    assert.doesNotMatch(await page.locator("#savedReportReader").innerText(), /Report ID:/);
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    assert.equal(await page.locator("#contextSidebar").isVisible(), false, "Direct Open does not force an inspector on return");
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "No prompts");
    assert.equal(await open.evaluate(node => node === document.activeElement), true);
});

test("recorded format capsules never manufacture files or turn a missing saved copy into a verified read", { timeout: 30000 }, async t => {
    const { page, context, entries, requests } = await setup(t, 2);
    const missing = entries[0], unlisted = entries[1];
    await unlink(missing.files["product-report.html"]);
    await updateBoardState(context, state => {
        const entry = state.exports.find(item => item.bundleId === unlisted.bundleId);
        entry.files = {};
        entry.formats = [];
        delete entry.preparedAt;
        delete entry.promptMode;
        delete entry.selectionScope;
    });
    await page.reload();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    const noFiles = page.locator(`.saved-library-row[data-bundle-id="${unlisted.bundleId}"]`);
    assert.equal(await noFiles.locator(".report-format").count(), 0);
    assert.equal(await noFiles.locator(".saved-file-gap").textContent(), "Files not listed");
    assert.doesNotMatch(await noFiles.textContent(), /Preparation time unavailable/);
    assert.equal(await noFiles.getByRole("button", { name: "Open saved report", exact: true }).count(), 0);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const statusWords = await noFiles.locator(".saved-report-no-html").evaluate(node => {
            const text = node.firstChild;
            return [...text.textContent.matchAll(/\S+/g)].map(match => {
                const range = document.createRange();
                range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
                const rects = [...range.getClientRects()];
                return { word: match[0], lines: new Set(rects.map(rect => rect.y)).size };
            });
        });
        assert.ok(statusWords.every(word => word.lines === 1), `${theme}: unavailable-file status keeps whole words: ${JSON.stringify(statusWords)}`);
        const row = page.locator(`.saved-library-row[data-bundle-id="${missing.bundleId}"]`);
        assert.deepEqual(await row.locator(".report-format").allTextContents(), ["HTML"]);
        await noFiles.locator(".saved-report-summary").click();
        await page.locator("#contextSidebar[open]").waitFor();
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().every(animation => animation.playState !== "running"));
        assert.match(await page.locator(".saved-inspector-actions").textContent(), /No supported saved format/);
        await shot(page, theme + "-legacy-unlisted-files");
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        await row.getByRole("button", { name: "Open saved report", exact: true }).click();
        await page.locator("#savedReportReader .error").waitFor();
        assert.equal(await page.locator("#savedReportReader iframe").count(), 0);
        assert.equal(await page.locator("#savedReportReader .saved-report-downloads").count(), 0);
        await shot(page, theme + "-missing-file-error");
        await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    }
    assert.equal(requests.some(endpoint => ["/api/export", "/api/report-original", "/api/artifact-deletion/confirm"].includes(endpoint)), false);
});

test("saved titles share the reading scroller while fixed actions and successor headings retain their owner", { timeout: 30000 }, async t => {
    const title = "Planning review with calendar changes, document lookups and unresolved follow-up across the handover. ".repeat(3).slice(0, 200);
    const { page, context, entries, requests } = await setup(t, 2, { prepared: true, title });
    const originals = await Promise.all(entries.flatMap(entry => Object.values(entry.files)).map(async file => hash(await readFile(file))));
    const settle = () => page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().every(animation => animation.playState !== "running"));
    const inspect = index => page.locator(`[data-bundle-id="${entries[index].bundleId}"] .saved-report-summary`);
    const measurements = [];
    async function geometry() {
        return page.locator("#contextSidebar").evaluate(panel => {
            const rect = selector => panel.querySelector(selector).getBoundingClientRect().toJSON();
            return { body: rect("#contextSidebarBody"), close: rect("#closeContextSidebar"), footer: rect("#contextSidebarFooter"),
                open: rect("#contextSidebarFooter button"), height: innerHeight,
                title: panel.querySelector(".saved-inspector-title").textContent,
                label: document.getElementById(panel.getAttribute("aria-labelledby"))?.textContent,
                focus: document.activeElement.id, headings: panel.querySelectorAll(".saved-inspector-title").length };
        });
    }
    for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width: 375, height: 667 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await chooseTheme(page, theme);
        for (const index of [1, 0]) {
            await inspect(index).click(); await settle();
            const before = await geometry();
            assert.equal(before.title, entries[index].title);
            assert.equal(before.label, before.title);
            assert.equal(before.focus, "savedInspectorTitle");
            assert.equal(before.headings, 1);
            assert.ok(before.body.height >= 44 && before.body.bottom <= before.footer.y + 1);
            assert.ok(before.footer.bottom <= before.height + 1 && before.close.y >= 0);
            assert.ok(before.close.height >= 44 && before.open.height >= 44);
            assert.equal(await page.getByRole("dialog", { name: before.title, exact: true }).count(), 1);
            assert.equal(await page.locator("#contextSidebar").getByRole("heading", { name: before.title, exact: true }).count(), 1);
            assert.equal(await page.locator("#contextSidebarTitle").isVisible(), false);
            await shot(page, `${theme}-saved-${index ? "maximum" : "short"}-title-start`);
            await page.keyboard.press("PageDown");
            await page.waitForFunction(() => document.querySelector("#contextSidebarBody").scrollTop > 0);
            const after = await geometry();
            assert.deepEqual(after.close, before.close);
            assert.deepEqual(after.footer, before.footer);
            await page.locator(".saved-inspector-files").scrollIntoViewIfNeeded();
            for (const control of ["#closeContextSidebar", "#contextSidebarFooter button"]) {
                assert.ok(await page.locator(control).evaluate(node => {
                    const box = node.getBoundingClientRect();
                    return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
                }), `${control} remains genuinely reachable after reading the title and facts`);
            }
            measurements.push({ theme, index, before, after });
            await shot(page, `${theme}-saved-${index ? "maximum" : "short"}-title-scrolled`);
            await page.locator("#closeContextSidebar").press("Enter");
            await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
            assert.equal(await inspect(index).evaluate(node => node === document.activeElement), true);
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await inspect(1).click(); await settle();
    await navigateMain(page, "analyze");
    await page.locator(".request-card-open").first().click(); await settle();
    assert.equal(await page.locator("#contextSidebarTitle").isVisible(), true);
    assert.equal(await page.locator("#contextSidebarTitle").textContent(), "Interaction");
    assert.equal(await page.locator("#contextSidebar .saved-inspector-title").count(), 0);
    await page.locator("#closeContextSidebar").click();
    await navigateMain(page, "reports");
    await chooseReportScope(page, "all"); await reportContents(page); await settle();
    assert.equal(await page.locator("#contextSidebarTitle").isVisible(), true);
    assert.equal(await page.locator("#contextSidebarTitle").textContent(), "Report setup");
    assert.equal(await page.locator("#contextSidebar .saved-inspector-title").count(), 0);
    await openReportLibrary(page);
    await inspect(1).click(); await settle();
    assert.equal(await page.locator("#savedInspectorTitle").textContent(), title);
    await updateBoardState(context, state => { state.exports = state.exports.filter(entry => entry.bundleId !== entries[1].bundleId); });
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await page.getByRole("dialog", { name: "Report unavailable", exact: true }).waitFor();
    assert.equal(await page.locator("#savedInspectorTitle").textContent(), "Report unavailable");
    assert.equal(await page.locator("#contextSidebarFooter button").count(), 0);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    assert.deepEqual(await Promise.all(entries.flatMap(entry => Object.values(entry.files)).map(async file => hash(await readFile(file)))), originals);
    assert.equal(requests.some(endpoint => ["/api/export", "/api/report/open", "/api/artifact-deletion/confirm"].includes(endpoint)), false);
    if (process.env.WIRE_LIBRARY_PROOFS) await writeFile(path.join(process.env.WIRE_LIBRARY_PROOFS, "title-scroll.json"), JSON.stringify(measurements, null, 2));
});

test("Reports opens directly on the library and switching to creation preserves the reviewed draft and browser Back", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, 2);
    assert.equal(await page.locator("#pageTitle").innerText(), "Reports");
    assert.equal(await page.locator(".report-journey").isVisible(), false);
    assert.equal(await page.locator("#savedReportSearch").isVisible(), true);
    assert.equal(await page.locator("#savedReportSearch").getAttribute("placeholder"), "Search saved reports");
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), true);
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), false, "Finding a report does not require passing Setup");
    await page.locator("#savedReportSearch").focus();
    assert.equal(await page.locator("#savedReportSearch").evaluate(node => node === document.activeElement), true);
    await shot(page, "entry-library-first");
    const create = page.getByRole("link", { name: "Create a report", exact: true });
    assert.match(await create.getAttribute("href"), /task=create/);
    await create.click();
    assert.equal(await page.locator(".report-journey").isVisible(), true);
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), false);
    await chooseReportScope(page, "all");
    await reportContents(page);
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await previewResponse).json();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    const countBefore = requests.length;
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    assert.equal(await page.locator(".report-journey").isVisible(), false);
    await page.locator("#savedReportSearch").fill("masked");
    await page.locator("#bundleList").getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator("#savedReportReader iframe").waitFor();
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.goBack();
    assert.match(page.url(), /task=create/);
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed");
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "3");
    assert.equal(await page.getByRole("button", { name: "Save report", exact: true }).isEnabled(), true);
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), true);
    assert.equal(requests.slice(countBefore).some(url => ["/api/cancel-preview", "/api/preview", "/api/export"].includes(url)), false);
    assert.equal(requests.filter(url => url === "/api/preview").length, 1, preview.previewId);
    await page.goForward();
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "masked");
    await page.getByRole("link", { name: "Continue draft", exact: true }).click();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed");
    await shot(page, "entry-preserved-draft");
    const cancelledBefore = requests.filter(url => url === "/api/cancel-preview").length;
    await navigateMain(page, "activity");
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed", "Unrelated navigation preserves the verified report basis");
    assert.equal(requests.filter(url => url === "/api/cancel-preview").length, cancelledBefore);
});

test("Analyze chat create intent, request return and explicit creation deep links bypass the library without losing selection", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, 2);
    page.setDefaultTimeout(8000);
    const origin = new URL(page.url()).origin;
    await page.goto(origin + "/#activity?session=test-session");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.getByRole("button", { name: "Create report for this Copilot chat", exact: true }).click();
    assert.match(page.url(), /task=create/);
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 interaction/);
    await page.goBack();
    assert.match(page.url(), /#analyze/);
    await page.goForward();
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 interaction/);
    await page.locator("#reportList").getByRole("link", { name: "View interaction", exact: true }).click();
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Back to activity", exact: true }).click();
    assert.match(page.url(), /#reports.*task=create/);
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 interaction/);
    await navigateMain(page, "reports");
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), true, "Main Reports navigation always leads to the library");
    for (const hash of ["#reports?task=create", "#report", "#reports?request=test-scenario"]) {
        await page.goto(origin + "/" + hash);
        await page.reload();
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        assert.equal(await page.locator("#reportCreatePanel").isVisible(), true, hash);
        assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No interactions included", "A fresh panel does not invent selection from a deep link");
    }
    assert.equal(requests.some(url => ["/api/preview", "/api/export", "/api/artifact-deletion/confirm"].includes(url)), false);
});

test("a thousand-report library has bounded rows, direct page navigation, metadata search, frozen open and confirmed report-only deletion", { timeout: 120000 }, async t => {
    const { page, context, entries, requests } = await setup(t);
    const before = await loadBoardState(context);
    assert.equal(await page.locator("#bundleList .saved-report").count(), 6);
    assert.match(await page.locator("#savedReportCount").textContent(), /1,001 reports.*1 comparison/);
    await shot(page, "large-library-light");
    await page.getByRole("spinbutton", { name: "Saved library page", exact: true }).fill("167");
    await page.getByRole("button", { name: "Go to page", exact: true }).click();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await page.locator("#savedReportSearch").fill(entries[0].bundleId);
    assert.equal(await page.locator("#bundleList .saved-report").count(), 1);
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: "Frozen synthetic report 1", exact: true }).waitFor();
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Open saved report", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.locator("#savedReportSearch").fill("SYNTHETIC_PRIVATE_CONTENT_NEVER_SEARCHED");
    assert.match(await page.locator("#bundleList").textContent(), /No saved reports match/);
    await shot(page, "no-matches");
    await page.locator("#clearSavedReportSearch").click();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await navigateMain(page, "activity"); await page.goBack();
    assert.match(await page.locator("#bundleList").innerText(), /997-1,002 of 1,002/);
    await page.locator("#savedReportSearch").fill(entries[0].bundleId);
    await page.locator("#bundleList .saved-report-summary").click();
    await page.locator("#contextSidebar").getByRole("button", { name: "Delete report", exact: true }).click();
    await page.locator(".delete-object-confirm:not([disabled])").waitFor();
    await page.locator(".deletion-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("#closeContextSidebar").click();
    await page.locator("#savedLibraryManagement > summary").click();
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/preview"), { timeout: 60000 });
    await page.locator("#deleteAllReports").click();
    const bulkPreview = await previewResponse;
    assert.equal(bulkPreview.status(), 200, JSON.stringify(await bulkPreview.json()));
    await page.getByRole("button", { name: "Delete 1,001 saved reports", exact: true }).waitFor();
    await shot(page, "bulk-confirmation");
    await page.locator(".deletion-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual((await loadBoardState(context)).exports, before.exports);
    await page.locator("#deleteAllReports").click();
    const comparison = entries.at(-1), frozen = await readFile(comparison.files["comparison-report.html"]);
    await page.getByRole("button", { name: "Delete 1,001 saved reports", exact: true }).click();
    await page.getByRole("heading", { name: "1,001 saved reports deleted", exact: true }).waitFor();
    await page.locator(".deletion-dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#clearSavedReportSearch").click();
    assert.equal(await page.locator("#savedLibraryTitle").textContent(), "Saved reports and comparisons (1)");
    assert.equal(await page.locator("#bundleList .list-pager").isVisible(), false);
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
    const after = await loadBoardState(context);
    assert.deepEqual(after.exports.map(entry => entry.bundleId), [comparison.bundleId]);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
    assert.equal(await readFile(comparison.files["comparison-report.html"], "utf8"), frozen.toString());
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/confirm").length, 1);
    assert.deepEqual(requests.filter(url => ["/api/export", "/api/preview", "/api/evaluation/run", "/api/evaluation/automatic/approve", "/api/collection/now"].includes(url)), []);
});

test("small, empty and error library states retain accessible controls at narrow widths and 200 percent text", { timeout: 60000 }, async t => {
    const { page, context } = await setup(t, 6);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [820, 100], [375, 100], [1200, 200], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.locator("#bundles").evaluate(root => {
            const rect = node => {
                const box = node.getBoundingClientRect();
                return { label: node.textContent, width: box.width, height: box.height, scroll: node.scrollWidth, client: node.clientWidth };
            };
            const colorPair = node => {
                let background = "rgba(0, 0, 0, 0)";
                for (let parent = node; parent && background === "rgba(0, 0, 0, 0)"; parent = parent.parentElement) background = getComputedStyle(parent).backgroundColor;
                return { label: node.textContent, foreground: getComputedStyle(node).color, background };
            };
            return {
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                controls: [...root.querySelectorAll("button,summary,input"), ...document.querySelectorAll("#reportTaskNav a")].filter(node => node.checkVisibility()).map(rect),
                search: root.querySelector("#savedReportSearch").getBoundingClientRect().width,
                library: root.getBoundingClientRect().width,
                fontLoaded: getComputedStyle(document.body).fontFamily.startsWith('"Asta Sans"') && document.fonts.check('14px "Asta Sans"'),
                colors: [...root.querySelectorAll(".saved-report-identity,.saved-report-formats,.saved-report-manage,#savedReportCount")].map(colorPair),
            };
        });
        assert.equal(geometry.overflow, false, `${theme}/${width}/${scale}`);
        assert.equal(geometry.fontLoaded, true);
        for (const pair of geometry.colors) assert.ok(contrast(pair.foreground, pair.background) >= 4.5, `${theme}: ${pair.label}`);
        assert.deepEqual(geometry.controls.filter(node => node.height < 44 || node.scroll > node.client + 1), [], JSON.stringify({ theme, width, scale, geometry }));
        if (width === 1440 && scale === 100) assert.ok(geometry.search < geometry.library * .6, "Search does not fill the entire desktop library");
        await shot(page, `small-${theme}-${width}-${scale}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => { await gate; await route.fulfill({ status: 503, json: { error: "Synthetic saved-list read unavailable." } }); }, { times: 1 });
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await page.locator('#workspace[aria-busy="true"]').waitFor();
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A pending list does not permit a new deletion preview");
    await shot(page, "library-loading");
    release();
    await page.getByText("Synthetic saved-list read unavailable.", { exact: false }).first().waitFor();
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true, "A failed snapshot cannot approve destructive work");
    await shot(page, "library-error");
    await updateBoardState(context, state => { state.exports = []; });
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    if (!await page.locator("#bundles").evaluate(node => node.open)) await page.locator("#savedLibraryTitle").click();
    assert.match(await page.locator("#bundleList").innerText(), /No local reports have been saved/);
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
    await shot(page, "empty-library");
});

test("a lost bulk response survives panel reload, checks only its receipt and leaves an unfinished draft unchanged", { timeout: 30000 }, async t => {
    const { page, context, requests } = await setup(t, 2);
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator('[name=promptMode][value=original]').check();
    const draftBefore = await page.locator("#reportsView").getAttribute("data-report-step");
    await openReportLibrary(page);
    await page.locator("#savedLibraryManagement > summary").click();
    await page.route("**/api/artifact-deletion/confirm", async route => {
        const result = await route.fetch();
        assert.equal(result.status(), 200);
        await route.abort("connectionreset");
    });
    await page.locator("#deleteAllReports").click();
    await page.getByRole("button", { name: "Delete 2 saved reports", exact: true }).click();
    await page.getByRole("button", { name: "Check deletion result", exact: true }).waitFor();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), draftBefore);
    assert.equal(await page.locator('[name=promptMode][value=original]').isChecked(), true);
    assert.equal((await loadBoardState(context)).exports.length, 1);
    await shot(page, "uncertain-bulk-result");
    const receipt = await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion"));
    assert.ok(receipt);
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.getByRole("button", { name: "Check earlier saved-item deletion", exact: true }).click();
    await page.getByRole("heading", { name: "2 saved reports deleted", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion")), null);
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/confirm").length, 1);
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/status").length, 1);
    await shot(page, "recovered-bulk-result");
});
