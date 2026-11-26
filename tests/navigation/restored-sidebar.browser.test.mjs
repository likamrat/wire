import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption, revealAnalyzeRecords } from "../support/helpers.mjs";
import { scopeRecords } from "../analyze/analysis-scope-fixture.mjs";



const proofs = process.env.WIRE_SIDEBAR_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settled = page => page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
const collapse = page => page.locator("#navigationCollapse");
async function capture(page, name) {
    if (!proofs) return;
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: true });
    await page.screenshot({ path: path.join(proofs, name + "-viewport.png") });
}
async function setup(t, options = {}, records = scopeRecords(), browserOptions = {}) {
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    let providerCalls = 0;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { providerCalls++; throw new Error("No providers in sidebar proof"); },
            readSource: async () => { providerCalls++; throw new Error("No source reads in sidebar proof"); },
        } });
    const browser = await chromium.launch(browserOptions);
    if (proofs) await mkdir(proofs, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference",
        ...(proofs ? { recordVideo: { dir: proofs, size: { width: 1440, height: 1000 } } } : {}), ...options });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    page.setDefaultTimeout(8000);
    t.after(async () => {
        await browser.close();
        await runtime.close();
        try {
            assert.deepEqual(errors, []);
            assert.equal(providerCalls, 0);
            assert.ok(requests.every(url => ["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/consent",
                "/api/assessment/overview", "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
                "/api/search/events"].includes(url)), `Unexpected mutation or provider request: ${requests}`);
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url);
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return { page, requests };
}

test("workspace links and footer utilities keep their native ownership across collapse and the drawer", async t => {
    const { page } = await setup(t);
    const main = page.getByRole("navigation", { name: "Main navigation", exact: true });
    const utility = page.getByRole("navigation", { name: "Utility navigation", exact: true });
    const settings = utility.getByRole("link", { name: "Settings", exact: true });
    const hosts = await page.locator("#navigationContent").elementHandle();
    await expect(main.locator("a")).toHaveText(["Analyze", "Trends", "Reports", "Compare"]);
    await expect(page.locator(".app-header nav")).toHaveCount(0);
    await expect(page.locator("#wireAccountEntry")).toBeHidden();
    await expect(settings).toHaveCount(1);
    for (const [name, href] of [["Analyze", "/"], ["Trends", "/trends"], ["Reports", "/reports"], ["Compare", "/compare"]]) {
        const link = main.getByRole("link", { name, exact: true });
        assert.equal(new URL(await link.getAttribute("href"), page.url()).pathname, href);
        await expect(link.locator("svg[aria-hidden=true]")).toHaveCount(1);
    }
    await collapse(page).click(); await settled(page);
    await main.getByRole("link", { name: "Reports", exact: true }).focus();
    await page.keyboard.press("Tab"); await expect(main.getByRole("link", { name: "Compare", exact: true })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(utility.getByRole("link", { name: "Help", exact: true })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(utility.getByRole("button", { name: "Feedback", exact: true })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(settings).toBeFocused();
    await page.keyboard.press("Enter"); await ready(page);
    await expect(settings).toHaveAttribute("aria-current", "page");
    for (const section of ["connection", "privacy", "themes", "regional"]) {
        await navigateSettings(page, section);
        await expect(main.getByRole("link", { name: "Compare", exact: true })).toBeVisible();
        await expect(settings).toHaveAttribute("aria-current", "page");
    }
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator("#navigationToggle").click();
    await expect(settings).toBeFocused();
    assert.ok(await hosts.evaluate(node => node === document.querySelector("#navigationDrawer #navigationContent")));
    await page.keyboard.press("Escape");
    await expect(page.locator("#navigationToggle")).toBeFocused();
});
test("sidebar groups remain scroll-reachable without overlap at narrow and 200% sizes", async t => {
    const { page } = await setup(t);
    const measurements = [];
    for (const [width, height, scale] of [[1440, 900, 2], [768, 900, 2], [390, 800, 1], [390, 640, 2]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            if (width < 700) {
                await page.locator("#navigationToggle").click();
                await page.waitForFunction(() => !document.querySelector("#navigationDrawer").getAnimations().length);
            }
            const parent = page.locator(width < 700 ? "#navigationDrawer" : "#sidebar");
            for (const selector of ['nav [data-nav="analyze"]', 'nav [data-nav="trends"]', 'nav [data-nav="reports"]', "#comparePeriods", 'nav [data-nav="settings"]']) {
                const control = parent.locator(selector);
                await control.focus();
                const metrics = await control.evaluate(node => {
                    const rect = node.getBoundingClientRect(), surface = node.closest("dialog,aside").getBoundingClientRect();
                    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, surface: surface.toJSON(),
                        visibleHit: node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
                        labelFits: node.scrollWidth <= node.clientWidth + 1 };
                });
                assert.ok(metrics.top >= metrics.surface.top && metrics.bottom <= metrics.surface.bottom, `${selector}: keyboard scrolls the complete target into view`);
                assert.ok(metrics.left >= metrics.surface.left && metrics.right <= metrics.surface.right,
                    `${width}/${height}/${scale}/${theme}/${selector}: ${JSON.stringify(metrics)}`);
                assert.equal(metrics.visibleHit, true, `${selector}: not covered by another group`);
                assert.equal(metrics.labelFits, true, `${selector}: no horizontal clipping`);
            }
            const layout = await page.evaluate(() => {
                const groups = [...document.querySelectorAll("#navigationContent > *")].filter(node => node.checkVisibility());
                return { overlap: groups.some((node, index) => index && node.getBoundingClientRect().top < groups[index - 1].getBoundingClientRect().bottom),
                    overflow: document.documentElement.scrollWidth - innerWidth };
            });
            assert.equal(layout.overlap, false);
            assert.ok(layout.overflow <= 1);
            measurements.push({ width, height, scale, theme, ...layout });
            await capture(page, `grouping-${theme}-${width}-${scale}x-settings`);
            if (width < 700) {
                await page.getByRole("button", { name: "Close navigation", exact: true }).click();
                await expect(page.locator("#navigationToggle")).toBeFocused();
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "sidebar-reachability.json"), JSON.stringify(measurements, null, 2));
});

for (const [theme, width, textScale, motion] of [
    ["light", 1440, 1, "no-preference"], ["dark", 1440, 1, "reduce"],
    ["light", 768, 2, "reduce"], ["dark", 768, 2, "no-preference"],
]) test(`Analyze tool labels stay on one line throughout collapse, expansion and reversal (${theme}/${width}/${textScale}x)`, async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width, height: 1000 });
    await chooseTheme(page, theme);
    await page.emulateMedia({ reducedMotion: motion });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, textScale);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const trace = await page.evaluate(async () => {
        const rail = document.getElementById("sidebar"), toggle = document.getElementById("navigationCollapse");
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve)), samples = [];
        let phase = "initial", running = true;
        function sample() {
            const rows = [...document.querySelectorAll("#analyzeTools .analyze-tool-action")].filter(node => node.checkVisibility()).map(node => {
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), lines = new Set();
                while (walker.nextNode()) {
                    if (!walker.currentNode.textContent.trim()) continue;
                    const range = document.createRange(); range.selectNodeContents(walker.currentNode);
                    for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) lines.add(Math.round(rect.y));
                }
                return { id: node.id, lines: lines.size, height: node.getBoundingClientRect().height };
            });
            samples.push({ phase, width: rail.getBoundingClientRect().width, rows });
            if (running) requestAnimationFrame(sample);
        }
        async function settle() {
            for (let i = 0; i < 120; i++) {
                await frame();
                if (i > 1 && !rail.hasAttribute("data-navigation-moving")) return;
            }
            throw new Error("Sidebar motion did not settle");
        }
        sample();
        for (const next of ["collapse", "expand"]) { phase = next; toggle.click(); await settle(); }
        phase = "reverse-collapse"; toggle.click();
        for (let i = 0; i < 4; i++) await frame();
        phase = "reverse-expand"; toggle.click(); await settle();
        running = false; await frame();
        return samples;
    });
    const label = `${theme}-${width}-${textScale}x-${motion}`;
    if (proofs) {
        await writeFile(path.join(proofs, `tool-label-motion-${label}.json`), JSON.stringify(trace, null, 2));
        await collapse(page).click(); await settled(page);
        await collapse(page).click();
        await page.evaluate(async () => {
            for (const selector of ["#sidebar", "#shellBrand"]) for (const animation of document.querySelector(selector).getAnimations({ subtree: true })) {
                animation.pause(); animation.currentTime = 40;
            }
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await page.screenshot({ path: path.join(proofs, `tool-label-expand-40ms-${label}.png`) });
        await page.evaluate(() => {
            for (const selector of ["#sidebar", "#shellBrand"]) for (const animation of document.querySelector(selector).getAnimations({ subtree: true })) animation.play();
        });
        await settled(page);
    }
    for (const phase of ["collapse", "expand", "reverse-collapse", "reverse-expand"]) {
        const samples = trace.filter(frame => frame.phase === phase);
        assert.ok(new Set(samples.map(frame => Math.round(frame.width))).size > 1, `${phase}: actual intermediate widths`);
        const wrapped = samples.find(frame => frame.rows.some(row => row.lines > 1));
        assert.equal(wrapped, undefined, `${label}/${phase}: tool labels must not reflow during the glide: ${JSON.stringify(wrapped)}`);
        for (const row of samples.flatMap(sample => sample.rows)) {
            const endpoints = [trace[0], trace.filter(sample => sample.phase === "collapse").at(-1), trace.at(-1)];
            const height = Math.max(...endpoints.flatMap(sample => sample.rows.filter(item => item.id === row.id).map(item => item.height)));
            assert.ok(row.height <= height, `${label}/${phase}/${row.id}: no transient height growth`);
        }
    }
});

