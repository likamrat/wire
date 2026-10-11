import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { privateFixture, selectActivityOption, chooseTheme, revealStoredRefresh } from "./helpers.mjs";
import { callInvestigationRecords } from "./call-investigation-fixture.mjs";

const proofs = process.env.WIRE_CALL_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const ids = page => page.locator("#activityList .matched-action").evaluateAll(nodes => nodes.map(node => node.dataset.actionId));
const row = (page, id) => page.locator("#activityList .matched-action").filter({ has: page.locator(`a.request-link[href*="${encodeURIComponent(id)}"]`) });

async function setup(t) {
    const cleanup = [], records = callInvestigationRecords();
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    let expected = await loadBoardState(context), runtime, browser;
    const errors = [], denied = [], requests = [];
    let providerCalls = 0;
    t.after(async () => {
        try {
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], expected[key], key);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.equal(providerCalls, 0);
            assert.doesNotMatch(JSON.stringify(requests), /Three synthetic documents|Find five synthetic|UNRELATED_CALL_CONTEXT/);
        } finally {
            try { await browser?.close(); await runtime?.close(); }
            finally { for (const action of cleanup) await action(); }
        }
    });
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { providerCalls++; throw Error("No provider work in call investigation."); },
            readSource: async () => { providerCalls++; throw Error("No source reads in call investigation."); } } });
    browser = await chromium.launch();
    const browserContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", timezoneId: "UTC" });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(6000);
    const readPaths = ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
    let snapshot;
    await browserContext.route("**/*", route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== new URL(runtime.url).origin || req.method() !== "GET" && !readPaths.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        requests.push({ path: url.pathname, body: req.postData(), url: req.url() });
        return route.continue();
    });
    browserContext.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    await browserContext.addInitScript(() => {
        window.callClipboard = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("No real clipboard reads."); },
            async writeText(text) { window.callClipboard.push(text); },
        } });
    });
    return { page, runtime, context, records, requests, snapshot: () => snapshot,
        acceptFixtureChange: async () => { expected = await loadBoardState(context); } };
}
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true }); await frames(page);
    await page.screenshot({ path: path.join(proofs, name + ".png") });
    await writeFile(path.join(proofs, name + ".txt"), await page.locator("#workspace").ariaSnapshot());
}
function exactURL(runtime, request, call, layer = "tool", extra = {}) {
    return runtime.url + "#request?" + new URLSearchParams({ request, call, layer, mode: "calls", ...extra });
}

