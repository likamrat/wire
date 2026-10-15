import test from "node:test";
import assert from "node:assert/strict";
import { reportContents, chooseReportScope, inspectReportCopies, cancelReportPreview } from "./report-journey-helpers.mjs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, navigateMain, chooseTheme } from "./helpers.mjs";

function records() {
    return Array.from({ length: 18 }, (_, s) => Array.from({ length: s === 0 ? 29 : 5 }, (_, r) => {
        const item = fixture(`disclosure-${s}-${r}`);
        item.sourceSessionId = `session-${s}`;
        item.sourceSessionName = `Synthetic session ${String(s + 1).padStart(2, "0")}`;
        item.projectId = s % 3 ? `project-${s % 3}` : null;
        item.project = item.projectId ? `Synthetic project ${s % 3}` : null;
        item.userPrompt.text = `Synthetic request ${s + 1}.${r + 1}: Review recorded calendar actions, without inferring task correctness.`;
        item.userPrompt.sourceTimestamp = new Date(Date.UTC(2026, 8, 30 - s, 12, 59 - r)).toISOString();
        item.toolCalls = Array.from({ length: s === 0 && r === 0 ? 37 : 3 }, (_, a) => ({
            ...structuredClone(item.toolCalls[0]), toolCallId: `call-${s}-${r}-${a}`, startEventId: `start-${s}-${r}-${a}`,
            toolSucceeded: [true, false, null][a % 3], reportedOutcome: "unknown", startedAt: item.userPrompt.sourceTimestamp,
        }));
        return item;
    })).flat();
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t) {
    const source = records(), { context } = await privateFixture(t, source);
    const controller = createExportController(context);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    const errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard reads in disclosure tests."); },
        writeText() { throw Error("No clipboard writes in disclosure tests."); },
    } }));
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); });
    await page.goto(runtime.url + "#activity"); await ready(page);
    assert.equal(await page.locator("#collectionForm").isVisible(), false);
    return { page, source, context, runtime, posts, controller, browser };
}
const group = (page, id = "session-0") => page.locator(`[data-session-id="${id}"]`);
async function outcomes(node) {
    return node.locator("[data-outcome]").evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.dataset.outcome, Number(n.dataset.count)])));
}
async function preview(page) {
    await reportContents(page);
    const response = page.waitForResponse(r => r.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const result = await response;
    const data = await result.json();
    assert.equal(result.status(), 200, JSON.stringify(data));
    await page.locator(".attestation [data-review-control]").waitFor();
    await inspectReportCopies(page);
    return data;
}

test("complete session groups, bounded cards, accessible independent toggles and unchanged selection/export identity", { timeout: 90000 }, async t => {
    const { page, context, posts } = await setup(t);
    const stateFile = (await readdir(context.dataDir)).find(name => name.endsWith(".state.json"));
    const before = await readFile(path.join(context.dataDir, stateFile));
    assert.equal(await page.locator(".session-group").count(), 8);
    assert.equal(await page.locator(".request-row").count(), 0, "Closed groups do not mount hidden cards");
    assert.match(await page.locator("#activityListSummary").innerText(), /114 request groups in 18 Copilot chats/);
    assert.match(await group(page).innerText(), /29 request groups with/);
    assert.deepEqual(await outcomes(group(page)), { success: 41, failure: 40, unknown: 40 });
    assert.match(await group(page).innerText(), /Copilot chat without a project/);
    const requests = posts.length, url = page.url(), toggle = group(page).locator(".session-toggle");
    await toggle.focus(); await page.keyboard.press("Enter");
    assert.equal(await group(page).locator(".request-row").count(), 6);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(page.url(), url);
    await page.keyboard.press("Space");
    assert.equal(await group(page).locator(".request-row").count(), 0);
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    assert.equal(posts.length, requests, "Disclosures do not collect, fetch, replay or write");
    await toggle.click();
    await group(page).locator(".request-row input").first().check();
    await group(page).getByRole("button", { name: "Next request groups", exact: true }).click();
    assert.match(await group(page).innerText(), /7-12 of 29 request groups/);
    const seen = new Set();
    await group(page).getByRole("button", { name: "Previous request groups", exact: true }).click();
    do {
        for (const id of await group(page).locator(".request-row").evaluateAll(nodes => nodes.map(n => n.dataset.viewKey))) {
            assert.equal(seen.has(id), false); seen.add(id);
        }
        const next = group(page).getByRole("button", { name: "Next request groups", exact: true });
        if (await next.isDisabled()) break;
        await next.click();
    } while (true);
    assert.equal(seen.size, 29);
    await toggle.click();
    assert.equal(await group(page).locator(".session-selected").innerText(), "1 in report");
    assert.match(await group(page).locator(".session-selected").getAttribute("title"), /^1 request group in this Copilot chat included in report/);
    await group(page, "session-1").locator(".session-toggle").click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await group(page, "session-1").locator(".request-row").count(), 5);
    const sessionIds = new Set(await page.locator(".session-group").evaluateAll(nodes => nodes.map(n => n.dataset.sessionId)));
    for (let i = 0; i < 2; i++) {
        await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
        for (const id of await page.locator(".session-group").evaluateAll(nodes => nodes.map(n => n.dataset.sessionId))) {
            assert.equal(sessionIds.has(id), false); sessionIds.add(id);
        }
    }
    assert.equal(sessionIds.size, 18);
    await navigateMain(page, "reports");
    assert.match(await page.locator("#previewSelectionSummary").innerText(), /1 chat · 1 interaction/);
    await reportContents(page);
    await page.locator("[name=promptMode][value=none]").check();
    const selected = await preview(page);
    assert.equal(selected.records.length, 1);
    assert.equal(selected.records[0].toolCalls.length, 37);
    await cancelReportPreview(page);
    await chooseReportScope(page, "current");
    const current = await preview(page);
    assert.equal(current.records.length, 114);
    assert.equal(new Set(current.records.map(r => r.scenarioId)).size, 114);
    assert.ok(current.records.some(record => record.scenarioId === selected.records[0].scenarioId));
    await cancelReportPreview(page);
    await page.getByRole("button", { name: "1. Activity", exact: true }).click();
    assert.equal(await page.locator("#reportList .report-entry").count(), 4);
    assert.match(await page.locator("#reportList").innerText(), /1-4 of 114 report requests/);
    await page.locator("#reportList").getByRole("button", { name: "Next report requests", exact: true }).click();
    assert.match(await page.locator("#reportList").innerText(), /5-8 of 114 report requests/);
    await reportContents(page);
    assert.equal(await page.locator("#reportRequests").isVisible(), false);
    assert.deepEqual(await readFile(path.join(context.dataDir, stateFile)), before);
    assert.ok(!posts.some(p => ["/api/export", "/api/move", "/api/import", "/api/record", "/api/collection/now"].includes(p)));
});

