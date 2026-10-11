import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { chooseTheme, navigateMain, selectActivityOption, revealStoredRefresh } from "./helpers.mjs";
import { reportContents, scanReport, inspectReportCopies } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";
import { time } from "../lib/time.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";

const event = (type, data) => ({ id: randomUUID(), type, timestamp: new Date().toISOString(), data });
const call = id => event("tool.execution_start", { toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", toolCallId: id, arguments: { entityUrls: ["/me/messages"] } });
const complete = (id, success = true) => event("tool.execution_complete", { toolCallId: id, success });
const jsonl = events => events.map(e => JSON.stringify(e) + "\n").join("");
const sourceCheckKey = "workiq-evidence.source-check.v1";
const ready = async page => {
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
};
async function fixture(t, approved = true, timers = false, pageOptions = {}, metadata174 = false) {
    const root = await mkdtemp(path.join(os.tmpdir(), "workiq-fresh-synthetic-"));
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state"), approved: true, enabled: false, pollSeconds: 5, windowDays: 30 };
    await mkdir(config.sessionRoot);
    const db = new DatabaseSync(config.appDbPath);
    db.exec(metadata174 ? metadata174Schema : `PRAGMA user_version=156;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
    const context = { dataDir: path.join(root, "private") };
    let runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers } });
    if (approved) await runtime.collector.configure(config);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1466, height: 1000 }, reducedMotion: "reduce", ...pageOptions });
    page.setDefaultTimeout(15000);
    const errors = [], writes = [], receipts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", r => { if (/\/api\/collection\/(?:now|configure|enabled)$/.test(r.url())) writes.push(new URL(r.url()).pathname); });
    page.on("response", async r => { if (r.url().endsWith("/api/collection/now") && r.ok()) receipts.push((await r.json()).check); });
    t.after(async () => { await browser.close(); await runtime.close(); db.close(); await rm(root, { recursive: true, force: true }); assert.deepEqual(errors, []); });
    async function source(events = []) {
        const id = randomUUID();
        db.prepare("INSERT INTO sessions(id,title,session_type,archived_at,execution_location) VALUES(?,?,?,?,?)").run(id, "Synthetic new Copilot chat", "chat", null, "local");
        const file = path.join(config.sessionRoot, id, "events.jsonl");
        await mkdir(path.dirname(file));
        await writeFile(file, jsonl([event("session.start", { sessionId: id, version: 1 }), ...events]));
        return { id, file };
    }
    async function check() {
        await page.locator("#checkActivity").click();
        await page.waitForFunction(() => ["complete", "partial", "error", "unconfirmed"].includes(document.querySelector("#freshActivity").dataset.phase));
        await ready(page);
    }
    return { root, context, config, db, page, writes, receipts, source, check,
        runtime: () => runtime, restart: async () => { await runtime.close(); runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } }); } };
}

test("Refresh checks grounded metadata174 and retains its view on genuinely incompatible mappings", { timeout: 30000 }, async t => {
    const app = await fixture(t, true, false, {}, true), { page } = app;
    const source = await app.source([event("user.message", { content: "Invented metadata174 request" }), call("compatible"), complete("compatible")]);
    const configFile = path.join(app.context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    await page.goto(app.runtime().url + "#activity"); await ready(page);
    assert.match(await page.locator("#activityView").innerText(), /No collected activity yet/);
    await app.check();
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "complete");
    assert.equal(await page.locator("#freshStatus").innerText(), "1 new activity record.");
    assert.doesNotMatch(await page.locator("#freshContextMessage").innerText(), /Unsupported|not confirmed/);
    assert.equal((await app.runtime().collector.status()).discovery.schemaVersion, 174);
    const before = await loadBoardState(app.context);
    assert.equal(before.evidence[0].toolCalls.length, 1);
    app.db.exec("PRAGMA user_version=175; ALTER TABLE sessions ADD COLUMN invented_future_field TEXT");
    await appendFile(source.file, jsonl([call("compatible-addition"), complete("compatible-addition")]));
    await app.check();
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "complete");
    assert.equal(await page.locator("#freshStatus").innerText(), "1 new activity record.");
    const accepted = await loadBoardState(app.context), previous = await page.locator("#activityView").innerHTML();
    assert.equal(accepted.evidence[0].toolCalls.length, 2);
    app.db.exec("ALTER TABLE sessions RENAME COLUMN execution_location TO removed_location");
    await app.check();
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "error");
    assert.equal(await page.locator("#freshStatus").innerText(), "Local check not confirmed.");
    assert.match(await page.locator("#freshContextMessage").innerText(), /Previous view kept.*Unsupported sessions mapping.*175.*execution_location.*No history was replaced/s);
    assert.equal(await page.locator("#activityView").innerHTML(), previous);
    assert.deepEqual(await loadBoardState(app.context), accepted);
    assert.deepEqual(await readFile(configFile), configBefore);
    assert.deepEqual(app.writes, ["/api/collection/now", "/api/collection/now", "/api/collection/now"]);
});

for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) test(`selected single day and custom dates collect fresh bounded records end-to-end in ${zone}`, { timeout: 90000 }, async t => {
    const app = await fixture(t, true, false, { timezoneId: zone }), { page } = app;
    const date = time.addDays(time.day(new Date().toISOString(), zone), -3), next = time.addDays(date, 1);
    const range = time.range({ from: date, to: next }, zone), day = time.range({ from: date, to: date }, zone);
    const at = value => new Date(value).toISOString(), observations = [], inputCalls = [];
    const dated = (record, stamp) => ({ ...record, timestamp: at(stamp) });
    function request(id, stamp, success = true) {
        inputCalls.push({ id, stamp: at(stamp) });
        return [dated(event("user.message", { content: `Invented date-boundary request ${id}` }), Date.parse(at(stamp)) - 2),
            dated(call(id), stamp), ...(success === null ? [] : [dated(complete(id, success), Date.parse(at(stamp)) + 1)])];
    }
    const source = await app.source([
        ...request("before", Date.parse(day.from) - 1),
        ...request("start", day.from),
        ...request("end", Date.parse(day.to) - 1),
        ...request("next-day", day.to),
        ...request("after", range.to),
    ]);
    await app.runtime().collector.collectNow();
    await page.goto(app.runtime().url); await ready(page);
    const configBefore = await readFile(path.join(app.context.dataDir, "collector", "config.json"));
    const baseline = await loadBoardState(app.context);
    const originalEvidence = await readFile(path.join(app.context.dataDir, "private-evidence", baseline.evidenceFile));
    let accepted;
    page.on("response", async response => {
        if (response.url().endsWith("/api/snapshot") && response.ok()) accepted = { query: response.request().postDataJSON(), snapshot: await response.json() };
    });
    async function dates(from, to) {
        if (await page.locator("#dateFilter").inputValue() !== "custom") await selectActivityOption(page, "dateFilter", "custom");
        await page.locator("#fromFilter").fill(from);
        await page.locator("#toFilter").fill(to);
        await page.locator("#applyDates").focus(); await page.keyboard.press("Enter");
        await ready(page);
    }
    async function verify(stage, expectedIds) {
        const state = await loadBoardState(app.context), status = await app.runtime().collector.status();
        const canonical = buildActivityAnalytics(state.evidence, accepted.query);
        assert.deepEqual(canonical.rows.map(row => row.toolCallId).sort(), [...expectedIds].sort());
        assert.deepEqual(accepted.snapshot.analytics.rows.map(row => row.id), canonical.rows.map(row => row.id));
        assert.equal(new Set(canonical.rows.map(row => row.id)).size, expectedIds.length);
        assert.equal(await page.locator("#activityCount").innerText(), String(expectedIds.length));
        for (const selector of ["#homeView", "#periodResult", "#resultSummary", ".percentage-section"]) {
            assert.equal(await page.locator(selector).getAttribute("data-revision"), String(state.revision));
        }
        assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), String(expectedIds.length));
        const columns = await page.locator("#chart .dimensional-column").evaluateAll(nodes => nodes.map(node => Number(node.dataset.total)));
        assert.equal(columns.reduce((sum, count) => sum + count, 0), expectedIds.length);
        if (expectedIds.length) {
            if (!await page.locator("#tableDisclosure").evaluate(node => node.open)) await page.locator("#tableDisclosure>summary").click();
            assert.equal(Number((await page.locator("#countTable tfoot td").first().innerText()).replaceAll(",", "")), expectedIds.length);
        }
        for (const card of ["outcomes", "composition"]) {
            const rows = await page.locator(`[data-percentage-card=${card}] .percentage-legend-row`).evaluateAll(nodes =>
                nodes.map(node => ({ category: node.dataset.category, count: Number(node.dataset.count), percentage: node.dataset.percentage })));
            assert.equal(rows.reduce((sum, row) => sum + row.count, 0), expectedIds.length);
            if (card === "outcomes") for (const row of rows) assert.equal(row.count, canonical.totals[row.category]);
        }
        assert.equal(status.config.enabled, false);
        assert.deepEqual(await readFile(path.join(app.context.dataDir, "collector", "config.json")), configBefore);
        assert.deepEqual(await readFile(path.join(app.context.dataDir, "private-evidence", baseline.evidenceFile)), originalEvidence);
        observations.push({ stage, selected: accepted.query, revision: state.revision, receipt: status.lastCheck,
            checkedWindow: status.checkedWindow, cursor: status.cursors.find(row => row.sessionId === source.id)?.cursor,
            metrics: status.metrics, canonical: canonical.rows.map(({ id, toolCallId, startedAt, outcome }) => ({ id, toolCallId, startedAt, outcome })),
            count: expectedIds.length, result: await page.locator("#freshStatus").innerText(), context: await page.locator("#freshContextMessage").textContent() });
        return status;
    }
    assert.equal(await page.locator("#activityCount").innerText(), "5");
    await dates(date, date);
    assert.equal(await page.locator("#applyDates").evaluate(node => node === document.activeElement), true);
    await verify("single-day", ["start", "end"]);
    assert.deepEqual(accepted.snapshot.analytics.dateRange, day);
    await dates(date, next);
    await verify("custom-two-days", ["start", "end", "next-day"]);
    assert.deepEqual(accepted.snapshot.analytics.dateRange, range);
    const before = (await app.runtime().collector.status()).cursors.find(row => row.sessionId === source.id).cursor.offset;
    const newCall = request("fresh-in-range", Date.parse(day.from) + 12 * 3600000, null);
    await appendFile(source.file, jsonl([...newCall, ...request("fresh-out-of-range", Date.parse(range.to) + 3600000)]));
    await app.check();
    const added = await verify("appended-in-and-out-of-range", ["start", "end", "next-day", "fresh-in-range"]);
    assert.equal(added.lastCheck.schemaVersion, 2);
    assert.equal(added.lastCheck.changes.added, 2);
    assert.equal(added.lastCheck.changes.updated, 0);
    assert.ok(added.lastCheck.revision > added.lastCheck.beforeRevision);
    assert.ok(added.cursors.find(row => row.sessionId === source.id).cursor.offset > before);
    assert.ok(added.metrics.lastBytesRead > 0);
    assert.match(await page.locator("#freshContextMessage").innerText(), /Some updates are outside/);
    assert.equal(accepted.query.filters.from, date);
    assert.equal(accepted.query.filters.to, next);
    assert.ok(added.lastCheck.changes.items.every(item => item.rowId && item.id));
    await appendFile(source.file, jsonl([complete("fresh-in-range", false)]));
    await app.check();
    const late = await verify("late-result-no-extra-call", ["start", "end", "next-day", "fresh-in-range"]);
    assert.equal(late.lastCheck.changes.added, 0);
    assert.equal(late.lastCheck.changes.updated, 1);
    assert.equal(accepted.snapshot.analytics.totals.failure, 1);
    assert.equal(accepted.snapshot.analytics.totals.success, 3);
    assert.equal(await page.locator('.percentage-legend-row[data-category=failure]').getAttribute("data-percentage"), "25%");
    for (const chart of ["workload", "endpoint", "time"]) {
        await page.locator(`[data-chart=${chart}]`).click(); await ready(page);
        for (const mode of ["tools", "services"]) {
            await page.locator(`[data-percentage-mode=${mode}]`).click();
            await verify(`${chart}-${mode}`, ["start", "end", "next-day", "fresh-in-range"]);
        }
    }
    for (const bucket of ["day", "week", "month"]) {
        await selectActivityOption(page, "bucketFilter", bucket); await ready(page);
        await verify(`aggregation-${bucket}`, ["start", "end", "next-day", "fresh-in-range"]);
        assert.equal(accepted.query.filters.from, date);
        assert.equal(accepted.query.filters.to, next);
    }
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await verify("shared-failure-filter", ["fresh-in-range"]);
    assert.equal(accepted.snapshot.analytics.resultFacet.totals.count, 4);
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await appendFile(source.file, jsonl([newCall[1]]));
    await app.check();
    await verify("duplicate-start-no-new-call", ["start", "end", "next-day", "fresh-in-range"]);
    assert.deepEqual(app.receipts.at(-1).changes, { added: 0, updated: 0, items: [] });
    await app.check();
    const noChange = await verify("fast-no-change", ["start", "end", "next-day", "fresh-in-range"]);
    assert.equal(noChange.metrics.lastBytesRead, 0);
    assert.equal(noChange.lastCheck.beforeRevision, noChange.lastCheck.revision);
    assert.equal(noChange.checkedWindow.until, noChange.lastCheckedAt);
    const callsWithinSelectedInstants = inputCalls.filter(row => Date.parse(row.stamp) >= Date.parse(range.from) && Date.parse(row.stamp) < Date.parse(range.to));
    assert.equal(callsWithinSelectedInstants.length, 4, "Independent source timestamp membership agrees with every chart denominator");
    const url = new URL(page.url());
    await page.reload(); await ready(page);
    await verify("reload-selected-dates", ["start", "end", "next-day", "fresh-in-range"]);
    await navigateMain(page, "activity"); await ready(page);
    await page.goBack(); await ready(page);
    await verify("back-selected-dates", ["start", "end", "next-day", "fresh-in-range"]);
    await app.restart();
    await page.goto(app.runtime().url + url.hash); await ready(page);
    await verify("restart-selected-dates", ["start", "end", "next-day", "fresh-in-range"]);
    await dates(time.addDays(date, -60), next);
    assert.match(await page.locator("#periodCoverageText").innerText(), /outside it may be missing.*does not collect/);
    assert.equal(await page.locator("#periodHistoryLink").isVisible(), true);
    await dates(time.addDays(next, 7), time.addDays(next, 8));
    await verify("future-empty-not-a-source-query", []);
    assert.match(await page.locator("#periodHint").innerText(), /not proof/);
    assert.ok(app.writes.every(route => route === "/api/collection/now"));
    if (process.env.WORKIQ_DATE_PROOFS) {
        await mkdir(process.env.WORKIQ_DATE_PROOFS, { recursive: true });
        const name = zone.replaceAll("/", "-");
        await writeFile(path.join(process.env.WORKIQ_DATE_PROOFS, `date-pipeline-${name}.json`), JSON.stringify({ fixture: "Invented SQLite + JSONL; real collector, receipt, store, server and browser. No production traffic.", sourceId: source.id, inputCalls, observations }, null, 2));
        await writeFile(path.join(process.env.WORKIQ_DATE_PROOFS, `date-source-${name}.jsonl`), await readFile(source.file));
    }
});

test("real pending phases stay visible, stop on failure, and changing dates during a check cannot apply stale charts", { timeout: 60000 }, async t => {
    const app = await fixture(t, true, false, { timezoneId: "UTC", reducedMotion: "no-preference" }), { page } = app;
    const date = time.addDays(time.day(new Date().toISOString(), "UTC"), -2), other = time.addDays(date, 1);
    const dated = (e, day) => ({ ...e, timestamp: day + "T12:00:00.000Z" });
    const source = await app.source([dated(event("user.message", { content: "Invented pending proof" }), date), dated(call("one"), date), dated(complete("one"), date)]);
    await app.runtime().collector.collectNow();
    const stages = [];
    async function holdNext(url) {
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { entered = resolve; });
        await page.route(url, async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); }, { times: 1 });
        t.after(() => release());
        return { release, pending };
    }
    async function proof(stage, selector, pending) {
        assert.equal(await page.locator(selector).getAttribute("data-pending"), String(pending));
        const spinner = page.locator(selector + " .pending-indicator");
        if (pending) {
            assert.equal(await spinner.isVisible(), true);
            assert.equal(await spinner.getAttribute("aria-hidden"), "true");
        }
        stages.push({ stage, pending, text: await page.locator(selector).innerText(), animation: pending ? await spinner.evaluate(node => getComputedStyle(node).animationName) : null });
        if (process.env.WORKIQ_DATE_PROOFS) {
            await mkdir(process.env.WORKIQ_DATE_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WORKIQ_DATE_PROOFS, `progress-${stage}.png`), fullPage: true });
        }
    }
    const initial = await holdNext("**/api/snapshot");
    await page.goto(app.runtime().url); await initial.pending;
    await proof("initial-load", "#loadingStatus", true);
    assert.equal(stages.at(-1).animation, "evidence-pending");
    initial.release(); await ready(page);
    await proof("initial-complete", "#loadingStatus", false);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(date); await page.locator("#toFilter").fill(date);
    await page.locator("#applyDates").click(); await ready(page);
    const buttonBox = await page.locator("#checkActivity").boundingBox(), beforeChart = await page.locator("#chart").innerHTML();
    const beforeWeight = await page.locator("#checkActivity").evaluate(node => getComputedStyle(node).fontWeight);
    await appendFile(source.file, jsonl([dated(event("user.message", { content: "Invented date-switch source" }), other), dated(call("two"), other), dated(complete("two"), other)]));
    const check = await holdNext("**/api/collection/now");
    await page.locator("#checkActivity").focus(); await page.keyboard.press("Enter"); await check.pending;
    await proof("checking", "#checkActivity", true);
    await proof("checking-status", "#freshStatus", true);
    assert.equal(await page.locator("#checkActivity").innerText(), "Refresh");
    assert.equal(await page.locator("#checkActivity").evaluate(node => getComputedStyle(node).fontWeight), beforeWeight, "Pending state preserves the control's font weight.");
    assert.equal((await page.locator("#checkActivity").boundingBox()).width, buttonBox.width);
    assert.equal(await page.locator("#chart").innerHTML(), beforeChart);
    assert.equal(await page.locator("#checkActivity").isDisabled(), true);
    await page.evaluate(() => document.querySelector("#checkActivity").click());
    assert.equal(app.writes.length, 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await proof("reduced-motion-check", "#checkActivity", true);
    assert.equal(stages.at(-1).animation, "none");
    const applying = await holdNext("**/api/snapshot");
    check.release(); await applying.pending;
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "applying");
    await proof("applying", "#freshStatus", true);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    await page.locator("#fromFilter").fill(other); await page.locator("#toFilter").fill(other);
    await page.locator("#applyDates").click(); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator("#fromFilter").inputValue(), other);
    const acceptedChart = await page.locator("#chart").innerHTML();
    const chartValues = () => page.locator("#chart .dimensional-column").evaluateAll(nodes => nodes.map(node => ({
        count: node.dataset.total, height: node.dataset.frontHeight, label: node.closest("button,a").getAttribute("aria-label"),
        segments: [...node.querySelectorAll(".time-segment")].map(segment => ({ count: segment.dataset.count, height: segment.getAttribute("height"), classes: segment.getAttribute("class") })),
    })));
    const acceptedValues = await chartValues();
    assert.match(await page.locator("#periodHint").innerText(), new RegExp(time.formatDate(other, { timeZone: "UTC", locale: "en-US" }, true)));
    applying.release();
    await page.waitForFunction(() => !document.querySelector("#checkActivity").disabled);
    assert.equal(await page.locator("#chart").innerHTML(), acceptedChart);
    await proof("applied-latest-date", "#freshStatus", false);
    assert.equal(await page.locator("#freshContextMessage").isVisible(), false, "The newly selected date contains the checked event");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "1");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented held snapshot failure" } }), { times: 1 });
    await app.check();
    await proof("snapshot-error", "#freshStatus", false);
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "error");
    assert.deepEqual(await chartValues(), acceptedValues);
    assert.match(await page.locator("#freshContextMessage").innerText(), /Invented held snapshot failure/);
    assert.equal(await page.locator("#freshContextMessage").isVisible(), true, "Removing unconditional footer copy must not hide a real failed collection update");
    assert.equal(await page.locator("#coverageNotice").isVisible(), false, "General evidence limits remain in the closed About disclosure");
    const writes = app.writes.length;
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.equal(app.writes.length, writes);
    await proof("read-only-recovery", "#freshStatus", false);
    const issues = await holdNext("**/api/collection/status");
    await navigateMain(page, "collection-status"); await issues.pending;
    await proof("scoped-status", "#collectionIssuesMessage", true);
    issues.release();
    await page.waitForFunction(() => document.querySelector("#collectionIssuesMessage").dataset.pending === "false");
    await navigateMain(page, "home"); await ready(page);
    assert.equal(await page.locator("#checkActivity").getAttribute("data-pending"), "false", "Healthy idle polling is not perpetual progress");
    if (process.env.WORKIQ_DATE_PROOFS) await writeFile(path.join(process.env.WORKIQ_DATE_PROOFS, "loading-state-matrix.json"), JSON.stringify(stages, null, 2));
});

test("first Home through approved fresh collection, selected dates, exact request and a deliberately reviewed saved report", { timeout: 90000 }, async t => {
    const app = await fixture(t, false, false, { timezoneId: "UTC" }), { page } = app;
    const from = time.addDays(time.day(new Date().toISOString(), "UTC"), -2), to = time.addDays(from, 1);
    const dated = (e, day) => ({ ...e, timestamp: day + "T12:00:00.000Z" });
    const source = await app.source([
        dated(event("user.message", { content: "Invented baseline request, retained before this journey" }), from),
        dated(call("journey-baseline"), from), dated(complete("journey-baseline"), from),
    ]);
    const stages = [], directory = process.env.WORKIQ_DATE_PROOFS && path.join(process.env.WORKIQ_DATE_PROOFS, "whole-journey");
    if (directory) await mkdir(directory, { recursive: true });
    async function stage(name, nextAction) {
        const state = await loadBoardState(app.context), status = await app.runtime().collector.status();
        const values = { name, nextAction, revision: state.revision, selectedDates: { from: await page.locator("#fromFilter").inputValue(), to: await page.locator("#toFilter").inputValue() },
            count: await page.locator("#activityCount").textContent(), appliedRevision: await page.locator("#periodResult").getAttribute("data-revision"),
            receipt: status.lastCheck, result: await page.locator("#freshStatus").textContent(),
            phase: await page.locator("#freshActivity").getAttribute("data-phase"), exports: state.exports.length };
        stages.push(values);
        if (directory) {
            await page.keyboard.press("Escape"); await page.mouse.move(0, 0);
            await page.evaluate(() => { scrollTo(0, 0); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
            await page.screenshot({ path: path.join(directory, name + ".png"), fullPage: true });
        }
        return state;
    }
    async function approveAndSave() {
        assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false, "No disclosure approval is borrowed");
        assert.equal(await page.getByRole("button", { name: "3. Save locally", exact: true }).isDisabled(), true);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
        await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
        await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
        await page.locator("#reportsView[data-report-phase=saved]").waitFor(); await ready(page);
    }
    await page.goto(app.runtime().url); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "0");
    assert.equal(await page.locator("#checkActivity").innerText(), "Refresh");
    await stage("01-first-home", "Review source & connect");
    await page.locator("#freshSourceSetup").click();
    await page.locator("#reviewSource").click();
    await page.locator("#sourceDatabase").fill(app.config.appDbPath);
    await page.locator("#sourceSessions").fill(app.config.sessionRoot);
    await page.locator("#connectCollection").click();
    await page.waitForFunction(() => document.querySelector("#settingsMessage").textContent.includes("Source approved"));
    await ready(page); await navigateMain(page, "home"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(app.writes.filter(route => route === "/api/collection/configure").length, 1);
    const config = await readFile(path.join(app.context.dataDir, "collector", "config.json"));
    const original = await stage("02-connected-baseline", "Choose a Copilot chat");
    const evidenceBefore = await readFile(path.join(app.context.dataDir, "private-evidence", original.evidenceFile));
    await page.locator("#pageAction").click(); await ready(page);
    await page.locator(".session-toggle").first().click();
    await page.locator('[id^="select-request-"]').first().check();
    await navigateMain(page, "reports"); await reportContents(page);
    await page.locator("[name=promptMode][value=none]").check();
    await page.locator("#formatOptions input[value=json]").check();
    await page.locator("#formatOptions input[value=html]").uncheck();
    await scanReport(page); await approveAndSave();
    const before = await loadBoardState(app.context), previousExport = before.exports[0];
    const savedBytes = await Promise.all(Object.values(previousExport.files).map(async file => [file, await readFile(file)]));
    await page.getByRole("button", { name: "Start a new report", exact: true }).click();
    assert.equal(await page.locator("#previewSelectionSummary").innerText(), "No requests selected");
    await navigateMain(page, "home"); await ready(page);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(from); await page.locator("#toFilter").fill(to);
    await page.locator("#applyDates").click(); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    await stage("03-custom-range-baseline", "Check for new activity after using Work IQ elsewhere");
    const prompt = "Invented newly recorded request for morgan@example.invalid. Read two mail items; retain this exact original locally.";
    await appendFile(source.file, jsonl([
        dated(event("user.message", { content: prompt }), to), dated(call("journey-new-pending"), to),
        dated(call("journey-new-worked"), to), dated(complete("journey-new-worked"), to),
        dated(event("user.message", { content: "Invented out-of-range request, not report membership" }), time.addDays(from, -1)),
        dated(call("journey-outside"), time.addDays(from, -1)), dated(complete("journey-outside"), time.addDays(from, -1)),
    ]));
    const missing = await app.source(); await rm(missing.file);
    await app.check();
    const newState = await stage("04-new-data-applied", "Inspect the changed chart or choose a Copilot chat");
    const status = await app.runtime().collector.status();
    assert.equal(status.lastCheck.schemaVersion, 2);
    assert.equal(status.lastCheck.changes.added, 3);
    assert.ok(status.lastCheck.revision > status.lastCheck.beforeRevision);
    assert.equal(await page.locator("#activityCount").innerText(), "3");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "3");
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "partial");
    assert.match(await page.locator("#freshIssues").innerText(), /Chat history: 1 unavailable/);
    assert.match(await page.locator("#freshContextMessage").innerText(), /outside/);
    assert.equal(await page.locator('.percentage-legend-row[data-category=unknown]').getAttribute("data-count"), "1");
    const selected = buildActivityAnalytics(newState.evidence, { filters: { scope: "history", from, to }, bucket: "day", timeContext: { timeZone: "UTC", locale: "en-US" } });
    assert.deepEqual(selected.rows.map(row => row.toolCallId).sort(), ["journey-baseline", "journey-new-pending", "journey-new-worked"]);
    const targetId = selected.rows.find(row => row.toolCallId === "journey-new-pending").scenarioId;
    assert.equal(selected.rows.find(row => row.toolCallId === "journey-new-worked").scenarioId, targetId);
    await appendFile(source.file, jsonl([complete("journey-new-pending", false)]));
    await app.check();
    assert.equal(await page.locator("#activityCount").innerText(), "3");
    assert.equal(app.receipts.at(-1).changes.updated, 1);
    assert.equal(app.receipts.at(-1).changes.added, 0);
    await stage("05-late-result", "Recorded result filters or the chart show the changed outcome");
    await app.check();
    assert.equal((await app.runtime().collector.status()).metrics.lastBytesRead, 0);
    assert.equal(await page.locator("#freshStatus").innerText(), "No new recorded activity.");
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "partial");
    await stage("06-no-new-records", "The persistent result and history-gap link explain the bounded check");
    await selectActivityOption(page, "bucketFilter", "day"); await ready(page);
    await page.locator("#chart .time-column").filter({ has: page.locator(".dimensional-column[data-total='2']") }).click();
    await ready(page);
    assert.equal(await page.locator("#activityView").isVisible(), true);
    if (await page.locator(".session-toggle[aria-expanded=false]").count()) await page.locator(".session-toggle[aria-expanded=false]").first().click();
    const requestRow = page.locator(".request-row").filter({ hasText: "Invented newly recorded request" });
    assert.equal(await requestRow.count(), 1);
    await requestRow.locator(".request-link").click(); await ready(page);
    assert.equal(await page.locator("#requestContent .request-original pre").innerText(), prompt);
    assert.equal(await page.locator("#requestContent .journey-item").count(), 2);
    assert.match(await page.locator("#requestContent").innerText(), /Tool failed/);
    assert.match(await page.locator("#requestContent").innerText(), /Worked/);
    await stage("07-exact-request-actions", "Add to report; only this request group is selected");
    await page.getByRole("button", { name: "Add to report", exact: true }).click();
    await navigateMain(page, "reports");
    assert.match(await page.locator("#previewSelectionSummary").innerText(), /1 request group included/);
    assert.equal(await page.locator("[name=reportScope]:checked").inputValue(), "selected");
    await reportContents(page);
    await page.locator("[name=promptMode][value=masked]").check();
    await page.locator("#formatOptions input[value=html]").check();
    await page.locator("#formatOptions input[value=json]").check();
    for (const format of ["pdf", "markdown"]) await page.locator(`#formatOptions input[value=${format}]`).uncheck();
    let release, arrived;
    const hold = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    t.after(() => release());
    await page.route("**/api/preview", async route => { const response = await route.fetch(); arrived(); await hold; await route.fulfill({ response }); }, { times: 1 });
    await page.locator("#exportBtn").click(); await pending;
    assert.equal(await page.locator("#reportReviewBody .pending-indicator").isVisible(), true);
    await page.getByRole("button", { name: "Back to setup", exact: true }).click();
    const cancelled = page.waitForResponse(response => response.url().endsWith("/api/cancel-preview"));
    release(); await cancelled;
    assert.equal((await loadBoardState(app.context)).exports.length, 1);
    await page.locator("[name=promptMode][value=none]").check();
    await page.locator("[name=promptMode][value=masked]").check();
    const previewRequest = page.waitForRequest(request => request.url().endsWith("/api/preview"));
    let frozen = await scanReport(page);
    assert.equal(frozen.records.length, 1);
    assert.equal(frozen.promptMode, "masked");
    assert.deepEqual(frozen.formats, ["html", "json"]);
    assert.deepEqual((await previewRequest).postDataJSON().selection.scenarioIds, [targetId]);
    assert.equal(frozen.snapshot.selectionScope.kind, "selected");
    assert.equal(frozen.snapshot.selectionScope.requestGroups, 1);
    assert.equal(frozen.snapshot.selectionScope.workIqActions, 2);
    assert.equal(frozen.records[0].toolCalls.length, 2);
    const followup = frozen.records[0].prompts.find(copy => copy.kind === "followup");
    assert.match(followup.label, /association inferred/);
    assert.equal(followup.text, "Invented out-of-range request, not report membership");
    await inspectReportCopies(page);
    assert.match(await page.locator(".report-copy-inspection").innerText(), /Follow-up 1 \(association inferred\)/);
    const followupCopy = page.locator(".prompt-comparison").filter({ has: page.locator(":scope>summary", { hasText: "Follow-up 1 (association inferred)" }) });
    await followupCopy.locator(":scope>summary").click();
    assert.match(await page.locator(".report-copy-inspection").innerText(), /Invented out-of-range request/);
    await followupCopy.getByText("Edit or omit this report copy", { exact: true }).click();
    await followupCopy.getByRole("checkbox", { name: "Omit this prompt from the report", exact: true }).check();
    const rebuiltResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    const rebuilt = await rebuiltResponse;
    frozen = await rebuilt.json();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    assert.deepEqual(rebuilt.request().postDataJSON().selection.scenarioIds, [targetId]);
    assert.equal(frozen.records[0].prompts.find(copy => copy.kind === "followup").omitted, true);
    assert.equal(frozen.records[0].toolCalls.length, 2);
    await stage("08-reviewed-copies", "Omit an unwanted inferred follow-up, rebuild the masked copies, then explicitly approve disclosure and confirm export");
    await approveAndSave();
    const final = await stage("09-saved-report", "Download the chosen HTML or JSON report");
    assert.equal(final.exports.length, 2);
    assert.deepEqual(final.exports[0], previousExport);
    const saved = final.exports[1], exported = JSON.parse(await readFile(saved.files["product-report.json"], "utf8"));
    assert.deepEqual(exported.records, frozen.records, "Actual saved JSON is the exact reviewed membership and content, not merely an existing file");
    assert.equal(exported.records.length, 1);
    assert.doesNotMatch(JSON.stringify(exported), /morgan@example\.invalid|Invented baseline request|Invented out-of-range request/);
    const html = await readFile(saved.files["product-report.html"], "utf8");
    assert.doesNotMatch(html, /morgan@example\.invalid|Invented baseline request|Invented out-of-range request/);
    assert.match(html, /Invented newly recorded request/);
    assert.equal(final.evidence.find(row => row.scenarioId === targetId).userPrompt.text, prompt);
    for (const [id, review] of Object.entries(before.cards)) assert.deepEqual(final.cards[id], review, "Earlier request review state is unchanged");
    assert.deepEqual(await readFile(path.join(app.context.dataDir, "private-evidence", original.evidenceFile)), evidenceBefore);
    for (const [file, bytes] of savedBytes) assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(await readFile(path.join(app.context.dataDir, "collector", "config.json")), config);
    assert.equal(app.writes.filter(route => route === "/api/collection/configure").length, 1);
    assert.equal(app.writes.filter(route => route === "/api/collection/enabled").length, 0);
    if (directory) {
        for (const [name, file] of Object.entries(saved.files)) await writeFile(path.join(directory, name), await readFile(file));
        await writeFile(path.join(directory, "journey-proof.json"), JSON.stringify({ fixture: "Invented isolated sources and report files only; real user controls and local pipeline",
            stages, canonicalIds: selected.rows.map(({ id, toolCallId, scenarioId, startedAt }) => ({ id, toolCallId, scenarioId, startedAt })),
            targetId, frozenSelection: frozen.snapshot.selectionScope, promptMode: frozen.promptMode, formats: frozen.formats,
            savedMembership: exported.records, priorExportsPreserved: 1, priorReviewsPreserved: Object.keys(before.cards).length,
            originalEvidencePreserved: true, approvalUnchanged: true, inferredFollowupExplicitlyOmitted: true, collectionWrites: app.writes }, null, 2));
    }
});

test("Home ingests real appended local evidence and newly mapped chats before applying counts, outcomes and charts", { timeout: 90000 }, async t => {
    const app = await fixture(t), { page } = app;
    const provenance = [];
    async function proof(stage) {
        const status = await app.runtime().collector.status(), state = await loadBoardState(app.context);
        const canonical = buildActivityAnalytics(state.evidence ?? [], { layer: "tool", bucket: "month", filters: { scope: "all" } }).rows;
        const applied = await page.locator("#periodResult").getAttribute("data-revision");
        provenance.push({ stage, fixture: "invented local SQLite and JSONL only", revision: state.revision,
            evidenceFile: state.evidenceFile, receipt: status.lastCheck, metrics: status.metrics,
            cursors: status.cursors.map(row => ({ sessionId: row.sessionId, logBytes: row.logBytes, cursor: row.cursor })),
            canonical: canonical.map(row => ({ id: row.id, toolCallId: row.toolCallId, outcome: row.outcome })),
            home: { count: await page.locator("#activityCount").innerText(), appliedRevision: applied,
                percentageTotal: await page.locator(".percentage-section").getAttribute("data-total"),
                percentageRevision: await page.locator(".percentage-section").getAttribute("data-revision"),
                result: await page.locator("#freshStatus").innerText(), context: await page.locator("#freshContextMessage").textContent() } });
        if (status.lastCheck) {
            assert.equal(String(status.lastCheck.revision), applied);
            assert.equal(provenance.at(-1).home.percentageRevision, applied);
            assert.equal(new Set(canonical.map(row => row.id)).size, canonical.length);
        }
        if (process.env.WORKIQ_FRESH_PROOFS) {
            await page.keyboard.press("Escape"); await page.mouse.move(0, 0);
            await mkdir(process.env.WORKIQ_FRESH_PROOFS, { recursive: true });
            await writeFile(path.join(process.env.WORKIQ_FRESH_PROOFS, "pipeline-provenance.json"), JSON.stringify(provenance, null, 2));
            await page.locator("#freshActivity").screenshot({ path: path.join(process.env.WORKIQ_FRESH_PROOFS, `${stage}.png`) });
        }
        return status;
    }
    const source = await app.source([event("user.message", { content: "Synthetic first request" }), call("one"), complete("one")]);
    await page.goto(app.runtime().url); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "0");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "0");
    await proof("baseline");
    const initialPercentage = await page.locator("#percentageCharts").innerHTML();
    const configBefore = await readFile(path.join(app.context.dataDir, "collector", "config.json"));
    const sourceBefore = await readFile(source.file);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const snapshotEntered = new Promise(resolve => { entered = resolve; });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        entered();
        await gate;
        await route.fulfill({ response });
    });

    await page.locator("#checkActivity").click();
    await snapshotEntered;
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "applying");
    assert.equal(await page.locator("#activityCount").innerText(), "0", "Previous chart remains while the actual ingested snapshot is pending");
    assert.equal(await page.locator("#percentageCharts").innerHTML(), initialPercentage, "No new denominator appears on old data while applying");
    assert.equal(await page.locator("#checkActivity").isDisabled(), true);
    assert.equal(await page.locator("#collectNow").isDisabled(), true, "Settings shares the same busy state");
    assert.equal(await page.locator("#pauseCollection").isDisabled(), true);
    await page.evaluate(() => { document.querySelector("#checkActivity").click(); document.querySelector("#checkActivity").click(); });
    assert.equal(app.writes.length, 1);
    assert.equal((await loadBoardState(app.context)).evidence[0].toolCalls.length, 1, "Actual collector committed before UI completion");
    release(); await ready(page);
    await page.unroute("**/api/snapshot");
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "1");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-revision"), await page.locator("#periodResult").getAttribute("data-revision"));
    assert.equal(await page.locator("#freshStatus").innerText(), "1 new activity record.");
    assert.equal(await page.locator("#freshActivity").getAttribute("data-revision"), await page.locator("#periodResult").getAttribute("data-revision"));
    assert.match(await page.locator("#chart").innerText(), /1/);
    const firstProof = await proof("initial-new-call");
    assert.ok(firstProof.metrics.lastBytesRead > 0);
    assert.ok(firstProof.cursors[0].cursor.offset > 0);
    const firstState = await loadBoardState(app.context);
    const oldEvidence = await readFile(path.join(app.context.dataDir, "private-evidence", firstState.evidenceFile));
    await navigateMain(page, "activity"); await ready(page);
    await page.locator(".session-toggle").first().click();
    await page.locator('[id^="select-request-"]').first().check();
    await navigateMain(page, "home"); await ready(page);
    await appendFile(source.file, jsonl([event("user.message", { content: "Synthetic later request" }), call("two")]));
    await app.check();
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "2");
    assert.equal((await loadBoardState(app.context)).evidence.flatMap(r => r.toolCalls).filter(c => c.reportedOutcome === "unknown").length, 1);
    const appendedProof = await proof("appended-call");
    assert.ok(appendedProof.metrics.totalBytesRead > firstProof.metrics.totalBytesRead);
    assert.ok(appendedProof.cursors[0].cursor.offset > firstProof.cursors[0].cursor.offset);
    const chartUnknown = await page.locator("#chart").innerHTML();
    await appendFile(source.file, jsonl([complete("two", false)]));
    await app.check();
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.equal(await page.locator("#freshStatus").innerText(), "1 updated activity record.");
    assert.equal(await page.locator("#freshContextMessage").isVisible(), false, "An in-scope late result is an update even when the count stays unchanged");
    assert.notEqual(await page.locator("#chart").innerHTML(), chartUnknown);
    await page.locator("#outcomeFilter-control").click();
    assert.equal(await page.getByRole("option", { name: "Tool failed (1)", exact: true }).count(), 1);
    await page.keyboard.press("Escape");
    const percentageOutcomes = await page.locator('[data-percentage-card="outcomes"] .percentage-legend-row').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.dataset.category, { count: Number(row.dataset.count), share: Number.parseFloat(row.dataset.percentage) }])));
    assert.equal(percentageOutcomes.success.count, 1);
    assert.equal(percentageOutcomes.failure.count, 1);
    assert.equal(percentageOutcomes.success.share, 50);
    assert.equal(percentageOutcomes.failure.share, 50);
    await proof("late-completion");
    const mapped = await app.source([event("user.message", { content: "Synthetic newly discovered source" }), call("three"), complete("three")]);
    await app.check();
    assert.equal(await page.locator("#activityCount").innerText(), "3");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "3");
    assert.equal(await page.locator("#periodResult").innerText(), "3 Work IQ tool calls");
    assert.ok((await app.runtime().collector.status()).cursors.some(row => row.sessionId === mapped.id));
    const mappedProof = await proof("newly-discovered-chat");
    await app.check();
    assert.equal(await page.locator("#freshStatus").innerText(), "No new recorded activity.");
    assert.equal(app.receipts.at(-1).changes.added, 0);
    assert.equal(app.receipts.at(-1).changes.updated, 0);
    const noChangeProof = await proof("no-new-activity");
    assert.equal(noChangeProof.metrics.lastBytesRead, 0, "An unchanged file is checked by its stamp, not reread");
    assert.equal(noChangeProof.lastCheck.beforeRevision, noChangeProof.lastCheck.revision);
    assert.equal(noChangeProof.lastNewDataAt, mappedProof.lastNewDataAt);
    const manualTime = await page.locator("#freshChecked").innerText();
    const manualResult = await page.locator("#freshStatus").innerText();
    await app.runtime().collector.collectNow();
    const polled = page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await polled;
    assert.equal(await page.locator("#freshChecked").innerText(), manualTime, "A later check by another client never replaces this panel's manual result time");
    assert.equal(await page.locator("#freshStatus").innerText(), manualResult);
    await navigateMain(page, "activity"); await ready(page);
    await page.locator("#activitySearch").fill("Synthetic first request");
    await page.waitForFunction(() => document.querySelector("#periodResult").textContent.includes("1 request group with 1 Work IQ tool call"));
    await navigateMain(page, "home"); await ready(page);
    assert.equal(await page.locator("#periodResult").innerText(), "3 Work IQ tool calls", "Home summary uses the Home chart scope, not the hidden Activity search");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "3");
    await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
    await appendFile(source.file, jsonl([event("user.message", { content: "Synthetic out-of-filter request" }), call("four"), complete("four")]));
    await app.check();
    assert.equal(await page.locator("#activityCount").innerText(), "0");
    assert.equal(await page.locator("#freshStatus").innerText(), "1 new activity record.");
    assert.match(await page.locator("#freshContextMessage").innerText(), /outside.*filters or evidence layer/);
    assert.equal(await page.locator("#serviceFilter").inputValue(), "Calendar");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "0");
    await proof("new-call-outside-filter");
    await selectActivityOption(page, "serviceFilter", "all"); await ready(page);
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "4");
    assert.equal(await page.locator("#freshContextMessage").isVisible(), false, "Fresh-check scope stays truthful after filters change");
    assert.deepEqual(await readFile(path.join(app.context.dataDir, "collector", "config.json")), configBefore);
    assert.deepEqual((await readFile(source.file)).subarray(0, sourceBefore.length), sourceBefore);
    assert.deepEqual(await readFile(path.join(app.context.dataDir, "private-evidence", firstState.evidenceFile)), oldEvidence);
    assert.deepEqual((await loadBoardState(app.context)).exports, firstState.exports);
    assert.equal((await app.runtime().collector.status()).config.enabled, false);
    assert.match(await page.locator("#activitySelectionSummary").textContent(), /1 request/);
    const lastCheck = (await app.runtime().collector.status()).lastCheck;
    await app.restart();
    assert.deepEqual((await app.runtime().collector.status()).lastCheck, lastCheck, "Owned completion survives restart");
    await page.goto(app.runtime().url); await ready(page);
    await app.check();
    assert.equal(await page.locator("#activityCount").innerText(), "4");
    assert.match(await page.locator("#freshStatus").innerText(), /No new recorded activity/);
    assert.equal((await app.runtime().collector.status()).config.enabled, false);
    assert.ok(app.writes.every(route => route === "/api/collection/now"), "No implicit permissions, configuration or background enable writes");
});

