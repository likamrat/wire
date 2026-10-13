import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption } from "./helpers.mjs";
import { scopeRecords } from "./analysis-scope-fixture.mjs";
import { reportContents } from "./report-journey-helpers.mjs";

const proofs = process.env.WIRE_SIDEBAR_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settled = page => page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
const collapse = page => page.locator("#navigationCollapse");
async function capture(page, name) {
    if (!proofs) return;
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: true });
    await page.screenshot({ path: path.join(proofs, name + "-viewport.png") });
}
async function workspaceSearch(page) {
    const geometry = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { search: box(".wire-search-entry"), toolbar: box(".workspace-toolbar"), main: box("#main"),
            brand: box("#shellBrand"), utilities: box(".workspace-utilities") };
    });
    const center = box => box.x + box.width / 2;
    assert.ok(Math.abs(center(geometry.search) - center(geometry.main)) < 1, "Search is centered on the workspace, excluding the rail");
    assert.ok(Math.abs(geometry.toolbar.x - geometry.main.x) < 1, "Toolbar and content share the same moving rail offset");
    assert.ok(geometry.search.x - geometry.brand.right >= 80, "Search is separate from sidebar branding, not logo-adjacent");
    assert.ok(geometry.search.right <= geometry.utilities.x - 8, "Right-side utilities do not crowd Search");
    assert.ok(geometry.search.width >= 240 && geometry.search.width <= 460, "Search has a bounded comfortable width");
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
            assert.ok(requests.every(url => ["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/detail",
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

test("production shell restores the three destinations in the left sidebar, not the header", async t => {
    const { page } = await setup(t);
    await expect(page.locator("#sidebar .primary-navigation a")).toHaveText(["Analyze", "Reports", "Settings"]);
    await expect(page.locator(".app-header nav")).toHaveCount(0);
    assert.deepEqual(await page.locator(".primary-navigation .fluent-icon").evaluateAll(nodes => nodes.map(node => node.dataset.fluentIcon)),
        ["data_trending_24_regular", "document_24_regular", "settings_24_regular"]);
    await expect(collapse(page)).toHaveAttribute("aria-expanded", "true");
    assert.equal(await page.locator("#wireSearch").count(), 1);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await workspaceSearch(page);
        for (const icon of await page.locator(".primary-navigation .fluent-icon").all()) {
            const box = await icon.boundingBox();
            assert.equal(box.width, 24); assert.equal(box.height, 24);
            assert.equal(await icon.getAttribute("aria-hidden"), "true");
        }
        await capture(page, `desktop-${theme}-expanded`);
        await collapse(page).click(); await settled(page);
        await workspaceSearch(page);
        await capture(page, `desktop-${theme}-collapsed`);
        await collapse(page).click(); await settled(page);
    }
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
        await page.locator("#themePreference").focus();
        await page.keyboard.press("Tab");
        if (width >= 700) await expect(collapse(page)).toBeFocused();
    }
    assert.ok(measurements.every(entry => entry.utilityChildren === 1), "The theme control has no redundant time-zone sibling or placeholder");
    await expect(page.locator(".display-time-zone")).toHaveCount(0);
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "display");
    await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toBeVisible();
    await expect(page.locator("#displayTimeZone option:checked")).not.toBeEmpty();
});