test("responsive defaults, search, direct links, Back, Reset and exact text retain presentation state", { timeout: 90000 }, async t => {
    const { page, source, runtime } = await setup(t);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 900 }); await chooseTheme(page, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator(".session-group button button,.session-toggle a,.session-toggle button").count(), 0);
        assert.equal(await page.locator(".session-toggle").evaluateAll(nodes => nodes.every(n => n.getBoundingClientRect().height >= 44 && n.getAttribute("aria-describedby") && document.getElementById(n.getAttribute("aria-controls")))), true);
        await page.locator("#activityInsights .assessment-grid").waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready);
        const { height, insights } = await page.evaluate(() => {
            const node = document.getElementById("activityInsights"), style = getComputedStyle(node);
            return { height: document.documentElement.scrollHeight, insights: node.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom) };
        });
        assert.ok(insights <= 550, `The new automatic insight summary stays compact: ${insights}px`);
        assert.ok(height - insights < ({ 375: 4621, 820: 3201, 1200: 2624 })[width] * .83,
            `Existing collapsed grouping retains its original page budget; ${height}px total includes ${insights}px of new visible insights`);
    }
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator("#activitySearch").fill("Synthetic request 2.1:");
    assert.equal(await page.locator(".session-group").count(), 1);
    assert.equal(await page.locator(".request-row").count(), 1);
    assert.doesNotMatch(page.url(), /Synthetic/);
    await page.locator("#activitySearch").fill("Synthetic request");
    assert.equal(await page.locator(".request-row").count(), 0, "Broad search does not auto-open all groups");
    await group(page).locator(".session-drill").click(); await ready(page);
    assert.equal(await group(page).locator(".session-toggle").getAttribute("aria-expanded"), "true");
    await group(page).getByRole("button", { name: "Next request groups", exact: true }).click();
    await group(page).locator(".request-link").first().click();
    const reader = page.locator(".request-original .full-text-toggle");
    if (await reader.getAttribute("aria-expanded") === "false") await reader.click();
    assert.match(await page.locator("#requestContent .request-original pre").innerText(), /Synthetic request 1.7:/);
    await page.goBack(); await ready(page);
    assert.match(await group(page).innerText(), /7-12 of 29 request groups/);
    await group(page).locator(".session-toggle").click();
    await navigateMain(page, "reports");
    await page.goBack(); await ready(page);
    assert.equal(await group(page).locator(".session-toggle").getAttribute("aria-expanded"), "false", "Back keeps a deliberately collapsed session");
    await group(page).locator(".session-drill").click(); await ready(page);
    assert.equal(await group(page).locator(".session-toggle").getAttribute("aria-expanded"), "true", "Choosing Open session deliberately reveals it");
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    await page.goBack(); await ready(page);
    assert.match(await group(page).innerText(), /7-12 of 29 request groups/);
    await page.goto(runtime.url + "#request?request=disclosure-0-0"); await ready(page);
    assert.equal(await page.locator(".journey-item").count(), 6);
    assert.match(await page.locator(".journey-pages").innerText(), /1-6 of 37 action records/);
    await page.locator(".journey-item").first().getByText("Technical details", { exact: true }).click();
    await page.locator(".journey-item").first().locator("summary").filter({ hasText: /^Exact recorded arguments \/ local only$/ }).click();
    assert.equal(await page.locator(".journey-item").first().locator("pre").innerText(), JSON.stringify(source[0].toolCalls[0].requestArgs, null, 2));
    await navigateMain(page, "home"); await navigateMain(page, "activity"); await page.goBack(); await page.goBack();
    await ready(page);
    assert.equal(await page.locator(".journey-item").first().locator("details[open]").count(), 2);
    await page.locator(".journey-pages").getByRole("button", { name: "Next action records", exact: true }).click();
    assert.match(await page.locator(".journey-pages").innerText(), /7-12 of 37 action records/);
    await page.locator(".journey-pages").getByRole("button", { name: "Previous action records", exact: true }).click();
    assert.equal(await page.locator(".journey-item").first().locator("details[open]").count(), 2);
});

