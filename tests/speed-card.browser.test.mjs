import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

function speedRecords({ unavailable = false } = {}) {
    let callIndex = 0;
    return Array.from({ length: 62 }, (_, index) => {
        const record = fixture(`synthetic-speed-${index}`);
        record.sourceSessionId = `synthetic-speed-session-${index}`;
        const start = Date.UTC(2026, 9, 1, 12, index, 0);
        record.userPrompt = { ...record.userPrompt, sourceEventId: `prompt-${index}`, sourceTimestamp: new Date(start).toISOString() };
        record.toolCalls = Array.from({ length: index < 33 ? 4 : 3 }, () => {
            const id = callIndex++, call = structuredClone(record.toolCalls[0]);
            Object.assign(call, {
                toolCallId: `synthetic-speed-call-${id}`, startEventId: `synthetic-speed-start-${id}`, completionEventId: `synthetic-speed-end-${id}`,
                startedAt: new Date(start + id * 10).toISOString(),
            });
            if (!unavailable && id < 218) Object.assign(call, {
                completedAt: new Date(start + id * 10 + 3077).toISOString(), durationMs: 3077,
            });
            return call;
        });
        if (!unavailable && index < 2) {
            const duration = index ? 677960 : 114247;
            record.responseTiming = recordedResponseTiming([
                { id: `prompt-${index}`, type: "user.message", timestamp: new Date(start).toISOString(), data: { messageId: "p" } },
                { id: `answer-${index}`, type: "assistant.message", timestamp: new Date(start + duration).toISOString(), data: {
                    wireResponseMetadataVersion: 1, hasResponseText: true, finalAnswer: true, hasToolRequests: false, turnId: "t", originatingMessageId: "p",
                } },
                { id: `end-${index}`, type: "assistant.turn_end", timestamp: new Date(start + duration + 1).toISOString(), data: { turnId: "t" } },
            ], record.userPrompt);
        }
        return record;
    });
}

