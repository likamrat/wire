import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, openActivitySessions, revealStoredRefresh } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WIRE_LINK_PROOFS;
const slice = "layer=tool&scope=all&from=2026-09-30&to=2026-09-30&service=Calendar&project=test-project";
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
}
async function setup(t, { readerBoundaries = false } = {}) {
    const row = fixture("navigation-links");
    row.sourceSessionName = "Synthetic navigation chat";
    row.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
    if (readerBoundaries) {
        row.userPrompt.text = "Synthetic boundary example: inspect the complete retained request without changing evidence. ".repeat(20);
        row.toolCalls.push({ ...structuredClone(row.toolCalls[0]), toolCallId: "boundary-failure", startEventId: "boundary-failure-start",
            toolSucceeded: false, reportedOutcome: "failed", apiResults: [{ index: 0, statusCode: 403 }] });
    }
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [row]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ url: request.url(), method: request.method() }));
    t.after(async () => {
        await browser.close();
        await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(request => new URL(request.url).origin === new URL(runtime.url).origin), "No external requests");
            assert.ok(requests.filter(request => request.method === "POST").every(request =>
                ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
                    "/api/report-artifacts/list", "/api/evaluation/automatic/summary"]
                    .includes(new URL(request.url).pathname)), "Navigation is read-only");
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#home?" + slice);
    await ready(page);
    return { page, runtime };
}
async function capture(page, name, selector) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.locator(selector).screenshot({ path: path.join(proofs, `${name}.png`) });
}
async function assertVisibleLinks(page, label) {
    const underlined = await page.locator("a[href]").evaluateAll(nodes => nodes
        .filter(node => node.checkVisibility()).flatMap(node => [node, ...node.querySelectorAll("*")]
            .filter(item => item.checkVisibility() && getComputedStyle(item).textDecorationLine !== "none")
            .map(item => item.textContent)));
    assert.deepEqual(underlined, [], `${label}: all visible native links and descendants omit underlines`);
}
async function assertLinkStates(page, link, label, focusSelector) {
    const decoration = () => link.evaluate(node => [node, ...node.querySelectorAll("*")]
        .filter(item => item.checkVisibility()).map(item => getComputedStyle(item).textDecorationLine));
    await page.mouse.move(0, 0);
    await link.evaluate(node => node.blur());
    assert.ok((await decoration()).every(value => value === "none"), `${label}: resting link and descendants have no underline`);
    await link.hover();
    assert.ok((await decoration()).every(value => value === "none"), `${label}: hover has no underline`);
    await page.mouse.down();
    assert.ok((await decoration()).every(value => value === "none"), `${label}: pressed link has no underline`);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await link.focus();
    await page.keyboard.press("Shift");
    assert.ok((await decoration()).every(value => value === "none"), `${label}: focus has no underline`);
    assert.equal(await link.evaluate((node, selector) => {
        const ring = selector ? node.querySelector(selector) : node;
        const style = getComputedStyle(ring);
        return node.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
    }, focusSelector), true, `${label}: visible keyboard focus`);
    assert.equal(await link.evaluate(node => node.tagName === "A" && node.hasAttribute("href") && node.tabIndex === 0), true, `${label}: native link`);
}

