import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { chooseTheme, openSearchFilters, selectActivityOption, navigateMain, revealAnalyzeRecords } from "./helpers.mjs";
import { replaceEvidence } from "../lib/store.mjs";

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
        records[0].userPrompt.text = "Review the release readiness checklist for the regional warehouse rollout, including inventory reconciliation, ownership changes and the staged support handoff.\n\n"
            + "Earlier planning notes cover baseline stock counts, shipping cutoffs and the unresolved weekend support rotation. Keep those conditions separate from the presentation request below.\n\n"
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
        assert.equal(requests.filter(request => /\/api\/(?:evaluation|assessment\/feedback|export|collection\/now)/.test(request.path)).length, 0);
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    if (proof) await mkdir(proof, { recursive: true });
    return { ...app, page, requests, records };
}

async function openInteraction(page, exactCall = false) {
    await page.locator("#activityList .request-card-open").first().click();
    if (!exactCall) return;
    const call = await page.locator('#requestContent [data-action-id]:not([data-action-id^="http:"])').first().getAttribute("data-action-id");
    await page.evaluate(call => { location.hash += "&call=" + encodeURIComponent(call); }, call);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-action-id", call);
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
    const categories = await page.locator(".wire-search-group-label").allTextContents();
    assert.ok(categories.includes("Reports") && categories.includes("Interactions"));
    assert.ok(await page.locator(".wire-search-excerpt mark").count() > 0, "Body-only matches remain visible");
    assert.ok(await page.locator(".wire-search-source mark").count() > 0, "Source matches keep their original offsets");
    const sourceOnly = page.locator(".wire-search-hit[data-search-type=interaction]")
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
    const report = page.locator(".wire-search-hit[data-search-type=report]").first();
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
    const interaction = page.locator(".wire-search-hit[data-search-type=interaction]").first();
    await expect(interaction.locator("mark")).not.toHaveCount(0);
    await input.press("ArrowDown");
    await expect(page.locator(".wire-search-hit").first()).toBeFocused();
    await interaction.focus();
    await interaction.press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    if (proof) await page.screenshot({ path: path.join(proof, "interaction-keyboard-open.png") });
    await page.locator("#closeContextSidebar").click();
    await expect(input).toHaveValue("POWER");
    await expect(interaction).toBeFocused();
    if (proof) await page.screenshot({ path: path.join(proof, "interaction-keyboard-return.png") });
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
        const row = page.locator(".wire-search-hit");
        await expect(row).toHaveCount(1);
        await expect(page.locator(".wire-search-group-label")).toHaveText("Reports");
        await expect(row.locator(".wire-search-source")).toHaveCount(0);
        await expect(row.locator(".wire-search-excerpt mark")).toHaveText("Power");
        const snippet = await row.locator(".wire-search-excerpt").textContent();
        assert.doesNotMatch(snippet, /[\r\n\t]| {2,}/);
        assert.ok(Array.from(snippet).length <= 112, snippet);
        const geometry = await row.evaluate(node => {
            const rect = target => { const { top, bottom, height } = target.getBoundingClientRect(); return { top, bottom, height }; };
            const excerpt = node.querySelector(".wire-search-excerpt");
            return { row: rect(node), heading: rect(node.querySelector(".wire-search-heading")), snippet: rect(excerpt),
                mark: rect(excerpt.querySelector("mark")), panel: rect(document.querySelector("#wireSearchPanel")),
                clamp: getComputedStyle(excerpt).webkitLineClamp };
        });

        assert.ok(geometry.heading.bottom <= geometry.snippet.top + 1);
        assert.ok(geometry.row.height <= (scale === 1 ? 170 : 400), JSON.stringify(geometry));
        assert.ok(geometry.mark.top >= geometry.panel.top && geometry.mark.bottom <= geometry.panel.bottom, JSON.stringify(geometry));
        assert.equal(geometry.clamp, "none");
        if (proof) await page.screenshot({ path: path.join(proof, `compact-report-${width}-${scale}.png`) });
        await row.tap();
        await expect(page.frameLocator("#savedReportReader iframe").locator("body")).toContainText("Invented closing notes");
        if (proof) await page.screenshot({ path: path.join(proof, `report-open-${width}-${scale}.png`) });
        await page.getByRole("button", { name: "Back to search", exact: true }).click();
        await expect(page.locator("#wireSearch")).toHaveValue("POWER");
        await expect(row).toBeFocused();
        if (proof) await page.screenshot({ path: path.join(proof, `report-return-${width}-${scale}.png`) });
        assert.deepEqual(await readFile(file), bytes);
        await page.locator("#wireSearch").press("Escape");
    }
});