test("Speed presents separate call and final-response timing groups without changing values or coverage", { timeout: 45000 }, async t => {
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, speedRecords());
    const exports = createExportController(context), runtime = await startServer(context, exports, {
        port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { assert.fail("Speed presentation cannot start an evaluator."); },
            readSource: async () => { assert.fail("Speed presentation cannot read original evidence."); },
        },
    });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", hasTouch: true });
    page.setDefaultTimeout(10000);
    const errors = [], forbidden = [], evidence = [];
    t.after(async () => { try { await browser.close(); await runtime.close(); } finally { for (const action of cleanup) await action(); } });
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) return route.continue();
        forbidden.push(`${request.method()} ${url.pathname}`); return route.abort();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#home");
    const speed = page.locator("#homeInsights .assessment-dimension").filter({ has: page.getByRole("heading", { name: "Speed", exact: true }) });
    await speed.locator(".assessment-value").nth(1).waitFor();
    const before = await loadBoardState(context);
    const facts = buildAssessmentModel(before).overview.metrics.filter(metric => metric.dimension === "speed");
    assert.equal(facts.find(metric => metric.definitionId === "tool-duration").value, 3077);
    assert.deepEqual(facts.find(metric => metric.definitionId === "tool-duration").coverage, { covered: 218, eligible: 219 });
    assert.equal(facts.find(metric => metric.definitionId === "recorded-response-duration").value, 114247);
    assert.deepEqual(facts.find(metric => metric.definitionId === "recorded-response-duration").coverage, { covered: 2, eligible: 62 });
    for (const [theme, width, zoom] of [["light", 1440, 100], ["dark", 1440, 100], ["dark", 375, 100], ["dark", 320, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(zoom => { document.documentElement.style.fontSize = zoom + "%"; }, zoom);
        await speed.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.fonts.ready);
        assert.deepEqual(await speed.locator(".assessment-value").allTextContents(), ["3.08 s", "114.25 s"]);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        const layout = await speed.evaluate(node => {
            const box = node.getBoundingClientRect();
            const groups = [...node.querySelectorAll(".assessment-fact")].map(group => {
                const bounds = group.getBoundingClientRect(), label = group.querySelector(".assessment-fact-label")?.getBoundingClientRect();
                const value = group.querySelector(".assessment-value").getBoundingClientRect(), coverage = group.querySelector(".assessment-coverage").getBoundingClientRect();
                return { top: bounds.top, bottom: bounds.bottom, label: label && { top: label.top, bottom: label.bottom }, value: { top: value.top, bottom: value.bottom },
                    coverage: { top: coverage.top, bottom: coverage.bottom }, contained: [label, value, coverage].filter(Boolean).every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1) };
            });
            return { text: node.innerText, groups, headingTags: [...node.querySelectorAll(".assessment-fact-label")].map(label => label.tagName) };
        });
        assert.ok(layout.groups.every(group => group.contained && group.label.bottom <= group.value.top && group.value.bottom <= group.coverage.top + 1));
        evidence.push({ theme, width, zoom, ...layout });
        if (process.env.WIRE_SPEED_CARD_PROOFS) {
            const output = process.env.WIRE_SPEED_CARD_PROOFS;
            await mkdir(output, { recursive: true });
            await speed.screenshot({ path: path.join(output, `speed-${theme}-${width}-${zoom}.png`) });
            await page.locator("#homeInsights").screenshot({ path: path.join(output, `neighbors-${theme}-${width}-${zoom}.png`) });
        }
    }
    if (process.env.WIRE_SPEED_CARD_PROOFS) await writeFile(path.join(process.env.WIRE_SPEED_CARD_PROOFS, "layout.json"), JSON.stringify(evidence, null, 2));
    assert.match(evidence[0].text, /Tool calls/);
    assert.match(evidence[0].text, /Request to final response/);
    assert.match(evidence[0].text, /218 of 219 calls timed/);
    assert.match(evidence[0].text, /2 of 62 requests timed/);
    assert.doesNotMatch(evidence[0].text, /Call start to recorded completion|Recorded request to final response; not tool-call time/);
    assert.deepEqual(evidence[0].headingTags, ["H4", "H4"]);
    assert.ok(evidence.every(item => item.groups[1].label.top - item.groups[0].coverage.bottom >= 32), "The next measure must be separated more than its own value and coverage.");
    assert.ok(evidence[0].text.trim().split(/\s+/).length <= 26, "Speed should not retain the old explanatory wall of prose.");
    await speed.getByRole("button", { name: /Speed/ }).focus();
    await page.keyboard.press("Enter");
    const tooltip = page.locator("#evidence-tooltip");
    await tooltip.waitFor({ state: "visible" });
    assert.match(await tooltip.innerText(), /call start.*completion/i);
    assert.match(await tooltip.innerText(), /request.*final response/i);
    await page.keyboard.press("Escape");
    assert.equal(await tooltip.isVisible(), false);
    await speed.getByRole("button", { name: "About Speed", exact: true }).tap();
    await tooltip.waitFor({ state: "visible" });
    assert.match(await tooltip.innerText(), /medians.*seconds.*Exact milliseconds/i);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Measure definitions", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Insight details", exact: true });
    await details.getByText("Recorded measures and definitions", { exact: true }).click();
    assert.match(await details.innerText(), /Median call duration.*Call start to recorded completion/s);
    assert.match(await details.innerText(), /Time to recorded final response.*Recorded request to final response; not tool-call time/s);
    await details.getByRole("button", { name: "Close", exact: true }).click();
    const measurements = metrics => metrics.map(metric => ({
        definitionId: metric.definitionId, value: metric.value, coverage: metric.coverage, samples: metric.samples,
        unit: metric.unit, boundary: metric.boundary,
    }));
    assert.deepEqual(measurements(buildAssessmentModel(await loadBoardState(context)).overview.metrics.filter(metric => metric.dimension === "speed")), measurements(facts));
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
    assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
});

test("unavailable Speed keeps missing timing distinct from zero at narrow width", { timeout: 20000 }, async t => {
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, speedRecords({ unavailable: true }));
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { assert.fail("Unavailable Speed cannot start an evaluator."); },
            readSource: async () => { assert.fail("Unavailable Speed cannot read original evidence."); },
        },
    });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 375, height: 900 } });
    t.after(async () => { try { await browser.close(); await runtime.close(); } finally { for (const action of cleanup) await action(); } });
    await page.goto(runtime.url + "#home");
    const speed = page.locator("#homeInsights .assessment-dimension").filter({ has: page.getByRole("heading", { name: "Speed", exact: true }) });
    await speed.locator(".assessment-value").waitFor();
    await chooseTheme(page, "dark");
    assert.equal(await speed.locator(".assessment-value").innerText(), "Not measured");
    assert.match(await speed.innerText(), /0 of 219 calls timed/);
    assert.doesNotMatch(await speed.innerText(), /\b0 ms\b/);
    assert.match(await speed.innerText(), /not retained/);
    if (process.env.WIRE_SPEED_CARD_PROOFS) {
        await mkdir(process.env.WIRE_SPEED_CARD_PROOFS, { recursive: true });
        await page.locator("#homeInsights").screenshot({ path: path.join(process.env.WIRE_SPEED_CARD_PROOFS, "unavailable-dark-375.png") });
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
});
