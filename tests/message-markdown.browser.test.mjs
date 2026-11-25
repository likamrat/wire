import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme, revealAnalyzeRecords } from "./helpers.mjs";
import { contract, retainedResponse } from "./assessment-ui-fixtures.mjs";

// Invented reply with the shape harnesses produce: prose, bold, a two-column table with
// labeled links, literal/escaped characters, code, a task list and untrusted HTML.
const reply = [
    "I found **one invented meeting link** and **two places** to check. I couldn\u2019t verify a recording.",
    "",
    "| Bridge | Where to look |",
    "|---|---|",
    "| **Invented review bridge** | [Invented meeting link](https://example.invalid/meet/one?p=abc) \u00b7 [Chat message](https://example.invalid/chat/" + "segment".repeat(12) + "). Start with **Recap**. |",
    "| **Invented planning bridge** | The [invented record](https://example.invalid/record/42) points to a channel under **Meet Now**. |",
    "",
    "Literal \\*asterisks\\* and a\\|pipe stay literal; `**not bold**` is code. See https://example.invalid/" + "unbrokenpath".repeat(10),
    "",
    "```text",
    "status: **unchanged** | raw",
    "```",
    "",
    "- [x] Checked step",
    "- Plain step",
    "",
    "<img src=x onerror=\"window.markdownExecuted=1\"><script>window.markdownExecuted=2</script>",
    "[unsafe](javascript:window.markdownExecuted=3) ![remote pixel](https://example.invalid/pixel.png)",
    "",
    "The search timed out, so **part of the lookup** is incomplete.",
].join("\n");

async function setup(t, text, promptText = "Find the invented meeting links.", frontend) {
    const cleanups = [];
    const record = fixture("message-markdown");
    record.userPrompt = { text: promptText, status: "full", sourceEventId: "invented-markdown-prompt",
        sourceTimestamp: "2026-09-30T12:00:00.000Z", authorship: { actor: "user", basis: "source-user" } };
    const { context } = await privateFixture({ after: action => cleanups.push(action) }, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, ...(frontend ? { frontend } : {}) });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.setDefaultTimeout(6000);
    page.on("pageerror", error => errors.push(error.stack));
    page.on("request", request => requests.push(new URL(request.url()).origin));
    await page.addInitScript(() => {
        window.readerCopies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            async writeText(value) { window.readerCopies.push(value); },
        } });
    });
    const view = retainedResponse(text, record);
    contract.validateInteractionView(view);
    const envelope = data => ({ schemaVersion: 1, basis: view.basis, data });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), value = await response.json();
        value.assessment = { schemaVersion: 1, basis: view.basis,
            catalog: [{ scenarioId: record.scenarioId, interactionRef: view.interaction.interactionRef,
                interactionRefs: [view.interaction.interactionRef], status: "retained", reason: null }],
            overview: { interactionRefs: [view.interaction.interactionRef], metrics: view.metrics },
            consent: view.consent, source: { available: true, sourceConfigRef: view.consent.sourceConfigRef ?? null, sourceConfigRevision: 1 },
            capabilities: { answer: true, usage: false, explicitAuthorization: false } };
        await route.fulfill({ response, json: value });
    });
    await page.route("**/api/assessment/detail", route => route.fulfill({ json: envelope(view) }));
    await page.route("**/api/collection/status", async route => {
        const response = await route.fetch(), value = await response.json();
        value.assessment = { ...value.assessment, basis: view.basis };
        await route.fulfill({ response, json: value });
    });
    await page.route("**/api/assessment/overview", route => route.fulfill({ json: envelope({ interactionRefs: [view.interaction.interactionRef], metrics: view.metrics }) }));
    await page.route("**/api/assessment/evidence", route => {
        const input = route.request().postDataJSON();
        return route.fulfill({ json: envelope({ observationRef: input.observationRef, text, completeness: "full-record", finality: "unverified", basis: view.basis }) });
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []);
            assert.ok(requests.every(origin => origin === new URL(runtime.url).origin), "Formatting makes no external requests");
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    return page;
}