test("body-match omission markers never form dot-only lines and Search results have no underlined chrome", { timeout: 30000 }, async t => {
    const { page, records } = await setup(t, { formatted: true });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#wireSearch").fill("POWER");
    const row = page.locator(".wire-search-hit");
    const orphaned = [];
    for (const theme of ["light", "dark"]) for (const type of ["report", "interaction"]) for (const [width, scale] of [[500, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.locator("#wireSearch").click();
        await selectActivityOption(page, "wireSearchType", type);
        await expect(row).toHaveCount(1);
        await expect(row.locator("mark")).toHaveText("Power");
        if (type === "interaction") await expect(row.locator(".wire-search-title")).toHaveText(records[0].userPrompt.text.slice(0, 120));
        const lines = await row.locator(".wire-search-excerpt").evaluate(node => {
            const lines = new Map(), walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let text;
            while ((text = walker.nextNode())) {
                let offset = 0;
                for (const char of text.data) {
                    const range = document.createRange();
                    range.setStart(text, offset); offset += char.length; range.setEnd(text, offset);
                    const rect = range.getBoundingClientRect(), key = Math.round(rect.y);
                    if (rect.width) lines.set(key, (lines.get(key) || "") + char);
                }
            }
            return [...lines.values()];
        });
        if (lines.some(line => /^[.\u2026\s]+$/u.test(line))) {
            orphaned.push({ theme, type, width, scale, lines });
            if (proof) await page.screenshot({ path: path.join(proof, `orphan-marker-${width}-${scale}.png`) });
        }
        await row.hover();
        assert.equal(await row.locator(".wire-search-title").evaluate(node => getComputedStyle(node).textDecorationLine), "none");
        assert.equal(await row.locator("mark").evaluate(node => getComputedStyle(node).textDecorationLine), "none");
        if (proof) await page.screenshot({ path: path.join(proof, `body-match-${type}-${theme}-${width}-${scale}-hover.png`) });
        await page.locator("#wireSearch").focus(); await page.keyboard.press("ArrowDown");
        await expect(row).toBeFocused(); await expect(row).toHaveCSS("outline-style", "solid");
        if (proof) await page.screenshot({ path: path.join(proof, `body-match-${type}-${theme}-${width}-${scale}-focus.png`) });
    }
    assert.deepEqual(orphaned, [], "Omission indicators must stay with readable context, never occupy their own row");
    const id = await row.getAttribute("data-search-id");
    await page.keyboard.press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await expect(page).toHaveURL(/#request\?request=search-0(?:&|$)/);
    await page.goBack();
    await expect(row).toBeFocused(); await expect(row).toHaveAttribute("data-search-id", id);
    await expect(row.locator("mark")).toHaveText("Power");
    await page.locator("#wireSearch").fill("no invented result contains this phrase");
    await expect(page.locator("#wireSearchStatus")).toHaveText("No matches. Try different words.");
    await page.locator("#wireSearchClear").click();
    await expect(page.locator("#wireSearch")).toBeFocused();
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
});

test("Search frozen reading retains its receipt fence without borrowing the independent library permission", { timeout: 30000 }, async t => {
    const { page, bundles, records, context, requests } = await setup(t, { formatted: true });
    const bytes = await readFile(bundles[0].files["product-report.html"]);
    await page.locator("#wireSearch").fill("POWER");
    await selectActivityOption(page, "wireSearchType", "report");
    const result = page.locator(".wire-search-hit");
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(page.frameLocator("#savedReportReader iframe").locator("body")).toContainText("Invented closing notes");
    assert.equal(requests.some(item => ["/api/report/open", "/api/artifact-file"].includes(item.path)), false);
    await replaceEvidence(context, () => ({ records: records.map((record, index) => index ? record : {
        ...record, userPrompt: { ...record.userPrompt, text: "Changed authorized source after the Search result was opened." },
    }) }));
    await expect(page.locator("#savedReportReader .error")).toContainText("Search destination is no longer current");
    assert.equal(await page.locator("#savedReportReader iframe,#savedReportReader .report-file-action").count(), 0);
    assert.equal(requests.some(item => ["/api/report/open", "/api/artifact-file"].includes(item.path)), false, "A stale Search receipt cannot fall back to library access");
    await page.getByRole("button", { name: "Back to search", exact: true }).click();
    await expect(page.locator("#savedReportReader")).toBeHidden();
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await navigateMain(page, "reports");
    await page.locator(`[data-bundle-id="${bundles[0].bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.frameLocator("#savedReportReader iframe").locator("body")).toContainText("Invented closing notes");
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.locator("#wireSearch").fill("POWER");
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(page.locator("#savedReportReader iframe")).toBeVisible();
    const reads = requests.filter(item => item.path === "/api/report/open").length;
    await page.reload();
    await expect(page.locator("#savedReportReader .error")).toContainText("Search destination is no longer current");
    await expect(page.locator("#savedReportReader iframe,#savedReportReader .report-file-action")).toHaveCount(0);
    assert.equal(requests.filter(item => item.path === "/api/report/open").length, reads, "Reload cannot upgrade Search into a library read");
    assert.deepEqual(await readFile(bundles[0].files["product-report.html"]), bytes);
});

test("literal result rows retain visible marks and touch targets in both themes at doubled text", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { touch: true });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#wireSearch").fill("POWER");
        const row = page.locator(".wire-search-hit[data-search-type=interaction]").first();
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
            await page.locator("#wireSearchClear").click();
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
    await expect(page.locator(".wire-search-group-label")).toHaveText(["Reports"]);
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

test("saved Search departures keep exact authority without recreating retired feedback controls", { timeout: 30000 }, async t => {
    for (const exactCall of [false, true]) await t.test(exactCall ? "exact call" : "ordinary interaction", async t => {
        const { page, requests } = await setup(t);
        await openInteraction(page, exactCall);
        await expect(page.locator("#requestContent [data-reader-section=reviews],#requestContent .assessment-feedback-dialog")).toHaveCount(0);
        assert.doesNotMatch(await page.locator("#requestContent").innerText(), /Automatic scores|Personal feedback|Your feedback/);
        await page.locator("#wireSearch").fill("POWER");
        await selectActivityOption(page, "wireSearchType", "report");
        const result = page.locator(".wire-search-hit");
        await expect(result).toHaveCount(1);
        await result.click();
        await expect(page.frameLocator("#savedReportReader iframe").locator("body")).toContainText("PowerPoint");
        await expect(page.locator("#contextSidebar")).toBeHidden();
        await expect(page.getByRole("button", { name: "Keep editing", exact: true })).toHaveCount(0);
        if (proof) await page.screenshot({ path: path.join(proof, `saved-search-retired-feedback-${exactCall ? "call" : "interaction"}.png`) });
        assert.equal(requests.some(item => ["/api/report/open", "/api/artifact-file"].includes(item.path)), false,
            "The admitted Search payload never borrows library authority");
    });
});

test("changing Search during a pending saved departure keeps the exact current reader", { timeout: 15000 }, async t => {
    const { page, requests } = await setup(t);
    await openInteraction(page, true);
    const origin = page.url(), call = await page.locator("#selectedCall").getAttribute("data-action-id");
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    await page.route("**/api/search/open", async route => { entered.resolve(); await gate.promise; await route.continue(); }, { times: 1 });
    try {
        await page.locator("#wireSearch").fill("POWER");
        await selectActivityOption(page, "wireSearchType", "report");
        await page.locator(".wire-search-hit").click(); await entered.promise;
        await page.locator("#wireSearch").fill("NO_CURRENT_REPORT_MATCH");
        await expect(page.locator(".wire-search-hit")).toHaveCount(0);
        const late = page.waitForResponse(response => response.url().endsWith("/api/search/open"));
        gate.resolve(); await (await late).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(page.url(), origin);
        await expect(page.locator("#selectedCall")).toHaveAttribute("data-action-id", call);
        await expect(page.locator("#savedReportReader")).toBeHidden();
        assert.equal(requests.some(item => ["/api/report/open", "/api/artifact-file"].includes(item.path)), false);
    } finally { gate.resolve(); }
});

test("saved Search Back restores its exact interaction origin with native history and without the Navigation API", { timeout: 30000 }, async t => {
    for (const native of [true, false]) await t.test(native ? "native Back" : "fallback Back", async t => {
        const { page, requests } = await setup(t);
        await openInteraction(page, true);
        const origin = page.url(), call = await page.locator("#selectedCall").getAttribute("data-action-id");
        await page.locator("#wireSearch").fill("POWER");
        await selectActivityOption(page, "wireSearchType", "report");
        const result = page.locator(".wire-search-hit");
        await expect(result).toHaveCount(1);
        const resultId = await result.getAttribute("data-search-id");
        await result.click();
        await expect(page.locator("#savedReportReader iframe")).toBeVisible();
        if (native) await page.goBack();
        else {
            await page.evaluate(() => Object.defineProperty(window, "navigation", { configurable: true, value: undefined }));
            await page.getByRole("button", { name: "Back to search", exact: true }).click();
        }
        await expect(page).toHaveURL(/#request\?/);
        assert.deepEqual([...new URLSearchParams(new URL(page.url()).hash.split("?")[1])].sort(),
            [...new URLSearchParams(new URL(origin).hash.split("?")[1])].sort(), "Exact interaction and call route values survive Back");
        await expect(page.locator("#selectedCall")).toHaveAttribute("data-action-id", call);
        await expect(page.locator("#savedReportReader")).toBeHidden();
        await expect(page.locator("#wireSearch")).toHaveValue("POWER");
        await expect(page.locator("#wireSearchType")).toHaveValue("report");
        await expect(page.locator(`.wire-search-hit[data-search-id="${resultId}"]`)).toBeFocused();
        assert.equal(await page.locator("#contextSidebar").evaluate(node => node.inert), false);
        if (proof) await page.screenshot({ path: path.join(proof, `saved-search-origin-${native ? "native" : "fallback"}.png`) });
        assert.equal(requests.some(item => ["/api/report/open", "/api/artifact-file"].includes(item.path)), false);
        await page.locator("#wireSearch").press("Escape");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        await expect(page).toHaveURL(/#analyze(?:\?|$)/);
    });
});

test("animated modal Close restores Search focus only after the sidebar releases its original page", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { touch: true });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await revealAnalyzeRecords(page);
    const before = await page.evaluate(() => scrollY);
    await page.locator("#wireSearch").fill("POWER");
    const row = page.locator(".wire-search-hit[data-search-type=interaction]").first();
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