test("only the full graphical wordmark is the native Analyze target, not its subtitle", { timeout: 60000 }, async t => {
    const { page, runtime } = await setup(t);
    await navigateMain(page, "reports");
    await ready(page);
    await page.locator(".brand-caption").hover();
    await capture(page, "header-subtitle-hover", ".app-header");
    const caption = page.locator(".brand-caption");
    const interactive = await caption.evaluate(node => Boolean(node.closest("a,button,[role=link],[tabindex]")));
    if (proofs) await writeFile(path.join(proofs, "subtitle.json"), JSON.stringify({ interactive }, null, 2));
    assert.equal(interactive, false, "Subtitle must be plain text outside the Home anchor");
    const brand = page.locator(".brand a[data-nav=analyze]");
    assert.equal(await brand.count(), 1, "One Home link around both theme variants");
    assert.match(await brand.getAttribute("aria-label"), /WIRE.*Analyze/);
    assert.equal(await brand.locator(".brand-logo").count(), 2);
    assert.equal(await brand.locator(".brand-caption,a,button,[tabindex]").count(), 0);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const activity = page.url();
        await caption.click();
        assert.equal(page.url(), activity, "Clicking the subtitle does not navigate");
        const href = await brand.getAttribute("href");
        assert.equal(href, await page.locator("nav [data-nav=analyze]").getAttribute("href"), "Shared scoped Analyze route");
        const paint = () => brand.evaluate(node => [node, ...node.querySelectorAll("*")]
            .filter(item => item.checkVisibility()).map(item => {
                const style = getComputedStyle(item);
                return [style.backgroundColor, style.boxShadow, style.filter, style.opacity, style.transform, style.textDecorationLine];
            }));
        const restingPaint = await paint();
        await brand.hover();
        await capture(page, `header-${theme}-logo-hover`, ".app-header");
        assert.deepEqual(await paint(), restingPaint, "Hover does not visually change the logo");
        await page.mouse.down();
        try {
            assert.deepEqual(await paint(), restingPaint, "Press does not add logo highlighting");
        } finally {
            await page.mouse.move(0, 0);
            await page.mouse.up();
        }
        for (const part of [.05, .32, .57, .89]) {
            const logo = brand.locator(".brand-logo:visible");
            const bounds = await logo.boundingBox();
            await logo.click({ position: { x: bounds.width * part, y: bounds.height / 2 } });
            await ready(page);
            assert.equal(new URL(page.url()).hash, href, "Every letter area returns Home");
            await page.goBack();
            await ready(page);
            assert.equal(page.url(), activity);
        }
        await page.locator(".skip-link").focus();
        await page.keyboard.press("Tab");
        assert.equal(await brand.evaluate(node => node === document.activeElement), true, "Wordmark is one native Tab stop");
        await assertLinkStates(page, brand, `${theme} wordmark`);
        await capture(page, `header-${theme}-focus`, ".app-header");
        await page.keyboard.press("Enter");
        await ready(page);
        assert.equal(new URL(page.url()).hash, href, "Keyboard activation returns Home");
        await page.goBack();
        await ready(page);
        await brand.focus();
        await page.keyboard.press("Tab");
        assert.equal(await page.locator("#wireSearch").evaluate(node => node === document.activeElement), true, "Header Search follows the wordmark; subtitle is not a tab stop");
        const popupPromise = page.context().waitForEvent("page");
        await brand.click({ modifiers: ["Control"] });
        const popup = await popupPromise;
        try {
            await popup.waitForLoadState();
            await ready(popup);
            assert.equal(new URL(popup.url()).hash, href);
            assert.equal(page.url(), activity, "Modifier activation preserves the source tab");
        } finally { await popup.close(); }
    }
    assert.ok(page.url().startsWith(runtime.url));
});

