import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { chooseTheme, openSearchFilters, selectActivityOption } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { uxIconSources } from "../web/ux-icons.mjs";

test("Search removes caption recitals without merging the interaction and its real action", { timeout: 30000 }, async t => {
    const records = searchRecords(1), cleanup = [], errors = [], nonlocal = [], opens = [];
    records[0].userPrompt.text = "Who can review the dashboard layout for NOVA?";
    records[0].sourceSessionName = "Who can review the dashboard layout for NOVA";
    records[0].followUpPrompts = []; records[0].httpRecords = [];
    records[0].toolCalls[0] = { ...records[0].toolCalls[0], tool: "workiq-ask", requestArgs: {}, requestedApiPath: null, apiResults: [] };
    const app = await searchFixture({ after: fn => cleanup.push(fn) }, { records });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().endsWith("/api/search/open")) opens.push(request.postDataJSON().id); });
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(app.runtime.url).origin) {
            nonlocal.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        await browser.close();
        for (const fn of cleanup) await fn();
        assert.deepEqual(errors, []); assert.deepEqual(nonlocal, []);
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => [...document.fonts].some(face => face.family.includes("Asta Sans") && face.status === "loaded")),
        "A declared family alone must not conceal a fallback font");
    const input = page.locator("#wireSearch"), rows = page.locator(".wire-search-hit");
    const interaction = rows.filter({ has: page.locator(".wire-search-title", { hasText: records[0].userPrompt.text }) });
    const action = rows.filter({ has: page.locator(".wire-search-title", { hasText: /^workiq-ask$/ }) });
    let identities;
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await input.fill("NOVA"); await expect(rows).toHaveCount(2);
        const current = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.searchId));
        if (identities) assert.deepEqual(current, identities); else identities = current;
        await expect(interaction.locator(".wire-search-source")).toHaveCount(0);
        await expect(interaction.locator(".wire-search-title mark")).toHaveText("NOVA");
        await expect(action.locator(".wire-search-source")).toHaveText(records[0].sourceSessionName);
        await expect(action.locator(".wire-search-source mark")).toHaveText("NOVA");
        await expect(action.locator(".wire-search-kind")).toHaveText("Work IQ tool call");
        await expect(action.locator(".wire-search-outcome")).toHaveText("Worked");
        await openSearchFilters(page);
        await expect(page.locator("#wireSearchOptions,#wireSearchFilterSummary")).toHaveCount(0);
        const filterLayout = await page.evaluate(() => {
            const filters = document.querySelector(".wire-search-filters").getBoundingClientRect();
            const matches = document.querySelector("#wireSearchMatches").getBoundingClientRect();
            const panel = document.querySelector("#wireSearchPanel").getBoundingClientRect();
            return { beforeResults: filters.bottom <= matches.top, inside: filters.x >= panel.x && filters.right <= panel.right };
        });
        assert.deepEqual(filterLayout, { beforeResults: true, inside: true });
        for (const id of ["wireSearchScope", "wireSearchType"]) {
            await expect(page.locator("#" + id)).toHaveAttribute("data-select-presentation", "filter");
            const trigger = page.locator(`[data-select-id=${id}]`);
            await expect(trigger).toHaveClass(/select-trigger-filter/);
            const shared = await trigger.evaluate(node => {
                const reference = document.querySelector("#toolFilter-control");
                const shape = control => {
                    const css = getComputedStyle(control);
                    return [css.borderRadius, css.padding, css.minHeight, css.fontFamily, css.fontSize, css.fontWeight];
                };
                return { actual: shape(node), expected: shape(reference) };
            });
            assert.deepEqual(shared.actual, shared.expected, "Search uses the same filter bubble as the main activity filters.");
            await trigger.click();
            const popup = page.locator(".select-popup-filter:visible");
            await expect(popup).toBeVisible();
            await expect(popup.locator(".select-toggle,.select-footer,.select-draft-hint,.select-validation")).toHaveCount(0);
            assert.equal(await popup.getByRole("listbox").getAttribute("aria-multiselectable"), null);
            const skin = await trigger.evaluate(node => {
                const menu = document.querySelector(".select-popup-filter"), selected = menu.querySelector('[aria-selected="true"]');
                return { trigger: getComputedStyle(node, "::before").backgroundColor,
                    menu: getComputedStyle(menu).backgroundColor, selected: getComputedStyle(selected).backgroundColor,
                    paper: getComputedStyle(document.querySelector("#wireSearchPanel")).backgroundColor,
                    clipped: node.querySelector(".select-value").scrollWidth > node.querySelector(".select-value").clientWidth };
            });
            assert.equal(skin.trigger, skin.paper); assert.equal(skin.menu, skin.paper);
            assert.equal(skin.selected, "rgba(0, 0, 0, 0)");
            assert.equal(skin.clipped, false, "Full values need no routine tooltip");
            await expect(popup.locator('[aria-selected="true"] .select-check')).toBeVisible();
            await trigger.press("Escape");
            await expect(trigger).toBeFocused(); await expect(popup).toHaveCount(0);
        }
        const typography = await page.locator("#wireSearch,.wire-search-title,.wire-search-kind,.wire-search-source,.wire-search-outcome,.wire-search-filters .select-trigger").evaluateAll(nodes =>
            nodes.filter(node => node.checkVisibility()).map(node => {
                const css = getComputedStyle(node);
                return { role: node.id || node.className, family: css.fontFamily, size: css.fontSize, weight: css.fontWeight };
            }));
        for (const part of typography) {
            assert.match(part.family, /^"Asta Sans"/);
            assert.equal(part.size, `${14 * scale}px`, part.role);
            assert.equal(part.weight, "400", part.role);
        }
        await input.focus(); await input.press("ArrowDown"); await expect(interaction).toBeFocused();
        const before = await interaction.boundingBox();
        await action.hover();
        const paint = await action.evaluate(node => {
            const css = getComputedStyle(node), before = getComputedStyle(node, "::before");
            const title = getComputedStyle(node.querySelector(".wire-search-title"));
            const outcome = getComputedStyle(node.querySelector(".wire-search-outcome"));
            return { fill: css.backgroundColor, before: before.backgroundColor, decoration: title.textDecorationLine,
                outcome: outcome.color, paper: getComputedStyle(document.querySelector("#wireSearchPanel")).backgroundColor };
        });
        assert.equal(paint.fill, "rgba(0, 0, 0, 0)");
        assert.equal(paint.before, "rgba(0, 0, 0, 0)", "No gray full-row hover slab");
        assert.equal(paint.decoration, "none", "Search titles use restrained color feedback, not underlines");
        assert.ok(contrast(paint.outcome, paint.paper) >= 4.5);
        assert.deepEqual(await interaction.boundingBox(), before, "A neighboring hover cannot move the reading layout");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await input.press("Escape");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await input.focus(); await input.press("ArrowDown"); await interaction.press("Enter");
    await expect(page).toHaveURL(/#request\?request=search-0(?:&|$)/);
    await page.goBack(); await expect(interaction).toBeFocused();
    await expect(rows).toHaveCount(2);
    await action.tap();
    await expect(page.locator("#selectedCall")).toBeVisible();
    const target = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
    assert.equal(target.get("request"), records[0].scenarioId);
    assert.equal(target.get("layer"), "tool");
    const call = `call:${JSON.stringify([records[0].sourceSessionId, records[0].toolCalls[0].toolCallId])}`;
    assert.equal(target.get("call"), call);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-action-id", call);
    await page.goBack(); await expect(action).toBeFocused();
    assert.deepEqual(opens, identities);
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.searchId)), identities);
});

