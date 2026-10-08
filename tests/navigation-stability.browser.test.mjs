import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, chooseTheme, navigateMain, revealStoredRefresh } from "./helpers.mjs";
import { chooseReportScope, reportContents } from "./report-journey-helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";

const proofs = process.env.WIRE_NAVIGATION_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function setup(t, { width = 1200, scale = 1, route = "#activity?page=2", savedReports = 0, previewOnly = false } = {}) {
    const records = Array.from({ length: 26 }, (_, chat) => Array.from({ length: chat === 0 ? 13 : 1 }, (_, request) => {
        const row = fixture(`navigation-${chat}-${request}`);
        row.sourceSessionId = `navigation-chat-${chat}`;
        row.sourceSessionName = `Invented planning chat ${String(chat + 1).padStart(2, "0")}`;
        row.projectId = chat % 2 ? "project-b" : "project-a";
        row.project = chat % 2 ? "Invented project B" : "Invented project A";
        row.capturedAt = new Date(Date.UTC(2026, 8, 30 - chat, 12, request)).toISOString();
        row.userPrompt = { ...row.userPrompt, sourceEventId: `prompt-${chat}-${request}`,
            text: `Invented request ${chat + 1}.${request + 1}. ` + "Review fictional milestones and the next local step. ".repeat(5) };
        row.followUpPrompts = [];
        row.toolCalls = Array.from({ length: chat === 0 && request === 0 ? 13 : 1 }, (_, call) => ({
            ...row.toolCalls[0], toolCallId: `call-${chat}-${request}-${call}`, startEventId: `start-${chat}-${request}-${call}`,
            completionEventId: `complete-${chat}-${request}-${call}`,
            startedAt: row.capturedAt, completedAt: new Date(Date.parse(row.capturedAt) + 1000).toISOString(), durationMs: 1000,
        }));
        return row;
    })).flat();
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const controller = createExportController(context);
    // Real saved artifacts are needed only for the saved-history pager, and live solely in this invented store.
    for (let index = 0; index < savedReports; index++) {
        const current = await loadBoardState(context), owner = `invented-history-${index}`;
        const preview = await controller.preview(owner, undefined, { promptMode: "none", formats: ["html"] },
            { kind: "selected", revision: current.revision, scenarioIds: [records[index].scenarioId] });
        await controller.review(owner, preview.previewId, true);
        await controller.confirm(owner, preview.previewId, true);
    }
    const before = await loadBoardState(context);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(6000);
    const requests = [], errors = [];
    const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview",
        "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
        ...(previewOnly ? ["/api/preview", "/api/cancel-preview"] : [])];
    await page.route("**/api/**", route => {
        const request = route.request();
        return request.method() !== "POST" || allowed.includes(new URL(request.url()).pathname) ? route.continue() : route.abort();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            assert.deepEqual(after.evidence, before.evidence);
            assert.deepEqual(after.exports, before.exports);
            assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(url => allowed.includes(url)), JSON.stringify(requests));
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + route); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    if (scale !== 1) await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
    if (width === 375) await chooseTheme(page, "dark");
    await frames(page);
    return { page, runtime, requests, context };
}
async function startTrace(page, selector) {
    await page.evaluate(selector => {
        const samples = [];
        const rect = node => {
            if (!node?.checkVisibility()) return null;
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, documentY: box.y + scrollY };
        };
        const sample = () => ({
            scrollY, maxScroll: document.documentElement.scrollHeight - innerHeight,
            section: rect(document.querySelector(selector)), heading: rect(document.querySelector("#pageTitle")),
            focus: { id: document.activeElement?.id, text: document.activeElement?.textContent, tag: document.activeElement?.tagName },
            url: location.hash, busy: document.querySelector("#workspace").getAttribute("aria-busy"),
        });
        let running = true;
        samples.push(sample());
        const next = () => { if (running) { samples.push(sample()); requestAnimationFrame(next); } };
        requestAnimationFrame(next);
        window.stopNavigationTrace = () => { running = false; samples.push(sample()); return samples; };
    }, selector);
}
async function finishTrace(page, name) {
    const trace = await page.evaluate(() => window.stopNavigationTrace());
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, name + ".json"), JSON.stringify(trace, null, 2));
        await page.screenshot({ path: path.join(proofs, name + ".png") });
    }
    return trace;
}
async function positionSection(page, selector) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    await page.evaluate(selector => {
        const box = document.querySelector(selector).getBoundingClientRect();
        const header = document.querySelector(".app-header").getBoundingClientRect();
        scrollTo(0, Math.max(0, scrollY + box.top - header.bottom - 40));
    }, selector);
    await frames(page);
}

