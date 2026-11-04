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
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const settled = page => page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);

async function setup(t, motion) {
    const records = Array.from({ length: 10 }, (_, index) => {
        const record = fixture(`interruption-${index}`);
        record.project = "Invented community workshop preparation and accessible room arrangements";
        record.capturedAt = `2026-01-${String(28 - index).padStart(2, "0")}T12:00:00Z`;
        record.userPrompt = { text: `Review the invented workshop checklist ${index + 1}.`, status: "full",
            sourceEventId: `prompt-${index}`, sourceTimestamp: record.capturedAt,
            authorship: { actor: "user", basis: "source-user" } };
        record.followUpPrompts = [];
        record.toolCalls = [true, false].map((worked, call) => ({
            ...record.toolCalls[0], toolCallId: `call-${index}-${call}`, startEventId: `start-${index}-${call}`,
            startedAt: record.capturedAt, durationMs: 100, toolSucceeded: worked,
            reportedOutcome: worked ? "succeeded" : "failed", apiResults: [],
            requestArgs: { entityUrls: ["/me/drive/items/invented-workshop"] },
            ...worked ? {} : { failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
                messageStatus: "text-excluded", messageSignal: "access-denial" } },
        }));
        if (index === 9) Object.assign(record.toolCalls[1], { requestArgs: {}, requestedApiPath: null });
        return record;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context), errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw Error("Providers are forbidden in interruption proof."); },
            readSource() { throw Error("Source reads are forbidden in interruption proof."); },
        } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const action of cleanup) await action(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: motion });
    page.on("pageerror", error => errors.push(error.message));
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await page.addInitScript(() => {
        window.readerInterruption = { armed: null, count: 0 };
        for (const type of ["popstate", "keydown"]) window.addEventListener(type, () => {
            if (window.readerInterruption.armed !== type) return;
            window.readerInterruption.armed = null;
            // Deliver a real entrance reflow before the app's handler and ResizeObserver.
            for (const animation of document.getAnimations()) {
                if (!["main", "contextSidebar"].includes(animation.effect.target.id)) continue;
                animation.pause();
                animation.currentTime = Number(animation.effect.getTiming().duration) / 8;
                window.readerInterruption.count++;
            }
        }, { capture: true });
    });
    return { page, runtime };
}

for (const motion of ["reduce", "no-preference"]) for (const view of ["activity", "chart", "comparison"])
for (const action of view === "chart" ? ["history"] : ["history", "close", "newer-input"]) test(`${view} ${action} during an unobserved entrance reflow (${motion})`, async t => {
    const { page, runtime } = await setup(t, motion);
    await page.goto(runtime.url + (view === "activity" ? "#analyze?page=1&result=failure"
        : view === "chart" ? "#analyze" : "#analyze?range=custom&from=2026-01-24&to=2026-01-28"));
    await ready(page);
    if (view === "chart") {
        const failure = page.locator('#outcomeChart [data-category="failure"] .percentage-label');
        const originalUrl = page.url(), opened = page.context().waitForEvent("page");
        await failure.click({ modifiers: ["Control"] });
        const popup = await opened;
        await ready(popup);
        assert.equal(page.url(), originalUrl);
        await popup.close();
        const response = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
        await failure.click();
        await response; await ready(page);
        await revealAnalyzeRecords(page);
        await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    } else if (view === "activity") await revealAnalyzeRecords(page);
    else {
        await page.locator("#comparePeriods").click();
        for (const [id, value] of Object.entries({ comparisonAFrom: "2026-01-19", comparisonATo: "2026-01-23",
            comparisonBFrom: "2026-01-24", comparisonBTo: "2026-01-28" })) await page.locator("#" + id).fill(value);
        await page.locator("#applyPeriodComparison").click();
        await page.locator("#createPeriodReport:visible").waitFor();
        await page.locator("#comparisonRecordsB").click();
    }
    const originLink = view === "comparison" ? page.locator("#comparisonExactRecordsB a.text-link").last()
        : page.locator(".request-card-open").first();
    await originLink.scrollIntoViewIfNeeded();
    await originLink.focus();
    const position = () => page.evaluate(() => ({
        y: scrollY, inner: document.getElementById("comparison-record-scroll-B")?.scrollTop ?? 0,
        focus: document.activeElement.id, href: document.activeElement.getAttribute("href"),
        selected: document.getElementById("comparisonRecordsB")?.getAttribute("aria-selected") ?? null,
    }));
    const origin = { url: page.url(), top: (await originLink.boundingBox()).y, ...await position() };
    await page.keyboard.press("Enter");
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(2);
    await settled(page);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar").waitFor({ state: "hidden" });
    await frames(page);
    await expect(originLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(2);
    if (action === "newer-input") await page.evaluate(() => {
        const pane = document.getElementById("contextSidebar");
        window.readerExitPaused = false;
        const observer = new MutationObserver(() => {
            if (!pane.inert || !pane.open) return;
            for (const node of [pane, document.getElementById("main")]) {
                for (const animation of node.getAnimations()) animation.pause();
            }
            window.readerExitPaused = true;
            observer.disconnect();
        });
        observer.observe(pane, { attributes: true, attributeFilter: ["inert"] });
    });
    if (action === "close") await page.locator("#closeContextSidebar").focus();
    await page.evaluate(action => { window.readerInterruption.armed = action === "close" ? "keydown" : "popstate"; }, action);
    if (action !== "close") await page.goBack();
    else await page.keyboard.press("Enter");
    let newer;
    if (action === "newer-input") {
        await page.waitForFunction(() => window.readerExitPaused);
        await page.keyboard.press("Tab");
        await page.locator("#wireSearch").evaluate(node => node.focus({ preventScroll: true }));
        const beforeWheel = await position();
        await page.mouse.move(300, 150);
        await page.mouse.wheel(0, -240);
        await page.waitForFunction(before => Math.abs(scrollY - Math.max(0, before.y - 240)) < 2, beforeWheel);
        newer = await position();
        assert.equal(newer.focus, "wireSearch");
        assert.ok(newer.y < origin.y, "The newer position is reachable after the main column expands.");
        await page.evaluate(() => {
            for (const node of [document.getElementById("contextSidebar"), document.getElementById("main")]) {
                for (const animation of node.getAnimations()) animation.play();
            }
        });
    }
    await page.locator("#contextSidebar").waitFor({ state: "hidden" });
    await frames(page);
    assert.equal(await page.evaluate(() => window.readerInterruption.count), 2);
    assert.equal(page.url(), origin.url);
    const returned = { top: (await originLink.boundingBox()).y, ...await position() };
    if (process.env.WIRE_INTERRUPTION_PROOFS) {
        const directory = process.env.WIRE_INTERRUPTION_PROOFS, name = `${view}-${action}-${motion}`;
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, name + ".json"), JSON.stringify({ origin, newer, returned }, null, 2));
        await page.screenshot({ path: path.join(directory, name + ".png") });
    }
    if (newer) assert.deepEqual(await position(), newer);
    else {
        await expect(originLink).toBeFocused();
        assert.ok(Math.abs(returned.top - origin.top) < 2, `${action} moved the origin from ${origin.top}px to ${returned.top}px.`);
        for (const field of ["y", "inner"]) assert.ok(Math.abs(returned[field] - origin[field]) < 2, field);
        for (const field of ["focus", "href", "selected"]) assert.equal(returned[field], origin[field], field);
    }
    if (view !== "comparison") await expect(page.locator("#activityPager")).toContainText("9-10 of 10 interactions");
    await expect(page.locator("#requestContent")).toBeEmpty();
});
