import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { extractGraphActivities } from "../../lib/graph-history.mjs";
import { loadBoardState, replaceEvidence } from "../../lib/store.mjs";
import { fixture, privateFixture, selectActivityOption } from "../support/helpers.mjs";

const outcomes = ["success", "failure", "unknown", "partial", "other", "transport"];

function records() {
    return ["succeeded", "failed", undefined, "partial"].map((outcome, index) => {
        const record = fixture(`shared-result-${index}`);
        record.userPrompt.text = `Synthetic shared result ${index}`;
        record.toolCalls[0] = {
            ...record.toolCalls[0], toolSucceeded: undefined, reportedOutcome: outcome,
            tool: index % 2 ? "workiq-call_function" : "workiq-fetch",
            startedAt: `2026-09-${10 + index * 5}T12:00:00Z`,
            requestArgs: { entityUrls: [index % 2 ? "/me/messages" : "/me/calendar"] },
            requestedApiPath: index % 2 ? "/me/messages" : "/me/calendar",
        };
        return record;
    });
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t, source = records()) {
    const { context } = await privateFixture(t, source);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 960 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const reads = [], errors = [], writes = [], snapshotRequests = [];
    let observedInitialSnapshot;
    const initialSnapshot = new Promise(resolve => { observedInitialSnapshot = resolve; });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST") {
            const pathname = new URL(request.url()).pathname;
            if (pathname === "/api/snapshot") snapshotRequests.push(request.postDataJSON());
            if (!["/api/snapshot", "/api/collection/status"].includes(pathname)) writes.push(pathname);
        }
    });
    page.on("response", async response => {
        if (response.url().endsWith("/api/snapshot") && response.ok()) {
            reads.push({ input: response.request().postDataJSON(), snapshot: await response.json() });
            observedInitialSnapshot();
        }
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []);
        assert.deepEqual(writes, [], "Outcome filters cannot mutate collection, evidence, review or reports");
    });
    await page.goto(runtime.url); await ready(page); await initialSnapshot;
    return { page, reads, snapshotRequests, context, runtime, source };
}

const number = value => Number(value.replaceAll(",", ""));

const selectedResults = page => page.locator("#outcomeFilter").evaluate(node => [...node.selectedOptions].map(option => option.value));
const rowIds = page => page.locator("#activityList article").evaluateAll(rows => rows.map(r => r.dataset.viewKey).sort());
async function facetCount(page, key) {
    if (key === "all") return number((await page.locator("#outcomeFilter").getAttribute("data-all-label")).match(/\(([\d,]+)\)$/)[1]);
    const label = await page.locator(`#outcomeFilter option[value="${key}"]`).textContent();
    return number(label.match(/\(([\d,]+)\)$/)[1]);
}

test("late, failed and equal-count mismatched unions cannot replace the accepted result set", async t => {
    const { page } = await setup(t);
    await selectActivityOption(page, "outcomeFilter", ["success", "unknown"]); await ready(page);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        if (route.request().postDataJSON().filters.outcomes?.join(",") === "failure,partial") await hold;
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", ["failure", "partial"]);
    assert.equal(await page.locator("#workspace").getAttribute("aria-busy"), "true");
    assert.deepEqual(await selectedResults(page), ["success", "unknown"]);
    assert.equal(await page.locator("#outcomeFilter-control").innerText(), "2 statuses");
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.deepEqual(await rowIds(page), ["request:shared-result-0", "request:shared-result-2"]);
    await selectActivityOption(page, "outcomeFilter", ["success", "partial"]); await ready(page);
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
        && response.request().postDataJSON().filters.outcomes?.join(",") === "failure,partial");
    release(); await late;
    assert.deepEqual(await selectedResults(page), ["success", "partial"]);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Synthetic union failure" } }));
    await selectActivityOption(page, "outcomeFilter", ["unknown", "other"]); await ready(page);
    assert.match(await page.locator("#message").innerText(), /Synthetic union failure/);
    assert.deepEqual(await selectedResults(page), ["success", "partial"]);
    assert.equal(new URL(page.url()).searchParams.has("result"), false);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", async route => {
        const input = route.request().postDataJSON();
        const response = await route.fetch({ postData: JSON.stringify({ ...input, filters: { ...input.filters, outcomes: ["unknown", "partial"] } }) });
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", ["success", "failure"]); await ready(page);
    assert.match(await page.locator("#message").innerText(), /result filter does not match/);
    assert.deepEqual(await selectedResults(page), ["success", "partial"]);
    assert.deepEqual(await rowIds(page), ["request:shared-result-0", "request:shared-result-3"]);
    await page.unroute("**/api/snapshot");
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    assert.deepEqual(await rowIds(page), records().map(r => `request:${r.scenarioId}`));
});

