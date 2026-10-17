import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { privateFixture, selectActivityOption, chooseTheme, restoreLegacySearch } from "./helpers.mjs";
import { callInvestigationRecords } from "./call-investigation-fixture.mjs";

const proofs = process.env.WIRE_CALL_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const ids = page => page.locator("#activityList .matched-action").evaluateAll(nodes => nodes.map(node => node.dataset.actionId));
const row = (page, id) => page.locator("#activityList .matched-action").filter({ has: page.locator(`a.request-link[href*="${encodeURIComponent(id)}"]`) });

async function setup(t, records = callInvestigationRecords()) {
    const cleanup = [];
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

test("Tool latency labels preserve individual values, accessible sorting and other evidence boundaries", { timeout: 60000 }, async t => {
    const record = callInvestigationRecords()[1];
    record.toolCalls = [record.toolCalls[0], record.toolCalls[1], record.toolCalls[9], record.toolCalls[10]];
    record.toolCalls[1].durationMs = 7;
    record.toolCalls[1].completedAt = new Date(Date.parse(record.toolCalls[1].startedAt) + 7).toISOString();
    const { page, runtime } = await setup(t, [record]);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1280, 1], [375, 2]]) {
        await page.goto(runtime.url + "#analyze?mode=calls"); await ready(page);
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const sort = page.getByRole("combobox", { name: "Tool latency", exact: true });
        await expect(sort).toBeVisible();
        for (const order of ["slowest", "fastest"]) {
            await selectActivityOption(page, "callSort", order); await ready(page);
            const values = page.locator(".matched-action .call-duration");
            assert.deepEqual(await values.allTextContents(), order === "slowest"
                ? ["0.9 s", "<0.01 s", "0 s", "Not recorded"] : ["0 s", "<0.01 s", "0.9 s", "Not recorded"]);
            assert.deepEqual(await values.evaluateAll(nodes => nodes.map(node => node.getAttribute("value"))),
                order === "slowest" ? ["900", "7", "0", null] : ["0", "7", "900", null]);
        }
        await expect(page.locator(".matched-action dt").filter({ hasText: /^Tool latency:$/ })).toHaveCount(4);
        await expect(page.locator("#activityList")).not.toContainText("Call duration");
        await page.locator("#meaning > summary").click();
        await expect(page.locator("#meaning")).toContainText("Tool latency runs from the recorded tool call start to completion.");
        await expect(page.locator("#meaning")).toContainText("Tool latencies are not added together");
        await page.locator("#meaning > summary").click();
        const layout = await page.locator("#activityView").evaluate(root => ({
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            clipped: [...root.querySelectorAll("#callSortLabel,.select-trigger,dt,.call-duration")].filter(node =>
                node.checkVisibility() && node.clientWidth && node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
        }));
        assert.ok(layout.overflow <= 1); assert.deepEqual(layout.clipped, []);
        await capture(page, `tool-latency-calls-${theme}-${width}-${scale}`);
        await page.locator(".matched-action").filter({ has: page.locator('data[value="7"]') }).locator(".request-link").click();
        const toolEntries = page.locator('#requestContent .journey-item[data-tool-call-id]');
        for (const [value, text] of [[7, "7 ms"], [0, "0 ms"], [900, "900 ms"]]) {
            await expect(toolEntries.locator(`.reader-call-duration:has(data[value="${value}"])`)).toHaveText(`Tool latency: ${text}`);
        }
        await expect(toolEntries.locator(".reader-call-duration").filter({ hasText: "Not recorded" })).toHaveText("Tool latency: Not recorded");
        await expect(page.locator("#requestContent .response-timing")).toContainText("Prompt to final response");
        await expect(page.locator("#requestContent .response-timing data")).toHaveAttribute("value", "3000");
        assert.match(await toolEntries.locator(".reader-call-duration").first().ariaSnapshot(), /Tool latency/);
        const clipped = await toolEntries.locator(".reader-call-duration").evaluateAll(nodes =>
            nodes.filter(node => node.checkVisibility() && node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
        assert.deepEqual(clipped, []);
        await capture(page, `tool-latency-reader-${theme}-${width}-${scale}`);
        await page.locator("#closeContextSidebar").click(); await ready(page);
    }
    for (const layer of ["reported-api", "http", "direct-request", "recorded-http", "code-reference"]) {
        await page.goto(runtime.url + "#analyze?mode=calls&layer=" + layer); await ready(page);
        await expect(page.getByRole("combobox", { name: "Duration", exact: true })).toBeVisible();
        await expect(page.locator("#activityList")).not.toContainText("Tool latency");
        if (layer === "reported-api") {
            await expect(page.locator(".matched-action").first()).toContainText("API result duration:");
            await expect(page.locator(".matched-action").first().locator("data.call-duration")).toHaveAttribute("value", "800");
        } else if (layer === "http") {
            await expect(page.locator(".matched-action").first()).toContainText("Record duration:");
            await expect(page.locator(".matched-action").first().locator("data.call-duration")).toHaveAttribute("value", "20");
        } else await expect(page.locator("#activityList data.call-duration")).toHaveCount(0);
    }
});

test("Calls sort all canonical matches, anchor a nonfirst action in full context, and restore exact Back state", { timeout: 45000 }, async t => {
    const app = await setup(t), { page, runtime, records, requests } = app;
    await page.goto(runtime.url + "#analyze"); await ready(page);
    const targetGroup = records[1].scenarioId;
    const interaction = page.locator(".request-row").filter({ has: page.locator(`a.request-card-open[href*="${targetGroup}"]`) });
    await interaction.locator("a").click();
    await page.locator("#requestReportToggle").click();
    await page.locator("#closeContextSidebar").click();
    await restoreLegacySearch(page, "synthetic documents");
    await selectActivityOption(page, "serviceAssociationFilter", "Files");
    await selectActivityOption(page, "promptAuthorFilter", "user");
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-30"); await page.locator("#toFilter").fill("2026-09-30");
    await page.locator("#applyDates").click(); await ready(page);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    const refreshOrigin = page.url();
    await page.locator("#checkActivity").click(); await ready(page);
    assert.equal(page.url(), refreshOrigin, "Refresh preserves the exact filtered Calls route");
    await expect(page.locator("#activitySearch")).toHaveValue("synthetic documents");
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
    await expect(page.locator("#activityList")).toContainText("Not recorded");
    const target = app.snapshot().analytics.rows.find(row => row.toolCallId === "investigate-09");
    const open = row(page, target.id).locator(".request-link");
    await open.focus(); await frames(page);
    const origin = page.url(), position = await open.boundingBox();
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-action-id", target.id);
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator("#selectedCall")).toBeInViewport();
    const selected = await page.locator("#selectedCall").elementHandle(), selectedRoute = page.url();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (let toggle = 0; toggle < 2; toggle++) {
        await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
        assert.equal(page.url(), selectedRoute);
        assert.equal(await selected.evaluate(node => node === document.querySelector("#selectedCall")), true);
        await expect(page.locator("#selectedCall")).toBeInViewport();
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(requests.filter(req => req.path === "/api/snapshot").length, beforeReads);
    const selectedActions = records[1].toolCalls.length + records[1].graphActivities.length + records[1].httpRecords.length;
    await expect(page.locator(".request-context-timeline [data-context-kind=action]")).toHaveCount(selectedActions);
    const linked = page.locator('[data-reader-section="source"] .reader-linked-context');
    await expect(linked).not.toHaveAttribute("open", "");
    await expect(linked.locator(".full-text-content")).toHaveCount(0);
    await linked.locator(":scope > summary").click();
    await expect(linked).toContainText(records[0].userPrompt.text);
    await expect(page.locator("#requestContent [data-context-kind=action]")).toHaveCount(20);
    await linked.locator(":scope > summary").click();
    await expect(page.locator('[data-reader-section="prompt"]')).toContainText(records[1].userPrompt.text.trim());
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /UNRELATED_CALL_CONTEXT/);
    const timing = page.locator(".journey-item[data-context-kind=action]").filter({ has: page.locator('.reader-call-duration data[value="900"]') });
    await expect(timing).toHaveAttribute("data-action-id", target.id);
    await expect(timing.locator(".reader-call-duration")).toHaveText("Tool latency: 900 ms");
    await expect(page.locator("#selectedCall>.action-context")).toHaveCount(0);
    await expect(page.locator("#selectedCall .call-heading [data-result-layer=tool]")).toHaveAttribute("aria-label", "Tool completion: 1 Work IQ tool call");
    await expect(page.locator('[data-reader-section="source"] .reader-source-record')).toHaveCount(2);
    assert.deepEqual(await page.locator('[data-reader-section="source"] .reader-source-record').evaluateAll(nodes =>
        nodes.map(node => node.dataset.contextGroup)), records.slice(0, 2).map(record => record.scenarioId));
    await capture(page, "exact-call-context-light");
    await expect(page.locator("#selectedCall .technical-detail")).toBeVisible();
    await expect(page.locator("#selectedCall .reader-input-label")).toHaveText("Requested paths");
    await expect(page.locator("#selectedCall .technical-detail details")).toHaveCount(0);
    await expect(page.locator("#selectedCall").getByRole("button", { name: "Copy recorded arguments", exact: true })).toHaveCount(0);
    const targets = page.locator("#selectedCall .reader-input-value code");
    await expect(targets).toHaveText(records[1].toolCalls[9].requestArgs.entityUrls);
    assert.equal(await targets.first().evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        const exact = getSelection().toString() === node.textContent;
        getSelection().removeAllRanges(); return exact;
    }), true);
    assert.deepEqual(await page.evaluate(() => window.callClipboard), []);
    await page.locator("#closeContextSidebar").click(); await ready(page); await frames(page);
    assert.equal(page.url(), origin);
    await expect(open).toBeFocused();
    assert.ok(Math.abs((await open.boundingBox()).y - position.y) < 3);
    await expect(page.locator("#activitySearch")).toHaveValue("synthetic documents");
    await expect(page.locator("#callSort")).toHaveValue("fastest");
    await expect(page.locator("#serviceFocusScope")).toContainText("Files + calls with missing service details");
    await page.locator('[data-analyze-mode="interactions"]').click();
    await interaction.locator("a").click();
    await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
    await page.locator("#closeContextSidebar").click();
    await page.locator('[data-analyze-mode="calls"]').click();
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    const failed = app.snapshot().analytics.rows.find(row => row.toolCallId === "investigate-08");
    await row(page, failed.id).locator(".request-link").click(); await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", "investigate-08");
    await expect(page.locator("#requestContent")).toContainText("Outside current view");
    await expect(page.locator("#requestContent")).toContainText("Tool outcomes do not establish answer correctness");
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
    const others = page.locator(".selected-api-result .returned-api-entries");
    await expect(others).toBeVisible();
    await expect(page.locator(".selected-api-result details")).toHaveCount(0);
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
    const replacementRevision = (await loadBoardState(app.context)).revision;
    await page.goto(staleURL); await ready(page);
    await page.reload(); await ready(page);
    await expect.poll(() => app.snapshot()?.revision).toBe(replacementRevision);
    assert.notEqual(String(app.snapshot().revision), callRevision);
    assert.ok(app.snapshot().requestActivity["reported-api"].some(row => row.id === retained.id), "The positional canonical ID was reused");
    await expect(page.locator("#unavailableCall")).toContainText("No other entry was substituted");
    await expect(page.locator("#selectedCall,.interaction-response")).toHaveCount(0);
    await page.goto(runtime.url + "#analyze?mode=calls&layer=tool"); await ready(page);
    await expect.poll(() => app.snapshot()?.analytics.layer).toBe("tool");
    const parent = app.snapshot().analytics.rows.find(row => row.id === api.parentCallId);
    await expect(row(page, parent.id).locator(".activity-card-facts dt")).toContainText(["Activity category"]);
    await expect(row(page, parent.id).locator(".action-service .service-cue")).toHaveText(["Mail", "Files"]);
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
        await expect.poll(() => app.snapshot()?.analytics.layer).toBe(layer);
        const target = app.snapshot().analytics.rows.find(predicate);
        const open = row(page, target.id).locator(".request-link");
        if (layer === "code-reference") {
            await expect(row(page, target.id)).toContainText("Not recorded");
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
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-action-id", target);
    await expect(page.locator('#requestContent [aria-busy="true"]')).toHaveCount(0);
    await frames(page);
    await expect(page.locator("#selectedCall")).toBeInViewport();
    const geometry = await page.locator("#selectedCall").evaluate(node => ({
        actionId: node.dataset.actionId, focused: document.activeElement === node,
        target: node.getBoundingClientRect().toJSON(),
        label: node.querySelector(".context-selected-label").getBoundingClientRect().toJSON(),
        header: document.querySelector(".app-header").getBoundingClientRect().toJSON(),
        viewport: { width: innerWidth, height: innerHeight }, scrollY,
    }));
    assert.ok(geometry.label.top >= geometry.header.bottom && geometry.label.bottom <= geometry.viewport.height,
        "The selected record label is readable below the sticky header after retained context settles");
    if (proofs) await writeFile(path.join(proofs, "exact-call-narrow-dark-200-geometry.json"), JSON.stringify(geometry, null, 2));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await capture(page, "exact-call-narrow-dark-200");
    await page.goBack(); await ready(page);
    await expect(open).toBeFocused();

    for (const interrupt of ["settle", "scroll", "back"]) {
        await page.reload(); await ready(page);
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        let release, arrived;
        const deliveries = [];
        const pending = new Promise(resolve => { arrived = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        await page.route("**/api/assessment/detail", route => {
            const delivery = (async () => {
                const response = await route.fetch();
                arrived();
                await held;
                await route.fulfill({ response });
            })();
            deliveries.push(delivery);
            return delivery;
        });
        try {
            const origin = page.url();
            await open.focus(); await frames(page);
            const position = await open.boundingBox();
            await page.keyboard.press("Enter"); await ready(page); await pending;
            await expect(page.locator("#selectedCall")).toHaveAttribute("data-action-id", target);
            await expect(page.locator("#selectedCall")).toBeFocused();
            await expect(page.locator("#selectedCall")).toBeInViewport();
            if (interrupt === "settle") {
                release();
                await expect(page.locator('#requestContent [aria-busy="true"]')).toHaveCount(0);
                await frames(page);
                await expect(page.locator("#selectedCall")).toBeInViewport();
                const label = await page.locator("#selectedCall .context-selected-label").boundingBox();
                const header = await page.locator(".app-header").boundingBox();
                assert.ok(label.y >= header.y + header.height && label.y + label.height <= 900,
                    "A delayed retained-context read keeps the selected record label readable");
                await capture(page, "exact-call-delayed-context");
                await page.goBack(); await ready(page);
            } else if (interrupt === "scroll") {
                const documentY = await page.evaluate(() => scrollY);
                await page.keyboard.press("Control+Home");
                await expect.poll(() => page.locator("#contextSidebarBody").evaluate(node => node.scrollTop)).toBe(0);
                const focused = await page.evaluate(() => document.activeElement.id);
                release();
                await expect(page.locator('#requestContent [aria-busy="true"]')).toHaveCount(0);
                await frames(page);
                assert.equal(await page.evaluate(() => scrollY), documentY, "Panel scrolling cannot move the origin document");
                assert.equal(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop), 0, "Late retained-context layout must not undo deliberate panel scrolling");
                assert.equal(await page.evaluate(() => document.activeElement.id), focused);
                await expect(page.locator("#selectedCall")).not.toBeInViewport();
                await page.goBack(); await ready(page);
            } else {
                await page.locator("#closeContextSidebar").click(); await ready(page);
                release();
                await Promise.all(deliveries);
                await frames(page);
                assert.equal(page.url(), origin);
                await expect(open).toBeFocused();
                assert.ok(Math.abs((await open.boundingBox()).y - position.y) < 3,
                    "A late reader completion must not scroll the restored Calls origin");
            }
        } finally {
            release();
            await Promise.all(deliveries);
            await page.unroute("**/api/assessment/detail");
        }
    }
});

test("a removed call never navigates to another action or initiates a source read", { timeout: 20000 }, async t => {
    const app = await setup(t), { page, runtime, records, context } = app;
    await page.goto(runtime.url + "#analyze?mode=calls"); await ready(page);
    await expect.poll(() => app.snapshot()?.analytics.layer).toBe("tool");
    const target = app.snapshot().analytics.rows.find(row => row.toolCallId === "investigate-09");
    const href = await row(page, target.id).locator(".request-link").getAttribute("href");
    await row(page, target.id).locator(".request-link").click(); await ready(page);
    records[1].toolCalls = records[1].toolCalls.filter(call => call.toolCallId !== "investigate-09");
    await replaceEvidence(context, () => ({ records, importCoverage: { counts: { includedSessions: 2, includedProjects: 1 }, roster: [] } }));
    await app.acceptFixtureChange();
    await page.reload(); await ready(page);
    await expect(page.locator("#unavailableCall")).toBeVisible();
    await expect(page.locator("#selectedCall")).toHaveCount(0);
    await page.goto(runtime.url + href); await ready(page);
    await expect(page.locator("#unavailableCall")).toContainText("This exact record is unavailable");
    await expect(page.locator(".interaction-response")).toHaveCount(0);
});
