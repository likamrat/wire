import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords, saveSearchComparison, streamPanel } from "./live-search-fixture.mjs";
import { chooseTheme, selectActivityOption } from "./helpers.mjs";
import { contrast, pairwise } from "./color-measurements.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { loadBoardState } from "../lib/store.mjs";

test("every Search category has its own readable rendered color, Lucide identity and type label", { timeout: 60000 }, async t => {
    const cleanup = [], records = searchRecords(1);
    let browser;
    const errors = [], observations = [], proofs = process.env.WIRE_SEARCH_CATEGORY_PROOFS;
    t.after(async () => {
        await browser?.close(); for (const fn of cleanup) await fn();
        assert.deepEqual(errors, []);
    });
    records[0].userPrompt.text = "Arrange an atlas review with the release team.";
    const app = await searchFixture({ after: fn => cleanup.push(fn) }, {
        records, formats: ["html", "json"], reportTitles: ["Planning notes", "Retrieval evidence"],
    });
    await saveSearchComparison(app, ["html"]);
    const storedBefore = await loadBoardState(app.context);
    const reference = await streamPanel(app.runtime);
    let rankedHits;
    try {
        await reference.api("/api/search/query", { query: "atlas", requestId: 1 });
        const ranked = await reference.wait(event => event.event === "results" && event.requestId === 1);
        rankedHits = ranked.matches.hits;
    } finally { await reference.close(); }
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    if (proofs) await mkdir(proofs, { recursive: true });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        assert.equal(new URL(route.request().url()).origin, new URL(app.runtime.url).origin);
        return route.continue();
    });
    const icons = {
        interaction: "message-square", context: "messages-square", reply: "message-square-reply",
        action: "workflow", tool: "wrench", service: "calendar", report: "file-text",
        comparison: "columns-2", view: "panels-top-left", setting: "settings",
    };
    const screenshot = async name => {
        if (proofs) await page.screenshot({ path: path.join(proofs, name + ".png") });
    };
    const measure = node => {
        const css = part => getComputedStyle(node.querySelector(part)), rect = part => node.querySelector(part).getBoundingClientRect();
        let group = node.closest("li");
        while (group && !group.querySelector(".wire-search-group-label")) group = group.previousElementSibling;
        const label = group.querySelector(".wire-search-group-label");
        const kind = getComputedStyle(label), icon = css(".wire-search-type-icon .wire-icon"), title = css(".wire-search-title");
        const mark = css("mark"), box = node.getBoundingClientRect(), outline = getComputedStyle(node);
        return {
            type: node.dataset.searchType, color: icon.color, labelColor: kind.color, titleColor: title.color,
            paper: getComputedStyle(document.querySelector("#wireSearchPanel")).backgroundColor,
            icon: node.querySelector(".wire-search-type-icon .wire-icon").dataset.lucideIcon,
            iconSize: Number(node.querySelector(".wire-search-type-icon .wire-icon").dataset.iconSize),
            iconWidth: rect(".wire-search-type-icon .wire-icon").width,
            iconHeight: rect(".wire-search-type-icon .wire-icon").height,
            label: label.textContent,
            size: kind.fontSize, weight: kind.fontWeight, family: kind.fontFamily,
            mark: { color: mark.color, background: mark.backgroundColor },
            outline: { color: outline.outlineColor, style: outline.outlineStyle },
            width: box.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
            iconCenter: rect(".wire-search-type-icon").y + rect(".wire-search-type-icon").height / 2,
            titleCenter: rect(".wire-search-heading").y + parseFloat(title.lineHeight) / 2,
        };
    };
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    const input = page.locator("#wireSearch"), rows = page.locator(".wire-search-hit");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await input.fill("a");
        const colors = {};
        for (const [type, icon] of Object.entries(icons)) {
            await selectActivityOption(page, "wireSearchType", type);
            await expect(rows.first()).toBeVisible();
            for (const glyph of await rows.locator(".wire-search-type-icon .wire-icon").all()) await expect(glyph).toHaveAttribute("aria-hidden", "true");
            assert.ok((await rows.evaluateAll(nodes => nodes.map(node => node.dataset.searchType))).every(value => value === type));
            await input.focus(); await input.press("ArrowDown");
            await expect(rows.first()).toBeFocused();
            const current = await rows.first().evaluate(measure);
            assert.equal(current.icon, icon);
            assert.equal(current.iconSize, type === "service" ? 24 : 16);
            assert.equal(current.iconWidth, current.iconSize);
            assert.equal(current.iconHeight, current.iconSize);
            if (type === "service") {
                const shared = page.locator("#percentageCharts .wire-icon[data-lucide-icon=calendar]").first();
                await expect(shared).toHaveAttribute("data-icon-size", "24");
                assert.equal(await rows.first().locator(".wire-search-type-icon .wire-icon").innerHTML(), await shared.innerHTML());
            }
            if (type === "setting") {
                const shared = page.locator('nav [data-nav="settings"] .wire-icon');
                assert.equal(await rows.first().locator(".wire-search-type-icon .wire-icon").innerHTML(), await shared.innerHTML());
            }
            assert.ok(current.label.trim());
            assert.equal(current.labelColor, current.color);
            assert.notEqual(current.color, current.titleColor);
            assert.equal(current.size, "14px"); assert.equal(current.weight, "400");
            assert.match(current.family, /Asta Sans/);
            assert.ok(contrast(current.color, current.paper) >= 4.5, `${theme}/${type} label and glyph`);
            assert.ok(contrast(current.labelColor, current.paper) >= 4.5);
            assert.ok(contrast(current.mark.color, current.mark.background) >= 4.5);
            assert.equal(current.outline.style, "solid");
            assert.ok(contrast(current.outline.color, current.paper) >= 3);
            assert.ok(Math.abs(current.iconCenter - current.titleCenter) < 1);
            const footprint = await rows.first().evaluate(node => {
                const slot = node.querySelector(".wire-search-type-icon"), glyph = slot.querySelector(".wire-icon");
                const rect = target => {
                    const { x, y, width, height } = target.getBoundingClientRect();
                    return { x, y, width, height };
                };
                const geometry = () => ({ row: rect(node), heading: rect(node.querySelector(".wire-search-heading")),
                    body: rect(node.querySelector(".wire-search-body")) });
                const before = geometry(), icon = rect(glyph);
                const ownsHit = document.elementFromPoint(icon.x + icon.width / 2, icon.y + icon.height / 2)?.closest(".wire-search-hit") === node;
                glyph.style.display = "none";
                const withoutGlyph = geometry();
                glyph.style.removeProperty("display");
                return { before, withoutGlyph, icon, ownsHit, decoratedButton: slot.matches(".icon-only,.icon-action"),
                    nestedTargets: node.querySelectorAll("button,a,[tabindex]").length };
            });
            assert.deepEqual(footprint.withoutGlyph, footprint.before, "Decorative glyph dimensions cannot create extra row whitespace.");
            assert.equal(footprint.decoratedButton, false);
            assert.equal(footprint.nestedTargets, 0, "The result is one click zone, not a row plus an icon button.");
            assert.equal(footprint.ownsHit, true);
            assert.ok(footprint.icon.x >= footprint.before.row.x && footprint.icon.y >= footprint.before.row.y);
            assert.ok(footprint.icon.x + footprint.icon.width <= footprint.before.row.x + footprint.before.row.width);
            assert.ok(footprint.icon.y + footprint.icon.height <= footprint.before.row.y + footprint.before.row.height);
            colors[type] = current.color;
            observations.push({ theme, state: "focused", ...current });
            await rows.first().hover();
            assert.equal((await rows.first().evaluate(measure)).color, current.color);
            await screenshot(`${theme}-${type}`);
        }
        assert.equal(new Set(Object.values(colors)).size, 10);
        const separation = pairwise(colors);
        assert.ok(separation[0].distance >= 6, JSON.stringify(separation.slice(0, 3)));
        observations.push({ theme, separation });
        await selectActivityOption(page, "wireSearchType", "");
        await input.fill("atlas");
        await expect(rows).not.toHaveCount(0);
        await expect(page.locator("#wireSearchOptions")).toHaveCount(0);
        await expect(page.getByRole("group", { name: "Search filters", exact: true })).toBeVisible();
        const identities = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.searchId));
        assert.deepEqual([...identities].sort(), rankedHits.map(hit => hit.id).sort(), "Grouping retains the complete server population.");
        const shownTypes = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.searchType));
        assert.deepEqual([...new Set(shownTypes)], [...new Set(rankedHits.map(hit => hit.type))]);
        for (const type of new Set(shownTypes)) {
            assert.deepEqual(identities.filter((_, index) => shownTypes[index] === type),
                rankedHits.filter(hit => hit.type === type).map(hit => hit.id), "Each group keeps its server ranking.");
        }
        await expect(page.locator(".wire-search-body-typed-title")).toHaveCount(0);
        assert.ok((await rows.evaluateAll(nodes => nodes.map(node => node.querySelector(".wire-search-heading")?.children.length)))
            .every(count => count === 1), "Every result has one canonical-title heading, without category/format machinery.");
        await expect(rows.locator(".wire-search-format,.wire-search-kind")).toHaveCount(0);
        await expect(page.locator(".wire-search-group-label")).toHaveText(["Interactions", "Reports"]);
        await expect(rows.locator(".wire-search-source")).toHaveCount(0);
        for (const [width, scale] of [[1440, 1], [375, 1], [375, 2]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = scale * 100 + "%"; }, scale);
            const field = await input.boundingBox();
            await input.fill("atlas ");
            await expect(rows).toHaveCount(identities.length);
            assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.searchId)), identities);
            assert.deepEqual(await input.boundingBox(), field);
            for (const locator of await rows.all()) {
                const row = await locator.evaluate(measure);
                assert.ok(row.scrollWidth <= row.clientWidth + 1);
                assert.equal(row.size, `${14 * scale}px`);
                assert.ok(contrast(row.color, row.paper) >= 4.5);
            }
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await screenshot(`${theme}-mixed-${width}-${scale}`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        for (const hidden of [true, false]) await page.evaluate(hidden => {
            Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
        }, hidden);
        await expect(rows).toHaveCount(identities.length);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await screenshot(`${theme}-recovered`);
        await input.fill("unmatched invented phrase");
        await expect(page.locator("#wireSearchStatus")).toHaveText("No matches. Try different words.");
        await screenshot(`${theme}-no-match`);
        await input.fill("403");
        await selectActivityOption(page, "wireSearchType", "action");
        await expect(rows).toHaveCount(1);
        const outcome = await rows.evaluate(node => {
            return { category: getComputedStyle(node.querySelector(".wire-search-type-icon .wire-icon")).color,
                failure: getComputedStyle(node.querySelector(".wire-search-outcome")).color,
                danger: getComputedStyle(node).getPropertyValue("--danger").trim() };
        });
        assert.notEqual(outcome.category, outcome.failure);
        assert.ok(contrast(outcome.failure, theme === "light" ? "#ffffff" : "#191919") >= 4.5);
        await screenshot(`${theme}-failure-separate`);
    }
    await unlink(app.bundles[0].files["product-report.html"]);
    app.runtime.search.invalidate();
    await selectActivityOption(page, "wireSearchType", "");
    await input.fill("atlas");
    await expect(page.locator("#wireSearchCoverage")).toHaveText("A saved report file is missing.");
    const summary = await page.locator("#wireSearchMatchesTitle").evaluate(node => {
        const count = node.querySelector("#wireSearchCount").getBoundingClientRect();
        const coverage = node.querySelector("#wireSearchCoverage").getBoundingClientRect();
        return { sameLine: Math.abs(count.y - coverage.y) < 1, text: node.textContent };
    });
    assert.equal(summary.sameLine, true, "Count and partial coverage share one concise summary.");
    await expect(rows.locator(".wire-search-source")).not.toContainText(["Approved frozen report"]);
    const report = rows.filter({ has: page.locator('[data-lucide-icon="file-text"]') });
    await expect(report.locator(".wire-search-kind")).toHaveCount(0);
    await expect(report.locator(".wire-search-title")).toHaveText(app.bundles[1].title);
    await expect(report.locator(".wire-search-meta")).toHaveCount(0);
    await input.fill("unmatched invented phrase");
    await expect(page.locator("#wireSearchStatus")).toHaveText("Search is incomplete. A saved report file is missing.");
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/search/query", async route => {
        entered.resolve(); await release.promise;
        await route.fulfill({ status: 503, json: { code: "runtime_unavailable", error: "Search is unavailable. Try again." } });
    });
    await input.fill("Theme"); await entered.promise;
    await expect(page.locator("#wireSearchStatus")).toHaveText("Searching...");
    release.resolve();
    await expect(page.locator("#wireSearchStatus")).toHaveText("Search is unavailable. Try again.");
    await input.focus();
    await expect(page.locator("#wireSearchStatus")).toHaveText("Search is unavailable. Try again.");
    await page.unroute("**/api/search/query");
    await page.locator("#wireSearchRetry").click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Theme");
    const storedAfter = await loadBoardState(app.context);
    for (const key of ["evidence", "exports", "cards", "personalEvaluation"]) assert.deepEqual(storedAfter[key], storedBefore[key]);
    if (proofs) await writeFile(path.join(proofs, "rendered-category-measurements.json"), JSON.stringify(observations, null, 2));
});