test("outer Activity Next/Previous stays at its pager rather than jumping to page top", async t => {
    const { page } = await setup(t);
    const pager = page.locator("#activityPager");
    await expect(pager).toContainText("17-24 of 26");
    await positionSection(page, "#activityPager");
    await pager.getByRole("button", { name: "Next", exact: true }).focus();
    await startTrace(page, "#activityPager");
    if (proofs) { await mkdir(proofs, { recursive: true }); await page.screenshot({ path: path.join(proofs, "outer-before.png") }); }
    await pager.getByRole("button", { name: "Next", exact: true }).click(); await frames(page);
    await expect(pager).toContainText("25-26 of 26");
    const trace = await finishTrace(page, "outer-next");
    t.diagnostic(JSON.stringify({ before: trace[0], after: trace.at(-1) }));
    const last = trace.at(-1);
    assert.ok(last.scrollY > 0, "Local pagination is not a page-top navigation.");
    assert.equal(last.section.y, Math.max(trace[0].section.y, last.section.documentY - last.maxScroll),
        "The section anchor is preserved where possible, with natural document-end clamping.");
    assert.equal(await pager.getByRole("button", { name: "Previous", exact: true }).evaluate(node => node === document.activeElement), true,
        "At the last page focus returns to the enabled reverse action.");
    const shortPageY = last.section.y;
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("17-24 of 26");
    assert.equal((await pager.boundingBox()).y, shortPageY, "Previous is local paging, not restoration of an older history position.");
    await expect(pager.getByRole("button", { name: "Previous", exact: true })).toBeFocused();
});

test("nested request pagination preserves its section and supports consecutive keyboard paging", async t => {
    const { page } = await setup(t, { route: "#activity" });
    const chat = page.locator('[data-session-id="navigation-chat-0"]');
    await chat.locator(".session-toggle").click();
    const pager = chat.locator(".list-pager");
    await positionSection(page, '[data-session-id="navigation-chat-0"] .list-pager');
    await pager.getByRole("button", { name: "Next request groups", exact: true }).focus();
    await startTrace(page, '[data-session-id="navigation-chat-0"] .list-pager');
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("7-12 of 13");
    const trace = await finishTrace(page, "nested-requests-next");
    assert.equal(trace.at(-1).section.y, trace[0].section.y);
    await expect(pager.getByRole("button", { name: "Next request groups", exact: true })).toBeFocused();
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("13-13 of 13");
    await expect(pager.getByRole("button", { name: "Previous request groups", exact: true })).toBeFocused();
    assert.equal(await chat.locator(".request-row").count(), 1);
});

test("exact-data table pages retain their own controls and current plotted totals", async t => {
    const { page } = await setup(t, { route: "#home?bucket=day" });
    await page.locator("#tableDisclosure > summary").click();
    const pager = page.locator("#countTable .list-pager");
    await expect(pager).toContainText("1-24 of 26");
    await positionSection(page, "#countTable .list-pager");
    await pager.getByRole("button", { name: /^Next / }).focus();
    await startTrace(page, "#countTable .list-pager");
    await page.keyboard.press("Enter"); await frames(page);
    await expect(pager).toContainText("25-26 of 26");
    const trace = await finishTrace(page, "exact-table-next");
    assert.equal(trace.at(-1).section.y, Math.max(trace[0].section.y, trace.at(-1).section.documentY - trace.at(-1).maxScroll));
    await expect(pager.getByRole("button", { name: /^Previous / })).toBeFocused();
    assert.equal(await page.locator("#countTable tbody tr").count(), 2);
    assert.equal(await page.locator("#tableDisclosure").evaluate(node => node.open), true);
});

