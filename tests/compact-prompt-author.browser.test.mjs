import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, navigateMain } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

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
    await page.locator("#resultsLink").click();
    for (const [id, actor] of cases) {
        const row = card(page, id), label = actor === "user" ? "My prompt" : actor === "agent" ? "Agent prompt" : "Author unverified";
        await expect(row.locator(".request-card-author")).toHaveText(label);
        await expect(row.locator(".request-card-author")).toHaveAttribute("data-prompt-actor", actor);
        await expect(row.locator("a,button,input")).toHaveCount(1);
        await expect(row.locator(".request-card-open")).toHaveAttribute("href", /#request\?/);
    }
    await expect(card(page, "missing").locator(".request-card-open")).toContainText("Prompt text unavailable");
    const link = card(page, "mine").locator(".request-card-open");
    await link.locator(".request-card-prompt").evaluate(node => {
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
    await expect(popup.locator(".request-original h2")).toHaveText("My prompt");
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await popup.close();
    await link.focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".request-original h2")).toHaveText("My prompt");
    await page.goBack(); await ready(page);
    await expect(link).toBeFocused();
    for (const actors of [["user"], ["agent"], ["unknown"], ["user", "agent"], ["user", "unknown"], ["agent", "unknown"], "all"]) {
        await selectActivityOption(page, "promptAuthorFilter", actors); await ready(page);
        assert.deepEqual((await page.locator(".request-card-author").evaluateAll(nodes => nodes.map(node => node.dataset.promptActor))).sort(),
            cases.filter(([, actor]) => actors === "all" || actors.includes(actor)).map(([, actor]) => actor).sort());
    }
    assert.deepEqual(await page.locator("#promptAuthorFilter option").allTextContents(), ["My prompts", "Agent prompts", "Author unverified"]);
    await page.locator('[data-select-id="promptAuthorFilter"]').click();
    await expect(page.locator('.select-popup:visible [data-value="user"]')).toContainText("My prompts");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator('label[for="promptAuthorFilter-control"]')).toHaveText("Prompt author");
    await expect(page.getByRole("button", { name: "About Prompt author", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Your prompt");
});

test("My, Agent and unverified origins agree across compact card, sidebar, report picker and peek at both themes and enlarged widths",
    { timeout: 180000 }, async t => {
        const { page, evidence } = await setup(t), measurements = [];
        for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [1440, 2], [375, 1], [375, 2]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
            await chooseTheme(page, theme);
            await navigateMain(page, "analyze"); await ready(page);
            await page.locator("#resultsLink").click();
            const cues = await page.locator(".request-card-author").evaluateAll(nodes => nodes.map(node => {
                const css = getComputedStyle(node), prompt = node.closest(".request-card-prompt"), promptCSS = getComputedStyle(prompt);
                const rects = [...node.getClientRects()].map(rect => ({ left: rect.left, right: rect.right }));
                let parent = node, background;
                while (parent && (!background || background === "rgba(0, 0, 0, 0)")) {
                    background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement;
                }
                return { actor: node.dataset.promptActor, text: node.textContent, color: css.color, background,
                    fontWeight: css.fontWeight, fontSize: css.fontSize, fontStyle: css.fontStyle,
                    promptWeight: promptCSS.fontWeight, promptColor: promptCSS.color, ink: getComputedStyle(document.body).color,
                    display: css.display, margin: css.margin, padding: css.padding, rects };
            }));
            assert.equal(cues.length, cases.length);
            for (const cue of cues) {
                assert.ok(contrast(cue.color, cue.background) >= 4.5, `${theme}/${width}/${scale}: author contrast`);
                assert.equal(cue.fontWeight, "400"); assert.equal(cue.promptWeight, "400");
                assert.equal(cue.fontStyle, "normal"); assert.equal(cue.promptColor, cue.ink);
                assert.equal(cue.display, "inline"); assert.equal(cue.margin, "0px"); assert.equal(cue.padding, "0px");
                assert.ok(cue.rects.every(rect => rect.left >= 0 && rect.right <= width + 1), "The entire label fits without clipping");
            }
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await capture(page, `${theme}-${width}-${scale}-cards`);
            if (proof) for (const id of ["mine", "agent", "conflict"]) {
                await card(page, id).screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-${id}-card.png`) });
            }
            for (const [id, actor] of cases) {
                const record = evidence.find(record => record.scenarioId === "author-" + id);
                const expected = actor === "user" ? "My prompt" : actor === "agent" ? "Agent prompt" : "Copilot chat prompt";
                await card(page, id).locator(".request-card-open").click();
                const reader = page.locator(".request-original");
                await expect(reader.locator("h2")).toHaveText(expected);
                await expect(reader.locator("h2")).toHaveAttribute("data-prompt-actor", actor);
                if (actor === "unknown") await expect(reader.locator(".reader-state").first()).toBeVisible();
                if (id === "partial") await expect(reader.locator(".reader-state-partial")).toHaveText("Partial text");
                if (id === "missing") await expect(reader.getByRole("button", { name: "Copy prompt", exact: true })).toHaveCount(0);
                else {
                    if (await reader.locator(".full-text-toggle").getAttribute("aria-expanded") === "false") await reader.locator(".full-text-toggle").click();
                    assert.equal(await reader.locator("pre").textContent(), record.userPrompt.text);
                    if (scale === 1 && width === 1440) {
                        await reader.getByRole("button", { name: "Copy prompt", exact: true }).click();
                        assert.equal(await page.evaluate(() => window.authorCopy), record.userPrompt.text);
                        await reader.locator(".full-text-toggle").click();
                        await expect(reader.locator("pre")).toHaveCount(0);
                        await reader.locator(".full-text-toggle").click();
                    }
                }
                const technical = page.locator(".request-support details");
                await technical.locator("summary").click();
                await expect(technical).toContainText(promptAuthorship.reason(record.userPrompt));
                if (actor === "user") await expect(technical).toContainText("My prompt.");
                await expect(page.locator("#requestContent")).not.toContainText("Your prompt");
                if (["mine", "agent", "conflict"].includes(id)) {
                    await reader.locator("h2").scrollIntoViewIfNeeded();
                    await capture(page, `${theme}-${width}-${scale}-${id}-sidebar`);
                }
                if (await page.locator("#requestReportToggle").textContent() === "Add to report") await page.locator("#requestReportToggle").click();
                await page.locator("#requestReportContinue").click();
                const entry = picker(page, id);
                if (!await entry.count()) await page.locator("#reportRequestSearch").fill(record.userPrompt.text?.slice(0, 25) ?? "");
                // The report picker is paginated independently from Analyze.
                while (!await entry.count()) await page.getByRole("button", { name: "Next report requests", exact: true }).click();
                await expect(entry.locator("input")).toBeChecked();
                await expect(entry.locator(".full-text-preview-label")).toContainText(expected);
                await expect(entry.locator(".full-text-preview-label")).toHaveAttribute("data-prompt-actor", actor);
                assert.deepEqual(await page.locator("#reportPromptAuthorFilter option").allTextContents(), ["My prompts", "Agent prompts", "Author unverified"]);
                if (["mine", "agent", "conflict"].includes(id)) {
                    await entry.scrollIntoViewIfNeeded();
                    await capture(page, `${theme}-${width}-${scale}-${id}-picker`);
                }
                await entry.locator(".request-link").click();
                await expect(page.locator(".request-original h2")).toHaveText(expected);
                await expect(page.locator(".request-original h2")).toHaveAttribute("data-prompt-actor", actor);
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
                if (["mine", "agent", "conflict"].includes(id)) {
                    await page.locator(".request-original h2").scrollIntoViewIfNeeded();
                    await capture(page, `${theme}-${width}-${scale}-${id}-peek`);
                }
                await page.getByRole("button", { name: "Back to activity", exact: true }).click();
                await expect(entry.locator("input")).toBeChecked();
                await page.locator("#reportRequestSearch").fill("");
                await navigateMain(page, "analyze"); await ready(page);
            }
            measurements.push({ theme, width, scale, cues, variants: cases.map(([id]) => id) });
        }
        if (proof) await writeFile(path.join(proof, "measurements.json"), JSON.stringify(measurements, null, 2));
    });