test("the stationary capsule has an idle gradient halo, bounded interaction glide and a single accessible focus edge", { timeout: 45000 }, async t => {
    const cleanup = [], errors = [], measurements = [], proofs = process.env.WIRE_SEARCH_CATEGORY_PROOFS;
    let browser;
    t.after(async () => {
        await browser?.close(); for (const fn of cleanup) await fn(); assert.deepEqual(errors, []);
    });
    const app = await searchFixture({ after: fn => cleanup.push(fn) });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        assert.equal(new URL(route.request().url()).origin, new URL(app.runtime.url).origin);
        return route.continue();
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    const input = page.locator("#wireSearch"), panel = page.locator("#wireSearchPanel");
    const paint = node => {
        const css = getComputedStyle(node), placeholder = getComputedStyle(node, "::placeholder");
        const box = node.getBoundingClientRect();
        return {
            image: css.backgroundImage, shadow: css.boxShadow, position: css.backgroundPosition,
            color: css.color, placeholder: placeholder.color, paper: css.getPropertyValue("--paper").trim(), background: css.backgroundColor,
            outline: css.outlineStyle, outlineColor: css.outlineColor, outlineWidth: css.outlineWidth, outlineOffset: css.outlineOffset,
            border: css.borderColor, motion: css.transitionDuration, animation: css.animationName,
            x: box.x, y: box.y, right: box.right, width: box.width, height: box.height,
        };
    };
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await input.fill(""); await page.locator("#pageTitle").focus(); await page.mouse.move(0, 0);
        await expect.poll(async () => (await input.evaluate(paint)).position).toBe("0px 0px, 0px 50%");
        const idle = await input.evaluate(paint);
        assert.match(idle.image, /linear-gradient/); assert.notEqual(idle.shadow, "none");
        assert.equal(idle.border, "rgba(0, 0, 0, 0)", "No neutral border underneath the colored edge");
        assert.equal(idle.animation, "none", "No perpetual animated ring");
        assert.ok(contrast(idle.color, idle.paper) >= 4.5);
        assert.ok(contrast(idle.placeholder, idle.paper) >= 4.5);
        assert.ok(idle.x >= 12 && idle.right <= width - 12, "The soft halo has room inside the header");
        if (proofs) await page.screenshot({ path: path.join(proofs, `capsule-${theme}-${width}-${scale}-idle.png`) });
        await input.hover();
        await expect.poll(async () => (await input.evaluate(paint)).position).toBe("0px 0px, 65% 50%");
        const hovered = await input.evaluate(paint);
        assert.notEqual(hovered.shadow, idle.shadow);
        assert.deepEqual([hovered.x, hovered.y, hovered.width, hovered.height], [idle.x, idle.y, idle.width, idle.height]);
        if (proofs) await page.screenshot({ path: path.join(proofs, `capsule-${theme}-${width}-${scale}-hover.png`) });
        await input.focus();
        await expect.poll(async () => (await input.evaluate(paint)).position).toBe("0px 0px, 100% 50%");
        const focused = await input.evaluate(paint);
        assert.equal(focused.outline, "solid"); assert.equal(focused.outlineWidth, "2px"); assert.equal(focused.outlineOffset, "-2px");
        assert.ok(contrast(focused.outlineColor, focused.paper) >= 3);
        assert.deepEqual([focused.x, focused.y, focused.width, focused.height], [idle.x, idle.y, idle.width, idle.height]);
        if (proofs) await page.screenshot({ path: path.join(proofs, `capsule-${theme}-${width}-${scale}-focus.png`) });
        await input.fill("Theme");
        await expect(page.locator(".wire-search-hit")).toHaveCount(1);
        const opened = await input.evaluate(paint), bounds = await panel.boundingBox();
        assert.deepEqual([opened.x, opened.y, opened.width, opened.height], [idle.x, idle.y, idle.width, idle.height]);
        assert.ok(Math.abs(bounds.x - opened.x) < 1 && Math.abs(bounds.width - opened.width) < 1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proofs) await page.screenshot({ path: path.join(proofs, `capsule-${theme}-${width}-${scale}-results.png`) });
        measurements.push({ theme, width, scale, idle, hovered, focused, opened });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal((await input.evaluate(paint)).motion, "0s");
    await page.emulateMedia({ forcedColors: "active" });
    const forced = await input.evaluate(paint);
    assert.equal(forced.shadow, "none");
    assert.equal(forced.image, "none");
    assert.ok(contrast(forced.outlineColor, forced.background) >= 3);
    if (proofs) await writeFile(path.join(proofs, "capsule-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("file formats are supporting disambiguators only for otherwise identical report titles", { timeout: 20000 }, async t => {
    const cleanup = [];
    let browser;
    t.after(async () => { await browser?.close(); for (const close of cleanup) await close(); });
    const app = await searchFixture({ after: close => cleanup.push(close) }, { formats: ["json", "markdown"] });
    assert.ok(app.bundles[0].title);
    assert.equal(app.bundles[0].title, app.bundles[1].title, "The real producer supplies the same factual title across formats");
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#wireSearch").fill("physician");
    await selectActivityOption(page, "wireSearchType", "report");
    const rows = page.locator(".wire-search-hit");
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".wire-search-group-label")).toHaveText(["Reports"]);
    await expect(rows.locator(".wire-search-heading")).toHaveText(app.bundles.map(bundle => bundle.title));
    assert.deepEqual((await rows.locator(".wire-search-format").allTextContents()).sort(), ["JSON", "Markdown"]);
    await expect(rows.locator(".wire-search-heading .wire-search-format")).toHaveCount(0);
    assert.equal(new Set(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.searchId))).size, 2);
});

