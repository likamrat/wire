import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { searchFixture, searchRecords } from "../search/live-search-fixture.mjs";
import { navigateMain, selectActivityOption } from "../support/helpers.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { palettes } from "../../web/theme.mjs";
import { contrast, paintedLabelContrast } from "../support/color-measurements.mjs";
import { retainedContextFixture } from "../reader/request-context-fixture.mjs";
import { historicalComparison } from "../comparison/historical-comparison-fixture.mjs";

test("saved-file exposure cannot be determined from selected IDs alone", async t => {
    const records = retainedContextFixture().records;
    for (const record of records) for (const call of record.toolCalls) call.requestArgs = { entityUrls: ["/me/drive/root/children"] };
    const app = await searchFixture(t, { records, copilotAccess: true, frontend: "react", reply: false });
    async function save(index, title, recordedContext = false) {
        const preview = await app.exports.preview("file-boundary", undefined,
            { title: `Workshop review ${title}`, formats: ["html"], promptMode: "original", recordedContext },
            { kind: "selected", revision: (await loadBoardState(app.context)).revision, scenarioIds: [records[index].scenarioId] });
        await app.exports.review("file-boundary", preview.previewId, true);
        return { preview, entry: (await app.exports.confirm("file-boundary", preview.previewId, true)).bundle };
    }
    const selected = await save(0, "selected");
    const linked = await save(1, "linked", true);
    const other = await save(3, "separate");
    const { bundle: unknown } = await historicalComparison(app.context, selected.entry.bundleId, other.entry.bundleId,
        { title: "Workshop review comparison", formats: ["html"] });
    // Known at fixture preparation, without reading any original to decide whether it can open.
    assert.deepEqual(linked.entry.scenarioIds, [records[1].scenarioId]);
    assert.ok(JSON.stringify(linked.preview.snapshot.recordedContext).includes(records[0].userPrompt.text));
    assert.deepEqual(other.entry.scenarioIds, [records[3].scenarioId]);
    assert.ok(!JSON.stringify(other.preview.snapshot).includes(records[0].userPrompt.text));
    assert.ok(!Object.hasOwn(unknown, "scenarioIds"));
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage(); await page.goto(app.runtime.url);
    const hits = page.locator(".wire-search-hit[data-search-bundle]");
    async function find() { await page.locator("#wireSearch").click(); await page.locator("#wireSearch").fill("Workshop review"); }
    await find(); await expect(hits).toHaveCount(4, { timeout: 15000 });
    await page.locator("#wireSearch").press("Escape");
    await page.locator("#activityList article").filter({ hasText: records[0].userPrompt.text }).getByRole("button", { name: "Hide", exact: true }).click();
    await find(); await expect(page.locator("#wireSearchStatus")).toContainText("No visible matches"); await expect(hits).toHaveCount(0);
    const reads = [];
    page.on("request", req => { if (/\/api\/(?:artifact-file|report\/open|report-original|search\/open)/.test(req.url())) reads.push(req.url()); });
    for (const { bundleId } of [selected.entry, linked.entry, other.entry, unknown]) {
        await page.goto(new URL(`/reports?bundle=${bundleId}`, app.runtime.url).href);
        await expect(page.locator("#savedReportReader")).toContainText("all saved reports and comparisons closed");
    }
    assert.deepEqual(reads, []);
    await page.goto(app.runtime.url); await page.getByRole("button", { name: "Hidden cards (1)" }).click();
    await page.getByRole("dialog", { name: "Hidden cards" }).getByRole("button", { name: "Restore", exact: true }).click();
    await find(); await expect(hits).toHaveCount(4, { timeout: 15000 });
});

