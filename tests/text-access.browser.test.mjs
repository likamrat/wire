import test from "node:test";
import assert from "node:assert/strict";

import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";

import { fixture, privateFixture } from "./helpers.mjs";

const original = "SYNTHETIC complete request\n  preserve indentation and trailing spaces  \n" +
    "Read this long request without navigating or changing report choices. ".repeat(18) +
    "\nhttps://example.invalid/" + "unbrokensyntheticpath".repeat(24) +
    "\nUnicode: \u65e5\u672c\u8a9e \u05e9\u05dc\u05d5\u05dd \ud83d\ude80\nEND_OF_RETAINED_REQUEST";

async function setup(t, prompt = { text: original, status: "full", provenance: "human-authored" }, followups) {
    const record = fixture("text-access");
    record.userPrompt = prompt;
    if (followups) record.followUpPrompts = followups;
    record.sourceSessionName = "Synthetic session " + "longunbrokentitle".repeat(20);
    record.project = "Synthetic project " + "longunbrokenproject".repeat(18);
    record.toolCalls[0].requestArgs = { command: "echo synthetic\n  echo " + "longcommand".repeat(45) + "\n" };
    const { context: store } = await privateFixture(t, [record]);
    const runtime = await startServer(store, createExportController(store), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", hasTouch: true });
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.addInitScript(() => {
        window.syntheticCopies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw new Error("Clipboard reads are not permitted."); },
            async writeText(text) { window.syntheticCopies.push(text); },
        } });
    });
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    return { page, url: runtime.url, record, store };
}

async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
}

test("touch reading a long prompt does not navigate or truncate the clipboard subject", async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#request?request=text-access"); await ready(page);
    await page.setViewportSize({ width: 375, height: 840 });
    const prompt = page.locator('[data-reader-section="prompt"]');
    const route = page.url(), toggle = prompt.locator(".prompt-preview-toggle");
    await toggle.tap(); await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(prompt.locator("pre")).toHaveText(original);
    await toggle.tap(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await prompt.getByRole("button", { name: "Copy prompt" }).tap();
    assert.deepEqual(await page.evaluate(() => window.syntheticCopies), [original]);
    assert.equal(page.url(), route);
});

test("only the authorized nonempty following message offers Copy", async t => {
    const text = "  SYNTHETIC retained fragment\n";
    const { page, url } = await setup(t, { status: "unavailable", text: "EXCLUDED_ORIGINAL" }, [
        { sourceEventId: "fragment", status: "partial", text },
        { sourceEventId: "excluded", status: "unavailable", text: "EXCLUDED_FOLLOWING_MESSAGE" },
        { sourceEventId: "blank", status: "full", text: "   " },
    ]);
    await page.goto(url + "#request?request=text-access"); await ready(page);
    await page.getByRole("button", { name: "Source details" }).tap();
    const linked = page.locator(".reader-linked-context");
    await linked.locator("summary").tap();
    const copy = linked.getByRole("button", { name: "Copy following message" });
    await expect(copy).toHaveCount(1);
    await expect(linked.locator("pre")).toHaveCount(1);
    assert.equal(await linked.locator("pre").textContent(), text);
    await expect(page.getByRole("button", { name: "Copy prompt" })).toHaveCount(0);
    assert.doesNotMatch(await page.locator("#requestContent").textContent(), /EXCLUDED_/);
    await copy.tap();
    assert.deepEqual(await page.evaluate(() => window.syntheticCopies), [text]);
});
