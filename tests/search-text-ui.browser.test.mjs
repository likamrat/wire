import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { chooseTheme, openSearchFilters, selectActivityOption } from "./helpers.mjs";

const proof = process.env.WIRE_TEXT_SEARCH_PROOFS;
async function setup(t, { touch = false, formatted = false } = {}) {
    const records = searchRecords(4);
    records[0].userPrompt.text = "Prepare the PowerPoint handoff and the quarterly release notes.";
    records[0].sourceSessionName = "Invented release planning";
    records[1].userPrompt.text = "Review the milestones and follow-up decisions.";
    records[1].sourceSessionName = 'PowerPoint briefing <img src=x onerror="window.unexpectedSearchMarkup=true">';
    records[1].sourceSessionId = "invented-powerpoint-chat";
    records[2].userPrompt.text = "POWERSHELL deployment notes for an invented service.";
    records[3].userPrompt.text = "Summarize the decisions for the next release.";
    records[3].sourceSessionId = records[1].sourceSessionId;
    records[3].sourceSessionName = records[1].sourceSessionName;
    if (formatted) {
        records[0].userPrompt.text = "Invented opening notes and documented release context.\n\n".repeat(12)
            + "Prepare the PowerPoint handoff and the quarterly release notes.\n\n"
            + "Invented closing notes retained in the complete frozen report.\n\n".repeat(12);
        records[2].userPrompt.text = "Deployment notes for an invented service.";
        for (const index of [1, 3]) {
            records[index].sourceSessionId = "invented-planning-chat";
            records[index].sourceSessionName = "Invented planning";
        }
    }
    const cleanup = [];
    const app = await searchFixture({ after: action => cleanup.push(action) }, { records, formats: ["html"], reply: false });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: touch ? 375 : 1440, height: 1000 }, hasTouch: touch, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ path: new URL(request.url()).pathname,
        query: request.url().endsWith("/api/search/query") ? request.postDataJSON().query : undefined,
        origin: new URL(request.url()).origin }));
    t.after(async () => {
        await browser.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(request => request.origin === new URL(app.runtime.url).origin));
        assert.equal(requests.filter(request => /\/api\/(?:evaluation|assessment\/feedback|export|collection\/now)/.test(request.path)
            && request.path !== "/api/evaluation/automatic/summary").length, 0);
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    if (proof) await mkdir(proof, { recursive: true });
    return { ...app, page, requests, records };
}

test("typing POWER shows actual categorized title/body/source matches without completing the query", { timeout: 30000 }, async t => {
    const { page, requests, records } = await setup(t);
    const input = page.locator("#wireSearch"), panel = page.locator("#wireSearchPanel");
    const before = await input.boundingBox(), origin = page.url();
    await input.fill("POW");
    await expect(page.locator(".wire-search-hit")).not.toHaveCount(0);
    await input.fill("POWER");
    await expect(page.locator(".wire-search-hit mark").first()).toHaveText(/^power$/i);
    await expect(input).toHaveValue("POWER");
    assert.deepEqual(await input.boundingBox(), before, "The capsule stays stationary");
    assert.equal(page.url(), origin, "Typing never opens a result");
    assert.ok(requests.some(request => request.query === "POW") && requests.some(request => request.query === "POWER"));
    const categories = await page.locator(".wire-search-kind").allTextContents();
    assert.ok(categories.includes("Report") && categories.includes("Interaction"));
    assert.ok(await page.locator(".wire-search-excerpt mark").count() > 0, "Body-only matches remain visible");
    assert.ok(await page.locator(".wire-search-source mark").count() > 0, "Source matches keep their original offsets");
    const sourceOnly = page.locator(".wire-search-hit")
        .filter({ has: page.locator(".wire-search-kind", { hasText: /^Interaction$/ }) })
        .filter({ has: page.locator(".wire-search-source mark") });
    await expect(sourceOnly).toHaveCount(2);
    assert.deepEqual((await sourceOnly.locator("strong").allTextContents()).sort(),
        [records[1].userPrompt.text, records[3].userPrompt.text].sort(), "Same-chat source-only matches keep distinct original prompt titles");
    assert.equal(await sourceOnly.locator(".wire-search-excerpt").count(), 0, "Source matches do not repeat source text as a body excerpt");
    assert.equal(await page.locator("#wireSearchResults img,#wireSearchResults script").count(), 0);
    assert.equal(await page.evaluate(() => window.unexpectedSearchMarkup === true), false, "Matched source text never becomes markup");
    assert.equal(await page.locator("#wireSearchRelated,datalist").count(), 0);
    assert.doesNotMatch(await page.locator("#wireSearchCoverage").textContent(), /model|meaning|word search only/i);
    assert.ok((await page.locator(".wire-search-hit").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))).every(height => height >= 44));
    if (proof) await page.screenshot({ path: path.join(proof, "typed-power-mixed.png") });
    const report = page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-kind", { hasText: /^Report$/ }) }).first();
    if (proof) {
        await report.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(proof, "typed-power-report-body.png") });
    }
    const titlePrefix = Array.from(await report.locator("strong").textContent()).slice(0, 5).join("").trim();
    await input.fill(titlePrefix.toUpperCase());
    await expect(report.locator("strong mark").first()).toHaveText(titlePrefix);
    await input.fill("<img");
    await expect(page.locator(".wire-search-source mark").first()).toHaveText("<img");
    assert.equal(await page.locator("#wireSearchResults img").count(), 0);
    assert.equal(await page.evaluate(() => window.unexpectedSearchMarkup === true), false);
    await input.fill("POWER");
    const interaction = page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-kind", { hasText: /^Interaction$/ }) }).first();
    await expect(interaction.locator("mark")).not.toHaveCount(0);
    await input.press("ArrowDown");
    await expect(page.locator(".wire-search-hit").first()).toBeFocused();
    await interaction.focus();
    await interaction.press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await expect(input).toHaveValue("POWER");
    await expect(interaction).toBeFocused();
    await openSearchFilters(page);
    await page.locator("#wireSearchClear").click();
    await expect(input).toHaveValue("");
    await expect(page.locator(".wire-search-hit")).toHaveCount(0);
    await expect(panel).toBeHidden();
});

