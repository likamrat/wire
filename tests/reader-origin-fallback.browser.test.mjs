import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, revealAnalyzeRecords } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function settled(page) {
    await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.playState !== "running" || !Number.isFinite(animation.effect.getComputedTiming().iterations)));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function setup(t) {
    const records = Array.from({ length: 10 }, (_, index) => {
        const record = fixture("reader-fallback-" + index);
        const at = `2026-01-${String(28 - index).padStart(2, "0")}T12:00:00Z`;
        record.capturedAt = at;
        record.userPrompt = { text: `Review the retained workshop note ${index}.`, status: "full",
            sourceEventId: "fallback-prompt-" + index, sourceTimestamp: at,
            authorship: { actor: "user", basis: "source-user" } };
        record.followUpPrompts = [];
        record.toolCalls = [{ tool: "workiq-fetch", toolCallId: "fallback-call-" + index,
            startEventId: "fallback-start-" + index, startedAt: at, durationMs: 100,
            toolSucceeded: true, reportedOutcome: "succeeded", apiResults: [],
            requestArgs: { entityUrls: ["/me/drive/items/synthetic-note"] } }];
        return record;
    });
    const cleanups = [];
    const { context } = await privateFixture({ after: fn => cleanups.push(fn) }, records);
    const before = await loadBoardState(context), errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw Error("Providers denied in reader fallback proof."); },
            readSource() { throw Error("Source reads denied in reader fallback proof."); },
        } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/session", "/api/session/release", "/api/snapshot", "/api/collection/status",
            "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    return { page, runtime };
}

for (const kind of ["off-page", "zero-matches"]) for (const [width, scale] of [[1440, 1], [390, 2]]) test(`reader without an originating card returns to visible list context (${kind}, ${width}/${scale})`, async t => {
    const { page, runtime } = await setup(t);
    const query = kind === "off-page" ? "page=1" : "range=custom&from=2027-01-01&to=2027-01-02";
    await page.goto(runtime.url + "#analyze?" + query);
    await ready(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
    await revealAnalyzeRecords(page);
    await settled(page);
    await expect(page.locator("#activityListContext")).toHaveCount(1);
    await expect(page.locator("#activityTitle")).toHaveClass(/visually-hidden/);
    await expect(page.locator("#activityListSummary")).toBeVisible();
    await expect(page.locator("#activityListSummary")).toHaveAttribute("tabindex", "-1");
    const revision = await page.locator("#resultSummary").getAttribute("data-revision");
    assert.notEqual(revision, null);
    await expect(page.locator("#activityListScope")).toHaveAttribute("data-revision", revision);
    await expect(page.locator("#activityListScope")).not.toContainText("Saved collection");
    if (kind === "zero-matches") {
        await expect(page.locator("#activityListScope")).toBeVisible();
        await expect(page.locator("#activityListScope")).toContainText("Jan 1 - Jan 2, 2027");
    } else await expect(page.locator("#activityListScope")).toBeHidden();
    const scopeBefore = await page.locator("#activityListScope").textContent();
    const count = kind === "off-page" ? "10 interactions with 10 matching Work IQ tool calls"
        : "0 interactions with 0 matching Work IQ tool calls";
    await expect(page.locator("#activityListSummary")).toHaveText(count);
    await page.goto(runtime.url + "#request?" + query + "&request=reader-fallback-0&origin=analyze");
    await ready(page);
    await page.locator("#contextSidebar:visible").waitFor();
    await settled(page);
    assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), 16 * scale);
    await expect(page.locator('[data-view-key="request:reader-fallback-0"] .request-card-open')).toHaveCount(0);
    await expect(page.locator('[data-reader-section="prompt"]')).toContainText("Review the retained workshop note 0.");
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar").waitFor({ state: "hidden" });
    await settled(page);
    const expected = "activityListSummary";
    const result = await page.evaluate(() => ({
        focus: document.activeElement.id,
        visible: document.activeElement.checkVisibility(),
        semanticHidden: document.activeElement.classList.contains("visually-hidden"),
        top: document.activeElement.getBoundingClientRect().top,
        bottom: document.activeElement.getBoundingClientRect().bottom,
        headerBottom: document.querySelector(".app-header").getBoundingClientRect().bottom,
        viewport: innerHeight,
        summary: document.getElementById("activityListSummary").textContent,
        url: location.hash,
    }));
    if (process.env.WIRE_READER_FALLBACK_PROOFS) {
        await mkdir(process.env.WIRE_READER_FALLBACK_PROOFS, { recursive: true });
        const name = `${kind}-${width}-${scale}`;
        await writeFile(path.join(process.env.WIRE_READER_FALLBACK_PROOFS, name + ".json"),
            JSON.stringify({ kind, width, scale, expected, ...result }, null, 2));
        await page.screenshot({ path: path.join(process.env.WIRE_READER_FALLBACK_PROOFS, name + ".png") });
    }
    assert.equal(result.focus, expected);
    assert.equal(result.visible, true);
    assert.equal(result.semanticHidden, false);
    assert.ok(result.top >= result.headerBottom && result.bottom <= result.viewport);
    assert.equal(result.summary, count);
    await expect(page.locator("#activityListScope")).toHaveText(scopeBefore);
    const returned = new URLSearchParams(result.url.split("?")[1]);
    for (const [key, value] of new URLSearchParams(query)) assert.equal(returned.get(key), value);
});

test("an originating native card remains the first reader return target", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url + "#analyze?page=1");
    await ready(page);
    await revealAnalyzeRecords(page);
    const card = page.locator(".request-card-open").first();
    await card.focus();
    const before = await card.boundingBox(), url = page.url();
    await page.keyboard.press("Enter");
    await page.locator("#contextSidebar:visible").waitFor();
    await settled(page);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar").waitFor({ state: "hidden" });
    await settled(page);
    await expect(card).toBeFocused();
    assert.equal(page.url(), url);
    assert.ok(Math.abs((await card.boundingBox()).y - before.y) < 2);
});