test("compact summary and fresh action wrap accessibly in light/navy at every requested size", { timeout: 90000 }, async t => {
    const app = await fixture(t), { page } = app;
    let limited;
    for (let source = 0; source < 35; source++) {
        const events = [];
        for (let group = source; group < 61; group += 35) {
            events.push(event("user.message", { content: `Synthetic layout group ${group}` }));
            for (let i = 0; i < (group < 34 ? 4 : 3); i++) events.push(call(`layout-${group}-${i}`), complete(`layout-${group}-${i}`));
        }
        const history = await app.source(events);
        limited ??= history;
    }
    await appendFile(limited.file, JSON.stringify(event("assistant.message", { content: "x".repeat(1024 * 1024 + 20) })) + "\n");
    const missing = await app.source();
    await rm(missing.file);
    await app.runtime().collector.collectNow();
    const proofs = process.env.WORKIQ_FRESH_PROOFS, measurements = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 1466, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(app.runtime().url); await ready(page);
        await app.check();
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; scrollTo(0, 0); }, scale);
        await page.keyboard.press("Escape"); await page.mouse.move(0, 0);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator("#periodResult").innerText(), "217 Work IQ tool calls");
        const metrics = await page.evaluate(() => {
            const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
            const lines = id => {
                const walker = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT), rows = [];
                while (walker.nextNode()) {
                    const text = walker.currentNode;
                    if (!text.textContent.trim() || !text.parentElement.checkVisibility()) continue;
                    const range = document.createRange(); range.selectNodeContents(text);
                    for (const rect of range.getClientRects()) if (rect.width && !rows.some(top => Math.abs(top - rect.top) <= 1)) rows.push(rect.top);
                }
                return rows.length;
            };
            const clipping = [...document.querySelectorAll("#freshActivity button,#freshActivity p,#freshActivity a,#periodResult,#periodHint,#pageAction")].filter(n => n.checkVisibility()).flatMap(node => {
                const r = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
                return [...range.getClientRects()].filter(b => b.width && (b.left < r.left - 1 || b.right > r.right + 1 || b.bottom > r.bottom + 1)).map(() => node.id || node.textContent);
            });
            const textColors = ["freshStatus", "freshChecked", "freshScope", "freshIssues"].map(id => {
                const node = document.getElementById(id);
                let owner = node, background;
                while (owner) {
                    background = getComputedStyle(owner).backgroundColor;
                    if (background !== "transparent" && background !== "rgba(0, 0, 0, 0)") break;
                    owner = owner.parentElement;
                }
                return { id, color: getComputedStyle(node).color, background };
            });
            return { overflow: document.documentElement.scrollWidth - innerWidth, action: box("checkActivity"), period: box("periodFeedback"), introLines: lines("pageIntro"), resultLines: lines("periodResult"), hintLines: lines("periodHint"), clipping,
                textColors,
                targets: [...document.querySelectorAll("#freshActivity button,#freshActivity a")].filter(n => n.checkVisibility()).map(n => n.getBoundingClientRect().height) };
        });
        assert.ok(metrics.overflow <= 1, `${theme}/${width}/${scale}: no page overflow`);
        assert.deepEqual(metrics.clipping, []);
        for (const { id, color, background } of metrics.textColors) assert.ok(contrast(color, background) >= 4.5, `${id} text contrast in ${theme}`);
        assert.ok(metrics.targets.every(height => height >= 44));
        assert.ok(metrics.action.bottom <= 1000, `Fresh action visible in first viewport at ${theme}/${width}/${scale}: ${metrics.action.bottom}`);
        if (width >= 1200 && scale === 1) {
            assert.equal(metrics.introLines, 1, "Purpose is one real line, not clipped, shrunk or forced nowrap");
            assert.equal(metrics.resultLines, 1);
            assert.equal(metrics.hintLines, 1);
            assert.ok(metrics.period.height <= 56);
        }
        if (proofs) {
            await page.screenshot({ path: path.join(proofs, `fresh-${theme}-${width}-${scale * 100}.png`) });
            if (width === 375 && scale === 2) await page.screenshot({ path: path.join(proofs, `full-${theme}-${width}-${scale * 100}.png`), fullPage: true });
            else await page.locator("#freshActivity").screenshot({ path: path.join(proofs, `strip-${theme}-${width}-${scale * 100}.png`) });
        }
        await page.locator("#freshHelp>summary").focus(); await page.keyboard.press("Enter");
        assert.equal(await page.locator("#freshCheckDetails").isVisible(), true);
        assert.match(await page.locator("#freshHelp").innerText(), /does not run Work IQ or Graph queries/);
        assert.match(await page.locator("#freshCheckDetails").innerText(), /eligible Copilot chats in \d[\d,]* ms/);
        const helpClipping = await page.locator("#freshHelp p").evaluateAll(nodes => nodes.flatMap(node => {
            const r = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
            return [...range.getClientRects()].filter(box => box.width && (box.left < r.left - 1 || box.right > r.right + 1 || box.bottom > r.bottom + 1)).map(() => node.textContent);
        }));
        assert.deepEqual(helpClipping, [], "Essential help remains fully readable with enlarged text");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proofs && (width === 375 && scale === 2 || width === 1200 && scale === 1)) {
            await page.locator("#freshHelp").screenshot({ path: path.join(proofs, `help-${theme}-${width}-${scale * 100}.png`) });
        }
        await page.keyboard.press("Enter");
        measurements.push({ theme, width, scale, ...metrics });
    }
    if (proofs) await writeFile(path.join(proofs, "fresh-layout.json"), JSON.stringify(measurements, null, 2));
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.locator("#checkActivity").focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "partial");
    assert.equal(await page.locator("#checkActivity").evaluate(n => n === document.activeElement), true);
    await page.locator("#freshHelp>summary").focus(); await page.keyboard.press("Enter");
    const position = await page.evaluate(() => scrollY), manual = await page.locator("#freshChecked").innerText();
    const polled = page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await polled;
    assert.equal(await page.locator("#freshHelp").evaluate(n => n.open), true);
    assert.equal(await page.locator("#freshHelp>summary").evaluate(n => n === document.activeElement), true);
    assert.equal(await page.evaluate(() => scrollY), position);
    assert.equal(await page.locator("#freshChecked").innerText(), manual);
    await page.locator('#freshActivity a[href*="section=collection"]').click();
    assert.equal(await page.locator('[data-settings-section="connection"]').isVisible(), true);
    await page.goBack(); await ready(page);
    await page.locator('#freshActivity a[href*="source-paths"]').click();
    assert.equal(await page.locator("#approvedSourceDetails").isVisible(), true);
    assert.equal(await page.locator("#approvedSourceTitle").evaluate(n => n === document.activeElement), true);
});