test("Search Calendar, People and Files reuse the same service glyphs as the recorded-data widgets", { timeout: 20000 }, async t => {
    const cleanup = [], records = searchRecords(3), errors = [];
    const proofs = process.env.WIRE_SEARCH_CATEGORY_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    let browser;
    t.after(async () => {
        await browser?.close(); for (const close of cleanup) await close();
        assert.deepEqual(errors, []);
    });
    for (const [index, target] of ["/me/calendarView", "/me/people", "/me/drive/root/children"].entries()) {
        records[index].toolCalls[0].requestedApiPath = target;
        records[index].toolCalls[0].requestArgs = { entityUrls: [target] };
    }
    const app = await searchFixture({ after: close => cleanup.push(close) }, { records });
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    for (const [theme, width, scale] of [["light", 1440, 1], ["dark", 1440, 1], ["light", 375, 2], ["dark", 375, 2]]) for (const service of ["Calendar", "People", "Files"]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.locator("#wireSearch").fill(service);
        await selectActivityOption(page, "wireSearchType", "service");
        const row = page.locator(".wire-search-hit");
        await expect(row).toHaveCount(1);
        const asset = /data-lucide-icon="([^"]+)"/.exec(dimensionalIcons[service])[1];
        const glyph = row.locator(".wire-search-type-icon .wire-icon");
        const shared = page.locator(`#percentageCharts .wire-icon[data-lucide-icon="${asset}"]`).first();
        await expect(glyph).toHaveAttribute("data-lucide-icon", asset);
        await expect(glyph).toHaveAttribute("data-icon-size", "24");
        assert.equal(await glyph.innerHTML(), await shared.innerHTML());
        await expect(glyph).toHaveAttribute("aria-hidden", "true");
        await expect(glyph).toHaveAttribute("focusable", "false");
        await expect(row.locator(".wire-search-title")).toHaveText(service);
        await expect(row.locator(".service-cue")).toHaveCount(0);
        await expect(row.locator(".wire-search-type-icon button,.wire-search-type-icon a,.wire-search-type-icon [tabindex]")).toHaveCount(0);
        const dimensions = await glyph.evaluate(node => {
            const control = node.closest("button"), icon = node.getBoundingClientRect(), row = control.getBoundingClientRect();
            const text = control.querySelector(".wire-search-heading").getBoundingClientRect();
            const slot = node.parentElement.getBoundingClientRect(), gap = parseFloat(getComputedStyle(control).columnGap);
            node.style.display = "none";
            const without = control.getBoundingClientRect(), withoutText = control.querySelector(".wire-search-heading").getBoundingClientRect();
            node.style.removeProperty("display");
            return { iconWidth: icon.width, iconHeight: icon.height, fits: icon.x >= row.x && icon.right <= row.right
                && icon.y >= row.y && icon.bottom <= row.bottom,
                aligned: Math.abs(text.x - slot.right - gap) < 1,
                stable: row.height === without.height && row.width === without.width && text.x === withoutText.x && text.y === withoutText.y };
        });
        assert.deepEqual(dimensions, { iconWidth: 24, iconHeight: 24, fits: true, aligned: true, stable: true });
        await page.locator("#wireSearch").focus();
        await page.mouse.move(0, 0);
        if (proofs) await page.screenshot({ path: path.join(proofs, `shared-service-${theme}-${width}-${service.toLowerCase()}.png`) });
        if (theme === "light" && width === 1440) {
            const box = await glyph.boundingBox();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await expect(page).toHaveURL(new RegExp("services=" + service + "(?:&|$)"));
            await page.goBack();
            await expect(row).toBeFocused();
            await expect(row.locator(".wire-search-title")).toHaveText(service);
        }
    }
});