test("brand paint follows the eased sidebar through collapse, expansion and reversal", async t => {
    const { page } = await setup(t);
    const trace = await page.evaluate(async () => {
        const samples = [], rail = document.querySelector("#sidebar"), toggle = document.querySelector("#navigationCollapse");
        const wordmark = document.querySelector(".brand-logo[data-brand-theme=light]");
        const compact = document.querySelector(".brand-compact");
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        let phase = "initial", running = true;
        function sample() {
            const paint = node => {
                const style = getComputedStyle(node);
                const matrix = node.getScreenCTM();
                return { opacity: style.visibility === "hidden" || style.display === "none" ? 0 : Number(style.opacity),
                    rect: node.getBoundingClientRect().toJSON(), transform: style.transform,
                    matrix: matrix ? { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f } : null };
            };
            samples.push({ phase, at: performance.now(), width: rail.getBoundingClientRect().width,
                wordmark: paint(wordmark), compact: paint(compact) });
            if (running) requestAnimationFrame(sample);
        }
        async function settle() {
            for (let i = 0; i < 120; i++) {
                await frame();
                if (i > 1 && !rail.hasAttribute("data-navigation-moving")) return;
            }
            throw new Error("Brand motion did not settle");
        }
        sample();
        for (const next of ["collapse", "expand"]) {
            phase = next; toggle.click(); await settle();
        }
        phase = "reverse-collapse"; toggle.click();
        for (let i = 0; i < 4; i++) await frame();
        phase = "reverse-expand"; toggle.click(); await settle();
        running = false; await frame();
        return samples;
    });
    if (proofs) await writeFile(path.join(proofs, "brand-motion.json"), JSON.stringify(trace, null, 2));
    for (const phase of ["collapse", "expand", "reverse-collapse", "reverse-expand"]) {
        const samples = trace.filter(frame => frame.phase === phase);
        assert.ok(new Set(samples.map(frame => Math.round(frame.width))).size > 1, `${phase}: real lateral motion`);
        assert.ok(samples.some(frame => frame.compact.opacity > 0 && frame.compact.opacity < 1),
            `${phase}: the symbol paint must ease with the rail rather than switch at the click`);
        assert.ok(samples.some(frame => frame.wordmark.opacity > 0 && frame.wordmark.opacity < 1),
            `${phase}: the wordmark must ease with the rail rather than switch at the click`);
        for (const frame of samples.filter(frame => frame.wordmark.opacity > 0 && frame.compact.opacity > 0)) {
            for (const key of ["a", "d", "e", "f"]) {
                assert.ok(Math.abs(frame.wordmark.matrix[key] - frame.compact.matrix[key]) < .001,
                    `${phase}: both symbols share the same rendered artwork coordinates (${key})`);
            }
        }
        if (["collapse", "expand"].includes(phase)) {
            const first = Math.max(...trace.map(frame => frame.width)), last = Math.min(...trace.map(frame => frame.width));
            for (const frame of samples) {
                const progress = (first - frame.width) / (first - last);
                assert.ok(Math.abs(frame.compact.opacity - progress) < .001,
                    `${phase}: logo and rail use the same eased progress, not independent timing`);
            }
        }
    }
    if (proofs) for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const phase of ["collapse", "expand"]) {
            await collapse(page).click();
            await page.evaluate(() => {
                window.brandProofAnimations = ["#sidebar", "#shellBrand"].flatMap(selector =>
                    document.querySelector(selector).getAnimations({ subtree: true }));
                for (const animation of window.brandProofAnimations) animation.pause();
            });
            for (const time of [0, 80, 160, 240, 319]) {
                await page.evaluate(async time => {
                    for (const animation of window.brandProofAnimations) animation.currentTime = time;
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                }, time);
                await page.screenshot({ path: path.join(proofs, `brand-${theme}-${phase}-${time}ms.png`),
                    clip: { x: 0, y: 0, width: 220, height: 144 } });
            }
            await page.evaluate(() => { for (const animation of window.brandProofAnimations) animation.play(); });
            await settled(page);
        }
    }
});

