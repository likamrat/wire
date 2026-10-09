import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture, fixture, chooseTheme, navigateMain, openActivitySessions } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WIRE_HEADING_FOCUS_PROOFS;

async function setup(t) {
    const record = fixture();
    record.sourceSessionName = "Synthetic review of a long chat heading that must stay readable when enlarged";
    const cleanup = [];
    const { root, context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.join(root, "invented-copilot-home");
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1614, height: 1100 }, reducedMotion: "reduce" });
    const errors = [], denied = [];
    const origin = new URL(runtime.url).origin;
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() === "POST" && ![
            "/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary",
            "/api/assessment/overview", "/api/assessment/detail", "/api/assessment/consent",
        ].includes(url.pathname)) {
            denied.push(`${request.method()} ${url.pathname}`);
            return route.abort();
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await runtime.close();
        for (const action of cleanup) await action();
        if (previousHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousHome;
        assert.deepEqual(errors, []);
        assert.deepEqual(denied, []);
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    return { page, url: runtime.url };
}

async function headingState(page) {
    return page.locator("#pageTitle").evaluate(node => {
        const style = getComputedStyle(node), rail = getComputedStyle(node, "::before");
        const range = document.createRange(); range.selectNodeContents(node);
        return {
            text: node.textContent, active: document.activeElement === node, focusVisible: node.matches(":focus-visible"),
            outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor,
            boxWidth: node.getBoundingClientRect().width, textWidth: range.getBoundingClientRect().width,
            role: node.tagName, tabindex: node.getAttribute("tabindex"),
            rail: { content: rail.content, width: rail.width, color: rail.backgroundColor },
        };
    });
}

test("normal route focus must not paint a full-width black box around the page heading", async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#collection-status");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await chooseTheme(page, "dark");
    await page.reload();
    await expect(page.locator("#pageTitle")).toBeFocused();
    const state = await headingState(page);
    if (proofs) {
        await page.screenshot({ path: path.join(proofs, "collection-route-focus.png"), fullPage: true });
        await writeFile(path.join(proofs, "route-focus.json"), JSON.stringify(state, null, 2));
    }
    assert.equal(state.role, "H1");
    assert.equal(state.tabindex, "-1");
    assert.equal(state.active, true, "Keep the semantic route focus destination");
    assert.equal(state.outlineStyle, "none", `Passive route heading has an unintended rectangle: ${JSON.stringify(state)}`);
    assert.equal(state.rail.width, "3px");
    assert.notEqual(state.rail.content, "none");
});

test("pointer, keyboard and Skip to content keep an intentional current-page destination", async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#home");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "collection-status");
    await expect(page.locator("#pageTitle")).toBeFocused();
    const pointer = await headingState(page);
    const authorOutlineRules = await page.locator("#pageTitle").evaluate(node => {
        const matching = [];
        function visit(rules) {
            for (const rule of rules) {
                if (rule.selectorText && !rule.selectorText.includes("::") && rule.style?.outline && node.matches(rule.selectorText)) matching.push(rule.selectorText);
                if (rule.cssRules) visit(rule.cssRules);
            }
        }
        for (const sheet of document.styleSheets) visit(sheet.cssRules);
        return matching;
    });
    await navigateMain(page, "home");
    await page.keyboard.press("Tab");
    const link = page.locator('nav [data-nav="collection-status"]');
    await link.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#pageTitle")).toBeFocused();
    const keyboard = await headingState(page), beforeSkip = page.url();
    await page.locator(".skip-link").focus(); await page.keyboard.press("Enter");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const skip = { url: page.url(), title: await page.locator("#pageTitle").textContent(),
        active: await page.evaluate(() => document.activeElement.id) };
    if (proofs) await writeFile(path.join(proofs, "navigation-focus.json"), JSON.stringify({ pointer, keyboard, authorOutlineRules, beforeSkip, skip }, null, 2));
    assert.equal(skip.url, beforeSkip, "Skip to content must not be interpreted as a route change to Home");
    assert.equal(skip.active, "pageTitle");
    assert.equal(skip.title, "Collection status");
    assert.equal(pointer.focusVisible, false);
    assert.equal(pointer.rail.content, "none");
    assert.equal(keyboard.focusVisible, true);
    assert.equal(keyboard.outlineStyle, "none");
    assert.notEqual(keyboard.rail.content, "none", "Keyboard users retain an intentional heading focus indicator");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id === "pageTitle"), false, "Passive heading is not added to the tab order");
    assert.equal(await page.evaluate(() => {
        const node = document.activeElement, style = getComputedStyle(node);
        return node.matches("a,button,input,select,summary") && node.matches(":focus-visible")
            && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
    }), true, "Interactive keyboard outlines stay intact");
    await navigateMain(page, "home");
    await page.goBack();
    await expect(page.locator("#pageTitle")).toHaveText("Collection status");
    assert.equal(await page.locator("#collectionStatusView").isVisible(), true);
});