for (const frontend of ["react", "bundled"]) test(`card visibility keeps the reader, search and report copies covered (${frontend})`, async t => {
    const records = searchRecords();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    for (const record of records) {
        record.capturedAt = `${yesterday}T12:00:00Z`;
        record.userPrompt.sourceTimestamp = record.capturedAt;
        record.toolCalls[0].startedAt = record.capturedAt;
    }
    const { runtime, bundles, context: store } = await searchFixture(t, { records, copilotAccess: true, frontend, reply: false, formats: ["html"] });
    const saved = bundles[0].files["product-report.html"], bytes = await readFile(saved);
    const browser = await chromium.launch(); t.after(() => browser.close());
    const context = await browser.newContext(), page = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url);
    const row = page.locator("#activityList article").filter({ hasText: "The physician treated" });
    await expect(row).toBeVisible();
    await row.locator(".report-draft-trigger").click();
    const picker = page.getByRole("dialog", { name: "Report drafts", exact: true });
    await picker.getByRole("button", { name: "New draft", exact: true }).click();
    await picker.getByLabel("Draft name").fill("Case review");
    await picker.getByRole("button", { name: "Create draft and add" }).click();
    await expect(row.locator(".report-draft-trigger")).toContainText("Case review");
    const membership = (await loadBoardState(store)).namedReportDrafts;
    const prepared = frontend === "react" ? await context.newPage() : null;
    let previewReads = 0;
    if (prepared) {
        await prepared.goto(new URL("/reports", runtime.url).href);
        await prepared.locator("#reportDraftsPanel").getByRole("button", { name: /^Case review\b/ }).click();
        prepared.on("request", request => { if (new URL(request.url()).pathname === "/api/preview") previewReads++; });
        await prepared.locator("#prepareReportPreview").click();
        await expect(prepared.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await page.bringToFront();
    }
    await row.locator(".request-card-open").first().click();
    await expect(page.locator("#requestContent")).toContainText("physician");
    const original = page.url();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    const summary = await page.locator("#activityListSummary").textContent();
    await row.getByRole("button", { name: "Hide", exact: true }).press("Enter");
    if (prepared) { await expect(prepared.locator("#hiddenPreviewNotice")).toBeVisible(); await expect(prepared.locator("#reportStage3")).toBeHidden(); }
    await expect(row).toHaveCount(0);
    await expect(page.locator("#activityListSummary")).toHaveText(summary);
    await expect(page.getByRole("button", { name: "Undo hide" })).toBeFocused();
    await page.getByRole("button", { name: "Hidden cards (1)" }).click();
    const dialog = page.getByRole("dialog", { name: "Hidden cards", exact: true });
    await expect(dialog).not.toContainText("physician");
    await expect(dialog.getByRole("heading", { name: "Hidden cards" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hidden cards (1)" })).toBeFocused();
    await page.locator("#wireSearch").click();
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchStatus")).toContainText("No visible matches", { timeout: 15000 });
    await expect(page.locator(".wire-search-hit")).toHaveCount(0);
    // A counted-call link belongs to its original tab. Revisit its original history entry.
    await page.goForward();
    await expect(page.locator("#requestContent")).toContainText("This card is hidden");
    assert.equal(page.url(), original);
    await expect(page.locator("#requestContent")).not.toContainText("physician");
    await navigateMain(page, "reports");
    await page.locator("#reportDraftsPanel").getByRole("button", { name: /^Case review\b/ }).click();
    await expect(page.locator("#prepareReportPreview")).toBeDisabled();
    await expect(page.locator("#prepareReportPreview")).toHaveAccessibleDescription(/hidden card/i);
    await page.goto(new URL(`/reports?bundle=${bundles[0].bundleId}`, runtime.url).href);
    await expect(page.locator("#savedReportReader")).toContainText("Saved file kept closed");
    assert.deepEqual(await readFile(saved), bytes);
    assert.deepEqual((await loadBoardState(store)).namedReportDrafts, membership);
    await page.goto(new URL("/compare", runtime.url).href);
    await page.locator("#viewComparisonCalls").click(); await page.locator("#comparisonRecordsB").click();
    await expect(page.locator("#comparisonExactRecordsB tbody tr")).toHaveCount(3);
    await expect(page.locator("#comparisonExactRecordsB tbody tr").filter({ hasText: "Hidden card" })).toHaveCount(1);
    await page.goto(new URL("/trends?section=charts&measure=rhythm", runtime.url).href);
    const chart = page.locator(".trends-panel[data-family=rhythm]");
    await chart.locator('[data-trend-mark][aria-label*="3 calls"]').first().press("Enter");
    await chart.getByRole("button", { name: "View 3 calls" }).click();
    await expect(page.locator(".trends-evidence-row")).toHaveCount(3);
    await expect(page.locator(".trends-evidence-row").filter({ hasText: "Hidden card" })).toHaveCount(1);
    await page.goto(new URL("/settings?section=analyze", runtime.url).href);
    await selectActivityOption(page, "defaultCardHideDuration", "tab");
    await navigateMain(page, "analyze");
    const mechanic = page.locator("#activityList article").filter({ hasText: "The mechanic repaired" });
    await mechanic.getByRole("button", { name: "Hide", exact: true }).click();
    await page.reload(); await expect(mechanic).toHaveCount(0);
    const other = await context.newPage(); await other.goto(runtime.url);
    await expect(other.locator("#activityList")).toContainText("The mechanic repaired");
    await expect(other.locator("#activityList")).not.toContainText("The physician treated");
    await page.getByRole("button", { name: "Hidden cards (2)" }).click();
    await dialog.getByRole("button", { name: "Restore all (2)" }).press("Enter");
    await expect(dialog).toHaveCount(0); await expect(row).toBeVisible(); await expect(mechanic).toBeVisible();
    if (prepared) { await expect(prepared.locator("#reportStage3")).toBeVisible(); assert.equal(previewReads, 1); }
    assert.deepEqual(errors, []);
});

test("Hide stays aligned with Add to report across states, text sizes and palettes", { timeout: 120000 }, async t => {
    const { runtime } = await searchFixture(t, { copilotAccess: true, frontend: "react", reply: false });
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1340, height: 900 }, reducedMotion: "reduce" });
    await page.goto(runtime.url);
    const row = page.locator("#activityList .request-row").first();
    const hide = row.getByRole("button", { name: "Hide", exact: true }), add = row.locator(".report-draft-trigger");
    await expect(hide).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const metrics = control => control.evaluate(node => {
        const css = getComputedStyle(node), face = getComputedStyle(node, "::before");
        const icon = node.querySelector("svg"), glyph = icon.getBoundingClientRect(), box = node.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(node.lastChild); const text = range.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, faceHeight: parseFloat(face.height),
            top: glyph.top - box.top, glyph: glyph.width, textTop: text.top - box.top, gap: text.left - glyph.right,
            left: glyph.left - box.left, right: box.right - text.right, font: css.font, stroke: icon.getAttribute("stroke-width") };
    });

    const checkRecovery = async () => {
        for (const [width, scale, theme] of [[1340, 1, "light"], [390, 2, "dark"]]) {
            const touch = width < 500;
            const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, reducedMotion: "reduce", colorScheme: theme, locale:"en-GB", timezoneId:"UTC" });
            const activate = control => touch ? control.tap() : control.click();
            await page.goto(new URL("/settings?section=regional",runtime.url).href);
            await selectActivityOption(page,"displayTimeZone","Asia/Tokyo");
            await page.goto(runtime.url);
            await page.evaluate(s => { document.documentElement.style.fontSize = `${s * 100}%`; }, scale);
            const hides = page.locator("#activityList").getByRole("button", { name: "Hide", exact: true });
            await activate(hides.first());
            const actions = page.locator("#cardVisibilityActions");
            const undo = actions.getByRole("button", { name: "Undo hide" });
            const check = async (control, icon) => {
                await expect(control.locator("svg")).toHaveCount(1);
                await expect(control.locator("svg")).toHaveAttribute("data-lucide-icon", icon);
                await control.scrollIntoViewIfNeeded();
                const bounds = await control.boundingBox();
                assert.ok(bounds.height >= 44 && bounds.width >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width, `Unreachable ${await control.textContent()}: ${JSON.stringify(bounds)}`);
                const measure = () => control.evaluate(n => {
                    const glyph = n.querySelector("svg").getBoundingClientRect(), box = n.getBoundingClientRect();
                    const text = document.createRange(); text.selectNodeContents(n.lastChild);
                    const rect = text.getBoundingClientRect(), face = getComputedStyle(n, "::before");
                    return { gap: rect.left - glyph.right, align: Math.abs((glyph.top + glyph.bottom - box.top - box.bottom)/2),
                        face: face.backgroundColor, topInset: parseFloat(face.top), bottomInset: parseFloat(face.bottom) };
                });
                await page.mouse.move(2, 2);
                const rest = await measure();
                assert.ok(rest.gap >= 6 && rest.align <= 1 && rest.topInset > 0 && rest.topInset === rest.bottomInset, JSON.stringify(rest));
                if (touch) { assert.ok(await paintedLabelContrast(control) >= 4.5); return; }
                await control.hover({position:{x:2,y:bounds.height/2}}); const hovered = await measure(); assert.notEqual(hovered.face, rest.face);
                await page.mouse.down(); const pressed = await measure(); assert.notEqual(pressed.face, hovered.face);
                assert.deepEqual(await control.boundingBox(), bounds);
                const ratio = await paintedLabelContrast(control);
                assert.ok(ratio >= 4.5, `${await control.textContent()} pressed contrast ${ratio}`);
                await page.mouse.move(bounds.x-1,bounds.y+bounds.height/2); await page.mouse.up();
            };
            await check(undo, "rotate-ccw"); await activate(undo); await expect(hides).toHaveCount(3);
            await activate(hides.first()); await activate(hides.first());
            const manage = actions.getByRole("button", { name: "Hidden cards (2)" });
            await check(manage, "eye-off"); await activate(manage);
            const dialog = page.getByRole("dialog", { name: "Hidden cards", exact: true });
            await expect(dialog.locator(".dialog-head button svg")).toHaveCount(1);
            await expect(dialog.locator(".dialog-head button svg")).toHaveAttribute("data-lucide-icon", "x");
            const restore = dialog.getByRole("button", { name: "Restore", exact: true }).first(), all = dialog.getByRole("button", { name: "Restore all (2)" });
            await check(all, "rotate-ccw"); await check(restore, "eye");
            const last = await dialog.locator(".hidden-card-row").last().boundingBox(), bulk = await all.boundingBox();
            assert.ok(bulk.y >= last.y + last.height && Math.abs(bulk.x + bulk.width - last.x - last.width) <= 1);
            assert.ok(await dialog.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
            await activate(restore); await expect(hides).toHaveCount(2);
            await activate(actions.getByRole("button", { name: "Hidden cards (1)" }));
            await expect(dialog.getByRole("button", { name: /Restore all/ })).toHaveCount(0);
            const stamp = dialog.locator("time");
            const localDate = await stamp.evaluate(n => new Intl.DateTimeFormat(navigator.language, {
                timeZone:"Asia/Tokyo",year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",
            }).format(new Date(n.dateTime)));
            await expect(stamp).toHaveText(localDate);
            await activate(restore);
            await expect(dialog).toHaveCount(0); await expect(hides).toHaveCount(3);
            await expect(page.locator("#activityListSummary")).toBeFocused();
            await page.close();
        }
    };
    const paint = control => control.evaluate(node => {
        const face = getComputedStyle(node, "::before"), style = getComputedStyle(node);
        return [face.backgroundColor, face.borderTopColor, style.outlineWidth, style.outlineStyle];
    });
    for (const [width, scale] of [[1340, 1], [390, 1.5], [390, 2]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(s => { document.documentElement.style.fontSize = `${s * 100}%`; }, scale);
        await hide.scrollIntoViewIfNeeded();
        const peer = await metrics(add), own = await metrics(hide);
        for (const key of ["height", "top", "glyph", "textTop", "gap", "left", "font", "stroke"]) assert.equal(own[key], peer[key], `${width}/${scale}: ${key}`);
        assert.ok(own.height >= 44 && own.width >= 44 && own.faceHeight <= own.height, `Paint outside hit target: ${JSON.stringify(own)}`);
        assert.ok(own.left >= 8 && Math.abs(own.left - own.right) <= 1, `Unbalanced padding: ${JSON.stringify(own)}`);
        const bounds = await row.boundingBox();
        assert.ok(own.x + own.width <= bounds.x + bounds.width - 8, "Hide must remain inside the card with a trailing inset");
        if (own.y === peer.y) assert.ok(own.x - (peer.x + peer.width) >= 8, "Separate adjacent hit targets");
        else assert.ok(own.x === peer.x && own.y >= peer.y + peer.height, "Wrapped commands retain their leading edge and separate targets");
        assert.equal(await hide.locator("svg").getAttribute("data-lucide-icon"), "eye-off");
        assert.equal(await hide.locator("svg").getAttribute("aria-hidden"), "true");
    }
    await page.setViewportSize({ width: 1340, height: 900 });
    await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
    for (const palette of Object.keys(palettes)) for (const theme of ["light", "dark"]) {
        await page.evaluate(([palette, theme]) => Object.assign(document.documentElement.dataset, { evidencePalette: palette, evidenceTheme: theme }), [palette, theme]);
        await hide.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
        const normal = await paint(hide), geometry = await metrics(hide), where = `${palette}/${theme}`;
        const checkInk = async () => assert.ok(await paintedLabelContrast(hide) >= 4.5, `${where}: label contrast`);
        await checkInk();
        await hide.hover(); const hover = await paint(hide); await checkInk();
        assert.notEqual(hover[0], normal[0], `${where}: hover must tint the face`);
        await page.mouse.down();
        const press = await paint(hide); await checkInk();
        assert.notEqual(press[0], hover[0], `${where}: pressed must differ from hover`);
        assert.deepEqual(await metrics(hide), geometry, `${where}: moving paint must not move the target or text`);
        await page.mouse.move(1, 1); await page.mouse.up();
        await add.focus(); await page.keyboard.press("Tab"); await expect(hide).toBeFocused();
        const [ink, surface, thickness] = await hide.evaluate(node => {
            const style = getComputedStyle(node);
            let surface = node.parentElement;
            while (surface.parentElement && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement;
            return [style.outlineColor, getComputedStyle(surface).backgroundColor, parseFloat(style.outlineWidth)];
        });
        assert.ok(thickness >= 2 && contrast(ink, surface) >= 3, `${where}: keyboard outline ${thickness}px ${ink} on ${surface}`);
        await checkInk(); await page.keyboard.press("Shift+Tab");
    }
    await checkRecovery();
});