test("an actual background cycle can already have the new call before a fast manual no-change check", { timeout: 45000 }, async t => {
    const app = await fixture(t, true, true), { page } = app;
    const source = await app.source([event("user.message", { content: "Synthetic interval-collected request" })]);
    const baseline = await app.runtime().collector.collectNow();
    await page.goto(app.runtime().url); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "0");
    await appendFile(source.file, jsonl([call("background-call"), complete("background-call")]));
    await app.runtime().collector.setEnabled(true);
    await page.waitForFunction(() => document.querySelector("#activityCount").textContent === "1", null, { timeout: 20000 });
    const before = await app.runtime().collector.status();
    assert.equal(before.lastCheck.id, baseline.check.id, "Only the real interval has run since the empty baseline");
    const revision = (await loadBoardState(app.context)).revision;
    await app.check();
    const after = await app.runtime().collector.status();
    assert.equal(after.lastCheck.revision, revision);
    assert.equal(after.lastCheck.beforeRevision, revision);
    assert.deepEqual(after.lastCheck.changes, { added: 0, updated: 0, items: [] });
    assert.equal(after.metrics.lastBytesRead, 0);
    assert.equal(after.lastNewDataAt, before.lastNewDataAt);
    assert.equal(await page.locator("#freshStatus").innerText(), "No new recorded activity.");
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    await page.locator("#freshHelp>summary").click();
    assert.match(await page.locator("#freshHelp").innerText(), /Background collection may already have read/);
    if (process.env.WORKIQ_FRESH_PROOFS) {
        await mkdir(process.env.WORKIQ_FRESH_PROOFS, { recursive: true });
        await writeFile(path.join(process.env.WORKIQ_FRESH_PROOFS, "background-caught-up.json"), JSON.stringify({
            fixture: "invented SQLite/JSONL; real enabled collector timer", before: { revision, lastCheck: before.lastCheck, metrics: before.metrics },
            manualReceipt: after.lastCheck, metrics: after.metrics, count: await page.locator("#activityCount").innerText(),
        }, null, 2));
    }
});

