import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { chooseTheme, selectActivityOption, openSearchFilters, setLegacyTimeBucket, revealAnalyzeRecords, navigateMain } from "./helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { chooseReportScope } from "./report-journey-helpers.mjs";

async function setup(t, options = {}, browserOptions = {}) {
    const cleanup = [];
    const app = await searchFixture({ after: action => cleanup.push(action) }, options);
    const browser = await chromium.launch(browserOptions);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const errors = [], nonlocal = [];
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(app.runtime.url).origin) { nonlocal.push(url.href); return route.abort(); }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.deepEqual(nonlocal, []);
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    return { ...app, page };
}

async function screenshot(page, name) {
    if (!process.env.WIRE_SEARCH_CONTROL_PROOFS) return;
    await mkdir(process.env.WIRE_SEARCH_CONTROL_PROOFS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.WIRE_SEARCH_CONTROL_PROOFS, name + ".png") });
}

async function clickVisible(page, locator) {
    const box = await locator.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height);
    // Locator auto-positioning can scroll a sticky field before the app sees pointerdown.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function geometry(page) {
    return page.locator(".header-inner").evaluate(header => {
        const rect = node => {
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height,
                right: box.right, bottom: box.bottom, center: box.y + box.height / 2 };
        };
        const input = document.querySelector("#wireSearch"), label = document.querySelector('[for="wireSearch"]');
        const theme = header.querySelector(".theme-control"), style = getComputedStyle(input);
        const navigation = document.querySelector(".primary-navigation");
        const toolbar = header.querySelector(".workspace-toolbar"), main = document.querySelector("#main");
        return {
            input: rect(input), label: rect(label), themeControl: rect(theme), header: rect(header),
            toolbar: rect(toolbar), main: rect(main),
            home: rect(document.querySelector("#wireSearchHome")), panel: rect(document.querySelector("#wireSearchPanel")),
            entry: rect(input.parentElement), radius: parseFloat(style.borderTopLeftRadius),
            font: style.fontSize, labelFont: getComputedStyle(label).fontSize,
            labelClip: getComputedStyle(label).clipPath,
            navigationFont: getComputedStyle(navigation.querySelector("a")).fontSize,
            outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
            viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
            direct: [...header.querySelectorAll(".workspace-toolbar-inner > *"), ...header.querySelectorAll(":scope > .brand")].filter(node => node.checkVisibility()).map(rect),
            associated: input.labels.length === 1 && input.labels[0] === label,
        };
    });
}

