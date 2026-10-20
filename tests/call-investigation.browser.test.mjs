import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { privateFixture, chooseTheme } from "./helpers.mjs";
import { callInvestigationRecords } from "./call-investigation-fixture.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settled = page => page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
const exactURL = (runtime, request, call, layer = "tool", extra = {}) => runtime.url + "#request?"
    + new URLSearchParams({ request, call, layer, ...extra });
async function capture(page, name) {
    if (!process.env.WIRE_CALL_PROOFS) return;
    await mkdir(process.env.WIRE_CALL_PROOFS, { recursive: true });
    await page.mouse.move(0, 0); await settled(page);
    await page.screenshot({ path: path.join(process.env.WIRE_CALL_PROOFS, name + ".png") });
}

async function setup(t, records = callInvestigationRecords()) {
    const cleanup = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    let expected = await loadBoardState(context), snapshot, providerCalls = 0;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { providerCalls++; throw Error("No provider work in call investigation."); },
            readSource: async () => { providerCalls++; throw Error("No source reads in call investigation."); } } });
    const browser = await chromium.launch(), browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC",
    });
    const page = await browserContext.newPage(), errors = [], denied = [];
    await browserContext.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], expected[key], key);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.equal(providerCalls, 0);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url); await ready(page);
    return { page, runtime, context, records, browserContext, snapshot: () => snapshot,
        acceptFixtureChange: async () => { expected = await loadBoardState(context); } };
}

test("legacy Calls becomes scoped Activity without interpreting its old sort or page as interaction paging", async t => {
    const record = callInvestigationRecords()[1];
    record.toolCalls = [record.toolCalls[0], record.toolCalls[1], record.toolCalls[9], record.toolCalls[10]];
    record.toolCalls[1].durationMs = 7;
    record.graphActivities = []; record.httpRecords = [];
    const { page, runtime } = await setup(t, [record]);
    await page.goto(runtime.url + "#calls?layer=tool&callSort=fastest&page=4&scope=all"); await ready(page);
    const params = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
    assert.equal(params.get("scope"), "all");
    for (const field of ["mode", "callSort", "page"]) assert.equal(params.has(field), false);
    await expect(page.locator("#activityTitle")).toHaveText("Activity");
    await expect(page.locator("[data-analyze-mode],#callSort")).toHaveCount(0);
    await expect(page.locator(".request-card-open")).toHaveCount(1);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator(".request-card-open").click(); await settled(page);
        const elapsed = page.locator("#requestContent [data-reader-section=activity] .reader-call-duration");
        assert.deepEqual(await elapsed.locator(".call-duration").evaluateAll(nodes => nodes.map(node => node.getAttribute("value"))),
            ["0", "7", "900", null]);
        await expect(elapsed).toHaveText(["Tool latency: 0 ms", "Tool latency: 7 ms", "Tool latency: 900 ms", "Tool latency: Not recorded"]);
        await expect(page.locator(".reader-timing-column")).toHaveCount(0);
        await expect(elapsed.locator(".reader-duration-label")).toHaveText(["Tool latency:", "Tool latency:", "Tool latency:", "Tool latency:"]);
        await page.locator("#closeContextSidebar").click(); await settled(page);
    }
});

test("an exact successful call wins over failure entry and retains its full ordered context", async t => {
    const app = await setup(t), { page, runtime, records } = app;
    const target = app.snapshot().requestActivity.tool.find(row => row.toolCallId === "investigate-09");
    await page.goto(exactURL(runtime, records[1].scenarioId, target.id, "tool", { mode: "calls", page: "3", result: "failure" }));
    await ready(page); await settled(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", "investigate-09");
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator("#selectedCall>.action-context")).toContainText("Outside current view");
    await expect(page.locator("#selectedCall .reader-call-duration data")).toHaveAttribute("value", "900");
    await expect(page.locator("#selectedCall .technical-detail")).toBeVisible();
    await expect(page.locator("#selectedCall .reader-input-value code")).toHaveText(records[1].toolCalls[9].requestArgs.entityUrls);
    assert.deepEqual(await page.locator('[data-reader-section=activity] [data-tool-call-id]').evaluateAll(nodes => nodes.map(node => node.dataset.toolCallId)),
        records[1].toolCalls.map(call => call.toolCallId));
    await expect(page.locator("#requestContent")).not.toContainText("UNRELATED_CALL_CONTEXT");
    await expect(page.locator(".reader-timing-column")).toHaveCount(0);
    await page.goto(exactURL(runtime, records[1].scenarioId, "removed"));
    await ready(page);
    await expect(page.locator("#unavailableCall")).toBeFocused();
    await expect(page.locator("#selectedCall")).toHaveCount(0);
});