test("duplicate aliases and richer API metadata cannot manufacture new Home calls", { timeout: 60000 }, async t => {
    const app = await fixture(t), { page } = app;
    const invocation = call("stable-call");
    const source = await app.source([event("user.message", { content: "Synthetic metadata-only change" }), invocation, complete("stable-call")]);
    await page.goto(app.runtime().url); await ready(page); await app.check();
    const original = await loadBoardState(app.context);
    await replaceEvidence(app.context, () => ({ records: [...original.evidence, {
        ...original.evidence[0], scenarioId: "synthetic-legacy-alias", isLegacy: true,
        toolCalls: original.evidence[0].toolCalls.map(call => ({ ...call, reportedOutcome: "failed", toolSucceeded: false })),
    }], importCoverage: original.importCoverage }));
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    await appendFile(source.file, jsonl([invocation]));
    await app.check();
    const alias = (await app.runtime().collector.status()).lastCheck;
    assert.deepEqual(alias.changes, { added: 0, updated: 0, items: [] });
    assert.ok(alias.revision >= alias.beforeRevision);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator("#freshStatus").innerText(), "No new recorded activity.");
    await appendFile(source.file, jsonl([event("tool.execution_complete", { toolCallId: "stable-call", success: true,
        result: { structuredContent: { results: [{ statusCode: 200, body: { "@odata.nextLink": "https://example.invalid/next" } }] } } })]));
    await app.check();
    const status = await app.runtime().collector.status(), state = await loadBoardState(app.context);
    assert.equal(status.lastCheck.changes.added, 0);
    assert.equal(status.lastCheck.changes.updated, 1);
    assert.ok(status.lastCheck.revision > alias.revision);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "1");
    assert.equal(await page.locator("#freshStatus").innerText(), "1 updated activity record.");
    assert.equal(await page.locator("#freshContextMessage").isVisible(), false);
    const api = buildActivityAnalytics(state.evidence, { layer: "reported-api", bucket: "month", filters: { scope: "all" } });
    assert.equal(api.rows.length, 1, "New result metadata is committed without adding a tool call");
    assert.equal(api.rows[0].parentCallId, status.lastCheck.changes.items[0].rowId);
    if (process.env.WORKIQ_FRESH_PROOFS) {
        await mkdir(process.env.WORKIQ_FRESH_PROOFS, { recursive: true });
        await writeFile(path.join(process.env.WORKIQ_FRESH_PROOFS, "alias-and-metadata.json"), JSON.stringify({
            fixture: "invented data only", aliasReceipt: alias, metadataReceipt: status.lastCheck,
            committedRevision: state.revision, acceptedRevision: await page.locator("#periodResult").getAttribute("data-revision"),
            toolCount: await page.locator("#activityCount").innerText(), apiRows: api.rows.map(({ id, parentCallId }) => ({ id, parentCallId })),
        }, null, 2));
    }
});