test("search control: capsule and page geometry stay fixed while live results appear in both themes and enlarged text", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const input = page.getByRole("searchbox", { name: "Search", exact: true });
    await expect(input).toHaveCount(1);
    await expect(page.locator('[for="wireSearch"]')).toHaveText("Search");
    const measurements = [];
    for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        await chooseTheme(page, theme);
        await page.mouse.move(0, 0);
        for (const [width, percent] of [[1280, 100], [375, 100], [375, 200]]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(percent => { document.documentElement.style.fontSize = percent + "%"; window.scrollTo(0, 0); }, percent);
            await input.fill("");
            await input.focus();
            if (await page.locator("#evidence-tooltip").isVisible()) await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
            await expect(page.locator("#wireSearchPanel")).toBeHidden();
            const closed = await geometry(page);
            assert.ok(closed.radius >= closed.input.height / 2, "Search is a capsule");
            await page.locator("#main").focus();
            await input.focus();
            await expect(page.locator("#wireSearchPanel")).toBeHidden();
            assert.deepEqual((await geometry(page)).input, closed.input, "Empty focus must not expand, move or open Search");
            await input.pressSequentially("Theme");
            await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
            await expect(page.locator("#wireSearchPanel")).toBeVisible();
            const result = await geometry(page);
            assert.equal(result.associated, true);
            assert.deepEqual(result.input, closed.input, "Typing and results must not change field position or size");
            assert.deepEqual(result.header, closed.header);
            assert.deepEqual(result.main, closed.main, "Results must not shift or expand the underlying page");
            assert.ok(result.radius >= result.input.height / 2);
            assert.ok(result.input.height >= 44);
            assert.ok(Math.abs(result.input.width - result.panel.width) < 1, "Results align with the unchanged capsule");
            assert.ok(Math.abs(result.panel.x - result.input.x) < 1);
            assert.ok(result.panel.y >= result.input.bottom && result.panel.bottom <= 900);
            assert.ok(result.label.width <= 1 && result.labelClip !== "none", "The associated label is not a visible header caption");
            assert.ok(Math.abs(result.input.width - result.entry.width) < 1, "No empty label track remains beside the field");
            assert.equal(result.font, result.navigationFont);
            assert.equal(result.outline, "solid"); assert.ok(result.outlineWidth >= 2);
            assert.ok(result.input.right <= result.entry.right + 1);
            assert.ok(result.input.width > result.entry.width / 2, "The associated label must not crowd out enlarged query text");
            assert.ok(result.documentWidth <= result.viewport);
            for (let i = 0; i < result.direct.length; i++) for (const other of result.direct.slice(i + 1)) {
                const item = result.direct[i];
                const overlapWidth = Math.min(item.right, other.right) - Math.max(item.x, other.x);
                const overlapHeight = Math.min(item.bottom, other.bottom) - Math.max(item.y, other.y);
                assert.ok(overlapWidth <= 1 || overlapHeight <= 1, "Header search, navigation trigger, brand and theme must not overlap");
            }
            if (width === 1280) {
                assert.ok(Math.abs(result.entry.x + result.entry.width / 2 - result.main.x - result.main.width / 2) < 1,
                    "Search is horizontally centered in the main workspace rather than placed beside the logo");
                assert.ok(result.input.width <= 460);
            } else {
                await expect(page.locator("#navigationToggle")).toBeVisible();
                await expect(page.locator(".app-header nav")).toHaveCount(0);
            }
            measurements.push({ theme, width, percent, ...result });
            await screenshot(page, `search-control-${theme}-${width}-${percent}`);
        }
    }
    t.diagnostic(JSON.stringify(measurements));
});

test("search control: native editing, long query, state feedback and keyboard Open/Back retain the corrected field", { timeout: 40000 }, async t => {
    const { page } = await setup(t);
    const input = page.getByRole("searchbox", { name: "Search", exact: true });
    await input.focus();
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    const longQuery = "Invented long query for local navigation ".repeat(30);
    await input.fill(longQuery);
    await input.press("Home");
    await input.pressSequentially("X");
    await expect(input).toHaveValue("X" + longQuery);
    assert.equal(await input.evaluate(node => node.selectionStart), 1);
    await input.press("End");
    await input.press("Backspace");
    await expect(input).toHaveValue(("X" + longQuery).slice(0, -1));
    assert.equal(await input.evaluate(node => node.selectionStart), longQuery.length);
    const result = await geometry(page);
    assert.ok(result.input.right <= result.entry.right + 1);
    assert.ok(await input.evaluate(node => node.scrollLeft > 0), "Long queries scroll inside the native field instead of widening the header");
    await screenshot(page, "search-control-long-query");
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await input.press("End");
    const narrow = await geometry(page);
    assert.equal(narrow.font, "28px");
    assert.ok(narrow.documentWidth <= narrow.viewport);
    assert.ok(narrow.radius >= narrow.input.height / 2);
    assert.equal(await input.evaluate(node => node.selectionStart), longQuery.length);
    await screenshot(page, "search-control-long-query-375-200");
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.keyboard.insertText("réunion 予定");
    await expect(input).toHaveValue("réunion 予定");
    assert.equal(await input.evaluate(node => node.selectionStart), "réunion 予定".length);
    await input.fill("Short editable query");
    await openSearchFilters(page);
    await page.locator("#wireSearchClear").click();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/search/query", async route => {
        if (route.request().postDataJSON().query === "Theme") { entered.resolve(); await release.promise; }
        await route.continue();
    });
    await input.press("ControlOrMeta+A");
    await input.pressSequentially("Theme");
    await selectActivityOption(page, "wireSearchType", "setting");
    await entered.promise;
    await expect(page.locator("#wireSearchStatus")).toHaveText("Searching...");
    await screenshot(page, "search-control-pending");
    release.resolve();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator("#wireSearchStatus")).toHaveText(/1 (?:available )?match/);
    await expect(page.locator("#wireSearchCoverage")).not.toContainText("npm run");
    await input.press("ArrowDown");
    await expect(page.locator("#wireSearchResults button")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/setting=theme/);
    await page.goBack();
    await expect(input).toHaveValue("Theme");
    await expect(page.locator("#wireSearchResults button")).toBeFocused();
    await expect(page.locator("#wireSearchType")).toHaveValue("setting");
    await input.fill("INVENTED_HEADER_NO_MATCH_82791");
    await expect(page.locator("#wireSearchStatus")).toHaveText("No matches. Try different words.");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await screenshot(page, "search-control-no-match");
    await input.press("Escape");
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await expect(input).toHaveAttribute("aria-expanded", "false");
    await input.press("Tab");
    await input.focus();
    await expect(page.locator("#wireSearchPanel")).toBeVisible();
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await input.fill("physician");
    await expect(page.locator("#activityListScope")).toHaveText("Search applied");
    await expect(page.locator("#activityCount")).toHaveText("1");
});

