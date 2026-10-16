import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { chooseTheme, selectActivityOption } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

test("Search separates original title, type, source and evidence without clipping or inventing metadata", { timeout: 60000 }, async t => {
    const records = searchRecords(5), cleanups = [];
    records[0].userPrompt.text = records[1].userPrompt.text = "Prepare the PowerPoint release plan.";
    records[0].sourceSessionName = "Invented design review";
    records[1].sourceSessionName = "Invented delivery review";
    records[2].userPrompt.text = "Review the release decisions and recorded constraints.";
    records[2].sourceSessionName = "Invented PowerPoint workshop";
    records[3].userPrompt.text = "Retained opening notes about the planned release. ".repeat(8)
        + "\nDo not publish the PowerPoint until the review is complete.\n"
        + "Retained closing notes about the planned release. ".repeat(8);
    records[4].userPrompt.text = "\u0645\u0631\u0627\u062c\u0639\u0629 PowerPoint \u65e5\u672c\u8a9e e\u0301 "
        + "UnbrokenRetainedToken".repeat(12);
    const app = await searchFixture({ after: fn => cleanups.push(fn) }, { records, formats: ["html"], reply: false });
    const browser = await chromium.launch(), errors = [], nonlocal = [], measurements = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(app.runtime.url).origin) {
            nonlocal.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        await browser.close();
        for (const fn of cleanups) await fn();
        assert.deepEqual(errors, []); assert.deepEqual(nonlocal, []);
    });
    const proofs = process.env.WIRE_SEARCH_DESIGN_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    const input = page.locator("#wireSearch"), rows = page.locator(".wire-search-hit");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [768, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await input.fill("");
        const capsule = await input.boundingBox();
        await input.fill("POWER");
        await expect(rows).not.toHaveCount(0);
        assert.deepEqual(await input.boundingBox(), capsule);
        const row = rows.first();
        await expect(row.locator(".wire-search-title")).toContainText("PowerPoint");
        await expect(row.locator(".wire-search-kind")).toHaveText("Interaction");
        await expect(row.locator(".wire-search-type-icon .wire-icon")).toHaveCount(1);
        await expect(row.locator(".wire-search-title mark")).toHaveText("Power");
        assert.equal(await row.locator("button,a,input,select,[tabindex]").count(), 0, "One result is one native action");
        assert.ok(await rows.locator(".wire-search-source,.wire-search-excerpt,.wire-search-limitation")
            .evaluateAll(nodes => nodes.every(node => node.textContent.trim().length > 0)), "No blank optional metadata slots");
        await input.press("ArrowDown");
        await expect(row).toBeFocused();
        const geometry = await rows.evaluateAll(nodes => nodes.map(node => {
            const rect = element => {
                const { x, y, width, height, bottom, right } = element.getBoundingClientRect();
                return { x, y, width, height, bottom, right };
            };
            const style = selector => {
                const element = node.querySelector(selector);
                if (!element) return null;
                const css = getComputedStyle(element);
                return { ...rect(element), color: css.color, background: css.backgroundColor,
                    fontSize: parseFloat(css.fontSize), weight: css.fontWeight, lineHeight: parseFloat(css.lineHeight),
                    clamp: css.webkitLineClamp, overflow: css.overflow, text: element.textContent };
            };
            const parent = node.closest("li"), css = getComputedStyle(node);
            return { row: rect(node), title: style(".wire-search-title"), meta: style(".wire-search-meta"),
                source: style(".wire-search-source"), excerpt: style(".wire-search-excerpt"),
                icon: style(".wire-search-type-icon .wire-icon"), kind: style(".wire-search-kind"), mark: style("mark"),
                border: getComputedStyle(parent).borderTopWidth, margin: getComputedStyle(parent).marginTop,
                background: getComputedStyle(document.querySelector("#wireSearchPanel")).backgroundColor,
                outline: css.outlineStyle, outlineColor: css.outlineColor, outlineWidth: css.outlineWidth,
                scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
        }));
        for (const [index, item] of geometry.entries()) {
            assert.ok(item.row.height >= 44 && item.row.width >= 44);
            assert.ok(item.meta.bottom <= item.title.y - 3, "Type is a separate compact lead-in, not title prose");
            assert.ok(Math.abs(item.title.x - item.meta.x) < 1, "Shared text edge");
            assert.ok(item.icon.height <= item.kind.lineHeight, "No SVG baseline slack");
            assert.ok(Math.abs(item.icon.y + item.icon.height / 2 - item.kind.y - item.kind.height / 2) < 1);
            assert.ok(item.title.fontSize > item.kind.fontSize);
            assert.equal(item.title.weight, "400", "Original prompt titles stay regular");
            assert.ok(item.scrollWidth <= item.clientWidth + 1);
            if (index) {
                assert.ok(parseFloat(item.border) >= 1 && parseFloat(item.margin) >= 4, "Visible separation between distinct results");
            }
            if (item.source) {
                assert.ok(item.source.y >= item.title.bottom + 3, "Source has its own line");
                assert.ok(Math.abs(item.source.x - item.title.x) < 1);
            }
            if (item.excerpt) {
                assert.ok(item.excerpt.y >= (item.source || item.title).bottom + 7, "Match evidence is grouped below its context");
                assert.equal(item.excerpt.clamp, "none");
                assert.notEqual(item.excerpt.overflow, "hidden");
            }
            for (const part of [item.title, item.kind, item.source, item.excerpt].filter(Boolean)) {
                assert.ok(contrast(part.color, item.background) >= 4.5, `${theme}: readable ${part.text}`);
            }
            assert.ok(contrast(item.icon.color, item.background) >= 3);
            assert.ok(contrast(item.mark.color, item.mark.background) >= 4.5);
            assert.ok(item.mark.height > 0);
        }
        assert.equal(geometry[0].outline, "solid");
        assert.ok(parseFloat(geometry[0].outlineWidth) >= 2);
        assert.ok(contrast(geometry[0].outlineColor, geometry[0].background) >= 3);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proofs) await page.screenshot({ path: path.join(proofs, `hierarchy-${theme}-${width}-${scale}.png`) });
        measurements.push({ theme, width, scale, geometry });
        await input.press("Escape");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await input.fill("POWER");
    await selectActivityOption(page, "wireSearchType", "interaction");
    await expect(rows).toHaveCount(5);
    const repeated = rows.filter({ has: page.locator(".wire-search-title", { hasText: /^Prepare the PowerPoint release plan\.$/ }) });
    await expect(repeated).toHaveCount(2);
    assert.equal(new Set(await repeated.evaluateAll(nodes => nodes.map(node => node.dataset.searchId))).size, 2);
    assert.deepEqual((await repeated.locator(".wire-search-source").allTextContents()).sort(),
        ["Invented delivery review", "Invented design review"]);
    const body = rows.filter({ has: page.locator(".wire-search-excerpt mark") });
    await expect(body).toHaveCount(1);
    await expect(body.locator(".wire-search-excerpt")).toContainText("Do not publish the PowerPoint until the review is complete.");
    await expect(rows.filter({ has: page.locator(".wire-search-source mark") })).toHaveCount(1);
    assert.equal(await rows.locator(".wire-search-title").filter({ hasText: "\u0645\u0631\u0627\u062c\u0639\u0629" })
        .evaluate(node => getComputedStyle(node).direction), "rtl");
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const longMatch = "UnbrokenRetainedToken".repeat(10);
    await input.fill(longMatch);
    await expect(rows).toHaveCount(1);
    await expect(rows.locator(".wire-search-excerpt mark")).toHaveText(longMatch);
    const longEvidence = await rows.locator(".wire-search-excerpt").evaluate(node => {
        const css = getComputedStyle(node);
        return { width: node.clientWidth, scroll: node.scrollWidth, clamp: css.webkitLineClamp, overflow: css.overflow };
    });
    assert.ok(longEvidence.scroll <= longEvidence.width + 1);
    assert.equal(longEvidence.clamp, "none"); assert.notEqual(longEvidence.overflow, "hidden");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await input.fill("POWER");
    await expect(rows).toHaveCount(5);
    await page.emulateMedia({ forcedColors: "active" });
    await input.press("ArrowDown");
    const forced = await rows.first().evaluate(node => {
        const mark = getComputedStyle(node.querySelector("mark")), css = getComputedStyle(node);
        return { color: mark.color, background: mark.backgroundColor, decoration: mark.textDecorationLine,
            outline: css.outlineStyle, outlineColor: css.outlineColor,
            paper: getComputedStyle(document.querySelector("#wireSearchPanel")).backgroundColor };
    });
    assert.ok(contrast(forced.color, forced.background) >= 4.5);
    assert.ok(forced.decoration.includes("underline"));
    assert.equal(forced.outline, "solid"); assert.ok(contrast(forced.outlineColor, forced.paper) >= 3);
    if (proofs) await page.screenshot({ path: path.join(proofs, "hierarchy-forced-colors.png") });
    if (proofs) await writeFile(path.join(proofs, "hierarchy-measurements.json"), JSON.stringify(measurements, null, 2));
});

