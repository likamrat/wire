import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

test("known empty retained prompts export as explicitly unavailable without altering source", async t => {
    const source = fixture();
    source.userPrompt = { status: "full", text: "" };
    source.followUpPrompts = [{ status: "full", text: "   " }];
    const { context } = await privateFixture(t, [source]);
    const before = await loadBoardState(context);
    const controller = createExportController(context);
    const preview = await controller.preview("synthetic", undefined, { promptMode: "masked", formats: ["json", "markdown"] }, { kind: "all", revision: before.revision });
    assert.equal(preview.snapshot.promptCoverage.unavailable, 2);
    assert.equal(preview.snapshot.promptCoverage.included, 0);
    for (const p of preview.records[0].prompts) {
        assert.equal(p.status, "unavailable");
        assert.equal(p.sourceStatus, "full");
        assert.equal(p.text, null);
        assert.match(p.availabilityNote, /empty/i);
    }
    assert.match(preview.files["product-report.md"], /source marked full/i);
    assert.deepEqual(await loadBoardState(context), before);
    controller.discard("synthetic");
    source.userPrompt = { status: "made-up", text: "" };
    await assert.rejects(buildSanitizedBundle([source], "a".repeat(64)), /coverage is unsupported/);
    source.userPrompt = { status: "full", text: null };
    await assert.rejects(buildSanitizedBundle([source], "a".repeat(64)), /coverage is unsupported/);
});

test("report starts with outcomes, preserves exact optional copies and has working offline navigation", { timeout: 60000 }, async () => {
    const source = fixture();
    source.userPrompt.text = "EXACT_REVIEWED_ORIGIN " + "long readable context ".repeat(150);
    source.toolCalls.push({ tool: "workiq-ask", toolCallId: "second", order: 2, requestArgs: { question: "QUESTION_CANARY" }, reportedOutcome: "failed", toolSucceeded: false, apiResults: [] });
    const bundle = await buildSanitizedBundle([source], "a".repeat(64), { formats: ["html", "json", "markdown"] });
    assert.equal(bundle.snapshot.summary.metrics[0].count, 2);
    assert.equal(bundle.snapshot.summary.metrics[0].outcomes.failure, 1);
    assert.doesNotMatch(bundle.files["product-report.md"], /JSONL/);
    assert.ok(bundle.files["product-report.md"].indexOf("At a glance") < bundle.files["product-report.md"].indexOf("Coverage and reading notes"));
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, javaScriptEnabled: false });
        await page.setContent(bundle.previewHtml);
        assert.ok((await page.locator("#overview").boundingBox()).y < 200);
        assert.ok((await page.locator("#overview .report-tool-score").boundingBox()).y < 400, "Recorded outcomes remain immediately visible");
        assert.ok((await page.locator("#overview .report-dimensions").boundingBox()).y < 500, "The four evaluation dimensions start in the first viewport");
        assert.deepEqual(await page.locator(".report-dimension > h2").allTextContents(), ["Accuracy", "Speed", "Trust"]);
        assert.ok(await page.locator("#overview table").isVisible(), "Exact evidence-layer counts remain available below the headline summary");
        assert.ok((await page.locator("#examples").innerText()).includes("EXACT_REVIEWED_ORIGIN"));
        const sequence = await page.locator(".example li").allTextContents();
        assert.match(sequence[0], /workiq-fetch/);
        assert.match(sequence[1], /workiq-ask/);
        assert.equal(await page.locator(".prompt-record[open]").count(), 0);
        await page.locator(".prompt-record summary").first().click();
        assert.equal(await page.locator(".prompt pre").first().textContent(), source.userPrompt.text);
        const broken = await page.locator('a[href^="#"]').evaluateAll(nodes => nodes.filter(n => !document.getElementById(n.hash.slice(1))).map(n => n.hash));
        assert.deepEqual(broken, []);
        assert.equal(await page.locator("script,img,iframe,link").count(), 0);
        await page.emulateMedia({ media: "print" });
        assert.equal(await page.locator(".json-records-link").isVisible(), false);
        assert.equal(await page.locator(".print-companion").isVisible(), true);
        await page.emulateMedia({ media: "screen" });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    } finally { await browser.close(); }
});

test("bounded examples retain the highlighted late failure and disclose excluded calls", async () => {
    const source = fixture();
    source.toolCalls = Array.from({ length: 18 }, (_, i) => ({
        ...structuredClone(source.toolCalls[0]), toolCallId: `ordered-${i}`, order: i + 1,
        startEventId: `start-${i}`, completionEventId: `complete-${i}`,
        reportedOutcome: i === 14 ? "failed" : "succeeded", toolSucceeded: i !== 14,
    }));
    const bundle = await buildSanitizedBundle([source], "a".repeat(64), { promptMode: "none", formats: ["html", "markdown"] });
    assert.match(bundle.previewHtml, /<ol start="12">/);
    assert.match(bundle.files["product-report.md"], /15\. workiq-fetch: .* - failed\./);
    assert.match(bundle.previewHtml, /11 earlier and 0 later calls are outside this bounded example/);
});
