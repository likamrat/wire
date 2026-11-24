import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_ACTION_DETAILS_PROOFS;
const original = "Synthetic retained request\n  Exact spacing and <not-markup> stay unchanged.  ";
function source(count = 2) {
    const record = fixture("action-grouping");
    record.sourceSessionName = "Synthetic action grouping";
    record.userPrompt.text = original;
    record.followUpPrompts = [];
    record.toolCalls = Array.from({ length: count }, (_, index) => ({
        tool: "workiq-search_paths", toolCallId: `grouping-call-${index}`, startEventId: `grouping-start-${index}`,
        startedAt: `2026-09-30T12:00:0${index}Z`, completedAt: `2026-09-30T12:00:0${index + 1}Z`,
        toolSucceeded: index !== 1, reportedOutcome: index === 1 ? "failed" : "succeeded",
        requestArgs: { query: `Only action ${index}: ` + (index === 1 ? "unbroken".repeat(80) : "SYNTHETIC"), exact: "  <not-markup>\n\u65e5\u672c\u8a9e  " },
        requestedApiPath: index === 1 ? "/" + "unbrokenpath".repeat(24) : null,
        observedGraphHttp: false,
        apiResults: index === 1 ? [{ index: 0, statusCode: 403, errorCode: "Only_action_1_<not-markup>", evidenceLevel: "intermediary-reported" }] : [],
    }));
    return record;
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t, record = source(), otherRecords = [], { enforced = false } = {}) {
    const cleanup = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, [record, ...otherRecords]);
    const access = enforced ? await createCopilotRuntimeAccess(context) : undefined;
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend: "react", access, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const errors = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const updateStatus = url.pathname === "/api/app-update" && request.method() === "POST" && request.postDataJSON()?.action === "status";
        if (url.origin !== new URL(runtime.url).origin || (request.method() !== "GET" && !updateStatus && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
            "/api/evaluation/automatic/summary", ...(enforced ? ["/api/access/watch", "/api/profile/github",
                "/api/access/status", "/api/collection/sources/status", "/api/report-drafts/list","/api/assessment/consent"] : []),
        ].includes(url.pathname))) { mutations.push(url.pathname); t.diagnostic(`Blocked fixture request: ${url.pathname}`); return route.abort(); }
        return route.continue();
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Grouping never reads the clipboard."); },
        writeText() { throw Error("Grouping never writes the clipboard."); },
    } }));
    t.after(async () => {
        try { await browser.close(); await runtime.close(); await access?.close(); }
        finally { for (const fn of cleanup) await fn(); }
        assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
    });
    await page.goto(runtime.url); await ready(page);
    const card = page.locator('#activityList article[data-view-key="request:action-grouping"]');
    return { page, card, context, record };
}
const actions = page => page.locator('[data-reader-section="activity"] .reader-call-row');
const details = item => item.locator(":scope > .technical-detail");
const toggle = item => item.locator(".reader-call-toggle");

async function geometry(page) {
    return page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        items: [...document.querySelectorAll('[data-reader-section="activity"] .reader-call-row')].map(item => {
            const summary = item.querySelector(".reader-call-toggle"), detail = document.getElementById(summary.getAttribute("aria-controls"));
            const box = item.getBoundingClientRect(), support = detail.getBoundingClientRect(), label = summary.getBoundingClientRect();
            return {
                detailKey: detail.id, open: !detail.hidden, expanded: summary.getAttribute("aria-expanded"),
                parent: detail.parentElement === item, last: item.lastElementChild === detail,
                top: box.top, bottom: box.bottom, detailTop: support.top, detailBottom: support.bottom, summaryBottom: label.bottom,
                summaryHeight: label.height, summaryWidth: label.width,
                nextTop: item.nextElementSibling?.getBoundingClientRect().top ?? null,
                divider: parseFloat(getComputedStyle(item).borderBlockStartWidth),
                clippedLabels: [...item.querySelectorAll("h3,dt:not(.visually-hidden),dd,code.api-path")].filter(node =>
                    node.checkVisibility() && node.scrollWidth > node.clientWidth + 1).map(node => node.tagName),
            };
        }),
    }));
}
function assertGrouped(result, context) {
    assert.ok(result.pageOverflow <= 1, `${context}: page fits`);
    assert.ok(result.items.length > 0);
    assert.equal(new Set(result.items.map(item => item.detailKey)).size, result.items.length);
    for (const [index,item] of result.items.entries()) {
        assert.equal(item.parent && item.last, true, `${context}: disclosure ends its own record`);
        assert.equal(item.expanded, String(item.open), `${context}: toggle controls its own detail`);
        assert.equal(item.divider, index ? 1 : 0, `${context}: divider separates complete records`);
        assert.ok(item.summaryHeight >= 44 && item.summaryWidth >= 44, `${context}: disclosure target`);
        if (item.open) assert.ok(item.detailTop >= item.summaryBottom - 1 && item.detailBottom <= item.bottom + 1);
        if (item.nextTop !== null) assert.ok(item.bottom <= item.nextTop + 1);
        assert.deepEqual(item.clippedLabels, [], `${context}: labels fit`);
    }
}
async function screenshot(page, name) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await page.locator("#contextSidebar").screenshot({ path: path.join(proofDir, `${name}.png`) });
}