test("finishing a previously applied read preserves a newer draft without committing it", async t => {
    const { page, snapshotRequests } = await setup(t);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        await hold;
        await route.fulfill({ response });
    });

    await selectActivityOption(page, "outcomeFilter", ["failure", "partial"]);
    const requests = snapshotRequests.length;
    await page.locator("#outcomeFilter-control").click();
    await page.locator(".select-all").click();
    await page.locator('.select-option[data-value="success"]').click();
    await page.locator('.select-option[data-value="unknown"]').click();
    release(); await ready(page);
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("aria-expanded"), "true");
    assert.deepEqual(await page.locator(".select-option[aria-selected=true]").evaluateAll(nodes => nodes.map(node => node.dataset.value)), ["success", "unknown"]);
    assert.deepEqual(await selectedResults(page), ["failure", "partial"], "Only the previously applied set is accepted");
    assert.equal(snapshotRequests.length, requests, "Finishing an earlier read never submits the newer draft");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(await selectedResults(page), ["failure", "partial"]);
    assert.equal(snapshotRequests.length, requests);
});

test("clearing a pending outcome keeps the accepted date and a newer date draft", async t => {
    const { page } = await setup(t);
    await selectActivityOption(page, "projectFilter", "test-project"); await ready(page);
    await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        if (route.request().postDataJSON().filters.outcomes?.includes("failure")) await gate.promise;
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", "failure");
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-20"); await page.locator("#toFilter").fill("2026-09-20");
    const pending = page.waitForRequest(r => r.url().endsWith("/api/snapshot")
        && r.postDataJSON().filters.from === "2026-09-20" && r.postDataJSON().filters.outcomes?.includes("failure"));
    await page.locator("#applyDates").click(); await pending;
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-19");
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
    const late = page.waitForResponse(r => r.url().endsWith("/api/snapshot")
        && r.request().postDataJSON().filters.from === "2026-09-20" && r.request().postDataJSON().filters.outcomes?.includes("failure"));
    gate.resolve(); await (await late).finished(); await ready(page);
    assert.deepEqual(await selectedResults(page), outcomes);
    assert.deepEqual(await rowIds(page), ["request:shared-result-2"]);
    await expect(page.locator("#periodResult")).toContainText("Sep 20, 2026");
    await expect(page.locator("#fromFilter")).toHaveValue("2026-09-19");
    await expect(page.locator("#projectFilter")).toHaveValue("test-project");
    await expect(page.locator("#serviceFilter")).toHaveValue("Calendar");
    await expect(page.locator("#outcomeFilter-control")).toBeFocused();
    assert.equal(new URL(page.url()).searchParams.has("result"), false);
});