test("context Back and browser history restore the originating paged chat-list section", async t => {
    const { page } = await setup(t);
    await positionSection(page, "#activityPager");
    const chat = page.locator(".session-group").first(), drill = chat.locator(".session-drill");
    await drill.focus();
    const origin = { url: page.url(), y: (await drill.boundingBox()).y, scroll: await page.evaluate(() => scrollY) };
    await startTrace(page, '[data-session-id="navigation-chat-16"] .session-drill');
    await drill.click(); await ready(page);
    await expect(page.locator("#sessionAnalysis")).toBeVisible();
    const destination = page.url();
    await page.locator("#contextBack").click(); await ready(page); await frames(page);
    await finishTrace(page, "context-return");
    t.diagnostic(JSON.stringify({ origin, returned: { url: page.url(), y: (await drill.boundingBox()).y, scroll: await page.evaluate(() => scrollY) } }));
    assert.equal(page.url(), origin.url);
    assert.equal((await drill.boundingBox()).y, origin.y);
    await expect(drill).toBeFocused();
    await page.goBack(); await ready(page);
    assert.equal(page.url(), destination);
    await page.goBack(); await ready(page);
    assert.equal(page.url(), origin.url);
    assert.equal((await drill.boundingBox()).y, origin.y);
    await page.goForward(); await ready(page);
    assert.equal(page.url(), destination);
});

