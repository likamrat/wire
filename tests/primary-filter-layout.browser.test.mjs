import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { chooseTheme, selectActivityOption, navigateMain, openActivitySessions } from "./helpers.mjs";
import { createControlHelp } from "../lib/control-help.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";

const proofs = process.env.WIRE_PRIMARY_FILTER_PROOFS;
const ids = ["dateFilter", "toolFilter", "serviceAssociationFilter", "outcomeFilter", "promptAuthorFilter"];
const help = createControlHelp(serviceCategories);
const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");

async function setup(t, touch = false) {
    const app = await authorFilterFixture(t), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: touch ? 375 : 1200, height: 1000 }, hasTouch: touch, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [], blocked = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(app.runtime.url).origin || /\/api\/(?:collection\/(?:now|configure|enabled)|evaluation\/(?:start|automatic\/(?:approve|revoke)))/.test(url.pathname)) {
            blocked.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    app.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(blocked, []); });
    await page.goto(app.runtime.url); await ready(page);
    if (proofs) await mkdir(proofs, { recursive: true });
    return { ...app, page };
}

async function geometry(page) {
    return page.evaluate(ids => {
        const box = node => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
        };
        const fields = ids.map(id => {
            const control = document.getElementById(id + "-control");
            const label = document.querySelector(`label[for="${id}-control"]`);
            const value = control.querySelector(".select-value");
            const labelRange = document.createRange();
            labelRange.selectNodeContents(label);
            const labelText = labelRange.getBoundingClientRect();
            return { id, visible: control.checkVisibility(), control: box(control), label: box(label),
                labelText: { x: labelText.x, y: labelText.y, bottom: labelText.bottom, height: labelText.height },
                lineHeight: parseFloat(getComputedStyle(label).lineHeight), value: box(value),
                textClipped: value.scrollWidth > value.clientWidth + 1,
                labelClipped: label.scrollWidth > label.clientWidth + 1 };
        });
        return { fields, overflow: document.documentElement.scrollWidth - innerWidth,
            row: box(document.querySelector(".period-controls")), scroll: box(document.querySelector(".filter-scroll")) };
    }, ids);
}
const range = values => Math.max(...values) - Math.min(...values);
function aligned(layout) {
    assert.ok(layout.overflow <= 1, "No page-level horizontal overflow");
    assert.ok(layout.fields.every(field => field.visible), "All five primary filters are visible without an expansion");
    assert.ok(layout.fields.every(field => field.control.height >= 44 && !field.textClipped), "Labels stay readable with 44px hit targets");
    assert.ok(layout.fields.every(field => !field.labelClipped), "Complete filter titles stay readable");
    assert.ok(range(layout.fields.map(field => field.label.x - field.control.x)) <= 1, "Label insets are consistent");
    for (const field of layout.fields) assert.ok(field.control.x >= layout.scroll.x - 1 && field.control.right <= layout.scroll.right + 1, "Fields wrap within the region instead of hiding active values offscreen");
}

test("primary analytical filters wrap readably at desktop, narrow and 200 percent text sizes", { timeout: 45000 }, async t => {
    const { page } = await setup(t), measurements = [];
    for (const theme of ["dark", "light"]) for (const width of [1200, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => {
            document.documentElement.style.fontSize = `${scale * 100}%`;
            document.querySelector(".filter-scroll").scrollLeft = 0;
        }, scale);
        await page.locator("#filters").scrollIntoViewIfNeeded();
        const layout = await geometry(page);
        if (width >= 1200 && scale === 1) assert.ok(range(layout.fields.map(field => field.control.y)) <= 1, "The five primary defaults share one desktop row");
        if (proofs) {
            await page.screenshot({ path: path.join(proofs, `context-${theme}-${width}-${scale}.png`), fullPage: true });
            await page.locator("#filters").screenshot({ path: path.join(proofs, `primary-${theme}-${width}-${scale}.png`) });
        }
        measurements.push({ theme, width, scale, ...layout });
        for (const id of ids) {
            const trigger = page.locator(`#${id}-control`);
            await trigger.scrollIntoViewIfNeeded();
            const field = await trigger.boundingBox(), viewport = await page.locator(".filter-scroll").boundingBox();
            assert.ok(field.x >= viewport.x - 1 && field.x + field.width <= viewport.x + viewport.width + 1, `${id}: the complete control can be brought into view`);
            assert.ok((await trigger.getAttribute("aria-labelledby")).trim(), "Every filter retains its accessible label");
        }
        if (proofs) await page.locator("#filters").screenshot({ path: path.join(proofs, `row-end-${theme}-${width}-${scale}.png`) });
    }
    if (proofs) await writeFile(path.join(proofs, "geometry.json"), JSON.stringify(measurements, null, 2));
    for (const layout of measurements) aligned(layout);
});