test("collector snapshot keeps open group, page, selected IDs, focus and reading anchor while appending evidence", { timeout: 45000 }, async t => {
    const { page, source, context, runtime } = await setup(t);
    await group(page).locator(".session-toggle").click();
    await group(page).locator("input").first().check();
    await group(page).getByRole("button", { name: "Next request groups", exact: true }).click();
    const focus = group(page).locator(".request-link").nth(2);
    await focus.focus();
    await focus.evaluate(node => node.scrollIntoView({ block: "center" }));
    const before = await focus.boundingBox(), label = await focus.getAttribute("aria-label");
    const incoming = fixture("new-arrival");
    incoming.sourceSessionId = "session-new";
    incoming.sourceSessionName = "New session after collector update";
    const updated = structuredClone(source);
    updated[0].toolCalls[2].toolSucceeded = true;
    await replaceEvidence(context, () => ({ records: [incoming, ...updated], importCoverage: { counts: { includedSessions: 19 }, roster: [] } }));
    const revision = (await loadBoardState(context)).revision;
    await page.waitForFunction(expected => document.querySelector("#activityListSummary").textContent.includes(expected), "115 request groups", { timeout: 15000 });
    assert.equal(await group(page).locator(".session-toggle").getAttribute("aria-expanded"), "true");
    assert.match(await group(page).innerText(), /7-12 of 29 request groups/);
    assert.equal(await group(page).locator(".session-selected").innerText(), "1 in report");
    assert.match(await group(page).locator(".session-selected").getAttribute("title"), /Complete eligible request groups/);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), label);
    assert.ok(Math.abs((await focus.boundingBox()).y - before.y) <= 2);
    assert.equal(await page.locator(".session-group").first().getAttribute("data-session-id"), "session-0");
    assert.deepEqual(await outcomes(group(page).locator(".session-summary")), { success: 42, failure: 40, unknown: 39 });
    assert.ok(revision > 0);
    assert.equal((await runtime.collector.status()).state, "disconnected", "Synthetic fixture never approves a real source");
});