test("request Back restores its nested page, expanded prompt, selection and link anchor", async t => {
    const { page } = await setup(t, { route: "#activity" });
    const chat = page.locator('[data-session-id="navigation-chat-0"]');
    await chat.locator(".session-toggle").click();
    await chat.locator(".list-pager").getByRole("button", { name: "Next request groups", exact: true }).click();
    const row = chat.locator(".request-row").nth(2);
    await row.locator("input[type=checkbox]").check();
    await row.locator(".full-text-toggle").click();
    const link = row.locator(".request-link");
    await link.scrollIntoViewIfNeeded(); await link.focus(); await frames(page);
    const before = { url: page.url(), y: (await link.boundingBox()).y, scroll: await page.evaluate(() => scrollY) };
    await link.click(); await ready(page);
    await expect(page.locator("#requestView")).toBeVisible();
    await page.locator("#contextBack").click(); await ready(page); await frames(page);
    assert.equal(page.url(), before.url);
    await expect(chat.locator(".list-pager")).toContainText("7-12 of 13");
    await expect(row.locator(".full-text-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator("input[type=checkbox]")).toBeChecked();
    assert.equal((await link.boundingBox()).y, before.y);
    await expect(link).toBeFocused();
});

test("report-flow Back returns to the originating request-selection position, not the page heading", async t => {
    const { page } = await setup(t, { route: "#reports" });
    await chooseReportScope(page, "all");
    await page.locator("#reportRequests > summary").click();
    const next = page.getByRole("button", { name: "Continue to contents", exact: true });
    await next.scrollIntoViewIfNeeded(); await next.focus(); await frames(page);
    const before = { y: (await next.boundingBox()).y, scroll: await page.evaluate(() => scrollY) };
    await startTrace(page, "#reportStage1 .report-stage-actions button");
    await next.click();
    await expect(page.locator("#reportStage2")).toBeVisible();
    await page.getByRole("button", { name: "Back to requests", exact: true }).click(); await frames(page);
    await finishTrace(page, "report-stage-back");
    const after = { y: (await next.boundingBox()).y, scroll: await page.evaluate(() => scrollY) };
    t.diagnostic(JSON.stringify({ before, after }));
    assert.deepEqual(after, before);
    await expect(next).toBeFocused();
    assert.equal(await page.locator("#reportRequests").evaluate(node => node.open), true);
});

test("a failed contextual return keeps its original destination and retry control", async t => {
    const { page } = await setup(t);
    await positionSection(page, "#activityPager");
    await page.locator(".session-group").first().locator(".session-drill").click(); await ready(page);
    const origin = page.url();
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented return read failed." } }), { times: 1 });
    await page.locator("#contextBack").click(); await ready(page); await frames(page);
    assert.equal(page.url(), origin);
    await expect(page.locator("#message")).toContainText("Invented return read failed");
    await expect(page.locator("#contextBack")).toBeFocused();
    assert.ok(await page.locator("#contextBack").evaluate(node => {
        const box = node.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight;
    }));
});

test("a delayed context Back does not reclaim focus or scroll after a newer user reading action", async t => {
    const { page } = await setup(t);
    await positionSection(page, "#activityPager");
    await page.locator(".session-group").first().locator(".session-drill").click(); await ready(page);
    const entered = deferred(), release = deferred();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release.resolve());
    await page.locator("#contextBack").click(); await entered.promise;
    const search = page.locator("#activitySearch");
    await search.click();
    await page.mouse.wheel(0, 120); await frames(page);
    const user = { y: (await search.boundingBox()).y, scroll: await page.evaluate(() => scrollY) };
    await startTrace(page, "#activitySearch");
    release.resolve(); await ready(page); await frames(page);
    await finishTrace(page, "delayed-context-user-intent");
    const after = { y: (await search.boundingBox()).y, scroll: await page.evaluate(() => scrollY) };
    t.diagnostic(JSON.stringify({ user, after }));
    await expect(search).toBeFocused();
    const expectedScroll = await search.evaluate((node, wantedY) => Math.min(document.documentElement.scrollHeight - innerHeight,
        Math.max(0, Math.round(node.getBoundingClientRect().top + scrollY - wantedY))), user.y);
    assert.equal(after.scroll, expectedScroll, "Current reading anchor is kept at native scroll-pixel precision, not the stale historical position.");
});

for (const failed of [false, true]) test(`paging during a held ${failed ? "failed" : "successful"} same-scope read preserves the user's later manual scroll and current page`, async t => {
    const { page } = await setup(t);
    const entered = deferred(), release = deferred();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise;
        if (failed) await route.fulfill({ status: 503, json: { error: "Invented paging read failed." } });
        else await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release.resolve());
    await (await revealStoredRefresh(page)).click(); await entered.promise;
    await positionSection(page, "#activityPager");
    const pager = page.locator("#activityPager");
    await pager.getByRole("button", { name: "Next", exact: true }).click(); await frames(page);
    await expect(pager).toContainText("25-26 of 26");
    await page.mouse.move(1100, 700); await page.mouse.wheel(0, -160); await frames(page);
    const wantedY = (await pager.boundingBox()).y;
    await startTrace(page, "#activityPager");
    release.resolve(); await ready(page); await frames(page);
    await finishTrace(page, `held-${failed ? "failed" : "successful"}-read-user-scroll`);
    await expect(pager).toContainText("25-26 of 26");
    const observed = await pager.evaluate((node, y) => ({
        scroll: scrollY,
        expected: Math.min(document.documentElement.scrollHeight - innerHeight, Math.max(0, Math.round(node.getBoundingClientRect().top + scrollY - y))),
    }), wantedY);
    assert.equal(observed.scroll, observed.expected);
    if (failed) await expect(page.locator("#message")).toContainText("Invented paging read failed");
    await expect(pager.getByRole("button", { name: "Previous", exact: true })).toBeFocused();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("page"), "3");
});