test("compact Search preserves native input identity, caret and page position throughout typing and dismissal", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const input = page.locator("#wireSearch");
    await input.evaluate(node => { window.originalSearchInput = node; });
    for (const width of [1280, 375]) {
            await page.setViewportSize({ width, height: 900 });
            await page.mouse.move(width - 30, 700);
            await page.mouse.wheel(0, 420);
            await page.waitForFunction(() => scrollY >= 400);
            const before = await page.evaluate(() => ({ y: scrollY, header: document.querySelector(".app-header").getBoundingClientRect().height }));
            await clickVisible(page, input);
            await expect(input).toBeFocused();
            await expect(page.locator(".app-header #wireSearch")).toHaveCount(1);
            await input.fill("Theme");
            await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
            assert.ok(Math.abs(await page.evaluate(() => scrollY) - before.y) < 1, "Typing does not move the page");
            await input.press("Home"); await input.press("ArrowRight");
            assert.equal(await input.evaluate(node => node.selectionStart), 1);
            await input.evaluate(node => {
                node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
                node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", isComposing: true }));
            });
            await expect(page.locator("#wireSearchPanel")).toBeVisible();
            await input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" })));
            assert.equal(await input.evaluate(node => node === window.originalSearchInput), true);
            assert.equal(await page.locator(".app-header").evaluate(node => node.getBoundingClientRect().height), before.header);
            await page.keyboard.press("Escape");
            await expect(page.locator("#wireSearchPanel")).toBeHidden();
            await expect(input).toBeFocused();
            assert.equal(await input.evaluate(node => node.selectionStart), 1);
            assert.ok(Math.abs(await page.evaluate(() => scrollY) - before.y) < 1);
            // A still-focused field must reopen on a real click, not require blur first.
            await clickVisible(page, input);
            await expect(page.locator("#wireSearchPanel")).toBeVisible();
            await page.mouse.move(0, 0);
            await page.keyboard.press("Escape");
            await expect(page.locator("#wireSearchPanel")).toBeHidden();
            assert.ok(Math.abs(await page.evaluate(() => scrollY) - before.y) < 1);
            await expect(page.locator("#wireSearchHome #wireSearch")).toHaveCount(1);
            assert.equal(await input.evaluate(node => node === window.originalSearchInput), true);
            await screenshot(page, `search-return-${width}`);
            await page.evaluate(() => scrollTo(0, 0));
    }
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await input.click();
    await input.press("ArrowDown");
    await expect(page.locator("#wireSearchResults button")).toBeFocused();
    const forced = await page.locator("#wireSearchPanel").evaluate(node => {
        const css = getComputedStyle(node), hit = getComputedStyle(node.querySelector(".wire-search-hit"));
        return { shadow: css.boxShadow, border: css.borderTopStyle, outline: hit.outlineStyle, width: parseFloat(hit.outlineWidth) };
    });
    assert.equal(forced.shadow, "none"); assert.equal(forced.border, "solid");
    assert.equal(forced.outline, "solid"); assert.ok(forced.width >= 2);
});

