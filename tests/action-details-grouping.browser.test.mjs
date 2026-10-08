import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";

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
async function setup(t, record = source()) {
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const errors = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const endpoint = new URL(request.url()).pathname;
        if (request.method() !== "GET" && !(request.method() === "POST" && ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(endpoint))) mutations.push(endpoint);
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Grouping never reads the clipboard."); },
        writeText() { throw Error("Grouping never writes the clipboard."); },
    } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
    });
    await page.goto(runtime.url + "#request?request=action-grouping"); await ready(page);
    return { page, runtime, context, record };
}
const actions = page => page.locator(".journey-item");
const details = item => item.locator(":scope > .detail-disclosure");
const argumentsSummary = item => item.locator("summary").filter({ hasText: /^Exact recorded arguments \/ local only$/ });

async function geometry(page) {
    return page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        items: [...document.querySelectorAll(".journey-item")].map(item => {
            const detail = item.querySelector(":scope > .detail-disclosure"), summary = detail.firstElementChild;
            const prior = detail.previousElementSibling, heading = item.querySelector("h3");
            const box = item.getBoundingClientRect(), support = detail.getBoundingClientRect(), label = summary.getBoundingClientRect();
            const style = getComputedStyle(detail);
            return {
                key: item.dataset.viewKey, detailKey: detail.dataset.disclosureKey,
                open: detail.open, parent: detail.parentElement === item, last: item.lastElementChild === detail,
                headingLeft: heading.getBoundingClientRect().left, detailLeft: support.left,
                top: box.top, bottom: box.bottom, detailTop: support.top, detailBottom: support.bottom,
                summaryBottom: label.bottom, summaryHeight: label.height, summaryWidth: label.width,
                gapBefore: support.top - prior.getBoundingClientRect().bottom,
                nextTop: item.nextElementSibling?.getBoundingClientRect().top ?? null,
                borderTop: parseFloat(style.borderTopWidth), borderBottom: parseFloat(style.borderBottomWidth),
                rail: parseFloat(getComputedStyle(item).borderLeftWidth),
                contentBottom: detail.open ? Math.max(...[...detail.children].map(child => child.getBoundingClientRect().bottom)) : label.bottom,
                clippedLabels: [...item.querySelectorAll("h3,summary,dt,dd,.ux-inline-code>code,code.api-path")].filter(node =>
                    node.checkVisibility() && node.scrollWidth > node.clientWidth + 1).map(node => node.tagName),
            };
        }),
    }));
}
function assertGrouped(result, context) {
    assert.ok(result.pageOverflow <= 1, `${context}: page fits`);
    assert.equal(new Set(result.items.map(item => item.detailKey)).size, result.items.length);
    for (const item of result.items) {
        assert.equal(item.parent && item.last, true, `${context}: disclosure ends its own record`);
        assert.equal(item.borderTop, 0, `${context}: no apparent record-ending rule before disclosure`);
        assert.equal(item.borderBottom, item.nextTop === null ? 0 : 1, `${context}: divider follows complete non-last record`);
        assert.ok(Math.abs(item.headingLeft - item.detailLeft) < 1, `${context}: aligned with action content`);
        assert.ok(item.gapBefore >= 0 && item.gapBefore <= 4.1, `${context}: attached, not separated by a larger gap`);
        assert.ok(item.summaryHeight >= 44 && item.summaryWidth >= 44, `${context}: disclosure target`);
        assert.equal(item.rail, 2);
        assert.ok(item.contentBottom <= item.detailBottom + 1 && item.detailBottom <= item.bottom + 1);
        if (item.nextTop !== null) assert.ok(item.detailBottom <= item.nextTop && item.nextTop - item.detailBottom <= 24.1);
        assert.deepEqual(item.clippedLabels, [], `${context}: labels fit`);
    }
}
async function screenshot(page, name) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    const clip = await page.locator(".journey").boundingBox();
    await page.screenshot({ path: path.join(proofDir, `${name}.png`), fullPage: true, clip });
}