test("Calls sort all canonical matches, anchor a nonfirst action in full context, and restore exact Back state", { timeout: 45000 }, async t => {
    const app = await setup(t), { page, runtime, records, requests } = app;
    await page.goto(runtime.url + "#analyze"); await ready(page);
    const targetGroup = records[1].scenarioId;
    const interaction = page.locator(".request-row").filter({ has: page.locator(`a.request-link[href*="${targetGroup}"]`) });
    await interaction.locator("input").check();
    await page.locator("#activitySearch").fill("synthetic documents");
    await selectActivityOption(page, "serviceAssociationFilter", "Files");
    await selectActivityOption(page, "promptAuthorFilter", "user");
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-30"); await page.locator("#toFilter").fill("2026-09-30");
    await page.locator("#applyDates").click(); await ready(page);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    await expect(page.locator("#callSortControls")).toBeVisible();
    await expect(page.locator("#callTimingScope")).toContainText("2 unavailable");
    const expected = app.snapshot().analytics.rows.slice().sort((a, b) =>
        (a.durationMs === null ? b.durationMs === null ? 0 : 1 : b.durationMs === null ? -1 : b.durationMs - a.durationMs)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(row => row.id);
    const first = await ids(page);
    assert.deepEqual(first, expected.slice(0, 8));
    await capture(page, "calls-slowest-light");
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click(); await ready(page);
    assert.deepEqual([...first, ...await ids(page)], expected);
    await page.goBack(); await ready(page);
    const beforeReads = requests.filter(req => req.path === "/api/snapshot").length;
    await selectActivityOption(page, "callSort", "fastest"); await ready(page);
    assert.equal(requests.filter(req => req.path === "/api/snapshot").length, beforeReads);
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click(); await ready(page);
    await expect(page.locator("#activityList")).toContainText("Duration unavailable");
    const target = app.snapshot().analytics.rows.find(row => row.toolCallId === "investigate-09");
    const open = row(page, target.id).locator(".request-link");
    await open.focus(); await frames(page);
    const origin = page.url(), position = await open.boundingBox();
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-action-id", target.id);
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator("#selectedCall")).toBeInViewport();
    assert.equal(requests.filter(req => req.path === "/api/snapshot").length, beforeReads);
    await expect(page.locator(".request-context-timeline [data-context-kind=action]")).toHaveCount(20);
    await expect(page.locator(".request-context-timeline")).toContainText(records[0].userPrompt.text);
    await expect(page.locator(".request-context-timeline")).toContainText(records[1].userPrompt.text.trim());
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /UNRELATED_CALL_CONTEXT/);
    await expect(page.locator("#selectedCall")).toContainText("900 ms");
    await expect(page.locator("#selectedCall")).toContainText("1 matching Work IQ tool call");
    await expect(page.locator(".request-context-summaries")).toContainText("original recorded group and assessment scope");
    await capture(page, "exact-call-context-light");
    await page.locator("#selectedCall").getByText("Technical details", { exact: true }).click();
    await page.locator("#selectedCall").getByText("Exact recorded arguments / local only", { exact: true }).first().click();
    await page.locator("#selectedCall").getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.callClipboard), [JSON.stringify(records[1].toolCalls[9].requestArgs, null, 2)]);
    await page.locator("#contextBack").click(); await ready(page); await frames(page);
    assert.equal(page.url(), origin);
    await expect(open).toBeFocused();
    assert.ok(Math.abs((await open.boundingBox()).y - position.y) < 3);
    await expect(page.locator("#activitySearch")).toHaveValue("synthetic documents");
    await expect(page.locator("#callSort")).toHaveValue("fastest");
    await expect(page.locator("#serviceFocusScope")).toContainText("Files + calls with missing service details");
    await page.locator('[data-analyze-mode="interactions"]').click();
    await expect(interaction.locator("input")).toBeChecked();
    await page.locator('[data-analyze-mode="calls"]').click();
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    const failed = app.snapshot().analytics.rows.find(row => row.toolCallId === "investigate-08");
    await row(page, failed.id).locator(".request-link").click(); await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", "investigate-08");
    await expect(page.locator("#requestContent")).toContainText("Outside current view");
    await expect(page.locator("#requestContent")).toContainText("Completion is not correctness");
    await page.goBack(); await ready(page);
    await expect(page.locator("#outcomeFilter")).toHaveValues(["failure"]);
    assert.doesNotMatch(page.url(), /synthetic.documents/);
});

