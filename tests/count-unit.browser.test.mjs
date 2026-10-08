import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const proof = process.env.WORKIQ_COUNT_PROOFS;
const longName = "Original Session title " + "with a deliberately long recognizable Copilot conversation name ".repeat(4);
async function setup(t, { metadataOnly = 0 } = {}) {
    const records = [];
    for (const [source, sizes] of [["one", [3]], ["six", [3, 3, 2, 2, 2, 2]], ["long", [1]], ["unknown", [1]]]) for (const [index, size] of sizes.entries()) {
        const row = fixture(`${source}-${index}`);
        row.sourceSessionId = source;
        row.sourceSessionName = source === "long" ? longName : source === "unknown" ? null : `Original Session ${source}`;
        row.projectId = source === "one" || source === "unknown" ? null : "project";
        row.project = source === "long" ? "Long synthetic folder project ".repeat(8) : "Invented project";
        row.userPrompt.text = `Invented ${source} request ${index}`;
        row.followUpPrompts = [];
        row.toolCalls = Array.from({ length: size }, (_, call) => ({
            ...structuredClone(row.toolCalls[0]), toolCallId: `${source}-${index}-${call}`, startEventId: `start-${source}-${index}-${call}`,
            startedAt: "2026-09-30T12:00:00Z",
            toolSucceeded: source === "unknown" ? null : !(source === "six" && index === 5),
            reportedOutcome: source === "unknown" ? "unknown" : source === "six" && index === 5 ? "failed" : "succeeded",
        }));
        records.push(row);
    }
    let cleanup;
    const { context } = await privateFixture({ after: action => { cleanup = action; } }, records);
    if (metadataOnly) await replaceEvidence(context, () => ({ records, importCoverage: { counts: {}, roster: Array.from({ length: metadataOnly }, (_, i) => ({
        sessionId: `metadata-${i}`, name: `Invented metadata-only chat ${i}`, eligible: true, scanned: true,
    })) } }));
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 950 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(12000);
    const errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            const after = await loadBoardState(context);
            assert.deepEqual(after.cards, before.cards); assert.deepEqual(after.exports, before.exports);
            assert.equal(after.evidenceFile, before.evidenceFile); assert.equal(after.pseudonymKey, before.pseudonymKey);
            assert.deepEqual(errors, []);
            assert.ok(posts.every(url => ["/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary", "/api/assessment/detail", "/api/assessment/overview"].includes(url)));
        } finally { await cleanup(); }
    });
    return { page, url: runtime.url };
}
const ready = page => page.locator('#workspace[aria-busy="false"]').waitFor();
const group = (page, source) => page.locator(`.session-group[data-session-id="${source}"]`);

