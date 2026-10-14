import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, selectActivityOption, chooseTheme, navigateMain } from "./helpers.mjs";

const proof = process.env.WIRE_DATE_CLARITY_PROOF;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const now = "2026-10-13T19:00:00Z";

async function setup(t) {
    const records = Array.from({ length: 26 }, (_, index) => {
        const record = fixture(`date-clarity-${index}`);
        record.sourceSessionId = `invented-chat-${index % 15}`;
        record.capturedAt = index === 25 ? "2026-09-15T12:00:00Z" : `2026-10-${String(index % 12 + 1).padStart(2, "0")}T12:00:00Z`;
        record.userPrompt.text = `Invented date clarity request ${index}`;
        record.toolCalls = Array.from({ length: index < 18 ? 2 : 1 }, (_, call) => ({
            ...record.toolCalls[0], toolCallId: `clarity-${index}-${call}`, startEventId: `clarity-start-${index}-${call}`,
            startedAt: record.capturedAt,
        }));
        return record;
    });
    let cleanup;
    const { context } = await privateFixture({ after: fn => { cleanup = fn; } }, records);
    await replaceEvidence(context, () => ({ records, importCoverage: {
        since: "2026-09-13T18:00:00Z", until: "2026-10-13T18:00:00Z",
        counts: { includedSessions: 15, includedProjects: 1 }, roster: [],
    } }));
    const before = await loadBoardState(context), errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: () => { throw Error("Provider use forbidden in date clarity proof."); } } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { await cleanup(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    await page.clock.setFixedTime(new Date(now));
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await page.goto(runtime.url); await ready(page); await chooseTheme(page, "dark");
    return page;
}

test("October headline names the applied month and the notice distinguishes unchecked history without competing dates", async t => {
    const page = await setup(t);
    await selectActivityOption(page, "dateFilter", "month"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("43");
    await expect(page.locator("#periodHint")).toHaveText("25 interactions · 15 Copilot chats");
    if (proof) {
        await mkdir(proof, { recursive: true });
        await page.evaluate(async () => { await document.fonts.ready; document.activeElement.blur(); scrollTo(0, 0); });
        await page.screenshot({ path: path.join(proof, "october-desktop.png"), fullPage: true });
    }
    await expect(page.locator("#periodResult")).toHaveText("43 Work IQ tool calls (Oct 1 - Oct 31, 2026)");
    await expect(page.locator("#periodCoverageText")).toHaveText("Some of this period is outside checked history; activity may be missing.");
    await expect(page.locator("#periodHistoryLink")).toHaveText("History settings");
    const evidence = [];
    for (const [width, scale, theme] of [[1440, 1, "dark"], [1200, 1, "light"], [390, 2, "light"]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(async scale => {
            document.documentElement.style.fontSize = `${scale * 100}%`;
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, scale);
        const geometry = await page.locator("#periodCoverage").evaluate(node => {
            const text = node.querySelector("p"), link = node.querySelector("a");
            const range = document.createRange(); range.selectNodeContents(text);
            const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.y))).size;
            const textBox = text.getBoundingClientRect(), linkBox = link.getBoundingClientRect();
            return { lines, textSize: parseFloat(getComputedStyle(text).fontSize),
                sameRow: Math.abs(textBox.y + textBox.height / 2 - linkBox.y - linkBox.height / 2) < 2,
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                clipped: [node, text, link, document.querySelector("#periodResult")].some(item => item.scrollWidth > item.clientWidth + 1),
                linkHeight: linkBox.height };
        });
        assert.equal(geometry.overflow, false); assert.equal(geometry.clipped, false);
        assert.ok(geometry.linkHeight >= 44); assert.ok(geometry.textSize >= 16 * scale);
        if (scale === 1) { assert.equal(geometry.lines, 1); assert.equal(geometry.sameRow, true); }
        else assert.ok(geometry.lines > 1, "Enlarged narrow text wraps rather than shrinking.");
        evidence.push({ width, scale, theme, ...geometry, headline: await page.locator("#periodResult").textContent(),
            notice: await page.locator("#periodCoverageText").textContent() });
        if (proof) await page.locator("#periodFeedback").screenshot({ path: path.join(proof, `feedback-${width}-${scale}-${theme}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.locator("#periodHistoryLink").click();
    await expect(page).toHaveURL(/#settings.*section=connection.*setting=history-window/);
    await expect(page.locator("#collectionWindow-control")).toBeFocused();
    await page.goBack(); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("43 Work IQ tool calls (Oct 1 - Oct 31, 2026)");
    await navigateMain(page, "collection-status"); await ready(page);
    await expect(page.locator("#collectionEvidenceDetails")).toContainText("Last checked history");
    await expect(page.locator("#collectionEvidenceDetails")).toContainText("Sep 13, 2026, 11:00:00 AM GMT-7");
    await expect(page.locator("#collectionEvidenceDetails")).toContainText("Oct 13, 2026, 11:00:00 AM GMT-7");
    if (proof) await writeFile(path.join(proof, "visual-functional.json"), JSON.stringify(evidence, null, 2));
});

test("every Dates choice keeps its caption with accepted counts, including unapplied custom drafts and other units", async t => {
    const page = await setup(t);
    for (const [value, calls, caption] of [
        ["day", 0, "Oct 13, 2026"], ["week", 3, "Oct 12 - Oct 18, 2026"],
        ["month", 43, "Oct 1 - Oct 31, 2026"], ["7", 18, "Oct 7 - Oct 13, 2026"],
        ["30", 44, "Sep 14 - Oct 13, 2026"], ["capture", 44, "All dates"],
    ]) {
        await selectActivityOption(page, "dateFilter", value); await ready(page);
        await expect(page.locator("#periodResult")).toHaveText(`${calls} Work IQ tool calls (${caption})`);
    }
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-10-12");
    await page.locator("#toFilter").fill("2026-10-12");
    await expect(page.locator("#periodResult")).toHaveText("44 Work IQ tool calls (All dates)");
    await page.locator("#applyDates").click(); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("3 Work IQ tool calls (Oct 12, 2026)");
    await page.locator("#fromFilter").fill("2026-12-28");
    await page.locator("#toFilter").fill("2027-01-03");
    await expect(page.locator("#periodResult")).toHaveText("3 Work IQ tool calls (Oct 12, 2026)");
    await page.locator("#applyDates").click(); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("0 Work IQ tool calls (Dec 28, 2026 - Jan 3, 2027)");
    await page.locator("#clearDates").click(); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("44 Work IQ tool calls (All dates)");
    await selectActivityOption(page, "dateFilter", "month"); await ready(page);
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("43 tool-returned API results (Oct 1 - Oct 31, 2026)");
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("44 Work IQ tool calls (All dates)");
});

test("the accepted checked window, not old imported dates, controls the notice without hiding source failures", async t => {
    const page = await setup(t);
    let checkedWindow = { since: "2026-10-01T07:00:00Z", until: now };
    const status = original => ({ ...original, state: "error", error: "Invented source history read failed",
        config: { approved: true, enabled: false, appDbPath: "C:\\invented\\data.db", sessionRoot: "C:\\invented\\history", windowDays: 30, pollSeconds: 5 },
        checkedWindow, lastCheckedAt: now });
    await page.route("**/api/collection/status", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: status(await response.json()) });
    });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        await route.fulfill({ response, json: { ...snapshot, collection: status(snapshot.collection) } });
    });
    await selectActivityOption(page, "dateFilter", "month"); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("43 Work IQ tool calls (Oct 1 - Oct 31, 2026)");
    await expect(page.locator("#periodCoverage")).toBeHidden();
    await expect(page.locator("#collectionNotice")).toBeVisible();
    await expect(page.locator("#collectionNotice")).toHaveAttribute("data-severity", "error");
    checkedWindow = null;
    await selectActivityOption(page, "dateFilter", "week"); await ready(page);
    await expect(page.locator("#periodCoverageText")).toHaveText("Checked history is unknown; this view uses retained activity.");
    await expect(page.locator("#collectionNotice")).toBeVisible();
    await expect(page.locator("#collectionNotice")).toHaveAttribute("data-severity", "error");
});