test("HTTP, returned-result and Graph layers retain their units; code references cannot claim tool success", async t => {
    const source = records();
    for (const [index, record] of source.entries()) record.toolCalls[0].apiResults = [{ index: 0, statusCode: [200, 503, null, 302][index] }];
    source[0].httpRecords = [200, 503, null, 302, null].map((status, index) => ({
        recordId: `shared-http-${index}`, classification: "direct-graph-http", synthetic: false,
        observedGraphHttp: status !== null, responseOrigin: status !== null ? "https://graph.microsoft.com" : null,
        apiVersion: "v1.0", method: "GET", responsePath: { path: "/me/messages", query: [] }, status,
        transportError: index === 4 ? "TimeoutError" : null, startedAt: "2026-09-20T12:00:00Z",
    }));
    const graphSource = { sessionId: "11111111-1111-4111-8111-111111111111", projectId: "test-project", eligible: true,
        checkedAt: "2026-10-04T00:00:00Z", archiveEvidence: { archived_at: null, workspaces: [] } };
    const events = [{ id: "prompt", type: "user.message", timestamp: "2026-09-20T12:00:00Z", data: { content: "Synthetic graph history" } }];
    for (const [index, output] of ["HTTP/2 200", "HTTP/2 503", "No retained status", ""].entries()) {
        events.push({ id: `start-${index}`, type: "tool.execution_start", timestamp: "2026-09-20T12:00:00Z",
            data: { toolCallId: `graph-${index}`, toolName: "powershell", arguments: { command: index === 3
                ? "git diff -- src/api.ts # https://graph.microsoft.com/v1.0/me/messages" : "curl 'https://graph.microsoft.com/v1.0/me/messages'" } } });
        events.push({ id: `end-${index}`, type: "tool.execution_complete", timestamp: "2026-09-20T12:01:00Z",
            data: { toolCallId: `graph-${index}`, success: true, result: { content: output } } });
    }
    source.push(...extractGraphActivities(events, graphSource).scenarios);
    const { page } = await setup(t, source);
    for (const [layer, keys, selected, label, unit] of [
        ["reported-api", ["success", "failure", "unknown", "other"], "failure", "Error result", "tool-returned API result"],
        ["http", ["success", "failure", "unknown", "other", "transport"], "transport", "Connection failed", "owned HTTP record"],
        ["direct-request", ["success", "failure", "unknown"], "unknown", "No status recorded", "recorded Graph request site"],
        ["recorded-http", ["success", "failure"], "failure", "HTTP 4xx/5xx", "Graph request site with visible status"],
    ]) {
        await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
        await selectActivityOption(page, "layerFilter", layer); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText(String(keys.length));
        await selectActivityOption(page, "outcomeFilter", selected); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("1");
        await expect(page.locator("#activityUnit")).toHaveText(unit);
        await expect(page.locator("#resultSummary")).toContainText(label);
        await expect(page.locator("#resultSummary")).not.toContainText(/Tool completed|Tool failed/);
        for (const key of outcomes) assert.equal(await facetCount(page, key), Number(keys.includes(key)), `${layer}/${key}`);
    }
    await selectActivityOption(page, "layerFilter", "code-reference"); await ready(page);
    assert.match(await page.locator("#resultFilterScope").innerText(), /unavailable.*execution is not observed/);
    assert.equal(await page.locator("#outcomeFilter").isDisabled(), true);
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator("#activityUnit").innerText(), "Graph code reference");
    assert.doesNotMatch(await page.locator("#resultSummary").innerText(), /Tool completed|Tool failed/);
});

test("pending, failed, late and malformed reads keep the complete last accepted chart and facet", async t => {
    const { page } = await setup(t);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    const accepted = await page.locator("#resultSummary").innerText();
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().filters.outcomes?.[0] === "failure") {
            const response = await route.fetch();
            await hold;
            await route.fulfill({ response });
        } else await route.continue();
    });
    await selectActivityOption(page, "outcomeFilter", "failure");
    assert.equal(await page.locator("#workspace").getAttribute("aria-busy"), "true");
    assert.equal((await page.locator("#resultSummary").innerText()).replace(" Updating view...", ""), accepted);
    await expect(page.locator("#chart .flat-time-column")).toHaveAttribute("data-total", "1");
    await expect(page.locator('#outcomeChart li[data-category="success"]')).toHaveAttribute("data-count", "1");
    await expect(page.locator('#outcomeChart li[data-category="failure"]')).toHaveAttribute("data-count", "0");
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    assert.match(await page.locator("#resultFilterScope").innerText(), /Updating view/);
    assert.equal(await page.locator("#resultSummary").getAttribute("aria-busy"), "true");
    await selectActivityOption(page, "outcomeFilter", "unknown"); await ready(page);
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.outcomes?.[0] === "failure");
    release(); await late;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "unknown");
    assert.deepEqual(await rowIds(page), ["request:shared-result-2"]);
    assert.doesNotMatch(page.url(), /[?&]result=/);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Synthetic result filter failure" } }));
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "unknown");
    assert.match(await page.locator("#message").innerText(), /Synthetic result filter failure/);
    assert.match(await page.locator("#periodResult").innerText(), /Previous results/);
    assert.doesNotMatch(page.url(), /[?&]result=/);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.analytics.resultFacet.totals.count++;
        await route.fulfill({ response, json: snapshot });
    });
    await selectActivityOption(page, "outcomeFilter", "partial"); await ready(page);
    assert.match(await page.locator("#message").innerText(), /Available result counts do not match/);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "unknown");
    await page.unroute("**/api/snapshot");
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "4");
});

