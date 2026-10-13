import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

test("recorded response latency stays distinct through actual detail, overview and all saved formats", { timeout: 45000 }, async t => {
    const records = [0, 1200, 5000].map((duration, index) => {
        const record = fixture(`timed-response-${index}`), start = Date.UTC(2026, 9, 1, 12, 0, 0);
        record.sourceSessionId = `source-${index}`;
        record.userPrompt = { ...record.userPrompt, sourceEventId: "prompt", sourceTimestamp: new Date(start).toISOString() };
        record.responseTiming = recordedResponseTiming([
            { id: "prompt", type: "user.message", timestamp: new Date(start).toISOString(), data: { messageId: "p" } },
            { id: "response", type: "assistant.message", timestamp: new Date(start + duration).toISOString(), data: {
                wireResponseMetadataVersion: 1, finalAnswer: true, hasResponseText: true, hasToolRequests: false, turnId: "t", originatingMessageId: "p",
            } },
            { id: "end", type: "assistant.turn_end", timestamp: new Date(start + duration + 1).toISOString(), data: { turnId: "t" } },
        ], record.userPrompt);
        return record;
    });
    const { context } = await privateFixture(t, records), controller = createExportController(context);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } }), browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#home");
    await page.locator("#activityList .response-timing data").first().waitFor();
    assert.deepEqual(await page.locator("#activityList .response-timing data").evaluateAll(nodes =>
        nodes.map(node => Number(node.value)).sort((a, b) => a - b)), [0, 1200, 5000]);
    assert.equal(await page.locator("#homeInsights .assessment-timing").count(), 0);
    await page.goto(runtime.url + "#request?request=timed-response-0");
    await page.locator(".request-original .response-timing data").waitFor();
    assert.equal(await page.locator(".request-original .response-timing data").innerText(), "0 s");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width: 375, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    }
    const state = await loadBoardState(context);
    const preview = await controller.preview("synthetic-timing", undefined, { promptMode: "none", formats: ["html", "pdf", "json", "markdown"] },
        { kind: "selected", revision: state.revision, scenarioIds: records.map(record => record.scenarioId) });
    const timing = preview.snapshot.evaluationFacts.metrics.find(metric => metric.definitionId === "recorded-response-duration");
    assert.equal(timing.value, 1200);
    assert.deepEqual(timing.coverage, { eligible: 3, covered: 3 });
    assert.match(preview.previewHtml, /<!doctype html>/i);
    await controller.review("synthetic-timing", preview.previewId, true);
    const saved = (await controller.confirm("synthetic-timing", preview.previewId, true)).bundle;
    const json = JSON.parse(await readFile(saved.files["product-report.json"], "utf8"));
    assert.deepEqual(json.evaluationFacts.metrics.find(metric => metric.definitionId === timing.definitionId), timing);
    assert.equal(await readFile(saved.files["product-report.html"], "utf8"), preview.previewHtml);
    assert.equal(await readFile(saved.files["product-report.md"], "utf8"), preview.files["product-report.md"]);
    assert.equal((await readFile(saved.files["product-report.pdf"])).subarray(0, 5).toString(), "%PDF-");
    assert.deepEqual(errors, []);
});