test("Search action labels and glyphs use the real recorded-result layer contract", { timeout: 20000 }, async t => {
    const records = searchRecords(3), cleanup = [], results = createRecordedResults(), errors = [];
    records[0].toolCalls[0].toolSucceeded = false; records[0].toolCalls[0].reportedOutcome = "failed";
    records[1].toolCalls[0].toolSucceeded = null; records[1].toolCalls[0].reportedOutcome = "partial";
    records[2].toolCalls[0].toolSucceeded = null; records[2].toolCalls[0].reportedOutcome = "unknown";
    const app = await searchFixture({ after: fn => cleanup.push(fn) }, { records, reply: false });
    const browser = await chromium.launch(), page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        assert.equal(new URL(route.request().url()).origin, new URL(app.runtime.url).origin);
        return route.continue();
    });
    t.after(async () => {
        await browser.close(); for (const fn of cleanup) await fn(); assert.deepEqual(errors, []);
    });
    await page.goto(app.runtime.url + "#analyze?mode=calls");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    for (const [query, layer, key] of [["403", "http", "failure"], ["partial", "tool", "partial"], ["unknown", "tool", "unknown"]]) {
        await page.locator("#wireSearch").fill(query);
        await selectActivityOption(page, "wireSearchType", "action");
        const row = page.locator(".wire-search-hit"), expected = results.entries(layer, results.summarize([{ id: "fixture", outcome: key }]))[0];
        await expect(row).toHaveCount(1);
        await expect(row.locator(".wire-search-kind")).toHaveText(results.unit(layer, 1));
        await expect(row.locator(".wire-search-outcome")).toHaveText(expected.label);
        await expect(row.locator(".wire-search-outcome .wire-icon")).toHaveAttribute("data-lucide-icon", uxIconSources[expected.icon]);
        await expect(row.locator(".wire-search-outcome .wire-icon")).toHaveAttribute("data-icon-size", "16");
        const shared = page.locator(`#activityList .recorded-result.${key} .wire-icon`).first();
        await expect(shared).toHaveAttribute("data-icon-size", "16");
        assert.equal(await row.locator(".wire-search-outcome .wire-icon").innerHTML(), await shared.innerHTML());
        await expect(row).toHaveAccessibleName(new RegExp(results.unit(layer, 1)));
        await expect(row.locator("mark")).not.toHaveCount(0);
    }
    await page.locator("#wireSearch").fill("success");
    const rows = page.locator(".wire-search-hit");
    await expect(rows).not.toHaveCount(0);
    const shown = await rows.evaluateAll(nodes => nodes.map(node => ({
        unit: node.querySelector(".wire-search-kind").textContent,
        outcome: node.querySelector(".wire-search-outcome").textContent.trim(),
    })));
    const layerForUnit = new Map(results.layers.map(layer => [results.unit(layer, 1), layer]));
    assert.ok(shown.some(row => row.unit === results.unit("reported-api", 1)));
    assert.ok(shown.some(row => row.unit === results.unit("http", 1)));
    for (const row of shown) assert.equal(row.outcome, results.labels(layerForUnit.get(row.unit)).success);
});