test("new retained records while filtered update the same revision and preserve dropdown focus", async t => {
    const { page, reads, context, source } = await setup(t);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    const previousRevision = reads.at(-1).snapshot.revision;
    const added = structuredClone(source[1]);
    added.scenarioId = "new-failure";
    added.toolCalls[0].toolCallId = "new-failure-call";
    added.toolCalls[0].startEventId = "new-failure-event";
    const refreshed = page.waitForResponse(async r => r.url().endsWith("/api/snapshot") && r.ok() && (await r.json()).revision > previousRevision);
    await page.locator("#outcomeFilter-control").focus();
    await replaceEvidence(context, () => ({ records: [...source, added] }));
    const snapshot = await (await refreshed).json();
    await ready(page);
    assert.ok(snapshot.revision > previousRevision);
    assert.equal(await facetCount(page, "failure"), 2);
    assert.equal(await facetCount(page, "all"), 5);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.deepEqual(await rowIds(page), ["request:shared-result-0"]);
    await expect(page.locator("#outcomeFilter-control")).toBeFocused();
    const state = await loadBoardState(context);
    const updated = structuredClone(source);
    updated[2].toolCalls[0].reportedOutcome = "succeeded";
    const background = page.waitForResponse(async response => response.url().endsWith("/api/snapshot") && response.ok()
        && (await response.json()).revision > state.revision, { timeout: 10000 });
    await replaceEvidence(context, () => ({ records: [...updated, added] }));
    await background; await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.deepEqual(await rowIds(page), ["request:shared-result-0", "request:shared-result-2"]);
    assert.equal(await facetCount(page, "all"), 5);
    assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => node === document.activeElement), true);
});

test("all-zero facets still offer every canonical outcome and a single local recovery", async t => {
    const { page, reads } = await setup(t, []);
    for (const key of outcomes) {
        assert.equal(await facetCount(page, key), 0);
        await selectActivityOption(page, "outcomeFilter", key); await ready(page);
        assert.equal(await page.locator("#outcomeFilter").inputValue(), key);
        assert.equal(await page.locator("#activityCount").innerText(), "0");
        assert.equal(await page.getByRole("button", { name: /^Remove outcome filter:/ }).count(), 1);
        assert.equal(await page.locator("#clearResultFilter").isVisible(), false);
        assert.equal(await page.locator("#chart button").count(), 0, "Recovery belongs to the filter, not a second reset");
        assert.deepEqual(reads.at(-1).input.filters.outcomes, [key]);
    }
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).press("Enter"); await ready(page);
    assert.deepEqual(await selectedResults(page), outcomes);
    assert.equal(await page.getByRole("button", { name: /^Remove outcome filter:/ }).count(), 0);
});

test("choosing the accepted value cancels newer intent and an unchanged background poll preserves the open menu", async t => {
    const { page } = await setup(t);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        if (route.request().postDataJSON().filters.outcomes?.[0] === "failure") await hold;
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", "failure");
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.outcomes?.[0] === "failure");
    release(); await late;
    assert.doesNotMatch(page.url(), /[?&]result=/);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    await page.locator("#outcomeFilter-control").press("ArrowDown");
    await page.locator("#outcomeFilter-control").press("ArrowDown");
    const activeId = await page.locator("#outcomeFilter-control").getAttribute("aria-activedescendant");
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"), { timeout: 10000 });
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("aria-activedescendant"), activeId);
    await page.keyboard.press("Escape");
});