test("action details stay inside their record before the divider at every supported width and text size", { timeout: 90000 }, async t => {
    const { page, card } = await setup(t), metrics = [];
    await card.getByRole("link", { name: "1 tool call failed" }).click();
    await expect(actions(page)).toHaveCount(2);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const label = `${theme}-${width}-${scale * 100}`;
        metrics.push({ label: label + "-collapsed", ...await geometry(page) });
        if ((width === 1200 && scale === 1) || (width === 375 && scale === 2)) await screenshot(page, label + "-collapsed");
        for (const item of await actions(page).all()) await toggle(item).click();
        metrics.push({ label: label + "-expanded", ...await geometry(page) });
        assert.equal(await actions(page).nth(1).locator("pre").textContent(), JSON.stringify(source().toolCalls[1].requestArgs, null, 2));
        const code = actions(page).nth(1).locator("pre");
        assert.ok(await code.evaluate(node => node.scrollWidth <= node.clientWidth + 1 ||
            getComputedStyle(node).overflowX === "auto" && node.tabIndex === 0),
            "Unbroken arguments must wrap or allow keyboard scrolling");
        if ((width === 1200 && scale === 1) || (width === 375 && scale === 2)) await screenshot(page, label + "-expanded");
        for (const item of await actions(page).all()) await toggle(item).click();
    }
    if (proofDir) await writeFile(path.join(proofDir, "geometry.json"), JSON.stringify(metrics, null, 2));
    for (const result of metrics) assertGrouped(result, result.label);
});

test("repeated tools keep exact owning details, keyboard focus and expansion through pages, Back and live snapshots", { timeout: 45000 }, async t => {
    const others = Array.from({ length: 8 }, (_, i) => {
        const r = fixture(`newer-${i}`); r.capturedAt = r.userPrompt.sourceTimestamp = `2026-10-01T12:00:0${i}Z`;
        return r;
    });
    const { page, context, card, record } = await setup(t, source(8), others, { enforced: true });
    const before = await loadBoardState(context);
    const pager = page.getByRole("navigation", { name: "Analyze result pages" });
    await pager.getByRole("button", { name: "Next", exact: true }).press("Enter");
    await expect(pager).toContainText("9-9 of 9");
    const failed = card.getByRole("link", { name: "1 tool call failed", exact: true });
    await failed.press("Enter");
    const first = actions(page).nth(0), second = actions(page).nth(1), summary = toggle(first);
    await expect(second).toBeFocused();
    await expect(second).toHaveAttribute("data-tool-call-id", "grouping-call-1");
    await expect(actions(page)).toHaveCount(8);
    const url = page.url();
    await summary.focus(); await page.keyboard.press("Enter");
    await expect(details(first)).toBeVisible(); await expect(details(second)).toBeHidden();
    assert.ok(await summary.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== "none"));
    await page.keyboard.press("Space");
    await expect(details(first)).toBeHidden();
    await page.keyboard.press("Enter");
    await toggle(second).click();
    for (const [index, item] of [first, second].entries()) {
        assert.equal(await item.locator("pre").textContent(), JSON.stringify(record.toolCalls[index].requestArgs, null, 2));
        await expect(item).toHaveAttribute("data-tool-call-id", `grouping-call-${index}`);
    }
    assert.doesNotMatch(await first.innerText(), /Only_action_1/);
    assert.match(await second.innerText(), /Only_action_1_<not-markup>/);
    assert.equal(await page.locator("not-markup").count(), 0);
    assert.equal(page.url(), url);
    await toggle(actions(page).last()).click();
    assert.equal(await actions(page).last().locator("pre").textContent(), JSON.stringify(record.toolCalls[7].requestArgs, null, 2));
    await page.goBack(); await expect(failed).toBeFocused();
    await pager.getByRole("button", { name: "Previous", exact: true }).press("Enter");
    await expect(pager).toContainText("1-8 of 9");
    await page.goBack(); await expect(pager).toContainText("9-9 of 9");
    await failed.press("Enter"); await expect(second).toBeFocused();
    await expect(toggle(first)).toHaveAttribute("aria-expanded", "true");
    await expect(toggle(second)).toHaveAttribute("aria-expanded", "true");
    await summary.focus();
    await expect(summary).toBeFocused();
    assert.deepEqual(await loadBoardState(context), before);
    const updated = structuredClone(record);
    updated.toolCalls[0].durationMs = 9876;
    const refreshed = page.waitForResponse(async response => response.ok() && response.url().endsWith("/api/snapshot")
        && (await response.json()).revision > before.revision);
    await replaceEvidence(context, () => ({ records: [updated, ...others], importCoverage: before.evidence.importCoverage }));
    const stateAfterAppend = await loadBoardState(context);
    await refreshed;
    await expect(first.locator("data.call-duration")).toHaveAttribute("value", "9876");
    await expect(summary).toBeFocused();
    // A new evidence revision closes the old private input. Reopen its current owner.
    await expect(summary).toHaveAttribute("aria-expanded", "false"); await summary.press("Enter");
    assert.equal(await first.locator("pre").textContent(), JSON.stringify(record.toolCalls[0].requestArgs, null, 2));
    assert.equal(await page.locator("#requestContent [id]").evaluateAll(nodes => nodes.length === new Set(nodes.map(node => node.id)).size), true);
    assert.deepEqual(await loadBoardState(context), stateAfterAppend);
    await page.goBack(); await expect(failed).toBeFocused();
    const entry = card.getByRole("link", { name: /Returned entry 1.*HTTP 403/i });
    await entry.press("Enter");
    await expect(second.locator(".api-result-entry")).toBeFocused();
    await expect(second.locator(".api-result-entry")).toContainText("Only_action_1_<not-markup>");
    await page.goBack(); await expect(entry).toBeFocused();
});