test("compact Search exposes held, superseded, disconnected and retry states without reviving stale rows", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const input = page.locator("#wireSearch"), panel = page.locator("#wireSearchPanel");
    await input.click();
    await expect(page.locator("#wireSearchRetry")).toBeHidden();
    const held = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/search/query", async route => {
        if (route.request().postDataJSON().query === "physician") { held.resolve(); await release.promise; }
        await route.continue();
    });
    await input.fill("physician");
    await held.promise;
    await expect(page.locator("#wireSearchStatus")).toHaveText("Searching...");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await screenshot(page, "search-composer-held");
    await input.fill("Theme");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const oldFinished = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search/query"
        && response.request().postDataJSON().query === "physician");
    release.resolve();
    await oldFinished;
    await expect(page.locator("#wireSearchResults button")).toContainText("Theme");
    await input.press("Escape");
    await expect(panel).toBeHidden();
    await page.waitForTimeout(180);
    await expect(panel).toBeHidden();
    await page.route("**/api/search/query", route => route.fulfill({ status: 503, contentType: "application/json",
        body: JSON.stringify({ code: "runtime_unavailable", error: "Search is unavailable. Try again." }) }));
    await input.fill("INVENTED_UNAVAILABLE_QUERY_718");
    await expect(page.locator("#wireSearchStatus")).toContainText("unavailable");
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await screenshot(page, "search-composer-unavailable");
    await page.unroute("**/api/search/query");
    await page.locator("#wireSearchRetry").click();
    await expect(page.locator("#wireSearchStatus")).toHaveText("No matches. Try different words.");
    await expect(page.locator("#wireSearchCoverage")).not.toContainText("Word search only.");
    await screenshot(page, "search-composer-empty");
    const clearing = Promise.withResolvers(), clearedResponse = Promise.withResolvers();
    t.after(() => clearedResponse.resolve());
    await page.route("**/api/search/query", async route => {
        if (route.request().postDataJSON().query === "mechanic") { clearing.resolve(); await clearedResponse.promise; }
        await route.continue();
    });
    await input.fill("mechanic");
    await clearing.promise;
    await input.press("ControlOrMeta+A"); await input.press("Backspace");
    await expect(input).toHaveValue("");
    await expect(panel).toBeHidden();
    const late = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search/query"
        && response.request().postDataJSON().query === "mechanic");
    clearedResponse.resolve(); await late;
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await expect(page.locator("#wireSearchRelatedResults button")).toHaveCount(0);
    await expect(panel).toBeHidden();
    await expect(input).toHaveValue("");
    await page.unroute("**/api/search/query");
});

test("compact Search opens the exact retained interaction and restores its result focus and list position", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const input = page.locator("#wireSearch");
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        const count = await page.locator("#activityCount").textContent();
        await input.fill("physician");
        await selectActivityOption(page, "wireSearchType", "interaction");
        const result = page.locator("#wireSearchResults button");
        await expect(result).toHaveCount(1);
        await expect(page.locator("#activityCount")).toHaveText(count);
        const id = await result.getAttribute("data-search-id");
        await input.press("ArrowDown"); await expect(result).toBeFocused();
        const before = await result.evaluate(node => {
            const box = node.getBoundingClientRect();
            return { y: box.y, scroll: document.querySelector("#wireSearchResults").scrollTop };
        });
        await page.keyboard.press("Enter");
        await expect(page.locator("#requestContent")).toContainText("The physician treated an injured patient in the hospital.");
        await expect(page.locator("#wireSearchHome #wireSearch")).toHaveCount(1);
        await expect(page.locator("#wireSearchPanel")).toBeHidden();
        await page.locator("#closeContextSidebar").click();
        await expect(result).toBeFocused();
        await expect(result).toHaveAttribute("data-search-id", id);
        await expect(input).toHaveValue("physician");
        assert.equal(await page.locator("#wireSearchResults").evaluate(node => node.scrollTop), before.scroll);
        assert.ok(Math.abs((await result.boundingBox()).y - before.y) < 1);
        await expect(page.locator("#activityCount")).toHaveText(count);
        await screenshot(page, `search-record-back-${width}`);
        await page.keyboard.press("Escape");
    }
});