test("selected API result beyond the first details page opens its exact retained parent and entry", { timeout: 30000 }, async t => {
    const app = await setup(t), { page, runtime, records } = app;
    await page.goto(runtime.url + "#analyze?mode=calls&layer=reported-api"); await ready(page);
    await expect.poll(() => app.snapshot()?.analytics.layer).toBe("reported-api");
    const api = app.snapshot().analytics.rows.find(row => row.status === 429);
    assert.equal(api.resultIndex, 7, "Repeated source indexes cannot identify a result");
    assert.equal(api.workload, "Multiple workloads", "The legacy parent category is unchanged");
    assert.deepEqual(api.serviceAssociation.services, ["Mail"]);
    await expect(row(page, api.id).locator(".action-service")).toHaveText("Mail");
    const unattributed = app.snapshot().analytics.rows.find(row => row.serviceAssociation.gaps.some(gap => gap.reason === "unattributed-result"));
    assert.equal(unattributed.workload, "Multiple workloads");
    assert.deepEqual(unattributed.serviceAssociation.services, []);
    await expect(row(page, unattributed.id).locator(".action-service")).toContainText("Result target not identified");
    await row(page, api.id).locator(".request-link").click(); await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-result-id", api.id);
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator("#selectedCall")).toBeInViewport();
    await expect(page.locator("#selectedCall code.api-path")).toHaveText("/me/messages");
    await expect(page.locator("#selectedCall .action-service")).toHaveText("Mail");
    await expect(page.locator('[data-selected-action="true"]')).toHaveAttribute("data-tool-call-id", "investigate-09");
    await expect(page.locator("#selectedCall")).toContainText("1 Error result");
    await capture(page, "exact-api-entry-context");
    await page.getByText("Other returned API results", { exact: true }).click();
    const others = page.locator(".selected-api-result .returned-api-entries");
    await expect(others.locator(".api-result-entry")).toHaveCount(6);
    await others.getByRole("button", { name: "Next returned results", exact: true }).click();
    await expect(others.locator(".api-result-entry")).toHaveCount(2);
    assert.equal(await others.locator(`[data-result-id=${JSON.stringify(api.id)}]`).count(), 0);
    const callRevision = String(app.snapshot().revision);
    await page.goto(exactURL(runtime, records[1].scenarioId, api.id, "reported-api", { result: "success", callRevision })); await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-result-id", api.id);
    await expect(page.locator("#selectedCall")).toContainText("Outside current view");
    await page.goto(exactURL(runtime, records[1].scenarioId, unattributed.id, "reported-api", { callRevision })); await ready(page);
    await expect(page.locator("#selectedCall .action-service")).toContainText("Result target not identified");
    await expect(page.locator("#selectedCall .action-service")).toContainText(unattributed.serviceAssociation.gaps[0].description);
    assert.doesNotMatch(await page.locator("#selectedCall .action-service").innerText(), /More than one service|Mail|Files/);
    await capture(page, "exact-api-unattributed-context");
    for (const [request, call] of [[records[1].scenarioId, "removed"], [records[0].scenarioId, api.id]]) {
        await page.goto(exactURL(runtime, request, call, "reported-api", { callRevision })); await ready(page);
        await expect(page.locator("#unavailableCall")).toContainText("No nearby action was substituted");
        await expect(page.locator(".request-context-timeline")).toHaveCount(0);
        await expect(page.locator("#unavailableCall")).toBeFocused();
    }
    // Removing an earlier API entry reassigns existing canonical offsets. A stale
    // URL must not silently select the next entry now occupying the same ID.
    const retained = app.snapshot().requestActivity["reported-api"].find(row => row.status === 200);
    const staleURL = exactURL(runtime, records[1].scenarioId, retained.id, "reported-api", { callRevision });
    records[1].toolCalls[9].apiResults.shift();
    await replaceEvidence(app.context, () => ({ records, importCoverage: { counts: { includedSessions: 2, includedProjects: 1 }, roster: [] } }));
    await app.acceptFixtureChange();
    await page.goto(staleURL); await ready(page);
    await page.reload(); await ready(page);
    assert.notEqual(String(app.snapshot().revision), callRevision);
    assert.ok(app.snapshot().requestActivity["reported-api"].some(row => row.id === retained.id), "The positional canonical ID was reused");
    await expect(page.locator("#unavailableCall")).toContainText("No other entry was substituted");
    await expect(page.locator("#selectedCall,.interaction-response")).toHaveCount(0);
    await page.goto(runtime.url + "#analyze?mode=calls&layer=tool"); await ready(page);
    await expect.poll(() => app.snapshot()?.analytics.layer).toBe("tool");
    const parent = app.snapshot().analytics.rows.find(row => row.id === api.parentCallId);
    await expect(row(page, parent.id).locator(".action-fields dt").first()).toHaveText("Activity category");
    await expect(row(page, parent.id).locator(".action-service")).toHaveText("More than one service");
});

