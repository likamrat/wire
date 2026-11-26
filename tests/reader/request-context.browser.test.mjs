import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { fixture, privateFixture, selectActivityOption, openActivitySessions } from "../support/helpers.mjs";

function records() {
    const mixed = fixture("a-mixed");
    mixed.sourceSessionName = "Synthetic results session";
    mixed.userPrompt.text = "MIXED_PRIVATE: compare recorded results " + "with a deliberately long request excerpt ".repeat(14);
    mixed.toolCalls = [true, false, null].map((toolSucceeded, index) => ({
        ...structuredClone(mixed.toolCalls[0]), toolCallId: `mixed-${index}`, startEventId: `mixed-start-${index}`,
        startedAt: `2026-09-0${index + 1}T12:00:00Z`, toolSucceeded, reportedOutcome: "unknown",
        apiResults: index === 0 ? [{ index: 0, statusCode: 200 }, { index: 1, statusCode: 429 }, { index: 2 }] : [],
    }));
    const pure = (id, succeeded, projectId = "test-project") => {
        const source = fixture(id);
        source.userPrompt.text = "Synthetic " + id + " request";
        source.sourceSessionName = "Synthetic results session";
        source.projectId = projectId;
        source.project = projectId ? "Synthetic project" : null;
        source.toolCalls[0] = { ...source.toolCalls[0], startedAt: "2026-09-02T12:00:00Z", toolSucceeded: succeeded, reportedOutcome: "unknown" };
        return source;
    };
    const code = pure("code-only", null);
    code.toolCalls = [];
    code.graphActivities = [null, "code", 503].map((status, index) => ({
        activityId: "graph-" + index, sourceSessionId: code.sourceSessionId, scenarioId: code.scenarioId, toolCallId: "shell-" + index, startEventId: "graph-start-" + index, method: "GET",
        startedAt: "2026-09-02T12:00:00Z", tool: "shell",
        evidenceLevel: status === "code" ? "code-reference" : status === null ? "requested-direct-graph" : "output-visible-http",
        endpoint: { path: "/me/messages", method: "GET", apiVersion: "v1.0", queryShape: [] },
        workload: "Mail", httpStatus: typeof status === "number" ? status : null,
        statusBasis: typeof status === "number" ? "explicit-output-status" : "none",
        requestCount: null, countUnit: "recorded-request-site", confidence: "high", synthetic: false,
        sourceKind: "inline-command", requestBasis: "request-command",
        fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
    }));
    const alias = { ...structuredClone(mixed), scenarioId: "legacy-mixed", isLegacy: true };
    return [mixed, pure("all-worked", true), pure("failure-only", false), pure("no-completion", null, null), code, alias];
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await openActivitySessions(page);
}
async function setup(t, source = records()) {
    const cleanup = [];
    const { context: store } = await privateFixture({ after: action => cleanup.push(action) }, source);
    const stateName = (await readdir(store.dataDir)).find(name => name.endsWith(".state.json"));
    const before = await readFile(path.join(store.dataDir, stateName));
    const runtime = await startServer(store, createExportController(store), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, locale: "en-US", timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    const errors = [], posts = [];
    context.on("page", page => {
        page.setDefaultTimeout(8000);
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    });
    await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw new Error("No clipboard reads permitted in context proof."); },
        writeText() { throw new Error("No clipboard writes permitted in context proof."); },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await readFile(path.join(store.dataDir, stateName)), before);
            assert.deepEqual(errors, []);
            assert.ok(posts.every(url => ["/api/snapshot", "/api/assessment/detail", "/api/assessment/overview"].includes(url)), "Context navigation is read-only");
        } finally { for (const action of cleanup) await action(); }
    });
    return { context, url: runtime.url, posts };
}
const mixedCard = page => page.locator("#activityList .request-row").filter({ hasText: "MIXED_PRIVATE" });
test("partially overlapping request aliases do not double-count matching timeline actions", { timeout: 30000 }, async t => {
    const first = fixture("a-owner"), second = fixture("b-overlap");
    second.toolCalls.unshift(structuredClone(first.toolCalls[0]));
    second.userPrompt.text = "Synthetic overlapping request";
    const { context, url } = await setup(t, [first, second]), page = await context.newPage();
    await page.goto(url + "#activity?scope=all"); await ready(page);
    assert.match(await page.locator("#viewingContext").innerText(), /2 Work IQ tool calls/);
    const card = page.locator("#activityList .request-row").filter({ hasText: "Synthetic overlapping request" });
    assert.match(await card.innerText(), /1 of 2 Work IQ tool calls matches this view/);
    await card.locator(".request-card-open").click(); await ready(page);
    const included = page.locator('[data-reader-section="activity"] [data-tool-call-id]');
    await expect(included).toHaveCount(1);
    await expect(included).toHaveAttribute("data-tool-call-id", second.toolCalls[1].toolCallId);
    await page.getByRole("link", { name: "Show full activity" }).click();
    assert.deepEqual((await included.evaluateAll(nodes => nodes.map(node => node.dataset.toolCallId))).sort(),
        second.toolCalls.map(call => call.toolCallId).sort());
});

test("late filters and inconsistent revisions cannot relabel accepted counts", async t => {
    const { context, url } = await setup(t), page = await context.newPage();
    await page.goto(url + "#activity"); await ready(page);
    let release, intercepted;
    const pending = new Promise(resolve => { intercepted = resolve; });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), input = route.request().postDataJSON();
        if (input.filters.outcomes?.[0] === "success") {
            intercepted();
            await new Promise(resolve => { release = resolve; });
        }
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", "success"); await pending;
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    const late = page.waitForResponse(r => r.url().endsWith("/api/snapshot") && r.request().postDataJSON().filters.outcomes?.[0] === "success");
    release(); await (await late).finished();
    assert.match(await page.locator("#viewingContext").innerText(), /2 Work IQ tool calls.*Tool failed/s);
    await expect(mixedCard(page).getByRole("link", {name:"1 tool call failed",exact:true})).toBeVisible();
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.analytics.revision++;
        await route.fulfill({ response, json: snapshot });
    });
    const inconsistent = page.waitForResponse(r => r.url().endsWith("/api/snapshot"));
    await page.evaluate(() => dispatchEvent(new Event("online"))); await inconsistent; await ready(page);
    await expect(page.locator("#message")).toContainText(/last recorded snapshot.*changed during the read/s);
    assert.match(await page.locator("#viewingContext").innerText(), /2 Work IQ tool calls.*Tool failed/s);
});

test("refreshing with a malformed retained row cannot publish a broken or empty view", async t => {
    const { context, url } = await setup(t), page = await context.newPage();
    await page.goto(url + "#activity?result=failure"); await ready(page);
    const summary = page.locator("#activityListSummary"), before = await summary.innerText();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.requestActivity.tool = [null];
        await route.fulfill({ response, json: snapshot });
    });
    const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => dispatchEvent(new Event("online"))); await read; await ready(page);
    await expect(page.locator("#message")).toContainText(/last recorded snapshot|could not (?:read|refresh)|unavailable/i);
    await expect(summary).toHaveText(before);
    await expect(mixedCard(page)).toBeVisible();
});