test("both built-in sidebars paint actual frames under the unchanged native browser preference", async t => {
    const { page } = await setup(t, { reducedMotion: null }, scopeRecords(), {
        channel: process.platform === "win32" ? "msedge" : undefined,
        headless: process.env.WIRE_NATIVE_MOTION_PROBE !== "headed",
        ignoreDefaultArgs: ["--hide-scrollbars"],
    });
    const environment = await page.evaluate(() => ({
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        waapi: typeof Element.prototype.animate,
        visibility: document.visibilityState,
        scale: devicePixelRatio,
    }));
    const traces = [];
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await revealAnalyzeRecords(page);
        const trace = await page.evaluate(async () => {
            const rail = document.querySelector("#sidebar"), panel = document.querySelector("#contextSidebar");
            const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
            const samples = [];
            let phase = "initial";
            const sample = () => samples.push({ phase, at: performance.now(),
                width: rail.getBoundingClientRect().width, open: panel.open,
                x: panel.getBoundingClientRect().x, transform: getComputedStyle(panel).transform });
            async function settle(selector, expectedOpen) {
                for (let i = 0; i < 120; i++) {
                    await frame(); sample();
                    const node = document.querySelector(selector);
                    if (i > 2 && !node.getAnimations({ subtree: true }).length
                        && (expectedOpen === undefined || panel.open === expectedOpen)) return;
                }
                throw new Error(`${phase} did not settle`);
            }
            for (const next of ["collapse", "expand"]) {
                phase = next; document.querySelector("#navigationCollapse").click(); await settle("#sidebar");
            }
            phase = "open"; document.querySelector(".request-card-open").click(); await settle("#contextSidebar", true);
            phase = "close"; document.querySelector("#closeContextSidebar").click(); await settle("#contextSidebar", false);
            return samples;
        });
        for (const phase of ["collapse", "expand", "open", "close"]) {
            const frames = trace.filter(frame => frame.phase === phase && (["collapse", "expand"].includes(phase) || frame.open));
            const positions = new Set(frames.map(frame => Math.round(["collapse", "expand"].includes(phase) ? frame.width : frame.x))).size;
            t.diagnostic(JSON.stringify({ theme, phase, ...environment, frames: frames.length, positions }));
            assert.ok(positions >= 3, `${theme}/${phase}: actual intermediate frames, not just an animation object`);
        }
        traces.push({ theme, environment, trace });
    }
    if (proofs) await writeFile(path.join(proofs, "native-sidebar-motion.json"), JSON.stringify(traces, null, 2));
});