async function applyValues(page, id, values) {
    await page.locator(`[data-select-id="${id}"]`).click();
    const popup = page.locator(".select-popup:visible");
    for (const option of await popup.locator(".select-option").all()) {
        const wanted = values.includes(await option.getAttribute("data-value"));
        if ((await option.getAttribute("aria-selected") === "true") !== wanted) await option.click();
    }
    await popup.getByRole("button", { name: "Apply", exact: true }).click(); await ready(page);
}

test("active clear actions and custom dates keep dropdown geometry and filtering intact", { timeout: 45000 }, async t => {
    const { page, olderDay } = await setup(t);
    const original = await geometry(page);
    await applyValues(page, "outcomeFilter", ["failure"]);
    await applyValues(page, "promptAuthorFilter", ["user"]);
    assert.equal(await page.locator("#activityCount").textContent(), "1");
    const filtered = await geometry(page);
    aligned(filtered);
    assert.ok(Math.abs(filtered.row.y - original.row.y) <= 1, "Active controls keep the row's vertical anchor");
    for (const id of ["clearResultFilter", "clearPromptAuthorFilter"]) {
        const clear = page.locator("#" + id), bounds = await clear.boundingBox();
        assert.ok(bounds.width >= 44 && bounds.height >= 44);
        const field = filtered.fields[id === "clearResultFilter" ? 3 : 4];
        assert.ok(bounds.y + bounds.height <= field.control.y + 1, "Clear is above its dropdown, not an extra inter-field gap");
        assert.ok(bounds.x >= field.label.right, "Clear does not overlap its label");
    }
    if (proofs) await page.locator("#filters").screenshot({ path: path.join(proofs, "primary-active.png") });
    await page.getByRole("button", { name: "Clear prompt author filter", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#activityCount").textContent(), "2");
    await page.getByRole("button", { name: "Clear recorded result filter", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#activityCount").textContent(), "8");
    await selectActivityOption(page, "dateFilter", "custom"); await ready(page);
    aligned(await geometry(page));
    const custom = await page.locator("#dateFields").boundingBox(), layout = await geometry(page);
    assert.ok(custom.y >= Math.max(...layout.fields.map(field => field.control.bottom)), "Custom dates occupy their own row");
    await page.locator("#fromFilter").fill(olderDay); await page.locator("#toFilter").fill("");
    await page.locator("#applyDates").click();
    assert.equal(await page.locator("#dateError").isVisible(), true);
    assert.equal(await page.locator("#activityCount").textContent(), "8", "Invalid custom dates do not silently apply");
    await page.locator("#fromFilter").fill(olderDay); await page.locator("#toFilter").fill(olderDay);
    await page.locator("#applyDates").click(); await ready(page);
    assert.equal(await page.locator("#dateError").isVisible(), false);
    assert.equal(await page.locator("#activityCount").textContent(), "5");
    if (proofs) await page.locator("#filters").screenshot({ path: path.join(proofs, "primary-custom-dates.png") });
    await page.locator('[data-select-id="promptAuthorFilter"]').click();
    const popup = page.locator(".select-popup:visible");
    await popup.locator('[data-value="agent"]').click();
    await popup.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.locator("#activityCount").textContent(), "5");
    for (const width of [1200, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        for (const id of ["fromFilter", "toFilter", "applyDates", "clearDates"]) {
            await page.locator("#" + id).scrollIntoViewIfNeeded();
            const bounds = await page.locator("#" + id).boundingBox();
            assert.ok(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${id}: complete custom-date controls at ${width}/${scale}`);
        }
    }
});

test("filter help explains actual categories and all six honest activity units without changing counts", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#moreFilters > summary").click();
    const labels = ["Work IQ calls", "Graph API call sites", "Graph statuses", "Returned API entries", "HTTP recorder", "Graph code references"];
    assert.deepEqual(await page.locator("#layerFilter option").allTextContents(), labels);
    await page.getByRole("button", { name: "About Activity category", exact: true }).click();
    const category = await page.getByRole("tooltip").innerText();
    assert.match(category, /Mail, Calendar, Files.*recorded service targets/);
    assert.equal(category, help.categoryGuide(await page.locator("#serviceFilter option").evaluateAll(nodes => nodes.map(node => node.value).filter(value => value !== "all"))));
    assert.match(category, /Discovery:.*not data execution/);
    assert.match(category, /Search and retrieval: may span sources/);
    assert.match(category, /More than one service: one call, different services/);
    assert.match(category, /Service not shown:.*not failure/);
    await page.keyboard.press("Escape");
    await selectActivityOption(page, "serviceFilter", "Mail"); await ready(page);
    await page.getByRole("button", { name: "About Activity category", exact: true }).click();
    assert.equal(await page.getByRole("tooltip").innerText(), "Mail: " + serviceCategories.describe("Mail").description);
    await page.keyboard.press("Escape");
    await selectActivityOption(page, "serviceFilter", "all"); await ready(page);
    for (const layer of Object.keys(help.layers)) {
        await selectActivityOption(page, "layerFilter", layer); await ready(page);
        const count = await page.locator("#activityCount").textContent(), url = page.url();
        const button = page.getByRole("button", { name: "About Activity", exact: true });
        await button.scrollIntoViewIfNeeded(); await button.focus();
        await page.getByRole("tooltip").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("tooltip").innerText(), `${help.layers[layer]} ${help.fields.layerFilter}`);
        const metrics = await button.evaluate(node => {
            const glyph = node.querySelector("svg").getBoundingClientRect(), target = node.getBoundingClientRect();
            const text = document.createRange(); text.selectNodeContents(node.previousElementSibling);
            const label = text.getBoundingClientRect(), tip = document.querySelector("[role=tooltip]").getBoundingClientRect();
            return { gap: glyph.left - label.right, anchorGap: tip.top >= glyph.bottom ? tip.top - glyph.bottom : glyph.top - tip.bottom,
                target: { width: target.width, height: target.height }, tip: { left: tip.left, right: tip.right, top: tip.top, bottom: tip.bottom },
                width: innerWidth, height: innerHeight, hoverFill: getComputedStyle(node).backgroundColor };
        });
        assert.equal(metrics.gap, 4);
        assert.equal(metrics.anchorGap, 8);
        assert.ok(metrics.target.width >= 44 && metrics.target.height >= 44);
        assert.ok(metrics.tip.left >= 8 && metrics.tip.right <= metrics.width - 8 && metrics.tip.top >= 8 && metrics.tip.bottom <= metrics.height - 8);
        assert.equal(metrics.hoverFill, "rgba(0, 0, 0, 0)");
        if (proofs) await page.screenshot({ path: path.join(proofs, `help-${layer}.png`) });
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        assert.equal(await page.locator("#activityCount").textContent(), count);
        assert.equal(page.url(), url);
    }
    assert.equal(await page.locator("#outcomeFilter-control").isDisabled(), true);
    assert.equal(await page.locator("#resultFilterScope").isVisible(), true, "Unavailable execution filtering keeps its explanation outside the scroller");
});

test("narrow keyboard and touch can reach the row, menus and help without clipped overlays or applying drafts", { timeout: 45000 }, async t => {
    const { page } = await setup(t, true);
    const scroll = page.getByRole("region", { name: "Filter row", exact: true });
    await scroll.focus();
    for (const scale of [1, 2]) {
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await scroll.focus();
        for (const id of ids) {
            await page.keyboard.press("Tab");
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement.id), id + "-control", "Tab follows the row's label/control order");
            const bounds = await page.locator("#" + id + "-control").boundingBox();
            assert.ok(bounds.x >= 15 && bounds.x + bounds.width <= 360, `${id}/${scale}: Tab brings the complete focused control into view (${JSON.stringify(bounds)})`);
        }
        if (!await page.locator("#moreFilters").evaluate(node => node.open)) await page.locator("#moreFilters > summary").click();
        const activity = page.locator("#layerFilter-control");
        await activity.tap();
        const popup = page.locator(".select-popup:visible"), box = await popup.boundingBox();
        assert.ok(box.x >= 8 && box.x + box.width <= 367);
        assert.equal(await popup.evaluate(node => node.parentElement === document.body), true, "Popup is outside the scrolling row");
        for (const option of await popup.getByRole("option").all()) {
            await option.scrollIntoViewIfNeeded();
            const measure = await option.evaluate(node => {
                const label = node.querySelector(".select-option-label");
                const range = document.createRange(); range.selectNodeContents(label);
                return { height: node.getBoundingClientRect().height, overflow: label.scrollWidth - label.clientWidth, clipped: label.scrollHeight - label.clientHeight,
                    textHeight: range.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(label).lineHeight) };
            });
            assert.ok(measure.height >= 44 && measure.overflow <= 1 && measure.clipped <= 1);
        }
        if (proofs) await page.screenshot({ path: path.join(proofs, `narrow-menu-${scale}.png`) });
        await page.keyboard.press("Escape");
        assert.equal(await activity.evaluate(node => node === document.activeElement), true);
        const info = page.getByRole("button", { name: "About Activity", exact: true });
        await info.tap(); await page.getByRole("tooltip").waitFor({ state: "visible" });
        await page.locator("#pageTitle").tap();
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        await activity.tap();
        await page.locator("#moreFilters").evaluate(node => { node.open = false; });
        await page.waitForFunction(() => document.querySelector(".select-popup").hidden);
        assert.equal(await page.locator("#layerFilter").inputValue(), "tool", "Closing More filters dismisses a menu without committing");
        await page.locator("#promptAuthorFilter-control").tap();
        await page.locator('.select-popup [data-value="unknown"]').tap();
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#activityCount").textContent(), "8", "Escape still discards the multiselect draft");
    }
});

test("the same row and selected request membership survive chat scope, Back and Reset to Home", { timeout: 30000 }, async t => {
    const { page, cases } = await setup(t);
    await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
    await page.locator(`.request-row[data-view-key="request:${cases.agentMail.scenarioId}"] input`).check();
    await applyValues(page, "promptAuthorFilter", ["user"]);
    assert.equal(await page.locator(`.request-row[data-view-key="request:${cases.agentMail.scenarioId}"]`).count(), 0);
    await page.getByRole("link", { name: "Open analysis for GitHub Copilot chat: Invented author conversation", exact: true }).click(); await ready(page);
    aligned(await geometry(page));
    assert.equal(await page.locator(".filter-scroll .period-controls").count(), 1, "Chat scope reuses, rather than duplicates, the primary row");
    await page.goBack(); await ready(page);
    await page.locator("#resetView").click(); await ready(page);
    assert.ok(page.url().endsWith("#home"));
    assert.equal(await page.locator("#activityCount").textContent(), "8");
    await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
    assert.equal(await page.locator(`.request-row[data-view-key="request:${cases.agentMail.scenarioId}"] input`).isChecked(), true, "Reset does not erase hidden report membership");
});