test("bounded prompt review retains edits and consent gates; presentation never rewrites old reports", { timeout: 90000 }, async t => {
    const { page, context } = await setup(t);
    await navigateMain(page, "reports");
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator("#formatOptions input[value=html]").uncheck();
    await page.locator("#formatOptions input[value=json]").check();
    const data = await preview(page);
    assert.ok(data.promptReview.length > 6);
    assert.equal(await page.locator(".prompt-comparison").count(), 1);
    assert.match(await page.locator(".prompt-review-summary").innerText(), new RegExp(`${data.promptReview.length} copies · \\d+ removals`));
    await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
    await page.locator(".prompt-comparison textarea").first().fill("SYNTHETIC EDIT KEPT ACROSS PAGES");
    await page.getByRole("button", { name: "Next report copies", exact: true }).click();
    await page.getByRole("button", { name: "Previous report copies", exact: true }).click();
    assert.equal(await page.locator(".prompt-comparison textarea").first().inputValue(), "SYNTHETIC EDIT KEPT ACROSS PAGES");
    assert.equal(await page.getByRole("button", { name: "3. Review & save", exact: true }).isDisabled(), true);
    assert.equal(await page.locator(".attestation [data-review-control]").isDisabled(), true);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    await page.locator(".attestation [data-review-control]:not(:disabled)").waitFor();
    assert.equal(await page.getByRole("button", { name: "Save report", exact: true }).isVisible(), false);
    await page.getByRole("button", { name: "1. Activity", exact: true }).click();
    await page.locator("#reportsView [data-clear-selection]").first().click();
    assert.equal(await page.locator("#previewSelectionSummary").innerText(), "No interactions included");
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

test("long exact tables, scan notes and saved history stay bounded with complete totals and immutable files", { timeout: 60000 }, async t => {
    const { page, source, context, runtime, controller, browser } = await setup(t);
    const dated = structuredClone(source);
    for (const [index, record] of dated.entries()) {
        for (const tool of record.toolCalls) tool.startedAt = new Date(Date.UTC(2026, 8, 1 + index % 45, 12)).toISOString();
    }
    await replaceEvidence(context, () => ({ records: dated, importCoverage: { counts: { includedSessions: 18 }, roster: [] } }));
    for (let i = 0; i < 8; i++) {
        const state = await loadBoardState(context), owner = "synthetic-history-" + i;
        const report = await controller.preview(owner, undefined, { promptMode: "none", formats: ["json"] }, { kind: "selected", revision: state.revision, scenarioIds: ["disclosure-0-0"] });
        await controller.review(owner, report.previewId, true);
        await controller.confirm(owner, report.previewId, true);
    }
    const state = await loadBoardState(context);
    const oldFiles = await Promise.all(state.exports.flatMap(bundle => Object.values(bundle.files)).map(async file => [file, await readFile(file)]));
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), data = await response.json();
        data.coverage.notes = Array.from({ length: 19 }, (_, i) => `Synthetic exact scan note ${i + 1}.`);
        await route.fulfill({ response, json: data });
    });
    await page.goto(runtime.url + "#home?bucket=day"); await ready(page);
    assert.equal(await page.locator("#countTable tbody tr").count(), 24, "Default-visible exact data stays bounded to its first page");
    if (!await page.locator("#tableDisclosure").evaluate(node => node.open)) await page.locator("#tableDisclosure>summary").click();
    assert.equal(await page.locator("#countTable tbody tr").count(), 24);
    const first = await page.locator("#countTable tbody td:first-child").allTextContents();
    const total = await page.locator("#countTable tfoot .numeric").first().innerText();
    assert.equal(total, "376");
    await page.getByRole("button", { name: "Next chart rows", exact: true }).click();
    assert.equal(await page.locator("#countTable tbody tr").count(), 21);
    const last = await page.locator("#countTable tbody td:first-child").allTextContents();
    assert.equal(new Set([...first, ...last]).size, 45);
    assert.equal(await page.locator("#countTable tfoot .numeric").first().innerText(), total);
    await page.locator("#coverage>summary").click();
    await page.locator("#coverage").getByRole("link", { name: "Collection status", exact: true }).click();
    await ready(page);
    assert.equal(await page.locator(".evidence-notes li").count(), 6);
    assert.match(await page.locator("#collectionEvidenceDetails").innerText(), /of 19 scan notes/);
    await navigateMain(page, "reports");
    assert.match(await page.locator("#savedLibraryTitle").innerText(), /\(8\)/);
    assert.equal(await page.locator("#bundleList .saved-library-row").count(), 6);
    await page.getByRole("button", { name: "Next saved reports", exact: true }).click();
    assert.equal(await page.locator("#bundleList .saved-library-row").count(), 2);
    for (const [file, bytes] of oldFiles) assert.deepEqual(await readFile(file), bytes);
    assert.equal((await loadBoardState(context)).revision, state.revision);
    const touch = await browser.newPage({ viewport: { width: 375, height: 820 }, hasTouch: true });
    await touch.goto(runtime.url + "#activity"); await ready(touch);
    await group(touch).locator(".session-toggle").tap();
    assert.equal(await group(touch).locator(".request-row").count(), 6);
    await group(touch).locator(".session-toggle").tap();
    assert.equal(await group(touch).locator(".request-row").count(), 0);
    await touch.close();
});