test("collapsed groups expose Copilot identity, group-to-call relationship and exact 3/14 outcomes", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t);
    await page.goto(url); await ready(page);
    assert.equal(await page.locator("#periodResult").innerText(), "4 Copilot chats / 9 request groups with 19 Work IQ tool calls.");
    assert.match(await page.locator("#periodHint").innerText(), /^All retained dates/);
    await page.getByRole("link", { name: "Choose a Copilot chat", exact: true }).click(); await ready(page);
    assert.match(await page.locator("#coverageBody .activity-list-explanation").textContent(), /filters and private search/);
    for (const [source, text] of [["one", "1 request group with 3 Work IQ tool calls"], ["six", "6 request groups with 14 Work IQ tool calls"]]) {
        assert.equal(await group(page, source).locator(".session-toggle").getAttribute("aria-expanded"), "false");
        assert.equal(await group(page, source).locator(".session-label").innerText(), "Copilot chat name");
        assert.equal(await group(page, source).locator(".result-unit").innerText(), text);
        assert.equal(await group(page, source).locator(".request-row").count(), 0);
    }
    assert.equal(await group(page, "six").locator('[data-outcome="success"]').getAttribute("data-count"), "12");
    assert.equal(await group(page, "six").locator('[data-outcome="failure"]').getAttribute("data-count"), "2");
    assert.equal(await group(page, "unknown").locator(".session-name").innerText(), "Copilot chat name not recorded");
    assert.equal(await group(page, "unknown").locator(".project-context").innerText(), "Copilot chat without a project");
    assert.equal(await group(page, "unknown").locator(".recorded-result-label").innerText(), "1 No result recorded");
    const toggle = group(page, "one").locator(".session-toggle");
    await toggle.focus(); await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await group(page, "one").locator(".request-row").count(), 1);
    await page.keyboard.press("Space");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    const failure = group(page, "six").locator('.result-link[data-outcome="failure"]');
    let snapshots = 0;
    page.on("request", r => { if (r.url().endsWith("/api/snapshot")) snapshots++; });
    await failure.focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.equal(snapshots, 1, "Nested result link activates once");
    assert.match(await page.locator("#sessionAnalysis .result-unit").innerText(), /6 request groups with 14 Work IQ tool calls/);
    assert.match(await page.locator("#sessionAnalysis .session-scope").innerText(), /Totals above include all results/);
    assert.match(await group(page, "six").locator(".session-summary .result-unit").innerText(), /1 request group with 2 Work IQ tool calls/);
    assert.equal(await page.locator(".matched-action").count(), 2);
    await page.locator(".matched-action .text-link").first().click(); await ready(page);
    assert.match(await page.locator(".full-request-results [data-result-layer=tool] .result-unit").textContent(), /2 Work IQ tool calls/);
    assert.equal(await page.locator(".request-matching").count(), 0, "Identical matching/full scope has one result summary");
    await page.goBack(); await ready(page);
    assert.equal(await page.locator(".matched-action").count(), 2);
});