test("shared page and section headings retain readable keyboard focus across routes and enlarged layouts", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t), measured = [];
    const routes = ["home", "activity", "activity?session=test-session", "request?request=test-scenario", "reports",
        "reports?task=create", "settings?section=connection", "settings?section=collection", "settings?section=display",
        "settings?section=data", "collection-status"];
    await page.goto(url + "#home");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    for (const [theme, width, size] of [["light", 1614, 100], ["dark", 375, 200]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
        for (const route of routes) {
            await page.goto(url + "#" + route);
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            const beforeSkip = page.url();
            await page.locator(".skip-link").focus(); await page.keyboard.press("Enter");
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await expect(page.locator("#pageTitle")).toBeFocused();
            assert.equal(page.url(), beforeSkip, route + ": skip preserves route, parameters and history");
            const main = await headingState(page);
            assert.equal(main.outlineStyle, "none", route);
            assert.equal(main.focusVisible, true, route);
            assert.equal(main.rail.width, "3px", route);
            assert.notEqual(main.rail.content, "none", route);
            assert.equal(await page.getByRole("heading", { name: main.text, exact: true, level: 1 }).count(), 1, "Screen-reader heading semantics remain intact");
            const geometry = await page.locator("#pageTitle").evaluate(node => {
                const rect = node.getBoundingClientRect(), header = document.querySelector(".app-header").getBoundingClientRect();
                return { top: rect.top, bottom: rect.bottom, left: rect.left, headerBottom: header.bottom,
                    overflow: document.documentElement.scrollWidth > innerWidth, pageColor: getComputedStyle(document.body).backgroundColor };
            });
            assert.equal(geometry.overflow, false, `${theme}/${route}: no page overflow`);
            assert.ok(geometry.top >= geometry.headerBottom, `${theme}/${route}: heading focus hidden by sticky header ${JSON.stringify(geometry)}`);
            assert.ok(geometry.left >= 8, "Focus rail stays inside the viewport");
            assert.ok(contrast(main.rail.color, geometry.pageColor) >= 3, "Keyboard heading indicator has visible contrast");
            measured.push({ theme, width, size, route, ...main, geometry });
            if (proofs && ["home", "activity?session=test-session", "collection-status"].includes(route)) {
                await page.screenshot({ path: path.join(proofs, `${theme}-${width}-${size}-${route.replaceAll(/[?=]/g, "-")}.png`) });
            }
            const headings = page.locator(':is(h2,h3,h4,h5,h6)[tabindex="-1"]:visible');
            for (let index = 0; index < await headings.count(); index++) {
                const heading = headings.nth(index);
                await heading.focus();
                const style = await heading.evaluate(node => ({
                    tag: node.tagName, outline: getComputedStyle(node).outlineStyle,
                    rail: getComputedStyle(node, "::before").content, width: getComputedStyle(node, "::before").width,
                }));
                assert.equal(style.outline, "none", route + ": " + await heading.textContent());
                assert.notEqual(style.rail, "none");
                assert.equal(style.width, "3px");
            }
        }
    }
    await page.emulateMedia({ forcedColors: "active" });
    await page.locator(".skip-link").focus(); await page.keyboard.press("Enter");
    const forced = await headingState(page);
    assert.notEqual(forced.rail.content, "none");
    assert.notEqual(forced.rail.color, "rgba(0, 0, 0, 0)");
    if (proofs) await writeFile(path.join(proofs, "shared-heading-matrix.json"), JSON.stringify({ measured, forced }, null, 2));
});

test("Skip preserves history, private query and report selection before ordinary Back navigation", async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#activity?range=capture");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await openActivitySessions(page);
    await page.locator("#select-request-test-scenario").check();
    await page.locator("#activitySearch").fill("Synthetic");
    await page.waitForFunction(() => history.state?.evidenceView?.search === "Synthetic");
    await expect(page.locator("#select-request-test-scenario")).toBeChecked();
    const before = await page.evaluate(() => ({ url: location.href, length: history.length, state: history.state,
        selection: document.querySelector("#activitySelectionSummary").textContent }));
    await page.locator(".skip-link").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#pageTitle")).toBeFocused();
    const after = await page.evaluate(() => ({ url: location.href, length: history.length, state: history.state,
        selection: document.querySelector("#activitySelectionSummary").textContent }));
    assert.deepEqual(after, before);
    await expect(page.locator("#activitySearch")).toHaveValue("Synthetic");
    await expect(page.locator("#select-request-test-scenario")).toBeChecked();
    await navigateMain(page, "home");
    await page.goBack();
    await expect(page.locator("#activitySearch")).toHaveValue("Synthetic");
    await expect(page.locator("#select-request-test-scenario")).toBeChecked();
});