test("Graph, code references and transport retain distinct units; native links and narrow 200% controls work", { timeout: 45000 }, async t => {
    const app = await setup(t), { page, runtime } = app;
    for (const [layer, predicate, content] of [
        ["direct-request", row => row.status === null, "No HTTP status observed"],
        ["recorded-http", row => row.status === 429, "Visible HTTP status: 429"],
        ["code-reference", () => true, "Code reference only; execution is not established"],
        ["http", row => row.outcome === "transport", "Connection failed"],
    ]) {
        await page.goto(runtime.url + "#analyze?mode=calls&layer=" + layer); await ready(page);
        const target = app.snapshot().analytics.rows.find(predicate);
        const open = row(page, target.id).locator(".request-link");
        if (layer === "code-reference") {
            await expect(row(page, target.id)).toContainText("Duration unavailable");
            assert.doesNotMatch(await row(page, target.id).innerText(), /duration: .*ms/);
        }
        if (layer === "http") {
            await expect(row(page, target.id)).toContainText("no HTTP response was recorded");
            const origin = page.url();
            const popup = page.context().waitForEvent("page");
            await open.click({ modifiers: ["Control"] });
            const native = await popup; await ready(native);
            await expect(native.locator("#selectedCall")).toHaveAttribute("data-action-id", target.id);
            assert.equal(page.url(), origin);
            await native.close();
        }
        await open.click(); await ready(page);
        await expect(page.locator("#selectedCall")).toHaveAttribute("data-action-id", target.id);
        await expect(page.locator("#selectedCall")).toContainText(content);
        await expect(page.locator("#selectedCall")).toBeInViewport();
        if (layer === "http") await capture(page, "exact-transport-context");
    }
    await page.goto(runtime.url + "#analyze?mode=calls"); await ready(page);
    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await page.locator("#resultsLink").click(); await frames(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    for (const node of await page.locator("#callSort-control,#activityList .request-link").all()) {
        assert.ok((await node.boundingBox()).height >= 44);
    }
    await page.locator("#callSort-control").focus(); await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#callSort")).toHaveValue("fastest");
    await capture(page, "calls-narrow-dark-200");
    await page.locator("#activityList .matched-action").first().scrollIntoViewIfNeeded();
    await capture(page, "calls-narrow-dark-200-row");
    const target = (await ids(page))[2];
    const open = row(page, target).locator(".request-link");
    await open.focus(); await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator("#selectedCall")).toBeInViewport();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await capture(page, "exact-call-narrow-dark-200");
    await page.goBack(); await ready(page);
    await expect(open).toBeFocused();
});

test("a removed call never navigates to another action or initiates a source read", { timeout: 20000 }, async t => {
    const app = await setup(t), { page, runtime, records, context } = app;
    await page.goto(runtime.url + "#analyze?mode=calls"); await ready(page);
    const target = app.snapshot().analytics.rows.find(row => row.toolCallId === "investigate-09");
    const href = await row(page, target.id).locator(".request-link").getAttribute("href");
    await row(page, target.id).locator(".request-link").click(); await ready(page);
    records[1].toolCalls = records[1].toolCalls.filter(call => call.toolCallId !== "investigate-09");
    await replaceEvidence(context, () => ({ records, importCoverage: { counts: { includedSessions: 2, includedProjects: 1 }, roster: [] } }));
    await app.acceptFixtureChange();
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await expect(page.locator("#unavailableCall")).toBeVisible();
    await expect(page.locator("#selectedCall")).toHaveCount(0);
    await page.goto(runtime.url + href); await ready(page);
    await expect(page.locator("#unavailableCall")).toContainText("This exact record is unavailable");
    await expect(page.locator(".interaction-response")).toHaveCount(0);
});