test("API result offsets, parent identity and snapshot revision fail closed instead of selecting a neighbor", async t => {
    const app = await setup(t), { page, runtime, records, context } = app;
    await chooseTheme(page, "dark");
    await page.goto(runtime.url + "#analyze?layer=reported-api"); await ready(page);
    await expect.poll(() => app.snapshot()?.analytics.layer).toBe("reported-api");
    const api = app.snapshot().analytics.rows.find(row => row.status === 429);
    const revision = String(app.snapshot().revision);
    assert.equal(api.resultIndex, 7);
    await page.goto(exactURL(runtime, records[1].scenarioId, api.id, "reported-api", { callRevision: revision, result: "success" }));
    await ready(page); await settled(page);
    const selected = page.locator("#selectedCall");
    await expect(page.locator("#contextSidebarTitle")).toHaveText("API result in context");
    await expect(selected).toHaveAttribute("data-result-id", api.id);
    await expect(selected).toBeFocused();
    await expect(selected).toBeInViewport();
    await expect(selected.locator("code.api-path")).toHaveText("/me/messages");
    await expect(selected.locator(".action-service")).toHaveText("Mail");
    await expect(selected.locator(".reader-api-duration data")).toHaveAttribute("value", "800");
    await expect(selected).toContainText("Outside current view");
    const parent = page.locator('[data-selected-action=true]');
    await expect(parent).toHaveAttribute("data-tool-call-id", "investigate-09");
    await expect(parent.locator(":scope > .technical-detail")).toBeHidden();
    await capture(page, "exact-api-result");
    await expect(page.locator(".selected-api-result .returned-api-entries .api-result-entry")).toHaveCount(6);
    await expect(page.locator(".returned-api-entries .reader-api-duration data").filter({ hasText: "0 s" })).toHaveAttribute("value", "0");
    await page.getByRole("button", { name: "Next returned results", exact: true }).click();
    await expect(page.locator(".selected-api-result .returned-api-entries .api-result-entry")).toHaveCount(2);
    records[1].toolCalls[9].apiResults.shift();
    await replaceEvidence(context, () => ({ records }));
    await app.acceptFixtureChange();
    await page.reload(); await ready(page);
    await expect(page.locator("#unavailableCall")).toContainText("matching snapshot revision");
    await expect(page.locator("#selectedCall")).toHaveCount(0);
    await expect(page.locator(".request-context-timeline")).toHaveCount(0);
    await capture(page, "stale-api-result");
});

test("other evidence layers retain their own units and do not receive a tool failure entry or heading", async t => {
    const app = await setup(t, [callInvestigationRecords()[1]]), { page, runtime, records } = app;
    for (const layer of ["http", "direct-request", "recorded-http", "code-reference", "reported-api"]) {
        await page.goto(runtime.url + "#analyze?layer=" + layer); await ready(page);
        await page.locator(".request-card-open").click(); await settled(page);
        await expect(page.locator("#contextSidebarTitle")).toBeFocused();
        await expect(page.locator(".reader-timing-column")).toHaveCount(0);
        await expect(page.locator('#requestContent [data-result-layer="code-reference"]')).toContainText("Execution not observed");
        const rows = page.locator('[data-reader-section=activity] .reader-call-row');
        await expect(rows.locator(".reader-call-duration").filter({ hasText: "Recorded duration:" })).toHaveCount(3);
    }
    const http = app.snapshot().requestActivity.http.find(row => row.status == null);
    await page.goto(exactURL(runtime, records[0].scenarioId, http.id, "http")); await ready(page);
    await expect(page.locator("#contextSidebarTitle")).toHaveText("HTTP record in context");
    await expect(page.locator("#selectedCall .call-heading")).toContainText("Connection failed");
    await expect(page.locator("#selectedCall")).toContainText("No HTTP response recorded.");
    const reference = app.snapshot().requestActivity["code-reference"][0];
    await page.goto(exactURL(runtime, records[0].scenarioId, reference.id, "code-reference")); await ready(page);
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Code reference in context");
    await expect(page.locator("#selectedCall")).toContainText("Execution not observed");
    await expect(page.locator("#selectedCall .reader-call-duration")).toHaveCount(0);
});

test("a modified native card link opens untargeted context rather than replaying the homepage gesture default", async t => {
    const { page, browserContext } = await setup(t, [callInvestigationRecords()[1]]);
    const opened = browserContext.waitForEvent("page");
    await page.locator(".request-card-open").click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    const other = await opened; await other.waitForLoadState(); await ready(other); await settled(other);
    assert.equal(new URLSearchParams(new URL(other.url()).hash.split("?")[1]).has("call"), false);
    await expect(other.locator("#contextSidebarTitle")).toBeFocused();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
});