test("partial, bounded and failed checks retain honest coverage and last good Home; stale snapshots cannot complete", { timeout: 90000 }, async t => {
        const app = await fixture(t), { page } = app;
        const source = await app.source([event("user.message", { content: "Synthetic reliable source" }), call("one"), complete("one")]);
        await page.goto(app.runtime().url); await ready(page); await app.check();
        const missing = await app.source();
        await rm(missing.file);
        await appendFile(source.file, jsonl([event("user.message", { content: "Synthetic partially available batch" }), call("two"), complete("two")]));
        await app.check();
        assert.equal(await page.locator("#activityCount").innerText(), "2");
        assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "partial");
        assert.equal(await page.locator("#freshStatus").innerText(), "1 new activity record.");
        assert.equal(await page.locator("#freshIssues").innerText(), "Chat history: 1 unavailable");
        assert.match(await page.locator("#freshCheckDetails").textContent(), /1 history unavailable/);
        await appendFile(source.file, JSON.stringify(event("assistant.message", { content: "x".repeat(1024 * 1024 + 20) })) + "\n");
        await app.check();
        assert.equal(await page.locator("#freshStatus").innerText(), "No new recorded activity.");
        assert.equal(await page.locator("#freshIssues").innerText(), "Chat history: 1 unavailable · 1 with limits");
        assert.match(await page.locator("#freshCheckDetails").textContent(), /with limits/);
        assert.equal(app.receipts.at(-1).coverage.limited, 1);
        const previous = await page.locator("#chart").innerHTML();
        const previousPercentages = await page.locator("#percentageCharts").innerHTML();
        app.db.exec("PRAGMA user_version=174; ALTER TABLE sessions RENAME COLUMN execution_location TO removed_location");
        await app.check();
        assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "error");
        assert.match(await page.locator("#freshStatus").innerText(), /not confirmed/);
        assert.match(await page.locator("#freshContextMessage").innerText(), /Unsupported sessions mapping.*174/);
        assert.equal(await page.locator("#chart").innerHTML(), previous);
        assert.equal(await page.locator("#percentageCharts").innerHTML(), previousPercentages);
        assert.equal(await page.locator("#activityCount").innerText(), "2");
        assert.equal(await page.locator("#freshIssues").getAttribute("href"), "#collection-status");
        app.db.exec("PRAGMA user_version=156; ALTER TABLE sessions RENAME COLUMN removed_location TO execution_location");
        let oldSnapshot;
        await page.route("**/api/snapshot", async route => { const response = await route.fetch(); oldSnapshot = await response.json(); await route.fulfill({ response }); });
        await (await revealStoredRefresh(page)).click(); await ready(page);
        await page.unroute("**/api/snapshot");
        await appendFile(source.file, jsonl([event("user.message", { content: "Synthetic withheld snapshot" }), call("three"), complete("three")]));
        await page.route("**/api/snapshot", route => route.fulfill({ json: oldSnapshot }));
        await app.check();
        assert.equal(await page.locator("#activityCount").innerText(), "2");
        assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "error");
        assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "2");
        assert.match(await page.locator("#freshStatus").innerText(), /not updated/);
        assert.match(await page.locator("#freshContextMessage").innerText(), /older than the completed local check/);
        assert.equal((await loadBoardState(app.context)).evidence.flatMap(row => row.toolCalls).length, 3);
        await page.unroute("**/api/snapshot");
        const writeCount = app.writes.length;
        await (await revealStoredRefresh(page)).click(); await ready(page);
        assert.equal(await page.locator("#activityCount").innerText(), "3");
        assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "3");
        assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "partial");
        assert.equal(app.writes.length, writeCount, "Reload view recovers an apply failure without replaying collection");
        await page.locator("#freshIssues").click();
        assert.match(page.url(), /#collection-status.*setting=issues/);
        await page.locator(".history-reason>summary").first().click();
        await page.locator(".history-issue").first().waitFor();
        assert.match(await page.locator("#collectionIssuesBody").innerText(), /History file not found \(1\)/);
});

