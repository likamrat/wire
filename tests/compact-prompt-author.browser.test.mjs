import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, navigateMain, revealAnalyzeRecords } from "./helpers.mjs";

const proof = process.env.WIRE_COMPACT_AUTHOR_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const card = (page, id) => page.locator(`.request-row[data-view-key="request:author-${id}"]`);
const picker = (page, id) => page.locator(`[data-view-key="report:author-${id}"]`);
const cases = [
    ["mine", "user", "source-user", "Find the invented Cedar review notes."],
    ["agent", "agent", "source-agent", "Summarize the invented Cedar handover."],
    ["unknown", "unknown", "missing-source", "An invented message with no sender evidence."],
    ["conflict", "unknown", "conflicting-source", "An invented message with conflicting sender evidence."],
    ["legacy", "unknown", undefined, "My prompt from agent-helper: these words are not author evidence."],
    ["missing", "unknown", "missing-source", null],
    ["partial", "user", "source-user", "Only this invented fragment was retained."],
    ["long", "user", "source-user", "Check the invented review notes. " + "Keep the original spaces and punctuation. ".repeat(40) + "\n  End.  "],
];
function records() {
    return cases.map(([id, actor, basis, text], index) => {
        const record = fixture("author-" + id);
        record.sourceSessionId = `invented-author-chat-${id}`;
        record.sourceSessionName = "Invented user.message agent-helper source name";
        record.followUpPrompts = [];
        record.userPrompt = { text, status: text === null ? "unavailable" : id === "partial" ? "partial" : "full",
            sourceEventId: `invented-author-event-${id}`, sourceTimestamp: new Date(Date.UTC(2026, 8, 30, 12, index)).toISOString(),
            ...(basis ? { authorship: { actor, basis } } : {}) };
        record.toolCalls[0].startedAt = record.userPrompt.sourceTimestamp;
        return record;
    });
}
async function setup(t) {
    const cleanup = [], evidence = records();
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, evidence);
    const before = await loadBoardState(context);
    let forbiddenProviders = 0;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { forbiddenProviders++; throw Error("No provider work in author presentation proof."); },
            readSource: async () => { forbiddenProviders++; throw Error("No source recovery in author presentation proof."); } } });
    const browser = await chromium.launch(), browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
    const page = await browserContext.newPage(), denied = [], errors = [];
    page.setDefaultTimeout(6000);
    const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
    await browserContext.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(request.method() + " " + url.pathname); return route.abort();
        }
        return route.continue();
    });
    browserContext.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    page.on("pageerror", error => errors.push(error.message));
    await browserContext.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Real clipboard reads forbidden."); },
        async writeText(text) { window.authorCopy = text; },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(denied, []); assert.deepEqual(errors, []); assert.equal(forbiddenProviders, 0);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url); await ready(page); await page.evaluate(() => document.fonts.ready);
    return { page, browserContext, evidence };
}
async function capture(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.mouse.move(1, 1);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.screenshot({ path: path.join(proof, name + ".png") });
}

test("compact cards name the prompt author without inferring from text or replacing the native full-card link", { timeout: 45000 }, async t => {
    const { page, browserContext } = await setup(t);
    await revealAnalyzeRecords(page);
    for (const [id, actor] of cases) {
        const row = card(page, id), label = actor === "user" ? "Human prompt" : actor === "agent" ? "Agent prompt" : "Author unverified";
        await expect(row.locator(".request-card-author")).toHaveText(label);
        await expect(row.locator(".request-card-author")).toHaveAttribute("data-prompt-actor", actor);
        await expect(row.locator(".request-card-open")).toHaveCount(1);
        await expect(row.locator(".request-card-open")).toHaveAttribute("href", /\/request\?.*record=interaction-bookmark-/);
    }
    await expect(card(page, "missing").locator(".request-card-open")).toContainText("Prompt text unavailable");
    const link = card(page, "mine").locator(".request-card-open");
    await link.locator(".card-excerpt").evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    const selected = await page.evaluate(() => getSelection().toString());
    await link.dispatchEvent("click", { button: 0 });
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.equal(await page.evaluate(() => getSelection().toString()), selected);
    await page.evaluate(() => getSelection().removeAllRanges());
    const opened = browserContext.waitForEvent("page");
    await link.click({ modifiers: ["Control"] });
    const popup = await opened;
    await expect(popup.locator(".request-original").getByRole("region", { name: "Human prompt", exact: true })).toBeVisible();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await popup.close();
    await link.focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".request-original").getByRole("region", { name: "Human prompt", exact: true })).toBeVisible();
    await page.goBack(); await ready(page);
    await expect(link).toBeFocused();
    for (const actors of [["user"], ["agent"], ["unknown"], ["user", "agent"], ["user", "unknown"], ["agent", "unknown"], "all"]) {
        await selectActivityOption(page, "promptAuthorFilter", actors); await ready(page);
        assert.deepEqual((await page.locator(".request-card-author").evaluateAll(nodes => nodes.map(node => node.dataset.promptActor))).sort(),
            cases.filter(([, actor]) => actors === "all" || actors.includes(actor)).map(([, actor]) => actor).sort());
    }
    assert.deepEqual(await page.locator("#promptAuthorFilter option").allTextContents(), ["Human prompts", "Agent prompts", "Author unverified"]);
    await page.locator('[data-select-id="promptAuthorFilter"]').click();
    await expect(page.locator('.select-popup:visible [data-value="user"]')).toContainText("Human prompts");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator('label[for="promptAuthorFilter-control"]')).toHaveText("Prompt author");
    await expect(page.getByRole("button", { name: "About Prompt author", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Your prompt");
});

test("the report picker and its reader keep the selected interactions' author and text availability", async t => {
    const { page } = await setup(t);
    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 375, height: 960 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await navigateMain(page, "reports");
    await page.locator("#reportDeskActivity").click();
    const dialog = page.getByRole("dialog", { name: "Choose activity" });
    await dialog.getByRole("radio", { name: /^Selected interactions/ }).check();
    for (const [id, actor, , text] of cases) {
        const entry = picker(page, id);
        if (!await entry.count()) {
            const next = dialog.getByRole("button", { name: "Next report requests", exact: true });
            await (await next.isEnabled() ? next : dialog.getByRole("button", { name: "Previous report requests", exact: true })).click();
        }
        await entry.getByRole("checkbox").check();
        const name = { user: "Human prompt", agent: "Agent prompt", unknown: "Author unverified" }[actor];
        await expect(entry.locator(".request-card-author")).toHaveText(name);
        await expect(entry.locator(".request-card-author")).toHaveAttribute("data-prompt-actor", actor);
        await entry.locator(".request-card-open").press("Enter");
        await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:author-" + id);
        const section = page.locator('[data-reader-section="prompt"]');
        await expect(section.getByRole("heading")).toContainText(name);
        if (id === "partial") await expect(section).toContainText("Partial text");
        if (!text) {
            await expect(section).toContainText("Prompt text unavailable");
            await expect(section.getByRole("button", { name: "Copy prompt" })).toHaveCount(0);
        } else {
            assert.equal(await section.locator("pre").textContent(), text);
            await section.getByRole("button", { name: "Copy prompt", exact: true }).click();
            assert.equal(await page.evaluate(() => window.authorCopy), text);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (id === "conflict") await capture(page, "enlarged-unverified-report-reader");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        if (!await dialog.isVisible()) await page.locator("#reportDeskActivity").click();
        await expect(entry.getByRole("checkbox")).toBeChecked();
    }
    await expect(dialog.getByRole("radio", { name: /^Selected interactions/ })).toHaveAccessibleName(/8 interactions/);
});