for (const scale of [1, 2]) test(`narrow outer pagination keeps its section and first-page keyboard action at ${scale * 100}% text`, async t => {
    const { page } = await setup(t, { width: 375, scale, route: "#activity?page=1" });
    const pager = page.locator("#activityPager");
    await positionSection(page, "#activityPager");
    await startTrace(page, "#activityPager");
    await pager.getByRole("button", { name: "Next", exact: true }).click(); await frames(page);
    await expect(pager).toContainText("17-24 of 26");
    const trace = await finishTrace(page, `outer-narrow-${scale}`);
    assert.equal(trace.at(-1).section.y, Math.max(trace[0].section.y, trace.at(-1).section.documentY - trace.at(-1).maxScroll));
    await expect(pager.getByRole("button", { name: "Next", exact: true })).toBeFocused();
    await pager.getByRole("button", { name: "Previous", exact: true }).focus();
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("9-16 of 26");
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("1-8 of 26");
    await expect(pager.getByRole("button", { name: "Next", exact: true })).toBeFocused();
    assert.ok(await pager.getByRole("button", { name: "Next", exact: true }).evaluate(node => {
        const box = node.getBoundingClientRect(), header = document.querySelector(".app-header").getBoundingClientRect();
        return box.top >= header.bottom && box.bottom <= innerHeight;
    }));
});

test("matching action/result pages use the shared contextual pager", async t => {
    const { page } = await setup(t, { route: "#activity?session=navigation-chat-0&result=success" });
    const pager = page.locator(".session-requests .list-pager");
    await expect(pager).toContainText("1-6 of 25");
    await positionSection(page, ".session-requests .list-pager");
    const before = (await pager.boundingBox()).y;
    await pager.getByRole("button", { name: /^Next matching/ }).click(); await frames(page);
    await expect(pager).toContainText("7-12 of 25");
    assert.equal((await pager.boundingBox()).y, before);
    await expect(pager.getByRole("button", { name: /^Next matching/ })).toBeFocused();
    await page.keyboard.press("Enter"); await frames(page);
    await expect(pager).toContainText("13-18 of 25");
    assert.equal(await page.locator(".matched-action").count(), 6);
    assert.equal(await page.locator("#scopeCount-selected").textContent(), "0 request groups");
});

test("saved report history pages stay at their disclosure without writing or opening report files", async t => {
    const { page } = await setup(t, { route: "#reports", savedReports: 7 });
    await page.locator("#bundles > summary").click();
    const pager = page.locator("#bundleList .list-pager");
    await expect(pager).toContainText("1-6 of 7");
    await positionSection(page, "#bundleList .list-pager");
    await pager.getByRole("button", { name: "Next saved reports", exact: true }).focus();
    await startTrace(page, "#bundleList .list-pager");
    await page.keyboard.press("Enter"); await frames(page);
    await expect(pager).toContainText("7-7 of 7");
    const trace = await finishTrace(page, "saved-history-next");
    assert.equal(trace.at(-1).section.y, Math.max(trace[0].section.y, trace.at(-1).section.documentY - trace.at(-1).maxScroll));
    await expect(pager.getByRole("button", { name: "Previous saved reports", exact: true })).toBeFocused();
    assert.equal(await page.locator("#bundles").evaluate(node => node.open), true);
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("1-6 of 7");
});

test("late navigation replies cannot overwrite the newer destination or invent an unseen return position", async t => {
    const { page } = await setup(t, { route: "#activity?page=1" });
    await positionSection(page, "#activityPager");
    const first = page.locator('[data-session-id="navigation-chat-8"] .session-drill');
    const second = page.locator('[data-session-id="navigation-chat-9"] .session-drill');
    const entered = deferred(), release = deferred();
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().filters.sourceSessionIds?.[0] !== "navigation-chat-8") return route.continue();
        const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
    });
    t.after(() => release.resolve());
    await first.click(); await entered.promise;
    await second.click(); await ready(page);
    await expect(page.locator("#pageTitle")).toHaveText("Invented planning chat 10");
    const current = page.url();
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
        && response.request().postDataJSON().filters.sourceSessionIds?.[0] === "navigation-chat-8");
    release.resolve(); await late; await frames(page);
    assert.equal(page.url(), current);
    await expect(page.locator("#pageTitle")).toHaveText("Invented planning chat 10");
    await page.goBack(); await ready(page); await frames(page);
    await expect(page.locator("#pageTitle")).toHaveText("Invented planning chat 09");
    await expect(page.locator("#pageTitle")).toBeFocused();
    assert.ok(await page.locator("#pageTitle").evaluate(node => {
        const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight;
    }), "A previously requested but never displayed destination has no unrelated list position to restore.");
});