test("Search preserves Analyze records through live results, dismissal and record Back without replaying stale reading intent", { timeout: 30000 }, async t => {
    const { page, runtime } = await setup(t, { records: searchRecords(12) });
    const input = page.locator("#wireSearch");
    const position = () => page.evaluate(() => ({
        y: scrollY, title: document.querySelector("#activityTitle").getBoundingClientRect().top,
    }));
    for (const [width, mode] of [[1440, "empty"], [1440, "populated"], [1440, "back"], [375, "escape"], [1440, "changed-route"], [1440, "late"]]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
        await page.goto(runtime.url);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.evaluate(() => document.fonts.ready);
        await revealAnalyzeRecords(page);
        await page.locator("#activityList .request-card-open").nth(6).scrollIntoViewIfNeeded();
        const before = await position();
        assert.ok(before.y > 600, "Exercise deep reading, not the old fixed 420px case");
        await clickVisible(page, input);
        if (mode !== "empty") {
            await input.pressSequentially("Invented local");
            await expect(page.locator("#wireSearchStatus")).toHaveText(/\d+ matches/);
            assert.ok(await page.locator("#wireSearchResults button").count() > 1);
            assert.deepEqual(await position(), before, "Live results do not move the reading position");
        }
        if (mode === "back") {
            await selectActivityOption(page, "wireSearchType", "interaction");
            await expect(page.locator("#wireSearchResults button")).toHaveCount(12);
            await input.press("ArrowDown");
            const id = await page.locator("#wireSearchResults button:focus").getAttribute("data-search-id");
            await page.keyboard.press("Enter");
            await expect(page.locator("#closeContextSidebar")).toBeVisible();
            await page.goBack();
            await expect(page.locator("#wireSearchResults button:focus")).toHaveAttribute("data-search-id", id);
            await expect(input).toHaveValue("Invented local");
        }
        let release, finished;
        if (mode === "late") {
            const entered = Promise.withResolvers(), held = Promise.withResolvers();
            release = held.resolve;
            t.after(release);
            await page.route("**/api/search/query", async route => {
                entered.resolve(); await held.promise; await route.continue();
            });

            await input.fill("INVENTED_HELD_RETURN_QUERY_617");
            await entered.promise;
            finished = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search/query"
                && response.request().postDataJSON().query === "INVENTED_HELD_RETURN_QUERY_617");
        }
        let expected = before;
        if (mode === "changed-route") {
            await page.locator('nav [data-nav="reports"]:visible').click();
            await expect(page.locator("#pageTitle")).toHaveText("Reports");
            expected = await position();
        }
        await page.keyboard.press("Escape");
        await expect(page.locator("#wireSearchPanel")).toBeHidden();
        const after = await position();
        assert.ok(Math.abs(after.y - expected.y) < 1, `${width}/${mode} returns to the actual entry page position: ${JSON.stringify({ expected, after })}`);
        assert.ok(Math.abs(after.title - expected.title) < 1, `${width}/${mode} preserves the reading target`);
        if (mode !== "changed-route") await expect(input).toBeFocused();
        if (mode === "late") {
            await page.mouse.move(width - 30, 700);
            await page.mouse.wheel(0, -100);
            await expect.poll(async () => (await position()).y).toBeLessThan(after.y);
            const wheelPosition = (await position()).y;
            await input.press("Tab");
            await page.keyboard.press("PageUp");
            await expect.poll(async () => (await position()).y).toBeLessThan(wheelPosition);
            await page.waitForTimeout(250);
            const reading = await position();
            release(); await finished;
            await page.unroute("**/api/search/query");
            await expect(page.locator("#wireSearchPanel")).toBeHidden();
            assert.ok(Math.abs((await position()).y - reading.y) < 1, "Late results cannot override later wheel/key reading");
        }
    }
});