test("header keeps only the theme control beside centered Search, with time zone in Settings", async t => {
    const { page } = await setup(t, {}, scopeRecords(), {
        channel: process.platform === "win32" ? "msedge" : undefined, ignoreDefaultArgs: ["--hide-scrollbars"],
    });
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [1440, 768, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
            return { header: rect(".app-header"), search: rect("#wireSearchHome"), main: rect("#main"),
                themeControl: rect("#themePreference"), utilityChildren: document.querySelector(".workspace-utilities").children.length,
                overflow: document.documentElement.scrollWidth > innerWidth };
        });
        measurements.push({ theme, width, scale, ...geometry });
        if (proofs) {
            await page.screenshot({ path: path.join(proofs, `header-zone-${theme}-${width}-${scale}.png`) });
            await writeFile(path.join(proofs, "header-zone-geometry.json"), JSON.stringify(measurements, null, 2));
        }
        assert.equal(geometry.overflow, false);
        assert.ok(Math.abs(geometry.search.x + geometry.search.width / 2 - geometry.main.x - geometry.main.width / 2) < 1);
        const separate = (a, b) => a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1;
        assert.ok(separate(geometry.search, geometry.themeControl), "Search and theme never overlap");
        for (const box of [geometry.search, geometry.themeControl]) {
            assert.ok(box.y >= geometry.header.y && box.bottom <= geometry.header.bottom + 1);
            assert.ok(box.x >= 0 && box.right <= width && box.height >= 44);
        }
    }
    assert.ok(measurements.every(entry => entry.utilityChildren === 1), "The theme control has no redundant time-zone sibling or placeholder");
    await expect(page.locator(".display-time-zone")).toHaveCount(0);
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "regional");
    await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toBeVisible();
    await expect(page.locator("#displayTimeZone option:checked")).not.toBeEmpty();
});

