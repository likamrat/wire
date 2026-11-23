import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
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
async function setup(t, { width = 1200, scale = 1, route = "#activity?page=2", savedReports = 0 } = {}) {
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
    ];
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
    const { page } = await setup(t, { route: "?page=3" });
    const pager = page.locator("#activityPager");
    await expect(pager).toContainText("25-32 of 38 interactions");
    await positionSection(page, "#activityPager");
    await pager.getByRole("button", { name: "Next", exact: true }).focus();
    await startTrace(page, "#activityPager");
    if (proofs) { await mkdir(proofs, { recursive: true }); await page.screenshot({ path: path.join(proofs, "outer-before.png") }); }
    await pager.getByRole("button", { name: "Next", exact: true }).click(); await frames(page);
    await expect(pager).toContainText("33-38 of 38");
    const trace = await finishTrace(page, "outer-next");
    t.diagnostic(JSON.stringify({ before: trace[0], after: trace.at(-1) }));
    const last = trace.at(-1);
    assert.ok(last.scrollY > 0, "Local pagination is not a page-top navigation.");
    assert.ok(Math.abs(last.section.y - Math.min(last.section.documentY,
        Math.max(trace[0].section.y, last.section.documentY - last.maxScroll))) <= 1,
        "The section anchor is preserved where possible, with natural document-end clamping.");
    assert.equal(await pager.getByRole("button", { name: "Previous", exact: true }).evaluate(node => node === document.activeElement), true,
        "At the last page focus returns to the enabled reverse action.");
    const shortPageY = last.section.y;
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("25-32 of 38 interactions");
    assert.ok(Math.abs((await pager.boundingBox()).y - shortPageY) <= 1, "Previous is local paging, not restoration of an older history position.");
    await expect(pager.getByRole("button", { name: "Previous", exact: true })).toBeFocused();
});

for (const failed of [false, true]) test(`paging during a held ${failed ? "failed" : "successful"} same-scope read preserves the user's later manual scroll and current page`, async t => {
    const { page } = await setup(t, { route: "?page=3" });
    const entered = deferred(), release = deferred();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise;
        if (failed) await route.fulfill({ status: 503, json: { error: "Invented paging read failed." } });
        else await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release.resolve());
    await page.getByRole("button", { name: "Refresh", exact: true }).click(); await entered.promise;
    await positionSection(page, "#activityPager");
    const pager = page.locator("#activityPager");
    await pager.getByRole("button", { name: "Next", exact: true }).click(); await frames(page);
    await expect(pager).toContainText("33-38 of 38 interactions");
    await page.mouse.move(1100, 700); await page.mouse.wheel(0, -160); await frames(page);
    const wantedY = (await pager.boundingBox()).y;
    await startTrace(page, "#activityPager");
    release.resolve(); await ready(page); await frames(page);
    await finishTrace(page, `held-${failed ? "failed" : "successful"}-read-user-scroll`);
    await expect(pager).toContainText("33-38 of 38 interactions");
    const observed = await pager.evaluate((node, y) => ({
        scroll: scrollY,
        expected: Math.min(document.documentElement.scrollHeight - innerHeight, Math.max(0, Math.round(node.getBoundingClientRect().top + scrollY - y))),
    }), wantedY);
    assert.equal(observed.scroll, observed.expected);
    await expect(page.locator("#message").filter({ hasText: "Invented paging read failed" })).toBeHidden();
    await expect(pager.getByRole("button", { name: "Previous", exact: true })).toBeFocused();
    assert.equal(new URL(page.url()).searchParams.get("page"), "4");
});

for (const scale of [1, 2]) test(`narrow outer pagination keeps its section and first-page keyboard action at ${scale * 100}% text`, async t => {
    const { page } = await setup(t, { width: 375, scale, route: "#activity?page=1" });
    const pager = page.locator("#activityPager");
    await positionSection(page, "#activityPager");
    await startTrace(page, "#activityPager");
    await pager.getByRole("button", { name: "Next", exact: true }).click(); await frames(page);
    await expect(pager).toContainText("17-24 of 38 interactions");
    const trace = await finishTrace(page, `outer-narrow-${scale}`);
    assert.equal(trace.at(-1).section.y, Math.max(trace[0].section.y, trace.at(-1).section.documentY - trace.at(-1).maxScroll));
    await expect(pager.getByRole("button", { name: "Next", exact: true })).toBeFocused();
    await pager.getByRole("button", { name: "Previous", exact: true }).focus();
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("9-16 of 38 interactions");
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("1-8 of 38 interactions");
    await expect(pager.getByRole("button", { name: "Next", exact: true })).toBeFocused();
    assert.ok(await pager.getByRole("button", { name: "Next", exact: true }).evaluate(node => {
        const box = node.getBoundingClientRect(), header = document.querySelector(".app-header").getBoundingClientRect();
        return box.top >= header.bottom && box.bottom <= innerHeight;
    }));
});

test("saved report history pages keep the library pager visible without writing or opening report files", async t => {
    const { page } = await setup(t, { route: "#reports", savedReports: 7 });
    await page.getByRole("link", { name: "Saved library", exact: true }).click();
    const pager = page.locator("#bundleList .list-pager");
    await expect(pager).toContainText("1-6 of 7");
    await positionSection(page, "#bundleList .list-pager");
    await pager.getByRole("button", { name: "Next saved reports", exact: true }).focus();
    await startTrace(page, "#bundleList .list-pager");
    await page.keyboard.press("Enter"); await frames(page);
    await expect(pager).toContainText("7-7 of 7");
    const trace = await finishTrace(page, "saved-history-next");
    const last = trace.at(-1);
    assert.ok(Math.abs(last.section.y - Math.min(last.section.documentY,
        Math.max(trace[0].section.y, last.section.documentY - last.maxScroll))) <= 1);
    await expect(pager.getByRole("button", { name: "Previous saved reports", exact: true })).toBeFocused();
    assert.equal(await page.locator("#bundles").isVisible(), true);
    await page.keyboard.press("Space"); await frames(page);
    await expect(pager).toContainText("1-6 of 7");
});