test("authored chart, detail, Settings and dialog links have decoration-free native states", { timeout: 60000 }, async t => {
    const { page, runtime } = await setup(t);
    await capture(page, "home-links", "#homeView");
    for (const theme of ["light", "dark"]) for (const { width, scale } of [{ width: 1200, scale: 1 }, { width: 375, scale: 2 }]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await assertVisibleLinks(page, `${theme}/${width} Home`);
        const count = page.locator("#chart a:has(.dimensional-count)").first();
        await assertLinkStates(page, count, `${theme} chart count`, ".dimensional-count");
        if (width === 1200) await capture(page, `chart-${theme}-focus`, "#chart");
        await assertLinkStates(page, page.locator(".percentage-label[href]").first(), `${theme} chart category`);
        if (theme === "dark" && width === 375) await capture(page, "categories-dark-narrow-focus", "#percentageCharts");
        const countHref = await count.getAttribute("href");
        await count.locator(".dimensional-count").click();
        await ready(page);
        assert.equal(new URL(page.url()).hash, countHref);
        await page.goBack();
        await ready(page);
        await assertLinkStates(page, page.locator("#chart a:has(.dimensional-count)").first(), `${theme} revisited count`, ".dimensional-count");
        await navigateMain(page, "activity");
        await ready(page);
        await openActivitySessions(page);
        await assertVisibleLinks(page, `${theme}/${width} Activity`);
        const request = page.locator(".full-text-actions .request-link").first();
        await assertLinkStates(page, request, `${theme} full-text request`);
        if (width === 1200) await capture(page, `activity-${theme}-focus`, "#activityList");
        await request.click();
        await ready(page);
        await assertVisibleLinks(page, `${theme}/${width} Request`);
        await assertLinkStates(page, page.locator("#breadcrumbs a").first(), `${theme} detail breadcrumb`);
        await navigateMain(page, "settings");
        await ready(page);
        if (width === 375) await page.locator("#settingsCategorySummary").click();
        await assertVisibleLinks(page, `${theme}/${width} Settings`);
        await assertLinkStates(page, page.locator("#settingsCategoryNav a").first(), `${theme} Settings category`);
        await navigateMain(page, "reports");
        await ready(page);
        await assertVisibleLinks(page, `${theme}/${width} Reports`);
        await assertLinkStates(page, page.locator("#pageAction"), `${theme} Reports return`);
        await page.setViewportSize({ width: 375, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await page.locator("#navigationToggle").click();
        await assertVisibleLinks(page, `${theme}/${width} Navigation dialog`);
        await assertLinkStates(page, page.locator("#navigationDrawer a[data-nav=activity]"), `${theme} navigation dialog`);
        await capture(page, `dialog-${theme}-narrow-focus`, "#navigationDrawer");
        await page.keyboard.press("Escape");
        await capture(page, `header-${theme}-narrow-200`, ".app-header");
        assert.equal(await page.locator(".brand-caption").evaluate(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return new Set([...range.getClientRects()].map(rect => rect.top)).size;
        }), 1, "Subtitle stays on one line at enlarged text");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.setViewportSize({ width: 1200, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await page.goto(runtime.url + "#home?" + slice);
        await ready(page);
    }
});

test("new human HTML reports retain native section links without underlines", { timeout: 30000 }, async () => {
    const row = fixture("link-report"), before = structuredClone(row);
    const bundle = await buildSanitizedBundle([row], "a".repeat(64), { promptMode: "none", formats: ["html", "json"] });
    const browser = await chromium.launch(), page = await browser.newPage();
    const requests = [], errors = [];
    await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
    page.on("pageerror", error => errors.push(error.message));
    try {
        await page.setContent(bundle.files["product-report.html"]);
        for (const width of [1200, 375]) {
            await page.setViewportSize({ width, height: 1000 });
            for (const link of await page.locator("a").all()) {
                await assertLinkStates(page, link, `${width} report link`);
                await link.hover();
                assert.equal(await link.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", "New report text links do not paint a hover slab");
            }
        }
        const examples = page.locator('.report-nav a[href="#examples"]');
        await examples.focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.evaluate(() => location.hash), "#examples");
        await assertLinkStates(page, examples, "Revisited report section");
        await capture(page, "report-section-focus", ".report-nav");
        assert.deepEqual(requests, [], "Self-contained report requests no external resources");
        assert.deepEqual(errors, []);
        assert.deepEqual(row, before, "Generating new presentation does not modify captured source");
    } finally { await browser.close(); }
});

test("ordinary navigation text never paints its expanded hit target on hover or press", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await navigateMain(page, "activity");
    await ready(page);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const selector of [".session-drill", "#activityCollectionLink a"]) {
            const link = page.locator(selector).first();
            await link.hover();
            if (selector === ".session-drill") await capture(page, `plain-link-${theme}-hover`, ".session-heading");
            assert.equal(await link.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", `${selector}: no hover slab`);
            await page.mouse.down();
            try {
                assert.equal(await link.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", `${selector}: no pressed slab`);
            } finally { await page.mouse.move(0, 0); await page.mouse.up(); }
            await assertLinkStates(page, link, `${theme} ${selector}`);
        }
        const analysis = page.locator(".session-drill").first(), href = await analysis.getAttribute("href");
        await analysis.click();
        await ready(page);
        assert.equal(new URL(page.url()).hash, href);
        await page.goBack();
        await ready(page);
    }
});

test("text action controls have compact inset faces without shrinking native targets", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    for (const theme of ["light", "dark"]) for (const { width, scale } of [{ width: 1200, scale: 1 }, { width: 375, scale: 2 }]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await navigateMain(page, "activity");
        await ready(page);
        await capture(page, `activity-actions-${theme}-${width}`, "#activityCollectionLink");
        for (const selector of ["#activityDeleteShortcut", "#refreshBtn"]) {
            if (selector === "#refreshBtn") await revealStoredRefresh(page);
            const control = page.locator(selector);
            for (const state of ["rest", "hover", "pressed"]) {
                await page.mouse.move(0, 0);
                if (state !== "rest") await control.hover();
                if (state === "pressed") await page.mouse.down();
                try {
                    const paint = await control.evaluate(node => {
                        const style = getComputedStyle(node), face = getComputedStyle(node, "::before"), box = node.getBoundingClientRect();
                        return { target: box.height, rootFill: style.backgroundColor, face: face.content,
                            insetTop: parseFloat(face.top), insetBottom: parseFloat(face.bottom),
                            paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight) };
                    });
                    assert.equal(paint.rootFill, "rgba(0, 0, 0, 0)", `${selector}/${state}: outer target stays transparent`);
                    assert.notEqual(paint.face, "none", `${selector}: one inset control face`);
                    assert.ok(paint.target >= 44 && paint.insetTop === 4 && paint.insetBottom === 4, `${selector}/${state}: compact face inside native target`);
                    assert.equal(paint.paddingLeft, paint.paddingRight, "Balanced horizontal padding");
                } finally {
                    if (state === "pressed") { await page.mouse.move(0, 0); await page.mouse.up(); }
                }
            }
        }
        await page.locator("#activityDeleteShortcut").click();
        await page.locator("#deleteDialog").waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#activityDeleteShortcut").evaluate(node => node === document.activeElement), true);
    }
});