test("compact result scrolling, paging and Back stay inside the list without changing the underlying page", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { records: searchRecords(45) });
    const input = page.locator("#wireSearch"), panel = page.locator("#wireSearchPanel");
    await revealAnalyzeRecords(page);
    const pageY = await page.evaluate(() => scrollY);
    await clickVisible(page, input);
    await page.keyboard.type("Invented local");
    await selectActivityOption(page, "wireSearchType", "interaction");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(20);
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 1 of 3");
    const ids = new Set(await page.locator("#wireSearchResults button").evaluateAll(nodes => nodes.map(node => node.dataset.searchId)));
    const bounds = await panel.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => panel.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    assert.equal(await page.evaluate(() => scrollY), pageY);
    await page.getByRole("button", { name: "Next results", exact: true }).click();
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 3");
    await expect(page.locator("#wireSearchResults button").first()).toBeFocused();
    for (const id of await page.locator("#wireSearchResults button").evaluateAll(nodes => nodes.map(node => node.dataset.searchId))) {
        assert.equal(ids.has(id), false); ids.add(id);
    }
    await page.getByRole("button", { name: "Next results", exact: true }).click();
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 3 of 3");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Next results", exact: true })).toBeDisabled();
    for (const id of await page.locator("#wireSearchResults button").evaluateAll(nodes => nodes.map(node => node.dataset.searchId))) {
        assert.equal(ids.has(id), false); ids.add(id);
    }
    assert.equal(ids.size, 45, "Every real result remains reachable exactly once");
    await page.getByRole("button", { name: "Previous results", exact: true }).click();
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 3");
    await page.keyboard.press("End"); await page.keyboard.press("Home");
    await expect(page.locator("#wireSearchResults button").first()).toBeFocused();
    await page.keyboard.press("End");
    const last = page.locator("#wireSearchResults button").last();
    await expect(last).toBeFocused();
    const id = await last.getAttribute("data-search-id"), scroll = await panel.evaluate(node => node.scrollTop);
    assert.ok(scroll > 0);
    assert.equal(await page.evaluate(() => scrollY), pageY);
    const rect = await last.boundingBox();
    assert.ok(rect.y >= bounds.y && rect.y + rect.height <= bounds.y + bounds.height);
    await page.keyboard.press("Enter");
    await expect(page.locator("#closeContextSidebar")).toBeVisible();
    await page.goBack();
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute("data-search-id", id);
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 3");
    assert.equal(await panel.evaluate(node => node.scrollTop), scroll);
    assert.equal(await page.evaluate(() => scrollY), pageY);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await clickVisible(page, input);
    await expect(panel).toBeVisible();
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingTop), "0px");
    await page.keyboard.press("Tab");
    await expect(page.locator("#wireSearchClear")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#wireSearchScope-control")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#wireSearchType-control")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#wireSearchResults button").first()).toBeFocused();
    await clickVisible(page, page.getByRole("switch", { name: "Dark theme", exact: true }));
    await expect(panel).toBeHidden();
    await expect(page.getByRole("switch", { name: "Dark theme", exact: true })).toBeFocused();
    const inset = await page.evaluate(() => ({
        padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
        header: document.querySelector(".app-header").getBoundingClientRect().height,
    }));
    assert.ok(Math.abs(inset.padding - inset.header - 16) < 1, "Ordinary reading inset returns when focus leaves Search");
    await page.mouse.move(0, 0);
    await revealAnalyzeRecords(page);
    const titleY = await page.locator("#activityTitle").evaluate(node => node.getBoundingClientRect().top);
    const limit = await page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight, viewport: innerHeight }));
    assert.ok(titleY >= inset.header && titleY < limit.viewport
        && (titleY < inset.header + 60 || Math.abs(limit.y - limit.max) < 1), "Anchor targets remain below the header, or at the real short-page scroll limit");
});