test("Search retires current review navigation without suppressing authorized frozen text", { timeout: 30000 }, async t => {
    const records = searchRecords(1), cleanup = [], errors = [], requests = [];
    records[0].userPrompt.text = "Historical note: AI reviews and Personal feedback were discussed during the invented release.";
    records[0].toolCalls[0].toolSucceeded = false;
    records[0].toolCalls[0].reportedOutcome = "failed";
    const app = await searchFixture({ after: fn => cleanup.push(fn) }, { records, formats: ["html"], reply: false });
    const file = app.bundles[0].files["product-report.html"], bytes = await readFile(file);
    const browser = await chromium.launch(), page = await browser.newPage({ reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push(new URL(request.url()).pathname));
    await page.route("**/*", route => {
        assert.equal(new URL(route.request().url()).origin, new URL(app.runtime.url).origin);
        return route.continue();
    });
    t.after(async () => {
        await browser.close(); for (const fn of cleanup) await fn(); assert.deepEqual(errors, []);
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const input = page.locator("#wireSearch"), rows = page.locator(".wire-search-hit");
    for (const phrase of ["AI reviews", "Personal feedback"]) {
        for (const type of ["view", "setting"]) {
            await input.fill(phrase); await selectActivityOption(page, "wireSearchType", type);
            await expect(page.locator("#wireSearchStatus")).toHaveText("No matches. Try different words.");
            await expect(rows).toHaveCount(0);
        }
        await selectActivityOption(page, "wireSearchType", "report");
        await expect(rows).toHaveCount(1);
        await expect(rows.locator(".wire-search-format")).toHaveCount(0);
        await expect(rows).toHaveAttribute("aria-label", /HTML/);
        await expect(rows.locator("mark")).toHaveText(phrase);
        await rows.click();
        await expect(page.frameLocator("#savedReportReader iframe").locator("body")).toContainText(records[0].userPrompt.text);
        assert.equal(requests.some(route => ["/api/report/open", "/api/artifact-file"].includes(route)), false);
        await page.getByRole("button", { name: "Back to search", exact: true }).click();
        await expect(rows).toBeFocused(); await expect(input).toHaveValue(phrase);
        await expect(page.locator("#wireSearchType")).toHaveValue("report");
        assert.deepEqual(await readFile(file), bytes);
    }
    await input.press("Escape");
    await selectActivityOption(page, "layerFilter", "http");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#layerFilter")).toHaveValue("http");
    await input.fill("Failed calls"); await selectActivityOption(page, "wireSearchType", "view");
    await expect(rows).toHaveCount(1);
    await expect(rows.locator(".wire-search-title")).toHaveText("Failed calls");
    await rows.click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#activityList .matched-action")).toHaveCount(1);
    const destination = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
    assert.equal(destination.get("mode"), "calls"); assert.equal(destination.get("result"), "failure");
    await expect(page.locator("#layerFilter")).toHaveValue("tool");
    const call = `call:${JSON.stringify([records[0].sourceSessionId, records[0].toolCalls[0].toolCallId])}`;
    await expect(page.locator("#activityList .matched-action")).toHaveAttribute("data-action-id", call);
    await expect(page.locator("#activityView")).toBeFocused();
    await expect(page.locator("#homeFindings")).toHaveCount(0);
    await page.goBack(); await expect(rows).toBeFocused();
    await expect(input).toHaveValue("Failed calls");
});