test("only action and missing details retain explicit absence and independent request support boundaries", { timeout: 30000 }, async t => {
    const record = source(1);
    delete record.toolCalls[0].requestArgs;
    record.toolCalls[0].requestedApiPath = "/me/" + "messages/".repeat(60);
    record.toolCalls[0].toolSucceeded = false;
    record.toolCalls[0].reportedOutcome = "failed";
    record.toolCalls[0].tool = "workiq-fetch";
    const { page, card } = await setup(t, record);
    await card.getByRole("link", { name: "1 tool call failed" }).click();
    await expect(actions(page).first()).toContainText("No failure reason was saved");
    await toggle(actions(page).first()).click();
    assert.equal(await actions(page).first().locator("pre").textContent(), "[Arguments unavailable]");
    assert.equal(await details(actions(page).first()).locator("code.api-path").textContent(), record.toolCalls[0].requestedApiPath);
    assert.ok(record.toolCalls[0].requestedApiPath.length > 300,
        "The long-path fixture must render a long path, not a normalized short placeholder");
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        assertGrouped(await geometry(page), `only long-path action/${theme}/${width}/${scale}`);
    }
    await page.getByRole("button", { name: "Source details", exact: true }).click();
    await page.getByRole("button", { name: "Record identifiers", exact: true }).click();
    await expect(page.locator(".reader-identifiers")).toContainText("grouping-call-0");
    assert.equal(await page.locator(".request-original .full-text-content").textContent(), original);
});

test("Graph and HTTP action records share the same attached support pattern without changing their evidence", { timeout: 30000 }, async t => {
    const record = source(1);
    record.graphActivities = [null, "code"].map((status, index) => ({
        activityId: `grouping-graph-${index}`, sourceSessionId: record.sourceSessionId, scenarioId: record.scenarioId,
        toolCallId: `graph-call-${index}`, startEventId: `graph-start-${index}`, startedAt: "2026-09-30T12:01:00Z",
        tool: "shell", evidenceLevel: status === "code" ? "code-reference" : "requested-direct-graph",
        endpoint: { path: "/me/messages", method: "GET", apiVersion: "v1.0", queryShape: [] },
        workload: "Mail", method: "GET", httpStatus: null, statusBasis: "none",
        requestCount: null, countUnit: "recorded-request-site", confidence: "high", synthetic: false,
        sourceKind: "inline-command", requestBasis: "request-command",
        fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
    }));
    record.httpRecords = [{
        recordId: "grouping-http", classification: "direct-graph-http", synthetic: false,
        sourceSessionId: record.sourceSessionId, observedGraphHttp: true, startedAt: "2026-09-30T12:02:00Z",
        status: 200, responseOrigin: "https://graph.microsoft.com", apiVersion: "v1.0", method: "GET",
        responsePath: { path: "/$metadata", query: [] },
    }];
    const { page, card } = await setup(t, record);
    await card.getByRole("link", { name: "API discovery: open call", exact: true }).click();
    assert.equal(await actions(page).count(), 4);
    for (const item of await actions(page).all()) await toggle(item).click();
    const evidence = [record.graphActivities[0], record.graphActivities[1], record.httpRecords[0]];
    for (let index = 0; index < evidence.length; index++) {
        const item = actions(page).nth(index + 1);
        assert.equal(await item.locator("pre").textContent(), JSON.stringify(evidence[index], null, 2));
    }
    assertGrouped(await geometry(page), "shared Graph/HTTP records");
});