test("sidebar physically glides without replacing content, losing drafts or changing route history", async t => {
    const { page, requests } = await setup(t);
    const filters = await page.locator("#filters").elementHandle();
    const url = page.url(), reads = requests.filter(url => url === "/api/snapshot").length;
    await page.evaluate(() => {
        window.sidebarFrames = [];
        const start = performance.now();
        function sample() {
            const rail = document.querySelector("#sidebar").getBoundingClientRect();
            const main = document.querySelector("#main").getBoundingClientRect();
            window.sidebarFrames.push({ at: performance.now() - start, width: rail.width, main: main.x,
                header: document.querySelector(".app-header").getBoundingClientRect().height });
        }
        // Observe after the shell's ResizeObserver has aligned main, before the same frame paints.
        const observer = new ResizeObserver(sample);
        observer.observe(document.querySelector("#sidebar"));
        sample();
        setTimeout(() => { observer.disconnect(); sample(); window.sidebarTraceDone = true; }, 700);
    });
    await collapse(page).press("Enter");
    await settled(page);
    await page.waitForFunction(() => window.sidebarTraceDone);
    const trace = await page.evaluate(() => window.sidebarFrames);
    assert.ok(trace[0].width > trace.at(-1).width + 100);
    assert.ok(new Set(trace.map(frame => Math.round(frame.width))).size > 8, "Visible intermediate positions, not a snap");
    assert.ok(trace.every(frame => Math.abs(frame.main - frame.width) < 1.1), "Main follows the moving edge");
    assert.equal(new Set(trace.map(frame => frame.header)).size, 1);
    assert.equal(await filters.evaluate(node => node === document.querySelector("#filters")), true);
    assert.equal(page.url(), url);
    assert.equal(requests.filter(url => url === "/api/snapshot").length, reads);
    await expect(collapse(page)).toBeFocused();
    if (proofs) await writeFile(path.join(proofs, "sidebar-motion-frames.json"), JSON.stringify(trace, null, 2));
    await page.keyboard.press("Tab");
    await expect(page.locator('nav [data-nav="analyze"]')).toBeFocused();
    await expect(page.getByRole("tooltip", { name: "Analyze", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toBeHidden();
    await page.locator("#activityList input[type=checkbox]").first().check();
    const checkbox = await page.locator("#activityList input[type=checkbox]").first().elementHandle();
    await page.locator("#freshHelp > summary").click();
    await collapse(page).click(); await settled(page);
    await expect(page.locator("#freshHelp")).toHaveAttribute("open", "");
    assert.equal(await checkbox.evaluate(node => node.checked), true);
    await navigateMain(page, "reports"); await ready(page);
    await reportContents(page);
    await page.locator('[name=promptMode][value=none]').check();
    await page.locator("#formatOptions input[value=json]").check();
    const draft = await page.locator("#promptOptions").elementHandle();
    await collapse(page).click(); await settled(page);
    assert.equal(await draft.evaluate(node => node === document.querySelector("#promptOptions")), true);
    await navigateMain(page, "settings"); await ready(page);
    await expect(page.locator('nav [data-nav="settings"]')).toHaveAttribute("aria-current", "page");
    await page.goBack(); await ready(page);
    await expect(page.locator('[name=promptMode][value=none]')).toBeChecked();
    await expect(page.locator("#formatOptions input[value=json]")).toBeChecked();
    await navigateMain(page, "analyze"); await ready(page);
    await expect(page.locator("#activityList input[type=checkbox]").first()).toBeChecked();
    await page.reload(); await ready(page);
    await expect(collapse(page)).toHaveAttribute("aria-expanded", "false");
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

test("trusted sidebar reversals return the scrolled selected record to its original position", async t => {
    const records = scopeRecords().slice(0, 5);
    const { page } = await setup(t, { viewport: { width: 1600, height: 1100 } }, records, {
        channel: process.platform === "win32" ? "msedge" : undefined,
        ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--force-device-scale-factor=1.5"],
    });
    assert.ok(await page.evaluate(() => document.documentElement.clientWidth < innerWidth),
        "Native desktop scrollbar geometry is present, unlike the default headless overlay");
    await page.getByRole("link", { name: "View records", exact: true }).click();
    const selected = page.locator("#activityList .request-row").nth(1);
    await selected.locator("input[type=checkbox]").check();
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
    const toggle = await collapse(page).boundingBox();
    const checkpoints = [];
    for (const [index, wait] of [450, 900, 75, 75, 75, 450, 450, 900].entries()) {
        await page.mouse.click(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2);
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
    await expect(selected.locator("input[type=checkbox]")).toBeChecked();
    assert.ok(Math.abs(after.card.y - before.card.y) < 1, "The same final expanded state restores the same selected record position");
    assert.ok(Math.abs(after.scrollY - before.scrollY) < 1, "Repeated lateral motion does not accumulate page scroll drift");
    await page.mouse.click(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2);
    await page.waitForTimeout(70);
    await page.mouse.move(1000, 700);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(previous => scrollY > previous + 50, after.scrollY);
    await settled(page);
    const wheelY = await page.evaluate(() => scrollY);
    await page.mouse.click(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2);
    await settled(page);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - wheelY) < 1, "Finishing motion never restores stale pre-wheel scroll");
    const count = await page.locator("#activityCount").innerText();
    await page.locator('.flat-time-segment[data-segment="failure"]').first().hover();
    await expect(page.getByRole("tooltip")).toContainText(`of ${count} Work IQ tool calls`);
    await page.keyboard.press("Escape");
    await page.locator(".time-column").first().focus();
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText(count);
    await page.goBack(); await ready(page);
    await expect(selected.locator("input[type=checkbox]")).toBeChecked();
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
        assert.match(page.url(), /withinServices=Calendar/);
        assert.deepEqual(await order(), ["request:navigation-order-calendar"]);
        await page.goBack(); await ready(page);
        assert.equal(page.url(), originalUrl);
        const after = await order();
        if (proofs) await writeFile(path.join(proofs, `calendar-back-order-${cycle}.json`), JSON.stringify({ before, after }, null, 2));
        assert.deepEqual(after, before, "Returning from a service refinement restores the prior list, not the narrowed list first");
    }
});

test("service refinement owns its chart-data page and Back restores the parent page", async t => {
    const records = Array.from({ length: 26 }, (_, index) => {
        const record = fixture(`navigation-chart-page-${index}`);
        record.capturedAt = new Date(Date.UTC(2026, 8, index + 1, 12)).toISOString();
        const apiPath = index === 12 ? "/me/calendarView" : "/me/drive/root";
        record.toolCalls[0].requestArgs = { entityUrls: [apiPath] };
        record.toolCalls[0].requestedApiPath = apiPath;
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    const { page } = await setup(t, {}, records);
    await selectActivityOption(page, "bucketFilter", "day"); await ready(page);
    await page.locator("#meaning > summary").click();
    const pager = page.locator("#countTable .list-pager");
    await expect(pager).toContainText("1-24 of 26");
    await pager.getByRole("button", { name: "Next chart rows", exact: true }).click();
    await expect(pager).toContainText("25-26 of 26");
    const originalKey = await pager.getAttribute("data-view-key");
    const originalRows = await page.locator("#countTable tbody").innerText();
    const pages = [];
    for (let cycle = 0; cycle < 2; cycle++) {
        await page.locator("#percentageCharts").getByRole("link", { name: /^Calendar:.*View matching records/ }).click(); await ready(page);
        assert.notEqual(await pager.getAttribute("data-view-key"), originalKey);
        await expect(pager).toContainText(/^1-/);
        const refined = await pager.innerText();
        await page.goBack(); await ready(page);
        assert.equal(await pager.getAttribute("data-view-key"), originalKey);
        await expect(pager).toContainText("25-26 of 26");
        assert.equal(await page.locator("#countTable tbody").innerText(), originalRows);
        pages.push({ cycle, refined, restored: await pager.innerText() });
    }
    if (proofs) await writeFile(path.join(proofs, "calendar-chart-pages.json"), JSON.stringify(pages, null, 2));
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
            samples.push({ phase, at: performance.now(), header: rect(".app-header"), main: rect("#main"),
                brand: rect("#shellBrand"), logo: rect(".brand-home"),
                artwork: rect(`.brand-logo[data-brand-theme=${document.documentElement.dataset.evidenceTheme}]`),
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
    assert.ok(trace.every(frame => frame.artwork.width === 148 && frame.artwork.height === 46),
        "The wordmark retains its full geometry while the rail reveals or clips it laterally");
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
            captionHeight: document.querySelector(".brand-caption").getBoundingClientRect().height,
        }));
        const before = await geometry();
        await collapse(page).click();
        assert.equal(await page.locator("#sidebar").evaluate(node => node.getAnimations({ subtree: true }).length), 0);
        assert.deepEqual(await geometry(), before);
        await collapse(page).click();
        assert.deepEqual(await geometry(), before);
        const caption = await page.locator(".brand-caption").evaluate(node => ({
            width: node.clientWidth, content: node.scrollWidth, visible: node.checkVisibility({ visibilityProperty: true }),
        }));
        assert.ok(caption.visible && caption.content <= caption.width, "Enlarged caption wraps inside its reserved width without truncation");
        await capture(page, `enlarged-text-${theme}`);
    }
});

test("narrow overlay restores focus, traps keyboard, preserves the desktop choice and honors reduced motion", async t => {
    const { page } = await setup(t);
    await collapse(page).click(); await settled(page);
    const navigation = await page.locator(".primary-navigation").elementHandle();
    await page.locator('nav [data-nav="analyze"]').focus();
    await page.setViewportSize({ width: 375, height: 900 });
    const trigger = page.locator("#navigationToggle"), drawer = page.locator("#navigationDrawer");
    await expect(trigger).toBeFocused();
    await expect(page.locator("#navigationDrawer .display-time-zone")).toHaveCount(0);
    await expect(page.locator("#navigationDrawer #shellBrand")).toHaveCount(1);
    await expect(page.locator(".app-header .brand")).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await capture(page, `narrow-${theme}-closed`);
        await trigger.click();
        await expect(page.locator('nav [data-nav="analyze"]')).toBeFocused();
        assert.equal(await navigation.evaluate(node => node.closest("#navigationDrawer") !== null), true);
        await page.waitForTimeout(260);
        await capture(page, `narrow-${theme}-open`);
        for (let i = 0; i < 6; i++) {
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest("#navigationDrawer")), true);
        }
        await page.locator("#closeNavigation").focus();
        await page.keyboard.press("Escape");
        await expect(drawer).not.toHaveAttribute("open", "");
        await expect(trigger).toBeFocused();
    }
    await trigger.click();
    await page.locator('nav [data-nav="reports"]').click(); await ready(page);
    await expect(drawer).not.toHaveAttribute("open", "");
    await expect(page.locator("#pageTitle")).toBeFocused();
    await page.goBack(); await ready(page);
    await expect(page.locator("#pageTitle")).toHaveText("Analyze");
    await trigger.click();
    await page.waitForTimeout(260);
    await page.mouse.click(366, 400);
    await expect(drawer).not.toHaveAttribute("open", "");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.locator('nav [data-nav="settings"]').focus();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(drawer).not.toHaveAttribute("open", "");
    await expect(page.locator('nav [data-nav="settings"]')).toBeFocused();
    await expect(page.locator(".app-header .display-time-zone")).toHaveCount(0);
    await expect(page.locator(".app-header #shellBrand")).toHaveCount(1);
    await expect(collapse(page)).toHaveAttribute("aria-expanded", "false");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await collapse(page).click();
    assert.equal(await page.locator("#sidebar").evaluate(node => node.getAnimations({ subtree: true }).length), 0);
    await expect(collapse(page)).toHaveAttribute("aria-expanded", "true");
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await trigger.click();
    assert.equal(await drawer.evaluate(node => node.getAnimations().length), 0);
    for (const link of await page.locator(".primary-navigation a").all()) assert.ok((await link.boundingBox()).height >= 44);
    await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await capture(page, "narrow-dark-200");
});