test("chooser inventory is distinct from chats with matching evidence, including metadata-only and empty-search scopes", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t, { metadataOnly: 120 });
    await page.goto(url + "#activity"); await ready(page);
    assert.match(await page.locator("#periodResult").innerText(), /4 Copilot chats \/ 9 request groups with 19 Work IQ tool calls/);
    assert.equal(await page.locator("#activityInsights .assessment-scope").count(), 0);
    assert.equal(await page.locator("#activityListSummary").innerText(), "Also listed: 120 Copilot chats without matching evidence.");
    assert.equal(await page.locator("#activityPager>span").innerText(), "Listed Copilot chats 1-8 of 124");
    assert.equal(await page.locator(".session-group").count(), 8, "Keep metadata-only chats in the chooser");
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const clipped = await page.locator("#periodResult,#activityListSummary,#activityPager").evaluateAll(nodes =>
            nodes.filter(node => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1).map(node => node.id));
        assert.deepEqual(clipped, [], `${theme}/${width}/${scale}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    }
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
    await page.locator("#activitySearch").fill("Invented metadata-only chat");
    assert.match(await page.locator("#periodResult").innerText(), /0 Copilot chats \/ 0 request groups with 0 Work IQ tool calls/);
    assert.equal(await page.locator("#activityListSummary").innerText(), "The listed Copilot chats have no matching evidence in this view.");
    assert.equal(await page.locator("#activityPager>span").innerText(), "Listed Copilot chats 1-8 of 120");
    await page.locator("#activitySearch").fill("Invented metadata-only chat 119");
    assert.equal(await page.locator("#activityListSummary").innerText(), "The listed Copilot chat has no matching evidence in this view.");
    assert.equal(await page.locator("#activityPager>span").innerText(), "Listed Copilot chat 1-1 of 1");
    const row = page.locator(".session-group").first();
    assert.equal(await row.locator(".result-unit").innerText(), "0 request groups with 0 Work IQ tool calls");
    await row.locator(".session-drill").click(); await ready(page);
    assert.match(await page.locator("#sessionAnalysis .result-unit").innerText(), /0 request groups with 0 Work IQ tool calls/);
    await page.getByRole("link", { name: "Back to Copilot chats", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), "Invented metadata-only chat 119");
    await page.locator("#activitySearch").fill("Original Session one");
    assert.match(await page.locator("#periodResult").innerText(), /1 request group with 3 Work IQ tool calls/);
    assert.equal(await page.locator("#activityListSummary").isVisible(), false);
    assert.doesNotMatch(await page.locator("#activityListSummary").innerText(), /without matching evidence/);
    assert.equal(await page.locator("#activityPager>span").innerText(), "Copilot chat 1-1 of 1");
    await page.goto(url + "#activity?result=success"); await ready(page);
    assert.match(await page.locator("#periodResult").innerText(), /3 Copilot chats \/ 7 request groups with 16 Work IQ tool calls/);
    assert.equal(await page.locator("#activityListSummary").isVisible(), false);
    assert.doesNotMatch(await page.locator("#activityListSummary").innerText(), /without matching evidence/);
    assert.equal(await page.locator("#activityPager>span").innerText(), "Copilot chats 1-3 of 3");
});

test("one chat-title hue stays readable in both themes at all sizes and interaction states", { timeout: 120000 }, async t => {
    const { page, url } = await setup(t), measurements = [];
    if (proof) await mkdir(proof, { recursive: true });
    await page.goto(url + "#activity"); await ready(page);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const target = group(page, "long").locator(".session-toggle");
        for (const state of ["rest", "hover", "focus", "expanded", "report-selected"]) {
            await page.mouse.move(0, 0);
            await page.evaluate(() => document.activeElement?.blur());
            if (state === "hover") await target.hover();
            if (state === "focus") { await target.focus(); await page.keyboard.press("Shift"); }
            if (state === "expanded" && await target.getAttribute("aria-expanded") === "false") await target.click();
            if (state === "report-selected") {
                if (await target.getAttribute("aria-expanded") === "false") await target.click();
                await group(page, "long").locator("input[type=checkbox]").check();
            }
            const values = await page.locator(".copilot-chat-name").evaluateAll(nodes => {
                const rgba = color => { const v = color.match(/[\d.]+/g).map(Number); return [...v.slice(0, 3), v[3] ?? 1]; };
                const blend = (a, b) => a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3]));
                const background = node => {
                    if (!node) return [255, 255, 255];
                    let bg = blend(rgba(getComputedStyle(node).backgroundColor), background(node.parentElement));
                    const before = getComputedStyle(node, "::before");
                    if (before.content !== "none" && before.zIndex === "-1") bg = blend(rgba(before.backgroundColor), bg);
                    return bg;
                };
                const lum = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
                return nodes.filter(node => node.checkVisibility()).map(node => {
                    const color = getComputedStyle(node).color, bg = background(node), a = lum(rgba(color).slice(0, 3)), b = lum(bg);
                    return { color, background: bg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05),
                        clipped: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1 };
                });
            });
            assert.equal(new Set(values.map(v => v.color)).size, 1, "All Copilot titles share one category color");
            for (const value of values) {
                assert.ok(value.ratio >= 4.5, `${theme}/${width}/${scale}/${state}: ${JSON.stringify(value)}`);
                assert.equal(value.clipped, false);
            }
            const clipping = await page.locator(".session-toggle,.session-name,.project-context,.session-summary .result-unit,.recorded-result-label").evaluateAll(nodes =>
                nodes.filter(n => n.checkVisibility() && (n.scrollWidth > n.clientWidth + 2 || n.scrollHeight > n.clientHeight + 2)).map(n => n.className));
            assert.deepEqual(clipping, [], `${theme}/${width}/${scale}/${state}`);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.equal(await group(page, "long").locator(".session-name").textContent(), longName);
            const titleBox = await group(page, "long").locator(".session-toggle").boundingBox();
            assert.ok(titleBox.width >= Math.min(width - 60, 260), "Title receives readable line width instead of being crushed beside Open analysis");
            measurements.push({ theme, width, scale, state, values });
        }
        if (proof) {
            await page.mouse.move(0, 0); await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); }); await page.keyboard.press("Escape");
            await page.screenshot({ path: path.join(proof, `titles-${theme}-${width}-${scale}x.png`), fullPage: true });
        }
        await group(page, "long").locator("input[type=checkbox]").uncheck();
        await target.click();
    }
    if (proof) await writeFile(path.join(proof, "title-contrast-and-bounds.json"), JSON.stringify(measurements, null, 2));
});