test("sidebar changes preserve applied filters and never commit an open outcome draft", async t => {
    const { page, requests } = await setup(t);
    await selectActivityOption(page, "serviceAssociationFilter", "Files");
    await ready(page);
    const url = page.url(), reads = requests.filter(url => url === "/api/snapshot").length;
    const selected = () => page.locator("#outcomeFilter").evaluate(node => [...node.selectedOptions].map(option => option.value));
    const original = await selected();
    await page.locator('[data-select-id="outcomeFilter"]').click();
    await page.locator('.select-popup .select-option[data-value="success"]').click();
    assert.deepEqual(await selected(), original, "A menu draft is not yet an applied filter");
    await collapse(page).click(); await settled(page);
    await expect(page.locator(".select-popup")).toBeHidden();
    assert.deepEqual(await selected(), original, "Leaving for the sidebar cancels rather than applying the draft");
    assert.equal(page.url(), url);
    assert.equal(requests.filter(url => url === "/api/snapshot").length, reads);
    await collapse(page).press("Enter"); await settled(page);
    await expect(page.locator("#serviceAssociationFilter")).toHaveValue("Files");
    assert.equal(page.url(), url);
});

test("trusted sidebar reversals return the scrolled interaction to its original position", async t => {
    const records = scopeRecords().slice(0, 5);
    const { page } = await setup(t, { viewport: { width: 1600, height: 1100 } }, records, {
        channel: process.platform === "win32" ? "msedge" : undefined,
        ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--force-device-scale-factor=1.5"],
    });
    assert.ok(await page.evaluate(() => document.documentElement.clientWidth < innerWidth),
        "Native desktop scrollbar geometry is present, unlike the default headless overlay");
    await revealAnalyzeRecords(page);
    const selected = page.locator("#activityList .request-row").nth(1);
    await selected.locator(".request-card-open").first().press("Enter");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    // Current compact cards need headroom for the later downward wheel gesture.
    await page.evaluate(() => window.scrollBy(0, -200));
    const selectedKey = await selected.getAttribute("data-view-key");
    await page.evaluate(key => {
        const trace = [], clicks = [];
        let running = true, phase = "before";
        function sample() {
            const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
            trace.push({ at: performance.now(), phase, scrollY, documentHeight: document.documentElement.scrollHeight,
                maxScroll: document.documentElement.scrollHeight - innerHeight, header: rect(".app-header"), main: rect("#main"),
                card: rect(`[data-view-key="${key}"]`), rail: rect("#sidebar") });
            if (running) requestAnimationFrame(sample);
        }
        document.querySelector("#navigationCollapse").addEventListener("click", event => {
            phase = document.querySelector("#navigationCollapse").getAttribute("aria-expanded");
            clicks.push({ at: performance.now(), trusted: event.isTrusted, expanded: phase });
        });
        sample();
        window.finishScrolledMotion = () => { running = false; return { trace, clicks }; };
    }, selectedKey);
    async function clickMovingToggle() {
        const toggle = await collapse(page).boundingBox();
        await page.mouse.click(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2);
    }
    const checkpoints = [];
    for (const [index, wait] of [450, 900, 75, 75, 75, 450, 450, 900].entries()) {
        await clickMovingToggle();
        await page.waitForTimeout(wait);
        if (index === 1) checkpoints.push(await selected.evaluate(node => ({ cardY: node.getBoundingClientRect().y, scrollY })));
    }
    const evidence = await page.evaluate(() => window.finishScrolledMotion());
    if (proofs) await writeFile(path.join(proofs, "trusted-scrolled-reversals.json"), JSON.stringify(evidence, null, 2));
    const before = evidence.trace[0], after = evidence.trace.at(-1);
    t.diagnostic(JSON.stringify({ before, after, checkpoints, clicks: evidence.clicks }));
    assert.ok(evidence.clicks.length === 8 && evidence.clicks.every(click => click.trusted), "Actual pointer events drive every reversal");
    assert.ok(checkpoints.every(point => Math.abs(point.cardY - before.card.y) < 1 && Math.abs(point.scrollY - before.scrollY) < 1),
        "The ordinary settled collapse/expand pair preserves the reading position too");
    await expect(collapse(page)).toHaveAttribute("aria-expanded", "true");
    await expect(selected).toHaveAttribute("data-view-key", selectedKey);
    assert.ok(Math.abs(after.card.y - before.card.y) < 1, "The same final expanded state restores the same selected record position");
    assert.ok(Math.abs(after.scrollY - before.scrollY) < 1, "Repeated lateral motion does not accumulate page scroll drift");
    await clickMovingToggle();
    await page.waitForTimeout(70);
    await page.mouse.move(1000, 700);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(previous => scrollY > previous + 50, after.scrollY);
    await settled(page);
    const wheelY = await page.evaluate(() => scrollY);
    await clickMovingToggle();
    await settled(page);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - wheelY) < 1, "Finishing motion never restores stale pre-wheel scroll");
});