test("formatted report body hits show compact marked context before opening unchanged frozen text", { timeout: 30000 }, async t => {
    const { page, bundles } = await setup(t, { touch: true, formatted: true });
    const file = bundles[0].files["product-report.html"], bytes = await readFile(file);
    for (const [width, scale, theme] of [[1440, 1, "light"], [375, 2, "dark"]]) {
        await page.setViewportSize({ width, height: 812 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await page.locator("#wireSearch").fill("POWER");
        await selectActivityOption(page, "wireSearchType", "report");
        if (await page.locator("#wireSearchOptions").evaluate(node => node.open)) await page.locator("#wireSearchFilterSummary").click();
        const row = page.locator(".wire-search-hit");
        await expect(row).toHaveCount(1);
        await expect(row.locator(".wire-search-kind")).toHaveText("Report");
        await expect(row.locator(".wire-search-source")).toHaveText("Approved frozen report");
        await expect(row.locator(".wire-search-excerpt mark")).toHaveText("Power");
        const snippet = await row.locator(".wire-search-excerpt").textContent();
        assert.doesNotMatch(snippet, /[\r\n\t]| {2,}/);
        assert.ok(Array.from(snippet).length <= 112, snippet);
        const geometry = await row.evaluate(node => {
            const rect = target => { const { top, bottom, height } = target.getBoundingClientRect(); return { top, bottom, height }; };
            const excerpt = node.querySelector(".wire-search-excerpt");
            return { row: rect(node), meta: rect(node.querySelector(".wire-search-meta")), snippet: rect(excerpt),
                mark: rect(excerpt.querySelector("mark")), panel: rect(document.querySelector("#wireSearchPanel")),
                clamp: getComputedStyle(excerpt).webkitLineClamp };
        });
        assert.ok(geometry.meta.bottom <= geometry.snippet.top + 1);
        assert.ok(geometry.row.height <= (scale === 1 ? 170 : 400), JSON.stringify(geometry));
        assert.ok(geometry.mark.top >= geometry.panel.top && geometry.mark.bottom <= geometry.panel.bottom, JSON.stringify(geometry));
        assert.equal(geometry.clamp, "none");
        if (proof) await page.screenshot({ path: path.join(proof, `compact-report-${width}-${scale}.png`) });
        await row.tap();
        await expect(page.frameLocator(".wire-search-document iframe").locator("body")).toContainText("Invented closing notes");
        await page.getByRole("button", { name: "Back to search", exact: true }).click();
        await expect(page.locator("#wireSearch")).toHaveValue("POWER");
        await expect(row).toBeFocused();
        assert.deepEqual(await readFile(file), bytes);
        await page.locator("#wireSearch").press("Escape");
    }
});

test("literal result rows retain visible marks and touch targets in both themes at doubled text", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { touch: true });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#wireSearch").fill("POWER");
        const row = page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-kind", { hasText: /^Interaction$/ }) }).first();
        await expect(row.locator("mark")).not.toHaveCount(0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const box = await row.boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44);
        if (proof) await page.screenshot({ path: path.join(proof, `touch-${theme}-375-200.png`) });
        await row.tap();
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.locator("#closeContextSidebar").tap();
        await expect(page.locator("#wireSearch")).toHaveValue("POWER");
        await page.locator("#wireSearch").press("Escape");
    }
});