test("native compact Search keeps deep typing stationary and restores the reading inset only on focus departure", { timeout: 60000 }, async t => {
    const { page, runtime } = await setup(t, { records: searchRecords(12) }, {
        channel: process.platform === "win32" ? "msedge" : undefined,
        headless: !process.env.WIRE_SEARCH_NATIVE_HEADFUL, ignoreDefaultArgs: ["--hide-scrollbars"],
    });
    const input = page.locator("#wireSearch"), panel = page.locator("#wireSearchPanel");
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [1440, 768, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(runtime.url);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.evaluate(() => document.fonts.ready);
        await chooseTheme(page, theme);
        await page.mouse.move(0, 0);
        const idle = await geometry(page);
        assert.equal(idle.input.height, 44);
        assert.ok(idle.input.width <= 460);
        assert.ok(Math.abs(idle.input.x + idle.input.width / 2 - idle.main.x - idle.main.width / 2) < 1);
        await expect(page.locator(".display-time-zone")).toHaveCount(0);
        await expect(page.locator(".workspace-utilities > *")).toHaveCount(1);
        await screenshot(page, `native-${theme}-${width}-idle`);
        await revealAnalyzeRecords(page);
        await page.locator("#activityList .request-card-open").nth(6).scrollIntoViewIfNeeded();
        const reading = await page.evaluate(() => scrollY);
        assert.ok(reading > 600);
        await input.evaluate(node => { window.originalSearchInput = node; });
        await clickVisible(page, input);
        await expect(panel).toBeHidden();
        assert.deepEqual((await geometry(page)).input, idle.input);
        await screenshot(page, `native-${theme}-${width}-focus`);
        for (const character of "Invented local") {
            await page.keyboard.type(character);
            assert.equal(await page.evaluate(() => scrollY), reading, `Native "${character}" must not move the page`);
        }
        await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
        const results = await geometry(page);
        assert.deepEqual(results.input, idle.input);
        assert.deepEqual(results.header, idle.header);
        assert.equal(await input.evaluate(node => node === window.originalSearchInput), true);
        assert.equal(await input.evaluate(node => node.selectionStart), "Invented local".length);
        assert.ok(Math.abs(results.input.width - results.panel.width) < 1);
        assert.ok(results.panel.bottom <= 1000);
        await screenshot(page, `native-${theme}-${width}-results`);
        await page.keyboard.press("Escape");
        await expect(input).toBeFocused();
        await expect(panel).toBeHidden();
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingTop), "0px",
            "Escape does not relinquish Search focus");
        assert.equal(await page.evaluate(() => scrollY), reading);
        await page.keyboard.press("Tab");
        await expect(page.locator("#wireSearchClear")).toBeFocused();
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingTop), "0px",
            "Query-clear focus remains within Search");
        await page.keyboard.press("Tab");
        await expect(page.getByRole("switch", { name: "Dark theme", exact: true })).toBeFocused();
        const restored = await page.evaluate(() => ({
            inset: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
            header: document.querySelector(".app-header").getBoundingClientRect().height,
            focusInSearch: document.querySelector("#wireSearchHome").contains(document.activeElement),
        }));
        assert.equal(restored.focusInSearch, false);
        assert.ok(Math.abs(restored.inset - restored.header - 16) < 1);
        await page.locator(".skip-link").focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#pageTitle")).toBeFocused();
        assert.ok((await page.locator("#pageTitle").boundingBox()).y >= restored.header);
        await revealAnalyzeRecords(page);
        const target = await page.locator("#activityTitle").boundingBox();
        const limit = await page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight, viewport: innerHeight }));
        assert.ok(target.y >= restored.header && target.y < limit.viewport
            && (target.y < restored.header + 60 || Math.abs(limit.y - limit.max) < 1), JSON.stringify({ target, restored, limit }));
        measurements.push({ theme, width, idle, results, reading, restored, target });
    }
    if (process.env.WIRE_SEARCH_CONTROL_PROOFS) await writeFile(path.join(process.env.WIRE_SEARCH_CONTROL_PROOFS,
        "native-focus-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("compact Search keeps actual Analyze membership, local grouping and Settings destinations independent", { timeout: 40000 }, async t => {
    const records = searchRecords(6).map((row, index) => ({
        ...row, capturedAt: `2026-10-${index < 3 ? "06" : "07"}T12:00:00.000Z`,
    }));
    const { page, context, runtime } = await setup(t, { records });
    const before = await loadBoardState(context);
    const input = page.locator("#wireSearch");
    const ids = () => page.locator("#activityList .request-card-open").evaluateAll(nodes => nodes.map(node =>
        new URLSearchParams(node.hash.split("?")[1]).get("request")).sort());
    const allIds = await ids();
    assert.deepEqual(allIds, records.map(row => row.scenarioId).sort());
    await page.locator("#activityList .request-card-open").first().click();
    await page.locator("#requestReportToggle").click();
    await page.locator("#closeContextSidebar").click();
    await setLegacyTimeBucket(page, "day");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    assert.deepEqual(await ids(), allIds);
    await expect(page.locator("#filterChips")).toBeEmpty();
    await expect(page.locator("#resetView")).toBeDisabled();
    await input.fill("physician");
    await selectActivityOption(page, "wireSearchType", "interaction");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(2);
    await expect(page.locator("#wireSearchCoverage")).not.toContainText("Word search only.");
    await expect(page.locator("#wireSearchRelated")).toBeHidden();
    await expect(page.locator("#activityCount")).toHaveText("6");
    assert.deepEqual(await ids(), allIds, "Navigation search never applies a hidden analytical filter");
    await expect(page.locator("#filterChips")).toBeEmpty();
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#activityListScope")).toContainText("Search applied");
    await expect(page.locator("#activityCount")).toHaveText("2");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const matchingIds = await ids();
    assert.deepEqual(matchingIds, ["search-0", "search-3"], "Only the two actual physician interactions enter membership");
    await expect(page.locator("#wireSearchType")).toBeDisabled();
    assert.equal(await page.locator("#wireAnalysisSearchNotice").evaluate(node => node.parentElement.id), "main");
    await input.press("Escape");
    for (const bucket of ["week", "month", "day"]) {
        await setLegacyTimeBucket(page, bucket);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#homeView")).toBeVisible();
        await expect(page.locator("#activityCount")).toHaveText("2");
        await expect.poll(ids).toEqual(matchingIds);
        assert.equal(await page.locator(".flat-time-column").evaluateAll(nodes =>
            nodes.reduce((total, node) => total + Number(node.dataset.total), 0)), 2);
        await expect(page.locator("#filterChips")).toBeEmpty();
        await expect(page.locator("#scopeCount-current > span")).toHaveText(["1 chat", "2 interactions"]);
    }
    await page.locator(".time-column").first().click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#activityCount")).toHaveText("1");
    assert.deepEqual(await ids(), ["search-0"]);
    await expect(page.locator("#filterChips button")).toHaveAttribute("aria-label", /^Remove date filter:/);
    await page.goBack();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText("2");
    await expect.poll(ids).toEqual(matchingIds);
    await page.locator("#pageAction").click();
    await chooseReportScope(page, "current");
    await expect(page.locator("#scopeCount-current > span")).toHaveText(["1 chat", "2 interactions"]);
    await expect(page.locator("#scopeCount-selected")).toHaveText(/^1 /);
    await expect(page.locator("#wireAnalysisSearchNotice")).toBeHidden();
    await expect(page.locator("#pageTitle")).toHaveText("Create a report");
    await navigateMain(page, "settings");
    await expect(page.locator("#pageTitle")).toHaveText("Settings");
    await expect(page.locator("#wireAnalysisSearchNotice")).toBeHidden();
    await expect(input).toHaveValue("physician");
    await page.goBack();
    await expect(page.locator("#pageTitle")).toHaveText("Create a report");
    await page.goBack();
    await expect(page.locator("#activityCount")).toHaveText("2");
    await expect(page.locator("#activityListScope")).toContainText("Search applied");
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("bucket"), "day");
    await input.focus();
    await selectActivityOption(page, "wireSearchScope", "everywhere");
    await expect(page.locator("#activityCount")).toHaveText("6");
    for (const [query, title, setting, destination] of [
        ["Time zone", "Time zone", "time-zone", "#displayTimeZone-control"],
        ["History window", "History to include", "history-window", "#collectionWindow-control"],
    ]) {
        await input.fill(query);
        await selectActivityOption(page, "wireSearchType", "setting");
        const result = page.getByRole("button", { name: new RegExp(`^Open setting: ${title};`) });
        await expect(result).toHaveCount(1);
        const id = await result.getAttribute("data-search-id");
        await result.focus(); await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp(`setting=${setting}`));
        await expect(page.locator(destination)).toBeFocused();
        if (setting === "time-zone") {
            await selectActivityOption(page, "displayTimeZone", "UTC");
            await expect(page.locator("#displayTimeZone")).toHaveValue("UTC");
        } else {
            await expect(page.locator("#connectionPreferences #collectionWindow-control")).toBeVisible();
            await expect(page.locator("#connectionSource")).toBeVisible();
        }
        await page.goBack();
        await expect(result).toBeFocused();
        await expect(result).toHaveAttribute("data-search-id", id);
        await expect(input).toHaveValue(query);
        await expect(page.locator("#wireSearchType")).toHaveValue("setting");
        assert.equal(new URLSearchParams(page.url().split("?")[1]).get("bucket"), "day");
    }
    await input.press("Escape");
    await expect(page.locator("#filterChips")).toBeEmpty();
    await expect(page.locator("#resetView")).toBeDisabled();
    assert.equal((await runtime.collector.status()).config.enabled, false);
    const after = await loadBoardState(context);
    for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
});