test("unapproved Refresh reads retained activity and leaves source review as a separate deliberate action", async t => {
        const app = await fixture(t, false), { page } = app;
        await app.source([event("user.message", { content: "Synthetic unapproved activity" }), call("not-approved")]);
        await page.goto(app.runtime().url); await ready(page);
        assert.equal(await page.locator("#checkActivity").innerText(), "Refresh");
        await app.check();
        assert.match(page.url(), /#analyze/);
        assert.equal(await page.locator("#freshStatus").innerText(), "Stored activity refreshed.");
        assert.match(await page.locator("#freshContextMessage").innerText(), /No source history was checked/);
        assert.equal(await page.locator("#refreshBtn").isVisible(), false);
        await page.locator("#freshSourceSetup").click();
        assert.match(page.url(), /#settings.*section=connection.*setting=source/);
        assert.equal(await page.locator("#reviewSource").isVisible(), true);
        assert.deepEqual(app.writes, []);
        assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
});

test("unknown Refresh stays read-only across foreign receipts, delayed source completion and session renewal", { timeout: 45000 }, async t => {
    const app = await fixture(t), { page } = app;
    const source = await app.source([event("user.message", { content: "Invented retained activity" }), call("one"), complete("one")]);
    await app.runtime().collector.collectNow();
    const before = await loadBoardState(app.context);
    const configBefore = await readFile(path.join(app.context.dataDir, "collector", "config.json"));
    await page.goto(app.runtime().url); await ready(page);
    await appendFile(source.file, jsonl([event("user.message", { content: "Invented delayed update" }), call("delayed"), complete("delayed")]));
    const requests = [];
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    // The response is lost before the delayed source operation can be observed.
    await page.route("**/api/collection/now", route => route.abort(), { times: 1 });
    await app.check();
    assert.equal(app.writes.length, 1);
    assert.match(await page.locator("#freshContextMessage").textContent(), /outcome unknown/);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), sourceCheckKey), "pending");
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "unconfirmed");
    assert.equal(app.writes.length, 1, "Reload restores the pending guard without dispatching");
    const foreign = { ...(await app.runtime().collector.status()).lastCheck, id: "invented-foreign-manual-check" };
    await page.route("**/api/collection/status", async route => {
        const response = await route.fetch(), status = await response.json();
        await route.fulfill({ response, json: { ...status, lastCheck: foreign } });
    });
    await page.locator("#refreshBtn").focus(); await page.keyboard.press("Enter"); await ready(page);
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "unconfirmed");
    assert.equal(await page.locator("#freshActivity").getAttribute("data-check-id"), "");
    assert.equal(app.writes.length, 1, "A foreign completed status receipt is not authorization to replay");
    assert.equal((await loadBoardState(app.context)).revision, before.revision);
    await app.runtime().collector.collectNow(); // The original synthetic delayed operation finally settles.
    await page.unroute("**/api/collection/status");
    await app.check();
    assert.equal(await page.locator("#activityCount").innerText(), "2", "Latest stored evidence remains usable");
    assert.match(await page.locator("#freshStatus").innerText(), /source check unconfirmed/);
    assert.equal(await page.locator("#freshActivity").getAttribute("data-check-id"), "", "No unrelated receipt is adopted");
    assert.equal(app.writes.length, 1);
    await page.route("**/api/snapshot", route => route.fulfill({ status: 403, json: { code: "session_expired", error: "Invented connection renewal" } }), { times: 1 });
    await app.check();
    assert.ok(requests.includes("/api/session"), "Exercise real safe-read reauthentication");
    assert.equal(app.writes.length, 1, "Renewal cannot authorize another check");
    assert.match(await page.locator("#freshStatus").innerText(), /source check unconfirmed/);
    assert.deepEqual(await readFile(path.join(app.context.dataDir, "collector", "config.json")), configBefore);
    assert.equal(requests.some(value => /\/(?:configure|enabled|preview|privacy-review|export|start|qualify|confirm)$/.test(value)), false);
    if (process.env.WIRE_REFRESH_PROOFS) {
        await mkdir(process.env.WIRE_REFRESH_PROOFS, { recursive: true });
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            await page.screenshot({ path: path.join(process.env.WIRE_REFRESH_PROOFS, `${theme}-unknown-outcome.png`) });
        }
    }
});