async function proof(page, name) {
    const directory = process.env.WIRE_MESSAGE_PROOFS;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.locator('[data-reader-section="response"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, name + ".png") });
}

for (const frontend of [undefined, "bundled"]) test(`Copilot reply Markdown reads as formatted, inert prose while Copy keeps the original (${frontend ?? "standalone"})`, { timeout: 40000 }, async t => {
    const page = await setup(t, reply, undefined, frontend);
    const response = page.locator('[data-reader-section="response"]');
    const body = response.locator(".full-text-content");
    await expect(body).toHaveAttribute("data-message-format", "markdown");
    await expect(response).toContainText("Final-answer status unverified");
    const prose = await body.evaluate(node => {
        const copy = node.cloneNode(true);
        copy.querySelectorAll("code").forEach(code => code.remove());
        return copy.textContent;
    });
    assert.doesNotMatch(prose, /\*\*|\|---|\]\(https?:/u, "Markdown syntax is not painted as prose");
    assert.match(prose, /Literal \*asterisks\* and a\|pipe stay literal/u, "Escaped characters stay literal");
    await expect(body.locator("strong").first()).toHaveText("one invented meeting link");

    const table = body.getByRole("region", { name: "Table" });
    await expect(table.locator("th")).toHaveText(["Bridge", "Where to look"]);
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(table.locator("tbody tr").first().locator("td strong")).toHaveText(["Invented review bridge", "Recap"]);

    const links = body.locator("a[href]");
    await expect(links).toHaveText(["Invented meeting link", "Chat message", "invented record", "example.invalid/\u2026"]);
    for (const link of await links.all()) {
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(link).toHaveAttribute("rel", "noopener noreferrer");
        assert.match(await link.getAttribute("href"), /^https:\/\/example\.invalid\//u);
    }
    await expect(body.locator("a").last()).toHaveAttribute("title", /unbrokenpath/u);
    await expect(body.locator("pre.message-markdown-code code")).toHaveText("status: **unchanged** | raw");
    await expect(body.locator("li.message-markdown-task").getByRole("img", { name: "Done" })).toHaveCount(1);
    await expect(body.locator("input")).toHaveCount(0);

    await expect(body.locator("img,script,iframe,object,embed,svg,[onerror]")).toHaveCount(0);
    await expect(body).toContainText('<img src=x onerror="window.markdownExecuted=1">');
    await expect(body).toContainText("unsafe");
    await expect(body).toContainText("Image: remote pixel");
    assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);

    await response.getByRole("button", { name: "Copy response", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [reply]);

    await body.focus();
    await page.keyboard.press("Tab");
    await expect(table).toBeFocused();
    await expect(table).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Tab");
    await expect(links.first()).toBeFocused();
    await expect(links.first()).toHaveCSS("outline-style", "solid");
    await expect(links.first()).toHaveCSS("text-decoration-line", "underline");
    await proof(page, "reply-docked-light");

    await page.getByRole("button", { name: "Maximize interaction" }).click();
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "expanded");
    assert.ok(await table.evaluate(node => node.scrollWidth <= node.clientWidth + 1), "A two-column table fits the maximized reader");
    await proof(page, "reply-maximized-light");

    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "overlay");
    const fits = await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1);
    assert.ok(fits, "Narrow enlarged reading keeps table overflow inside the table region");
    assert.ok(await table.evaluate(node => node.clientWidth <= node.closest("#contextSidebarBody").clientWidth));
    await proof(page, "reply-narrow-dark");
});

test("structured prompts format in the reader and read as plain words on the card", async t => {
    const prompt = "Compare **two invented plans** before Friday:\n\n| Plan | Owner |\n|---|---|\n| Alpha | Invented owner |";
    const page = await setup(t, "Invented reply.", prompt);
    const reader = page.locator('[data-reader-section="prompt"] .full-text-content');
    await expect(reader).toHaveAttribute("data-message-format", "markdown");
    await expect(reader.locator("strong")).toHaveText("two invented plans");
    await expect(reader.getByRole("region", { name: "Table" }).locator("th")).toHaveText(["Plan", "Owner"]);
    await page.locator('[data-reader-section="prompt"]').getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [prompt]);
    await expect(page.locator(".request-card-prompt").first()).toHaveText("Compare two invented plans before Friday: Plan \u00b7 Owner");
});

test("a plain reply keeps its exact spacing and incomplete Markdown is not invented", async t => {
    const text = "Invented first response.\n  Its own spacing.\n**unclosed emphasis\n| a | b |\n|---|\n";
    const page = await setup(t, text);
    const body = page.locator('[data-reader-section="response"] .full-text-content');
    await expect(body).toHaveAttribute("data-message-format", "plain");
    assert.equal(await body.evaluate(node => node.textContent), text);
    await expect(body.locator("table,strong")).toHaveCount(0);
});
