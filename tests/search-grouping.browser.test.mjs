import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords, streamPanel } from "./live-search-fixture.mjs";
import { chooseTheme, selectActivityOption } from "./helpers.mjs";

async function setup(t, contextCount) {
    const cleanup = [], records = searchRecords(contextCount + 1), errors = [];
    let browser;
    t.after(async () => {
        await browser?.close();
        for (const close of cleanup) await close();
        assert.deepEqual(errors, []);
    });
    for (const [index, record] of records.entries()) {
        // Place the match beyond the retained title slice without cutting a sentence.
        const contextTitle = `Note ${index}: Review the release schedule, ownership, and remaining checks before preparing the handoff.`.padEnd(121, " ");
        record.sourceSessionId = `grouping-chat-${index}`;
        record.sourceSessionName = `Release review ${index}`;
        record.userPrompt.text = index === 1 ? "Lumen" : `Review the delivery schedule for item ${index}.`;
        record.followUpPrompts = [{
            text: index === 0 ? "Lumen" : index < contextCount
                ? `${contextTitle}\nLumen follow-up ${index}.`
                : "Keep the final handoff notes.",
            status: "full", provenance: "human-authored",
        }];
    }
    const app = await searchFixture({ after: close => cleanup.push(close) }, { records });
    const reference = await streamPanel(app.runtime);
    let ranked;
    try {
        await reference.api("/api/search/query", { query: "Lumen", requestId: 1 });
        ranked = (await reference.wait(event => event.event === "results" && event.requestId === 1)).matches.hits;
    } finally { await reference.close(); }
    assert.equal(ranked.length, contextCount + 1);
    assert.deepEqual(ranked.slice(0, 2).map(hit => hit.type), ["context", "interaction"]);
    assert.ok(ranked.slice(2).every(hit => hit.type === "context"), "The real server population crosses ranking tiers and reproduces the split.");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        assert.equal(new URL(route.request().url()).origin, new URL(app.runtime.url).origin);
        return route.continue();
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    return { ...app, page, ranked };
}

async function rows(page) {
    return page.locator(".wire-search-hit").evaluateAll(nodes => nodes.map(node => ({
        id: node.dataset.searchId, type: node.dataset.searchType, mark: node.querySelector("mark").textContent,
    })));
}

function verifyPopulation(shown, ranked) {
    assert.deepEqual(shown.map(hit => hit.id).sort(), ranked.map(hit => hit.id).sort());
    const categories = [...new Set(ranked.map(hit => hit.type))];
    const runs = shown.filter((hit, index) => !index || shown[index - 1].type !== hit.type).map(hit => hit.type);
    assert.deepEqual(runs, categories, "Each category occupies one continuous run, ordered by its first ranked match.");
    for (const type of categories) {
        assert.deepEqual(shown.filter(hit => hit.type === type).map(hit => hit.id),
            ranked.filter(hit => hit.type === type).map(hit => hit.id), "Ranking within each category stays intact.");
    }
    for (const hit of shown) {
        const original = ranked.find(item => item.id === hit.id), range = original.textMatch;
        assert.equal(hit.mark, original.excerpt.slice(range.start - range.excerptStart, range.end - range.excerptStart));
    }
}

test("Conversation context is one group instead of being split by a different match type", { timeout: 20000 }, async t => {
    const { page, ranked } = await setup(t, 3);
    const input = page.locator("#wireSearch"), headings = page.locator(".wire-search-group-label");
    for (const [theme, width, scale] of [["light", 1280, 1], ["dark", 1280, 1], ["light", 375, 2], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await input.fill("Lumen");
        await expect(page.locator(".wire-search-hit")).toHaveCount(4);
        await expect(headings).toHaveText(["Conversation context", "Interactions"]);
        verifyPopulation(await rows(page), ranked);
        await expect(page.locator("#wireSearchCount")).toHaveText("4 matches");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (process.env.WIRE_SEARCH_GROUP_PROOFS) {
            await mkdir(process.env.WIRE_SEARCH_GROUP_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_SEARCH_GROUP_PROOFS, `grouped-${theme}-${width}-${scale}.png`) });
        }
    }
});

test("grouping the full population precedes paging and preserves keyboard Open/Back and analytical membership", { timeout: 30000 }, async t => {
    const { page, ranked } = await setup(t, 25);
    const input = page.locator("#wireSearch"), hits = page.locator(".wire-search-hit");
    await expect(page.locator("#activityCount")).toHaveText("26");
    await input.fill("Lumen");
    await expect(hits).toHaveCount(20);
    const first = await rows(page);
    assert.ok(first.every(hit => hit.type === "context"), "The first page contains the first 20 members of the complete context group.");
    await expect(page.locator(".wire-search-group-label")).toHaveText(["Conversation context"]);
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 1 of 2; 26 total");
    await input.press("ArrowDown"); await expect(hits.first()).toBeFocused();
    await page.keyboard.press("End"); await expect(hits.last()).toBeFocused();
    await page.getByRole("button", { name: "Next results", exact: true }).click();
    await expect(hits).toHaveCount(6);
    const second = await rows(page);
    verifyPopulation([...first, ...second], ranked);
    await expect(page.locator(".wire-search-group-label")).toHaveText(["Conversation context", "Interactions"]);
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2; 26 total");
    const opened = second.at(-1).id;
    await page.evaluate(() => {
        window.groupedReturnEvents = [];
        const panel = document.querySelector("#contextSidebar"), popup = document.querySelector(".select-popup");
        const record = (kind, event) => window.groupedReturnEvents.push({
            kind, trusted: event.isTrusted, at: performance.now(), route: location.hash,
            panelOpen: panel.open, moving: panel.getAnimations().length > 0,
            popupOpen: !popup.hidden, focus: document.activeElement?.id,
        });
        document.querySelector("#wireSearchType-control").addEventListener("click", event => record("type", event));
        panel.addEventListener("close", event => record("sidebar-close", event));
    });
    await hits.last().focus(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/request=search-1(?:&|$)/);
    await page.goBack();
    await expect(page.locator(`[data-search-id="${opened}"]`)).toBeFocused();
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2; 26 total");
    assert.deepEqual(await rows(page), second);
    await selectActivityOption(page, "wireSearchType", "context");
    await expect(hits).toHaveCount(20);
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 1 of 2; 25 total");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#activityCount")).toHaveText("25");
    await expect(page.locator("#wireSearchType")).toBeDisabled();
    await expect(page.locator("#wireSearchCount")).toHaveText("26 matches");
    const returnEvents = await page.evaluate(() => window.groupedReturnEvents);
    t.diagnostic(JSON.stringify({ returnedSearch: returnEvents }));
    if (process.env.WIRE_SEARCH_GROUP_PROOFS) {
        await mkdir(process.env.WIRE_SEARCH_GROUP_PROOFS, { recursive: true });
        await writeFile(path.join(process.env.WIRE_SEARCH_GROUP_PROOFS, "grouped-return-events.json"), JSON.stringify(returnEvents, null, 2));
    }
    await page.locator("#wireSearchClear").click();
    await expect(hits).toHaveCount(0);
    await expect(page.locator("#activityCount")).toHaveText("26");
    await expect(input).toHaveValue("");
});