for (const mode of ["pending", "malformed", "read-denied", "write-denied", "write-dropped", "clear-denied", "clear-dropped"]) {
    test(`Refresh recovery storage ${mode} keeps the tab safe without discarding a known receipt`, { timeout: 20000 }, async t => {
        const app = await fixture(t), { page } = app;
        await app.source([event("user.message", { content: "Invented storage-guard activity" }), call("one"), complete("one")]);
        await page.addInitScript(({ key, mode }) => {
            const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
            if (mode === "pending" || mode === "malformed") sessionStorage.setItem(key, mode === "pending" ? "pending" : "invalid");
            Storage.prototype.getItem = function (name) {
                if (name === key && mode === "read-denied") throw new DOMException("Invented denied read", "SecurityError");
                return get.call(this, name);
            };
            Storage.prototype.setItem = function (name, value) {
                if (name === key && mode === "write-denied") throw new DOMException("Invented denied write", "QuotaExceededError");
                if (name === key && mode === "write-dropped") return;
                return set.call(this, name, value);
            };
            Storage.prototype.removeItem = function (name) {
                if (name === key && mode === "clear-denied") throw new DOMException("Invented denied clear", "SecurityError");
                if (name === key && mode === "clear-dropped") return;
                return remove.call(this, name);
            };
        }, { key: sourceCheckKey, mode });
        await page.route("**/api/collection/now", async route => {
            assert.equal(await page.evaluate(key => sessionStorage.getItem(key), sourceCheckKey), "pending", "Marker is verified before source dispatch");
            await route.continue();
        });
        await page.goto(app.runtime().url); await ready(page);
        await app.check();
        const known = mode.startsWith("clear-");
        assert.equal(app.writes.length, known ? 1 : 0);
        if (known) {
            assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "complete");
            assert.notEqual(await page.locator("#freshActivity").getAttribute("data-check-id"), "");
            assert.equal(await page.locator("#freshStatus").innerText(), "1 new activity record.");
            assert.match(await page.locator("#freshContextMessage").innerText(), /could not clear/);
            assert.doesNotMatch(await page.locator("#freshStatus").innerText(), /unconfirmed/);
        } else {
            assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
            assert.match(await page.locator("#freshContextMessage").innerText(), /never repeats|read-only/);
        }
        await app.check();
        assert.equal(app.writes.length, known ? 1 : 0, "A safe stored read does not lift the storage or unknown latch");
    });
}

