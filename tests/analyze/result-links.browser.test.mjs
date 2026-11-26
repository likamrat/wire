import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { fixture, privateFixture, restoreLegacySearch } from "../support/helpers.mjs";
import { searchFixture } from "../search/live-search-fixture.mjs";
import { frontendRecords } from "../support/frontend-fixture.mjs";

test("the Analyze donut opens readable exact calls with paging and an independent returned HTTP status", async t => {
    const records = frontendRecords(10);
    const extra = structuredClone(records[1].toolCalls[0]);
    Object.assign(extra, { toolCallId:"mixed-result", startEventId:"mixed-start", completionEventId:"mixed-end" });
    extra.apiResults[0].statusCode = 403;
    records[1].toolCalls.push(extra);
    const app = await searchFixture(t, { records, frontend:"react", reply:false });
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1150,height:900}, reducedMotion:"reduce"});
    await page.goto(app.runtime.url);
    const center = page.locator("#outcomeChart .percentage-total-link");
    await expect(center.locator(".percentage-total-value")).toHaveText("11"); await center.press("Enter");
    const rows = page.locator("#activityList .widget-record"), position = page.locator("#activityPagePosition");
    await expect(page.locator("#activityListSummary")).toHaveText("Recorded activity: 11 matching tool calls");
    await expect(position).toHaveText("1-8 of 11 Work IQ tool calls");
    async function assertLegible() {
        const list = await rows.allInnerTexts();
        assert.ok(list.length && list.every(text => !/\S(?:Tool (?:failed|completed)|No result recorded)/.test(text)), list.join("\n"));
        assert.ok(await rows.first().evaluate(n => {
            const a = n.querySelector("a").getBoundingClientRect(), meta = n.lastElementChild.getBoundingClientRect();
            return meta.top > a.bottom || meta.left > a.right;
        }));
    }
    await assertLegible();
    const ids = () => rows.evaluateAll(nodes => nodes.map(n=>n.dataset.actionId));
    const first = await ids();
    await page.locator("#activityPager button[data-page-direction='1']").click();
    await expect(position).toHaveText("9-11 of 11 Work IQ tool calls");
    const expected = records.flatMap(r=>r.toolCalls.map(c=>`call:${JSON.stringify([r.sourceSessionId,c.toolCallId])}`)).sort();
    assert.deepEqual([...first,...await ids()].sort(),expected);
    await page.goBack(); await expect(position).toHaveText("1-8 of 11 Work IQ tool calls");
    await page.goBack(); await expect(center).toBeFocused();
    const completed = page.locator("#outcomeChart [data-category=success] .percentage-label");
    await completed.press("Enter");
    await expect(page.locator("#activityListSummary")).toContainText("8 matching tool calls");
    // An outcome link narrows the accepted scope. The center now opens those exact 8 calls.
    await expect(center.locator(".percentage-total-value")).toHaveText("8");
    await expect(center.locator(".percentage-total-unit")).toHaveText("tool calls");
    await expect(center).toHaveAccessibleName("View all 8 Work IQ tool calls");
    await center.press("Enter");
    await page.setViewportSize({width:390,height:844}); await assertLegible();
    const mixed = rows.filter({has:page.locator("a")}).and(page.locator('[data-action-id*="mixed-result"]'));
    await expect(mixed).toContainText("Tool completed");
    await expect(mixed).not.toContainText("Tool failed");
    const open = mixed.getByRole("link"); await open.press("Enter");
    const call = page.locator('#requestContent [data-tool-call-id="mixed-result"]');
    await expect(call).toBeFocused(); await call.locator(".reader-call-toggle").click();
    await expect(call).toContainText("403"); await page.goBack(); await expect(open).toBeFocused();
});

test("a positive outcome drilldown keeps the private parent match and does not admit a sibling in its chat", async t => {
    const records = ["Invented survey match", "Invented other parent"].map((text, i) => {
        const r = fixture(`private-parent-${i}`);
        r.userPrompt.text = text;
        r.toolCalls = Array.from({length: 7}, (_, j) => ({...r.toolCalls[0], toolCallId: `call-${i}-${j}`,
            startEventId: `start-${i}-${j}`, toolSucceeded: j < 6, reportedOutcome: j < 6 ? "succeeded" : "failed"}));
        return r;
    });
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const urls = [];
    page.on("request", r => urls.push(r.url()));
    await page.goto(runtime.url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await restoreLegacySearch(page, "survey match");
    const completed = page.locator('#outcomeChart [data-category="success"] .percentage-label');
    await expect(completed).toHaveAccessibleName(/6 of 7 Work IQ tool calls/);
    await completed.press("Enter");
    await expect(page.locator("#activityListSummary")).toContainText("6 matching tool calls");
    const population = page.locator("#outcomeChart").getByRole("link", { name: "View all 6 Work IQ tool calls", exact: true });
    await population.click();
    const calls = page.locator("#activityList .widget-record");
    await expect(calls).toHaveCount(6);
    assert.deepEqual((await calls.evaluateAll(nodes => nodes.map(n => n.dataset.actionId))).sort(),
        Array.from({length: 6}, (_, i) => `call:["test-session","call-0-${i}"]`));
    assert.ok(urls.every(url => !decodeURIComponent(url).includes("survey match")));
});