test("request actions and static result badges have visible boundaries without changing native behavior", { timeout: 60000 }, async t => {
    const { page } = await setup(t, { readerBoundaries: true }), failures = [], measurements = [];
    await navigateMain(page, "activity");
    await ready(page);
    await openActivitySessions(page);
    const row = page.locator(".request-row").first();
    for (const theme of ["light", "dark"]) for (const { width, scale } of [{ width: 1200, scale: 1 }, { width: 375, scale: 2 }]) {
        await page.setViewportSize({ width, height: 1400 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await page.evaluate(() => document.fonts.ready);
        const view = row.locator(".request-link"), reader = row.locator(".full-text-toggle");
        const route = page.url(), selection = await page.locator("#activitySelectionSummary").textContent();
        for (const state of ["rest", "hover", "focus"]) {
            for (const [name, control] of [["view", view], ["reader", reader]]) {
                await control.scrollIntoViewIfNeeded();
                await control.evaluate(node => node.blur());
                await page.mouse.move(0, 0);
                if (state === "hover") await control.hover();
                if (state === "focus") { await control.focus(); await page.keyboard.press("Shift"); }
                const value = await control.evaluate(node => {
                    const style = getComputedStyle(node), face = getComputedStyle(node, "::before"), box = node.getBoundingClientRect();
                    return { height: box.height, width: box.width, outer: style.backgroundColor,
                        face: face.backgroundColor, border: face.borderTopColor, borderWidth: parseFloat(face.borderTopWidth),
                        inset: parseFloat(face.top), line: parseFloat(style.lineHeight), decoration: style.textDecorationLine,
                        row: getComputedStyle(node.closest(".request-row")).backgroundColor,
                        focus: node.matches(":focus-visible"), outline: style.outlineStyle };
                });
                const label = `${theme}/${width}/${state}/${name}`;
                measurements.push({ label, ...value });
                if (!value.borderWidth || value.border === "rgba(0, 0, 0, 0)") failures.push(`${label}: no visible action boundary`);
                else if (contrast(value.border, value.row) < 3 || contrast(value.border, value.face) < 3) failures.push(`${label}: weak action boundary`);
                assert.equal(value.outer, "rgba(0, 0, 0, 0)");
                assert.equal(value.decoration, "none");
                assert.ok(value.height >= 44);
                if (state === "focus") assert.equal(value.focus && value.outline === "solid", true);
                await capture(page, `boundaries-${theme}-${width}-${state}-${name}`, ".request-row .full-text-actions");
            }
            for (const badge of await row.locator(".recorded-result:not(.result-link)").all()) {
                await badge.scrollIntoViewIfNeeded();
                if (state === "hover") await badge.hover(); else await page.mouse.move(0, 0);
                const before = await badge.boundingBox();
                const value = await badge.evaluate(node => {
                    const style = getComputedStyle(node);
                    return { shadow: style.boxShadow, face: style.backgroundColor, color: style.color,
                        row: getComputedStyle(node.closest(".request-row")).backgroundColor,
                        tag: node.tagName, tabIndex: node.tabIndex, interactive: Boolean(node.closest("a,button,[role=button],[role=link]")) };
                });
                const edge = value.shadow.match(/rgba?\([^)]+\)/)?.[0];
                if (!edge || !value.shadow.includes("inset")) failures.push(`${theme}/${width}/${state}: static badge has no keyline`);
                else if (contrast(edge, value.row) < 3 || contrast(edge, value.face) < 3) failures.push(`${theme}/${width}/${state}: weak badge keyline`);
                assert.equal(value.tag, "SPAN"); assert.equal(value.tabIndex, -1); assert.equal(value.interactive, false);
                assert.ok(contrast(value.color, value.face) >= 4.5);
                await badge.click();
                assert.equal(page.url(), route);
                assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
                assert.deepEqual(await badge.boundingBox(), before, "A static badge neither navigates nor shifts on click");
            }
            if (state !== "hover") await page.mouse.move(0, 0);
            await capture(page, `badges-${theme}-${width}-${state}`, ".request-row .recorded-results");
        }
        await reader.focus(); await page.keyboard.press("Enter");
        assert.equal(await reader.getAttribute("aria-expanded"), "true");
        await page.keyboard.press("Space");
        assert.equal(await reader.getAttribute("aria-expanded"), "false");
        assert.equal(page.url(), route);
        const href = await view.getAttribute("href");
        await view.focus(); await page.keyboard.press("Enter"); await ready(page);
        assert.equal(new URL(page.url()).hash, href);
        await page.goBack(); await ready(page); await openActivitySessions(page);
        assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
        const popupPromise = page.context().waitForEvent("page");
        await view.click({ modifiers: ["Control"] });
        const popup = await popupPromise;
        try {
            await popup.waitForLoadState(); await ready(popup);
            assert.equal(new URL(popup.url()).hash, href);
            assert.equal(page.url(), route, "Outlined navigation retains native modifier behavior");
        } finally { await popup.close(); }
        await navigateMain(page, "home"); await ready(page);
        if (await page.locator("#freshHelp").isVisible() && !await page.locator("#freshHelp").evaluate(node => node.open)) {
            await page.locator("#freshHelp > summary").click();
        }
        const disabled = page.locator("#checkActivity");
        await disabled.waitFor({ state: "visible" });
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const holdSnapshot = async route => { await held; await route.fallback(); };
        await page.route("**/api/snapshot", holdSnapshot);
        try {
            await (await revealStoredRefresh(page)).click();
            await page.waitForFunction(() => document.querySelector("#checkActivity").disabled);
            const value = await disabled.evaluate(node => {
                const style = getComputedStyle(node), face = getComputedStyle(node, "::before");
                return { disabled: node.disabled, outer: style.backgroundColor, border: face.borderTopColor,
                    borderWidth: parseFloat(face.borderTopWidth), height: node.getBoundingClientRect().height };
            });
            assert.equal(value.disabled, true);
            assert.equal(value.outer, "rgba(0, 0, 0, 0)");
            assert.equal(value.borderWidth, 1);
            assert.notEqual(value.border, "rgba(0, 0, 0, 0)");
            assert.ok(value.height >= 44);
            await capture(page, `disabled-${theme}-${width}`, "#checkActivity");
        } finally {
            release();
            await page.unroute("**/api/snapshot", holdSnapshot);
            await ready(page);
        }
        await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
    }
    if (proofs) await writeFile(path.join(proofs, "boundary-measurements.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(failures, []);
});