test("one Refresh and legacy Settings alias preserve paused state, useful unapproved reading and keyboard recovery", { timeout: 45000 }, async t => {
    const app = await fixture(t), { page } = app;
    await app.source([event("user.message", { content: "Invented alias activity" }), call("one"), complete("one")]);
    await page.goto(app.runtime().url + "#settings?setting=collect-now"); await ready(page);
    assert.equal(await page.locator("#checkActivity").evaluate(node => node === document.activeElement), true);
    assert.equal(app.writes.length, 0, "Landing on the old target never dispatches");
    assert.equal(await page.locator("#collectNow").isVisible(), false);
    for (const view of ["analyze", "reports", "settings"]) {
        await navigateMain(page, view);
        assert.equal(await page.getByRole("button", { name: "Refresh", exact: true }).count(), 1);
        assert.equal(await page.locator("#refreshBtn").isVisible(), false);
    }
    await page.locator("#checkActivity").focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "complete");
    assert.equal((await app.runtime().collector.status()).config.enabled, false);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), sourceCheckKey), null, "A validated receipt clears the pending marker");
    await navigateMain(page, "analyze"); await ready(page);
    assert.equal(await page.locator("#activityCount").textContent(), "1");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented stored read failure" } }), { times: 1 });
    await app.check();
    assert.equal(await page.locator("#refreshBtn").isVisible(), true);
    const writes = app.writes.length;
    await page.route("**/api/collection/status", async route => {
        const response = await route.fetch(), status = await response.json();
        await route.fulfill({ response, json: { ...status, configVersion: "invented-changed-source" } });
    });
    await page.locator("#refreshBtn").click(); await ready(page);
    assert.equal(await page.locator("#freshActivity").getAttribute("data-phase"), "error");
    assert.match(await page.locator("#freshContextMessage").textContent(), /source changed during the stored read/);
    assert.equal(app.writes.length, writes);
    await page.unroute("**/api/collection/status");
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/collection/status", async route => { enter(); await gate; const response = await route.fetch(); await route.fulfill({ response }); }, { times: 1 });
    await page.locator("#refreshBtn").focus(); await page.keyboard.press("Enter"); await entered;
    assert.equal(await page.locator("#refreshBtn").isDisabled(), true);
    await page.evaluate(() => { document.querySelector("#refreshBtn").click(); document.querySelector("#checkActivity").click(); });
    release(); await ready(page);
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "complete");
    assert.equal(app.writes.length, writes);
    assert.equal(await page.locator("#checkActivity").evaluate(node => node === document.activeElement), true, "Recovery returns focus when Retry disappears");
});

test("manual Refresh keeps unrelated report draft choices and selection while applying new stored evidence", { timeout: 30000 }, async t => {
    const app = await fixture(t), { page } = app;
    await app.source([event("user.message", { content: "Invented selected draft request" }), call("selected"), complete("selected")]);
    await app.runtime().collector.collectNow();
    await page.goto(app.runtime().url); await ready(page);
    await page.locator(".interaction-select").first().check();
    await navigateMain(page, "reports"); await reportContents(page);
    await page.locator("#additionalMasking > summary").click();
    await page.locator("#manualTerms").fill("INVENTED_MASKING_TERM");
    const selection = await page.locator("#previewSelectionSummary").textContent();
    const choices = await page.locator("#formatOptions input").evaluateAll(nodes => nodes.map(node => [node.value, node.checked]));
    await app.source([event("user.message", { content: "Invented unrelated new request" }), call("unrelated"), complete("unrelated")]);
    await app.check();
    assert.equal(await page.locator("#manualTerms").inputValue(), "INVENTED_MASKING_TERM");
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), selection);
    assert.deepEqual(await page.locator("#formatOptions input").evaluateAll(nodes => nodes.map(node => [node.value, node.checked])), choices);
    const after = await loadBoardState(app.context);
    assert.equal(after.evidence.flatMap(record => record.toolCalls).length, 2);
    assert.equal(after.exports.length, 0);
    assert.deepEqual(app.writes, ["/api/collection/now"]);
    await scanReport(page);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 request/);
    assert.equal(await page.locator("#checkActivity").isDisabled(), true, "Refresh cannot replace a frozen report review");
    assert.equal(await page.locator("#checkActivity").locator("..").getAttribute("tabindex"), "0", "The blocked Refresh has a reachable explanation");
    const writes = app.writes.length;
    await page.evaluate(() => { document.querySelector("#checkActivity").click(); document.querySelector("#refreshBtn").click(); });
    assert.equal(app.writes.length, writes);
});

test("old status failures cannot replace a completed check and reconnect never replays collection", { timeout: 60000 }, async t => {
        const app = await fixture(t), { page } = app;
        await app.source([event("user.message", { content: "Synthetic reconnect source" }), call("one"), complete("one")]);
        await page.goto(app.runtime().url); await ready(page);
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { entered = resolve; });
        await page.route("**/api/collection/status", async route => {
            entered(); await gate;
            await route.fulfill({ status: 503, json: { error: "Synthetic old poll error" } });
        }, { times: 1 });
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await pending;
        await app.check();
        const message = await page.locator("#freshStatus").innerText();
        const oldResponse = page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
        release(); await oldResponse;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator("#freshStatus").innerText(), message);
        assert.doesNotMatch(await page.locator("#collectionNotice").innerText(), /Synthetic old poll error|status unavailable/);
        const cycles = (await app.runtime().collector.status()).metrics.cycles;
        await page.route("**/api/collection/now", route => route.fulfill({ status: 403, json: { code: "session_expired", error: "Synthetic expired capability" } }), { times: 1 });
        const before = app.writes.length;
        await app.check();
        assert.equal(app.writes.length, before + 1);
        assert.equal((await app.runtime().collector.status()).metrics.cycles, cycles);
        assert.match(await page.locator("#freshStatus").innerText(), /not confirmed/);
        assert.match(await page.locator("#freshContextMessage").innerText(), /not replayed/);
        assert.equal(await page.locator("#activityCount").innerText(), "1");
        await app.check();
        assert.equal(app.writes.length, before + 1, "Recovery after rejection first reads status and stored data only");
        await app.check();
        assert.match(await page.locator("#freshStatus").innerText(), /No new recorded activity/);
        assert.equal(app.writes.length, before + 2);
});

test("a review opened during checking stays frozen until leaving review, without expanding report membership", { timeout: 60000 }, async t => {
        const app = await fixture(t), { page } = app;
        const source = await app.source([event("user.message", { content: "Synthetic selected request" }), call("one"), complete("one")]);
        await page.goto(app.runtime().url); await ready(page); await app.check();
        await navigateMain(page, "activity"); await ready(page);
        await page.locator(".interaction-select").first().check();
        await navigateMain(page, "home"); await ready(page);
        await appendFile(source.file, jsonl([event("user.message", { content: "Synthetic unselected fresh request" }), call("two"), complete("two")]));
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { entered = resolve; });
        await page.route("**/api/collection/now", async route => {
            entered(); await gate; const response = await route.fetch(); await route.fulfill({ response });
        }, { times: 1 });
        await page.locator("#checkActivity").click(); await pending;
        await navigateMain(page, "reports"); await reportContents(page);
        await page.locator("#exportBtn").click();
        await page.locator(".attestation input[data-review-control]").waitFor();
        release();
        await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "waiting");
        assert.equal(await page.locator("#checkActivity").getAttribute("data-pending"), "false", "Frozen review is waiting for a person, not spinning work");
        assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
        assert.equal(await page.locator("#activityCount").textContent(), "1");
        assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 request/);
        assert.match(await page.locator("#freshContextMessage").textContent(), /preview stays frozen/);
        assert.equal((await loadBoardState(app.context)).exports.length, 0);
        await navigateMain(page, "home"); await ready(page);
        await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "complete");
        assert.equal(await page.locator("#activityCount").innerText(), "2");
        assert.match(await page.locator("#activitySelectionSummary").textContent(), /1 request/);
        assert.equal((await loadBoardState(app.context)).exports.length, 0);
});