for (const channel of [undefined, ...(process.platform === "win32" ? ["msedge"] : [])]) test(`Search query clear owns one capsule action with independent 44px targets (${channel || "chromium"})`, { timeout: 60000 }, async t => {
    const records = searchRecords(22), cleanup = [];
    for (const [index, record] of records.entries()) {
        record.userPrompt.text = `PowerPoint review ${index}: retain the original long title and the documented conditions before publishing the release plan.`;
        record.sourceSessionName = "Invented original release review";
    }
    records[21].userPrompt.text = "Retained contextual notes. ".repeat(12)
        + "Do not publish the PowerPoint until its review is complete.";
    const app = await searchFixture({ after: fn => cleanup.push(fn) }, { records, reply: false });
    const browser = await chromium.launch({ channel }), errors = [], nonlocal = [], queries = [], measurements = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.url().endsWith("/api/search/query")) queries.push(request.postDataJSON());
    });
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
    const input = page.locator("#wireSearch"), rows = page.locator(".wire-search-hit"), clear = page.locator("#wireSearchClear");
    await expect(clear).toHaveCount(1);
    await expect(page.locator("#wireSearchHome>#wireSearchClear")).toHaveCount(1);
    await expect(page.locator("#wireSearchOptions #wireSearchClear")).toHaveCount(0);
    await expect(input).toHaveAttribute("type", "search");
    await expect(clear).toHaveAttribute("type", "button");
    await page.evaluate(() => {
        window.originalQueryField = document.querySelector("#wireSearch");
        window.queryClearClicks = 0;
        document.querySelector("#wireSearchClear").addEventListener("click", () => window.queryClearClicks++);
    });
    const proofs = process.env.WIRE_SEARCH_ICON_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    const cdp = await page.context().newCDPSession(page);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await expect(clear).toBeHidden();
        const emptyField = await input.boundingBox();
        const longQuery = "Original editable PowerPoint query ".repeat(30);
        await input.fill(longQuery); await input.press("End");
        assert.ok(await input.evaluate(node => node.scrollLeft > 0));
        await input.press("ControlOrMeta+A");
        assert.equal(await input.evaluate(node => node.selectionEnd - node.selectionStart), longQuery.length);
        assert.deepEqual(await input.boundingBox(), emptyField);
        await input.fill("POWER");
        await selectActivityOption(page, "wireSearchType", "interaction");
        await expect(rows).toHaveCount(20);
        await input.focus(); await input.press("ArrowDown"); await input.focus();
        if (proofs) await page.screenshot({ path: path.join(proofs, `capsule-${channel || "chromium"}-${theme}-${width}-${scale}-results.png`) });
        const actions = page.locator("#wireSearchClear,#wireSearchPaging .icon-only");
        const measured = await actions.evaluateAll(nodes => nodes.map(node => {
            const rect = target => {
                const { x, y, width, height, right, bottom } = target.getBoundingClientRect();
                return { x, y, width, height, right, bottom };
            };
            const glyph = node.querySelector("svg"), parent = node.parentElement;
            const before = { target: rect(node), parent: rect(parent) };
            glyph.style.display = "none";
            const noGlyph = { target: rect(node), parent: rect(parent) };
            glyph.style.removeProperty("display");
            const disabledHelp = node.closest(".ux-disabled-help");
            return { name: node.getAttribute("aria-label"), before, noGlyph, glyph: rect(glyph),
                disabledHelp: disabledHelp ? rect(disabledHelp) : null,
                neighbors: [...parent.children].filter(sibling => sibling !== node
                    && sibling.id !== "wireSearch" && sibling.checkVisibility()).map(rect) };
        }));
        assert.equal(measured.length, 3);
        for (const item of measured) {
            assert.equal(item.before.target.width, 44, `${item.name}: usable fixed-width target`);
            assert.equal(item.before.target.height, 44, `${item.name}: icon action must not inherit adjacent text height`);
            assert.equal(item.glyph.width, 20); assert.equal(item.glyph.height, 20);
            if (item.disabledHelp) assert.ok(item.disabledHelp.height <= 44, "No phantom tall disabled-help row");
            assert.deepEqual(item.noGlyph, item.before, "Glyph participation does not control unrelated layout");
            for (const neighbor of item.neighbors) {
                const box = item.before.target;
                assert.ok(Math.min(neighbor.right, box.right) - Math.max(neighbor.x, box.x) <= 0
                    || Math.min(neighbor.bottom, box.bottom) - Math.max(neighbor.y, box.y) <= 0, "No overlapping sibling targets");
            }
        }
        const capsule = await clear.evaluate(node => {
            const input = document.querySelector("#wireSearch"), field = input.getBoundingClientRect();
            const button = node.getBoundingClientRect(), css = getComputedStyle(input);
            const textEnd = field.right - parseFloat(css.paddingRight) - parseFloat(css.borderRightWidth);
            const rect = target => {
                const { x, y, width, height } = target.getBoundingClientRect();
                return { x, y, width, height };
            };
            const adornment = document.querySelector(".wire-search-icon"), beforeAdornment = rect(input);
            adornment.style.display = "none";
            const withoutAdornment = rect(input);
            adornment.style.removeProperty("display");
            const row = document.querySelector(".wire-search-hit"), slot = row.querySelector(".wire-search-type-icon");
            const textGeometry = () => ({
                row: rect(row), meta: rect(row.querySelector(".wire-search-meta")),
                title: rect(row.querySelector(".wire-search-title")), source: rect(row.querySelector(".wire-search-source")),
            });
            const beforeType = textGeometry();
            slot.style.display = "none";
            const withoutType = textGeometry();
            slot.style.removeProperty("display");
            return { textEnd, clearStart: button.x, clearEnd: button.right, fieldEnd: field.right,
                beforeAdornment, withoutAdornment, beforeType, withoutType,
                centered: Math.abs(button.y + button.height / 2 - field.y - field.height / 2),
                actionHit: node.contains(document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2)),
                textHit: document.elementFromPoint(textEnd - 2, field.y + field.height / 2) === input,
                sameInput: window.originalQueryField === input };
        });
        assert.ok(capsule.textEnd < capsule.clearStart && capsule.clearEnd <= capsule.fieldEnd);
        assert.ok(capsule.centered < 1);
        assert.deepEqual(capsule.beforeAdornment, capsule.withoutAdornment);
        assert.deepEqual(capsule.beforeType, capsule.withoutType, "Decorative icons do not inflate reading geometry");
        assert.equal(capsule.actionHit, true); assert.equal(capsule.textHit, true); assert.equal(capsule.sameInput, true);
        const doc = await cdp.send("DOM.getDocument", { depth: 0 });
        const inputNode = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#wireSearch" });
        const native = await cdp.send("DOM.describeNode", { nodeId: inputNode.nodeId, depth: -1, pierce: true });
        function cancelNode(node) {
            if (node.attributes?.includes("-webkit-search-cancel-button")) return node;
            for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
                const found = cancelNode(child);
                if (found) return found;
            }
        }
        const cancel = cancelNode(native.node);
        if (cancel) {
            const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: cancel.backendNodeId });
            const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId,
                functionDeclaration: "function() { return { display: getComputedStyle(this).display, width: this.getBoundingClientRect().width }; }",
                returnByValue: true });
            assert.equal(result.value.display, "none"); assert.equal(result.value.width, 0, "No second native pointer-clear target");
        }
        const beforePaging = queries.length;
        await page.getByRole("button", { name: "Next results", exact: true }).tap();
        await expect(rows).toHaveCount(2);
        await expect(rows.locator(".wire-search-excerpt mark")).toHaveText("Power");
        await expect(rows.locator(".wire-search-excerpt")).toContainText("Do not publish the PowerPoint until its review is complete.");
        await page.getByRole("button", { name: "Previous results", exact: true }).tap();
        await expect(rows).toHaveCount(20);
        assert.equal(queries.length, beforePaging, "Paging changes a slice, not query/filter population");
        if (proofs) {
            await page.locator("#wireSearchFilterSummary").scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(proofs, `capsule-${channel || "chromium"}-${theme}-${width}-${scale}-filters.png`) });
        }
        await input.focus(); await input.press("Tab"); await expect(clear).toBeFocused();
        await expect(page.locator("#evidence-tooltip")).toBeVisible();
        await clear.press("Escape");
        await expect(page.locator("#evidence-tooltip")).toBeHidden();
        await expect(page.locator("#wireSearchPanel")).toBeVisible();
        await expect(input).toHaveValue("POWER");
        await clear.press("Escape");
        await expect(page.locator("#wireSearchPanel")).toBeHidden();
        await expect(input).toBeFocused(); await expect(input).toHaveValue("POWER"); await expect(clear).toBeVisible();
        await input.press("Tab"); await expect(clear).toBeFocused();
        assert.equal(await clear.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
        if (proofs) await page.screenshot({ path: path.join(proofs, `capsule-${channel || "chromium"}-${theme}-${width}-${scale}-clear-focus.png`) });
        await clear.evaluate(node => { node.disabled = true; });
        const disabled = await clear.boundingBox();
        assert.equal(disabled.height, 44); assert.equal(disabled.width, 44);
        await page.mouse.click(disabled.x + disabled.width / 2, disabled.y + disabled.height / 2);
        await expect(input).toHaveValue("POWER");
        await clear.evaluate(node => { node.disabled = false; });
        const clicks = await page.evaluate(() => window.queryClearClicks), emptyQueries = queries.filter(value => value.query === "").length;
        const cancelled = page.waitForResponse(response => response.url().endsWith("/api/search/query") && response.request().postDataJSON().query === "");
        if (scale === 1) { await input.focus(); await input.press("Tab"); await clear.press("Enter"); }
        else await clear.tap();
        await (await cancelled).finished();
        assert.equal(await page.evaluate(() => window.queryClearClicks), clicks + 1);
        assert.equal(queries.filter(value => value.query === "").length, emptyQueries + 1, "One clear dispatch, no synthetic input forwarding");
        await expect(input).toHaveValue(""); await expect(input).toBeFocused();
        await expect(page.locator("#wireSearchPanel")).toBeHidden();
        assert.equal(await clear.boundingBox(), null, "Empty Search leaves no hidden action hit area");
        await expect(page.locator("#wireSearchType")).toHaveValue("interaction");
        await expect(page.locator("#wireSearchScope")).toHaveValue("everywhere");
        assert.deepEqual(await input.boundingBox(), emptyField);
        if (proofs) await page.screenshot({ path: path.join(proofs, `capsule-${channel || "chromium"}-${theme}-${width}-${scale}-cleared.png`) });
        measurements.push({ theme, width, scale, measured, capsule });
    }
    await input.fill("  "); await expect(clear).toBeVisible();
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await clear.click(); await expect(input).toHaveValue("");
    await input.fill("POWER"); await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(rows).not.toHaveCount(0);
    await clear.click();
    await expect(page.locator("#wireSearchScope")).toHaveValue("analysis");
    await expect(page.locator("#wireSearchType")).toBeDisabled();
    await expect(page.locator("#wireSearchType")).toHaveValue("");
    await input.fill("POWER"); await selectActivityOption(page, "wireSearchScope", "everywhere");
    await expect(rows).not.toHaveCount(0);
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    await page.route("**/api/search/query", async route => {
        if (route.request().postDataJSON().query === "PowerPoint") { entered.resolve(); await gate.promise; }
        await route.continue();
    });
    try {
        await input.fill("PowerPoint"); await entered.promise;
        await clear.click(); await expect(input).toHaveValue(""); await expect(rows).toHaveCount(0);
        const late = page.waitForResponse(response => response.url().endsWith("/api/search/query")
            && response.request().postDataJSON().query === "PowerPoint");
        gate.resolve(); await (await late).finished();
        await expect(rows).toHaveCount(0); await expect(clear).toBeHidden(); await expect(input).toBeFocused();
    } finally { gate.resolve(); }
    await input.fill("POWER"); await expect(clear).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    await expect(input).toHaveValue(""); await expect(clear).toBeHidden();
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    if (proofs) await writeFile(path.join(proofs, `capsule-${channel || "chromium"}-measurements.json`), JSON.stringify(measurements, null, 2));
});