test("late literal queries and opens cannot replace new typing or cleared results", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    await page.route("**/api/search/query", route => {
        if (route.request().postDataJSON().query !== "POW") return route.continue();
        const delivery = (async () => { arrived(); await held; await route.continue(); })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await page.locator("#wireSearch").fill("POW"); await pending;
        await page.locator("#wireSearch").fill("quarterly");
        await expect(page.locator(".wire-search-hit mark").first()).toHaveText("quarterly");
        const current = await page.locator("#wireSearchResults").innerText();
        const oldQuery = page.waitForResponse(response => response.url().endsWith("/api/search/query")
            && response.request().postDataJSON().query === "POW");
        release(); await Promise.all(deliveries); await (await oldQuery).finished();
        await expect(page.locator("#wireSearchResults")).toHaveText(current, { useInnerText: true });
        let releaseOpen, openArrived;
        const openHeld = new Promise(resolve => { releaseOpen = resolve; }), openPending = new Promise(resolve => { openArrived = resolve; });
        await page.route("**/api/search/open", async route => { openArrived(); await openHeld; await route.continue(); }, { times: 1 });
        try {
            const origin = page.url();
            await page.locator(".wire-search-hit").first().click(); await openPending;
            await page.locator("#wireSearch").fill("");
            const lateOpen = page.waitForResponse(response => response.url().endsWith("/api/search/open"));
            releaseOpen();
            await (await lateOpen).finished();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await expect(page.locator(".wire-search-hit")).toHaveCount(0);
            await expect(page.locator("#wireSearchPanel")).toBeHidden();
            await expect(page).toHaveURL(origin);
            assert.equal(await page.locator("#contextSidebar[open]").count(), 0);
        } finally { releaseOpen(); }
    } finally { release(); await Promise.all(deliveries); }
});

test("Search results and category controls stay operable above an open docked sidebar", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("#activityList .request-card-open").first().click();
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "docked");
    await page.locator("#wireSearch").fill("POWER");
    await selectActivityOption(page, "wireSearchType", "report");
    await expect(page.locator(".wire-search-kind")).toHaveText(["Report"]);
    const row = page.locator(".wire-search-hit");
    await row.scrollIntoViewIfNeeded();
    assert.equal(await row.evaluate(node => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), true, "The visible result receives pointer input rather than the sidebar behind it");
    await selectActivityOption(page, "wireSearchType", "interaction");
    await page.locator(".wire-search-hit").nth(1).click();
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
});

test("animated modal Close restores Search focus only after the sidebar releases its original page", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { touch: true });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#resultsLink").click();
    const before = await page.evaluate(() => scrollY);
    await page.locator("#wireSearch").fill("POWER");
    const row = page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-kind", { hasText: /^Interaction$/ }) }).first();
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-search-id");
    await row.tap();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.locator("#closeContextSidebar").tap();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator(`.wire-search-hit[data-search-id="${id}"]`)).toBeFocused();
    await expect(page.locator("#wireSearch")).toHaveValue("POWER");
    assert.equal(await page.evaluate(() => scrollY), before);
});

test("Back before a cross-layer snapshot completes cannot repaint the restored tool population", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const unit = await page.locator("#activityUnit").textContent();
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    await page.route("**/api/snapshot", route => {
        if (route.request().postDataJSON().layer !== "reported-api") return route.continue();
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await page.locator("#wireSearch").fill("reported-api");
        await page.locator(".wire-search-hit").first().click();
        await pending;
        await page.goBack();
        await expect(page).toHaveURL(/#analyze$/);
        release(); await Promise.all(deliveries);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#layerFilter")).toHaveValue("tool");
        await expect(page.locator("#activityUnit")).toHaveText(unit);
        assert.equal(await page.locator("#contextSidebar[open]").count(), 0);
    } finally { release(); await Promise.all(deliveries); }
});

test("zero matches from an incomplete authorized corpus are not an unqualified no-match result", { timeout: 30000 }, async t => {
    const { page, bundles } = await setup(t);
    await unlink(bundles[0].files["product-report.html"]);
    await page.locator("#wireSearch").fill("ZXQ_NO_CORPUS_MATCH_714");
    await expect(page.locator("#wireSearchPanel")).toHaveAttribute("data-search-state", /^(partial|incomplete|unavailable)$/);
    assert.equal(await page.locator(".wire-search-hit").count(), 0);
    await expect(page.locator("#wireSearchStatus")).toContainText(/incomplete|unavailable/);
    assert.doesNotMatch(await page.locator("#wireSearchStatus").textContent(), /^No matches/);
});