test("action details stay inside their record before the divider at every supported width and text size", { timeout: 90000 }, async t => {
    const { page } = await setup(t), metrics = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const label = `${theme}-${width}-${scale * 100}`;
        metrics.push({ label: label + "-collapsed", ...await geometry(page) });
        if ((width === 1200 && scale === 1) || (width === 375 && scale === 2)) await screenshot(page, label + "-collapsed");
        for (const item of await actions(page).all()) {
            await details(item).locator(":scope > summary").click();
            await argumentsSummary(item).click();
        }
        metrics.push({ label: label + "-expanded", ...await geometry(page) });
        assert.equal(await actions(page).nth(1).locator("pre").textContent(), JSON.stringify(source().toolCalls[1].requestArgs, null, 2));
        const code = actions(page).nth(1).locator("pre");
        assert.ok(await code.evaluate(node => getComputedStyle(node).overflowX === "auto" && node.tabIndex === 0),
            "Exact unbroken arguments remain keyboard-scrollable, never clipped or rewritten");
        if ((width === 1200 && scale === 1) || (width === 375 && scale === 2)) await screenshot(page, label + "-expanded");
        for (const item of await actions(page).all()) {
            await argumentsSummary(item).click();
            await details(item).locator(":scope > summary").click();
        }
    }
    if (proofDir) await writeFile(path.join(proofDir, "geometry.json"), JSON.stringify(metrics, null, 2));
    for (const result of metrics) assertGrouped(result, result.label);
});

