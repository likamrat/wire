import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords, streamPanel } from "./live-search-fixture.mjs";
import { selectActivityOption } from "./helpers.mjs";

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

test("grouping the full population precedes paging and preserves keyboard Open/Back and analytical membership", { timeout: 30000 }, async t => {
    const { page, ranked } = await setup(t, 25);
    const input = page.locator("#wireSearch"), hits = page.locator(".wire-search-hit");
    await expect(page.locator("#activityCount")).toHaveText("26");
    await input.fill("Lumen");
    await expect(hits).toHaveCount(20);
    const first = await rows(page);
    assert.ok(first.every(hit => hit.type === "context"), "The first page contains the first 20 members of the complete context group.");
    await expect(page.locator(".wire-search-group-label")).toHaveText(["Conversation context"]);
    await expect(page.locator("#wireSearchCount")).toHaveText("26 matches");
    await expect(page.locator("#wireSearchPaging span").filter({ hasText: "Page" })).toHaveText("Page 1 of 2");
    await input.press("ArrowDown"); await expect(hits.first()).toBeFocused();
    await page.keyboard.press("End"); await expect(hits.last()).toBeFocused();
    await page.getByRole("button", { name: "Next results", exact: true }).click();
    await expect(hits).toHaveCount(6);
    const second = await rows(page);
    verifyPopulation([...first, ...second], ranked);
    await expect(page.locator(".wire-search-group-label")).toHaveText(["Conversation context", "Interactions"]);
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    const opened = second.at(-1).id;
    await hits.last().focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:search-1");
    assert.equal(new URL(page.url()).pathname, "/request");
    assert.doesNotMatch(page.url(), /search-1|Lumen/);
    await page.goBack();
    await expect(page.locator(`[data-search-id="${opened}"]`)).toBeFocused();
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    assert.deepEqual(await rows(page), second);
    await selectActivityOption(page, "wireSearchType", "context");
    await expect(hits).toHaveCount(20);
    await expect(page.locator("#wireSearchCount")).toHaveText("25 matches");
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 1 of 2");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#activityCount")).toHaveText("25");
    await expect(page.locator("#wireSearchType")).toBeDisabled();
    await expect(page.locator("#wireSearchCount")).toHaveText("26 matches");
    await page.locator("#wireSearchClear").click();
    await expect(hits).toHaveCount(0);
    await expect(page.locator("#activityCount")).toHaveText("26");
    await expect(input).toHaveValue("");
});
