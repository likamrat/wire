import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { chooseTheme, selectActivityOption, openAnalyzeFilters } from "../support/helpers.mjs";

import { createControlHelp } from "../../lib/control-help.mjs";
import { serviceCategories } from "../../lib/service-categories.mjs";

const proofs = process.env.WIRE_PRIMARY_FILTER_PROOFS;
const ids = ["dateFilter", "sourceFilter", "toolFilter", "serviceAssociationFilter", "outcomeFilter", "promptAuthorFilter"];
const help = createControlHelp(serviceCategories);
const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
const settled = async page => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.querySelector("#analyzeFilterDialog").getAnimations({ subtree: true })
        .every(animation => animation.playState !== "running"));
};

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
    await openAnalyzeFilters(page);
    await settled(page);
    if (proofs) await mkdir(proofs, { recursive: true });
    return { ...app, page };
}

test("filter naming exposes real category, context and evidence-layer distinctions without routine help", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#moreFilters > summary").click();
    const labels = ["Work IQ calls", "Graph API call sites", "Call sites with HTTP status", "Tool-returned API entries", "HTTP recorder captures", "Graph code references"];
    assert.deepEqual(await page.locator("#layerFilter option").allTextContents(), labels);
    assert.equal(await page.locator("#filters .ux-help,#filters .help-heading").count(), 0);
    assert.equal(await page.locator('label[for="serviceAssociationFilter-control"]').innerText(), "Service involved");
    assert.equal(await page.locator('label[for="serviceFilter-control"]').innerText(), "Activity category");
    assert.equal(await page.locator('label[for="promptAuthorFilter-control"]').innerText(), "Prompt author");
    assert.equal(await page.locator('label[for="projectFilter-control"]').innerText(), "Project");
    assert.equal(await page.locator('#dateFilter option[value=week]').innerText(), "This week");
    for (const category of ["Discovery", "Multiple workloads", "Unknown"]) {
        assert.equal(await page.locator(`#serviceFilter option[value="${category}"]`).innerText(), serviceCategories.display(category).label);
    }
    assert.deepEqual(await page.locator("#promptAuthorFilter option").allTextContents(), ["Human prompts", "Agent prompts", "Sender unclear"]);
    await selectActivityOption(page, "serviceFilter", "Mail"); await ready(page);
    assert.equal(await page.locator("#serviceFilter-control").innerText(), "Mail");
    await selectActivityOption(page, "serviceFilter", "all"); await ready(page);
    for (const layer of Object.keys(help.layers)) {
        await selectActivityOption(page, "layerFilter", layer); await ready(page);
        const count = await page.locator("#activityCount").textContent(), url = page.url();
        assert.equal(await page.locator('label[for="layerFilter-control"]').innerText(), "Evidence layer");
        assert.equal(await page.locator('label[for="chatFilter-control"]').innerText(), layer === "http" ? "Recorder source" : "Chat");
        assert.equal(await page.locator('#chatFilter option[value=all]').innerText(), layer === "http" ? "All recorder sources" : "All chats");
        await page.locator("#layerFilter-control").press("ArrowDown"); await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("tooltip").count(), 0);
        assert.equal(await page.locator("#activityCount").textContent(), count);
        assert.equal(page.url(), url);
    }
    assert.equal(await page.locator("#outcomeFilter-control").isDisabled(), true);
    assert.equal(await page.locator("#resultFilterScope").isVisible(), true, "Unavailable execution filtering keeps its explanation outside the scroller");
});

test("narrow keyboard and touch reach each named filter directly without clipped overlays or applying drafts", { timeout: 45000 }, async t => {
    const { page } = await setup(t, true);
    for (const scale of [1, 2]) {
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.locator("#dateFilter-control").focus();
        for (const id of ids) {
            if (id === "sourceFilter" && !await page.locator("#sourceFilter-control").isVisible()) continue;
            if (id !== "dateFilter") await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement.id), id + "-control", "Tab follows the row's label/control order");
            const bounds = await page.locator("#" + id + "-control").boundingBox();
            assert.ok(bounds.x >= 15 && bounds.x + bounds.width <= 360, `${id}/${scale}: Tab brings the complete focused control into view (${JSON.stringify(bounds)})`);
        }
        if (!await page.locator("#moreFilters").evaluate(node => node.open)) await page.locator("#moreFilters > summary").click();
        const activity = page.locator("#layerFilter-control");
        await activity.tap();
        const popup = page.locator(".select-popup:visible"), box = await popup.boundingBox();
        assert.ok(box.x >= 8 && box.x + box.width <= 367);
        assert.equal(await popup.evaluate(node => node.parentElement.id), "analyzeFilterDialog", "Popup stays in the modal top layer, outside the scrolling row");
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
        assert.equal(await page.locator("#filters .ux-help").count(), 0);
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