test("repeated tools keep exact owning details, keyboard focus and expansion through pages, Back and live snapshots", { timeout: 45000 }, async t => {
    const { page, runtime, context, record } = await setup(t, source(8));
    const stateFile = (await readdir(context.dataDir)).find(name => name.endsWith(".state.json"));
    const reviewBefore = await readFile(path.join(context.dataDir, stateFile));
    const url = page.url(), first = actions(page).first(), second = actions(page).nth(1);
    const summary = details(first).locator(":scope > summary");
    const counts = await page.locator(".full-request-results").innerText();
    await summary.focus(); await page.keyboard.press("Enter");
    assert.equal(await details(first).evaluate(node => node.open), true);
    assert.equal(await details(second).evaluate(node => node.open), false);
    assert.ok(await summary.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== "none"));
    await page.keyboard.press("Space");
    assert.equal(await details(first).evaluate(node => node.open), false);
    await page.keyboard.press("Enter");
    await argumentsSummary(first).click();
    await details(second).locator(":scope > summary").click();
    await argumentsSummary(second).click();
    for (const [index, item] of [first, second].entries()) {
        assert.equal(await item.locator("pre").textContent(), JSON.stringify(record.toolCalls[index].requestArgs, null, 2));
        assert.match(await details(item).innerText(), new RegExp(`grouping-call-${index}`));
        assert.doesNotMatch(await details(item).innerText(), new RegExp(`grouping-call-${1 - index}`));
    }
    assert.doesNotMatch(await first.innerText(), /Only_action_1/);
    assert.match(await second.innerText(), /Only_action_1_<not-markup>/);
    assert.equal(await page.locator("not-markup").count(), 0);
    assert.equal(page.url(), url);
    assert.equal(await page.locator(".full-request-results").innerText(), counts);
    assert.equal(await page.getByRole("button", { name: "Add to report", exact: true }).count(), 1);
    await page.getByRole("button", { name: "Next action records", exact: true }).click();
    assert.equal(await actions(page).count(), 2);
    await details(actions(page).last()).locator(":scope > summary").click();
    await argumentsSummary(actions(page).last()).click();
    assert.equal(await actions(page).last().locator("pre").textContent(), JSON.stringify(record.toolCalls[7].requestArgs, null, 2));
    assertGrouped(await geometry(page), "last action page");
    await page.getByRole("button", { name: "Previous action records", exact: true }).click();
    assert.equal(await first.locator("details[open]").count(), 2);
    assert.equal(await second.locator("details[open]").count(), 2);
    await navigateMain(page, "home"); await page.goBack(); await ready(page);
    assert.equal(page.url(), url);
    assert.equal(await first.locator("details[open]").count(), 2);
    await summary.focus();
    assert.deepEqual(await readFile(path.join(context.dataDir, stateFile)), reviewBefore);
    const updated = structuredClone(record);
    updated.toolCalls[0].durationMs = 9876;
    await replaceEvidence(context, () => ({ records: [updated], importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    const stateAfterAppend = await readFile(path.join(context.dataDir, stateFile));
    await page.waitForFunction(() => document.querySelector(".journey-item")?.textContent.includes("9876 ms"), null, { timeout: 15000 });
    assert.equal(await first.locator("details[open]").count(), 2);
    assert.equal(await summary.evaluate(node => node === document.activeElement), true);
    assert.equal(await first.locator("pre").textContent(), JSON.stringify(record.toolCalls[0].requestArgs, null, 2));
    assert.equal(await page.locator("#requestContent [id]").evaluateAll(nodes => nodes.length === new Set(nodes.map(node => node.id)).size), true);
    assert.deepEqual(await readFile(path.join(context.dataDir, stateFile)), stateAfterAppend);
    await page.goto(runtime.url + "#activity?session=test-session&result=failure"); await ready(page);
    assert.equal(await page.locator(".matched-action").count(), 1);
    assert.equal(await page.locator(".matched-action .detail-disclosure").count(), 0, "Matching actions use a request link, not this disclosure pattern");
    await page.locator(".matched-action .text-link").click(); await ready(page);
    assert.equal(await second.locator("pre").textContent(), JSON.stringify(record.toolCalls[1].requestArgs, null, 2));
});

test("only action and missing details retain explicit absence and independent request support boundaries", { timeout: 30000 }, async t => {
    const record = source(1);
    delete record.toolCalls[0].requestArgs;
    record.toolCalls[0].requestedApiPath = "/me/" + "messages/".repeat(60);
    record.toolCalls[0].toolSucceeded = false;
    record.toolCalls[0].reportedOutcome = "failed";
    const { page } = await setup(t, record);
    assert.match(await page.locator(".request-outcome").innerText(), /Failure cause unavailable in retained evidence/);
    await details(actions(page).first()).locator(":scope > summary").click();
    await argumentsSummary(actions(page).first()).click();
    assert.equal(await actions(page).first().locator("pre").textContent(), "[Arguments unavailable]");
    assert.match(await details(actions(page).first()).innerText(), /Not recorded/);
    assert.equal(await actions(page).first().locator(":scope > .action-fields code.api-path").textContent(), record.toolCalls[0].requestedApiPath);
    assert.ok((await actions(page).first().locator(":scope > .action-fields code.api-path").textContent()).length > 300,
        "The long-path fixture must render a long path, not a normalized short placeholder");
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        assertGrouped(await geometry(page), `only long-path action/${theme}/${width}/${scale}`);
    }
    assert.equal(await page.locator(".request-support > .detail-disclosure").evaluateAll(nodes =>
        nodes.every(node => getComputedStyle(node).borderTopWidth === "1px")), true, "Independent page-level support retains its own hierarchy");
    const reader = page.locator(".request-original .full-text-toggle");
    if (await reader.getAttribute("aria-expanded") === "false") await reader.click();
    assert.equal(await page.locator(".request-original pre").textContent(), original);
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
    const { page } = await setup(t, record);
    assert.equal(await actions(page).count(), 4);
    for (const item of await actions(page).all()) await details(item).locator(":scope > summary").click();
    const evidence = [record.graphActivities[0], record.graphActivities[1], record.httpRecords[0]];
    for (let index = 0; index < evidence.length; index++) {
        const item = actions(page).nth(index + 1);
        assert.equal(await item.locator("pre").textContent(), JSON.stringify(evidence[index], null, 2));
    }
    assertGrouped(await geometry(page), "shared Graph/HTTP records");
});