test("Calendar service drilldown and browser Back restore the original interaction order", async t => {
    const records = ["three", "five", "mail", "calendar", "archive"].map((name, index) => {
        const record = fixture(`navigation-order-${name}`);
        record.sourceSessionId = `navigation-order-chat-${index}`;
        record.capturedAt = new Date(Date.UTC(2026, 8, 30, 12, 5 - index)).toISOString();
        record.userPrompt.text = `Invented ${name} request`;
        const apiPath = name === "calendar" ? "/me/calendarView" : name === "mail" ? "/me/messages" : "/me/drive/root";
        record.toolCalls[0].requestArgs = { entityUrls: [apiPath] };
        record.toolCalls[0].requestedApiPath = apiPath;
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    const { page } = await setup(t, {}, records);
    const order = () => page.locator("#activityList .request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey));
    const before = await order(), originalUrl = page.url();
    for (let cycle = 0; cycle < 2; cycle++) {
        await page.locator("#percentageCharts").getByRole("link", { name: /^Calendar:.*View matching records/ }).click(); await ready(page);
        assert.equal(new URL(page.url()).search, "");
        assert.deepEqual(await order(), ["request:navigation-order-calendar"]);
        await page.goBack(); await ready(page);
        assert.equal(page.url(), originalUrl);
        const after = await order();
        if (proofs) await writeFile(path.join(proofs, `calendar-back-order-${cycle}.json`), JSON.stringify({ before, after }, null, 2));
        assert.deepEqual(after, before, "Returning from a service refinement restores the prior list, not the narrowed list first");
    }
});

for (const width of [1440, 940, 768]) for (const theme of ["light", "dark"]) {
test(`normal-root repeated sidebar motion is vertically stable at ${width}px in ${theme}`, async t => {
    const { page } = await setup(t, { viewport: { width, height: 1000 } });
    await chooseTheme(page, theme);
    const trace = await page.evaluate(async () => {
        const samples = [];
        const sidebar = document.querySelector("#sidebar");
        const toggle = document.querySelector("#navigationCollapse");
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        let phase = "initial", running = true;
        function sample() {
            const artwork = document.querySelector(`.brand-logo[data-brand-theme=${document.documentElement.dataset.evidenceTheme}]`);
            samples.push({ phase, at: performance.now(), header: rect(".app-header"), main: rect("#main"),
                brand: rect("#shellBrand"), logo: rect(".brand-home"),
                artwork: { ...artwork.getBoundingClientRect().toJSON(), layoutWidth: artwork.clientWidth, layoutHeight: artwork.clientHeight },
                sidebar: rect("#sidebar"), search: rect(".wire-search-entry"), scrollY });
            if (running) requestAnimationFrame(sample);
        }
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        async function settle() {
            for (let i = 0; i < 120; i++) {
                await frame();
                if (i > 1 && !sidebar.hasAttribute("data-navigation-moving")) return;
            }
            throw new Error("Sidebar did not settle");
        }
        sample();
        for (let cycle = 0; cycle < 3; cycle++) {
            phase = `collapse-${cycle}`; toggle.click(); await settle();
            phase = `expand-${cycle}`; toggle.click(); await settle();
        }
        phase = "rapid-collapse"; toggle.click();
        for (let i = 0; i < 4; i++) await frame();
        phase = "rapid-expand"; toggle.click();
        for (let i = 0; i < 3; i++) await frame();
        phase = "rapid-collapse-again"; toggle.click(); await settle();
        phase = "final-expand"; toggle.click(); await settle();
        running = false;
        await frame();
        return samples;
    });
    if (proofs) await writeFile(path.join(proofs, `normal-root-repeated-${width}-${theme}.json`), JSON.stringify(trace, null, 2));
    const extent = read => {
        const values = trace.map(read);
        return { min: Math.min(...values), max: Math.max(...values) };
    };
    const header = extent(frame => frame.header.height), main = extent(frame => frame.main.y);
    t.diagnostic(JSON.stringify({ samples: trace.length, header, main }));
    assert.ok(header.max - header.min < 1, `Header bounces during sidebar motion: ${JSON.stringify(header)}`);
    assert.ok(main.max - main.min < 1, `Main bounces during sidebar motion: ${JSON.stringify(main)}`);
    const initial = trace[0].artwork;
    assert.ok(initial.layoutWidth > 0 && initial.layoutHeight > 0);
    assert.ok(trace.every(frame => frame.artwork.layoutWidth === initial.layoutWidth && frame.artwork.layoutHeight === initial.layoutHeight),
        "The wordmark retains its layout geometry while its paint transforms without reflow");
    assert.ok(trace.every(frame => Math.abs(frame.artwork.width / frame.artwork.height - 402 / 82) < .01),
        "Logo motion scales uniformly, never distorting the approved artwork");
    assert.ok(trace.every(frame => Math.abs(frame.search.x + frame.search.width / 2 - frame.main.x - frame.main.width / 2) < 1),
        "Search stays centered on the moving content, not on the whole viewport");
    for (const phase of ["collapse-0", "expand-0", "rapid-collapse", "rapid-expand", "rapid-collapse-again"]) {
        assert.ok(new Set(trace.filter(frame => frame.phase === phase).map(frame => Math.round(frame.sidebar.width))).size > 1,
            `${phase} includes real intermediate lateral positions`);
    }
});
}

test("normal-root narrow drawer motion leaves header and main stationary in both themes", async t => {
    const { page } = await setup(t, { viewport: { width: 375, height: 900 } });
    const drawer = page.locator("#navigationDrawer"), trigger = page.locator("#navigationToggle");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.evaluate(() => {
            const trace = [];
            let running = true;
            function sample() {
                trace.push({ header: document.querySelector(".app-header").getBoundingClientRect().toJSON(),
                    main: document.querySelector("#main").getBoundingClientRect().toJSON(),
                    drawer: document.querySelector("#navigationDrawer").getBoundingClientRect().toJSON(),
                    open: document.querySelector("#navigationDrawer").open, scrollY });
                if (running) requestAnimationFrame(sample);
            }
            sample();
            window.finishDrawerTrace = () => { running = false; return trace; };
        });
        for (let cycle = 0; cycle < 3; cycle++) {
            await trigger.click();
            if (cycle === 2) {
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            } else {
                await drawer.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
            }
            await page.keyboard.press("Escape");
            await expect(drawer).not.toHaveAttribute("open", "");
            await expect(trigger).toBeFocused();
        }
        const trace = await page.evaluate(() => window.finishDrawerTrace());
        if (proofs) await writeFile(path.join(proofs, `normal-root-drawer-${theme}.json`), JSON.stringify(trace, null, 2));
        const first = trace[0];
        assert.ok(trace.every(frame => frame.header.height === first.header.height && frame.main.y === first.main.y),
            "Opening, closing and reversing the modal does not move the page vertically");
        assert.ok(new Set(trace.filter(frame => frame.open).map(frame => Math.round(frame.drawer.x))).size > 8,
            "Narrow proof includes intermediate drawer motion, not just endpoints");
    }
});

test("enlarged text and reduced motion keep a stable header without squeezing the brand", async t => {
    const { page } = await setup(t);
    // This is text enlargement, not browser zoom.
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.emulateMedia({ reducedMotion: "reduce" });
        const geometry = () => page.locator(".app-header").evaluate(node => ({
            height: node.getBoundingClientRect().height,
            mainY: document.querySelector("#main").getBoundingClientRect().y,
            lockupHeight: document.querySelector(`.brand-logo[data-brand-theme=${document.documentElement.dataset.evidenceTheme}]`).getBoundingClientRect().height,
        }));
        const before = await geometry();
        await collapse(page).click();
        await settled(page);
        assert.equal(await page.locator("#sidebar").evaluate(node => node.getAnimations({ subtree: true }).length), 0);
        assert.equal(await page.locator("#shellBrand").evaluate(node => node.getAnimations({ subtree: true }).length), 0);
        assert.deepEqual(await geometry(), before);
        await collapse(page).click();
        await settled(page);
        assert.deepEqual(await geometry(), before);
        const lockup = await page.locator(`.brand-logo[data-brand-theme=${theme}]`).evaluate(node => ({
            width: node.clientWidth, content: node.scrollWidth, visible: node.checkVisibility({ visibilityProperty: true }),
        }));
        assert.ok(lockup.visible && lockup.content <= lockup.width, "The integrated artwork stays intact during text enlargement");
        await capture(page, `enlarged-text-${theme}`);
    }
});

test("brand focus, touch, reduced motion and breakpoint interruption retain settled artwork", async t => {
    const { page } = await setup(t, { hasTouch: true });
    const brand = page.locator("#shellBrand"), link = brand.locator(".brand-home");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await collapse(page).tap(); await settled(page);
        await link.focus(); await page.keyboard.press("Shift");
        const focus = await link.evaluate(node => {
            const style = getComputedStyle(node), rect = node.getBoundingClientRect(), cell = node.parentElement.getBoundingClientRect();
            return { visible: node.matches(":focus-visible"), outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
                width: rect.width, height: rect.height, contained: rect.x >= cell.x && rect.right <= cell.right && rect.y >= cell.y && rect.bottom <= cell.bottom,
                edges: [[rect.x + 1, rect.y + 1], [rect.right - 1, rect.bottom - 1]].every(([x, y]) =>
                    document.elementFromPoint(x, y)?.closest("a") === node) };
        });
        assert.ok(focus.visible && focus.outline !== "none" && focus.outlineWidth >= 2 && focus.contained && focus.edges);
        assert.equal(focus.width, 44); assert.equal(focus.height, 44);
        if (proofs) await page.screenshot({ path: path.join(proofs, `brand-${theme}-keyboard-focus.png`), clip: { x: 0, y: 0, width: 220, height: 144 } });
        await page.keyboard.press("Enter"); await ready(page);
        await expect(page.locator('nav [data-nav="analyze"]')).toHaveAttribute("aria-current", "page");
        await collapse(page).tap();
        assert.ok(await page.locator("#sidebar").evaluate(node => node.hasAttribute("data-navigation-moving")));
        await page.emulateMedia({ reducedMotion: "reduce" });
        await settled(page);
        assert.equal(await brand.evaluate(node => node.getAnimations({ subtree: true }).length), 0);
        await expect(brand.locator(".brand-compact")).toHaveCSS("opacity", "0");
        await expect(brand.locator(`.brand-logo[data-brand-theme=${theme}]`)).toHaveCSS("transform", "none");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await collapse(page).tap();
        assert.ok(await page.locator("#sidebar").evaluate(node => node.hasAttribute("data-navigation-moving")));
        await page.setViewportSize({ width: 375, height: 900 });
        await page.locator("#navigationToggle").tap();
        await expect(page.locator("#navigationDrawer #shellBrand")).toBeVisible();
        assert.equal(await brand.evaluate(node => node.getAnimations({ subtree: true }).length), 0);
        await expect(brand.locator(".brand-compact")).toBeHidden();
        await expect(brand.locator(`.brand-logo[data-brand-theme=${theme}]`)).toHaveCSS("opacity", "1");
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1440, height: 1000 });
        await expect(collapse(page)).toHaveAttribute("aria-expanded", "false");
        await collapse(page).tap(); await settled(page);
    }
});