test("action-record pages keep the local journey anchor", async t => {
    const { page } = await setup(t, { route: "#request?request=navigation-0-0" });
    const pager = page.locator(".journey-pages > .list-pager");
    await expect(pager).toContainText("1-6 of 13");
    await positionSection(page, ".journey-pages > .list-pager");
    const top = (await pager.boundingBox()).y;
    await pager.getByRole("button", { name: "Next action records", exact: true }).click(); await frames(page);
    await expect(pager).toContainText("7-12 of 13");
    assert.equal((await pager.boundingBox()).y, top);
    await expect(pager.getByRole("button", { name: "Next action records", exact: true })).toBeFocused();
});

test("context-return hrefs keep modifier-click behavior and keyboard return", async t => {
    const { page } = await setup(t);
    await positionSection(page, "#activityPager");
    const drill = page.locator(".session-group").first().locator(".session-drill");
    const origin = page.url();
    await drill.click(); await ready(page);
    const destination = page.url(), back = page.locator("#contextBack"), href = await back.getAttribute("href");
    const popupPromise = page.context().waitForEvent("page");
    await back.click({ modifiers: ["Control"] });
    const popup = await popupPromise;
    try {
        await popup.waitForLoadState(); await ready(popup);
        assert.equal(new URL(popup.url()).hash, href);
        await expect(popup.locator("#activityPager")).toContainText("17-24 of 26");
        assert.equal(page.url(), destination);
    } finally { await popup.close(); }
    await back.focus(); await page.keyboard.press("Enter"); await ready(page); await frames(page);
    assert.equal(page.url(), origin);
    await expect(drill).toBeFocused();
});

test("Back from a synthetic unsaved review restores its Contents action without granting disclosure", async t => {
    const { page, requests } = await setup(t, { route: "#reports", previewOnly: true });
    await chooseReportScope(page, "all"); await reportContents(page);
    await page.locator('[name=promptMode][value=none]').check();
    const scan = page.locator("#exportBtn");
    await scan.scrollIntoViewIfNeeded(); await scan.focus(); await frames(page);
    const before = (await scan.boundingBox()).y;
    await scan.click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await page.getByRole("button", { name: "Back to contents", exact: true }).click(); await frames(page);
    await expect(page.locator("#reportStage2")).toBeVisible();
    await expect(scan).toBeFocused();
    assert.equal((await scan.boundingBox()).y, before);
    assert.ok(!requests.some(url => ["/api/privacy-review", "/api/export"].includes(url)));
});

test("report request-list paging keeps its local anchor and full report membership", async t => {
    const { page } = await setup(t, { route: "#reports" });
    await chooseReportScope(page, "all");
    await page.locator("#reportRequests > summary").click();
    const pager = page.locator("#reportList > .list-pager");
    await expect(pager).toContainText("1-4 of 38");
    await positionSection(page, "#reportList > .list-pager");
    const before = (await pager.boundingBox()).y, membership = await page.locator("#previewSelectionSummary").textContent();
    await pager.getByRole("button", { name: "Next report requests", exact: true }).click(); await frames(page);
    await expect(pager).toContainText("5-8 of 38");
    assert.equal((await pager.boundingBox()).y, before);
    await expect(pager.getByRole("button", { name: "Next report requests", exact: true })).toBeFocused();
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), membership);
    assert.equal(await page.locator("#reportList .report-entry").count(), 4);
});
