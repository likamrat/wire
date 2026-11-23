import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { frontendRecords } from "./frontend-fixture.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters } from "./helpers.mjs";

const proofs = process.env.WIRE_FILTER_STABILITY_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = (page, count = 3) => page.evaluate(count => new Promise(resolve => {
    const next = () => --count ? requestAnimationFrame(next) : resolve();
    requestAnimationFrame(next);
}), count);
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function setup(t, { width = 1200, bucket = "week", spreadDays = false, draft = false, search = false } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.parse(today + "T12:00:00Z") - 29 * 86400000).toISOString().slice(0, 10);
    const records = Array.from({ length: 8 }, (_, index) => {
        const day = spreadDays ? new Date(Date.parse(today + "T12:00:00Z") - index * 3 * 86400000).toISOString().slice(0, 10) : today;
        const row = fixture(`stability-${index}`);
        row.sourceSessionId = `stability-chat-${Math.floor(index / 2)}`;
        row.sourceSessionName = `Invented chat ${Math.floor(index / 2) + 1}`;
        row.projectId = index % 2 ? "project-b" : "project-a";
        row.project = index % 2 ? "Invented project B" : "Invented project A";
        row.capturedAt = day + "T12:00:00Z";
        row.userPrompt = { ...row.userPrompt, text: `Invented filter request ${index + 1}`, sourceEventId: `prompt-${index}` };
        row.followUpPrompts = [];
        Object.assign(row.toolCalls[0], { startedAt: day + "T12:00:00Z", completedAt: day + "T12:00:01Z",
            completionEventId: `complete-${index}`, durationMs: 1000,
            toolSucceeded: index % 2 === 0, reportedOutcome: index % 2 ? "failed" : "succeeded",
            requestArgs: { entityUrls: [index % 2 ? "/me/messages" : "/me/calendarView"] },
            requestedApiPath: index % 2 ? "/me/messages" : "/me/calendarView" });
        return row;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "UTC" });
    page.setDefaultTimeout(6000);
    const errors = [], posts = [], denied = [];
    const allowed = new Set(["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/app-update",
        ...(draft ? ["/api/report-drafts/list", "/api/report-drafts/edit"] : []),
        ...(search ? ["/api/search/query", "/api/search/status", "/api/search/events", "/api/search/cancel"] : [])]);
    await page.route("**/*", route => {
        const r = route.request(), url = new URL(r.url());
        if (url.origin === new URL(runtime.url).origin && (r.method() === "GET" || r.method() === "POST" && allowed.has(url.pathname)))
            return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    t.after(async () => {
        await browser.close(); await runtime.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.deepEqual(denied, []);
    });
    await page.goto(runtime.url + `?range=30&from=${from}&to=${today}&bucket=${bucket}`);
    await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("8");
    await page.evaluate(() => document.fonts.ready);
    return { page, today, posts };
}
async function startProbe(page, triggerId, extra = []) {
    await page.evaluate(({ triggerId, extra }) => {
        const selectors = ["#pageTitle", "#filters", ".app-header", "#sidebar",
            "#chart .dimensional-scroll", "#activityList", `#${triggerId}`, ...extra];
        const originals = new Map(selectors.map(selector => [selector, document.querySelector(selector)]));
        const probe = { phase: "before", running: true, frames: [], changes: [], shifts: [] };
        const rect = node => {
            if (!node?.checkVisibility()) return null;
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, documentY: box.y + scrollY, scrollLeft: node.scrollLeft };
        };
        const sample = () => {
            probe.frames.push({ time: performance.now(), phase: probe.phase, scrollY,
                focus: document.activeElement?.id || document.activeElement?.tagName,
                busy: document.querySelector("#workspace").getAttribute("aria-busy"),
                workspaceVisible: document.querySelector("#workspace").checkVisibility(),
                message: document.querySelector("#message").hidden ? "" : document.querySelector("#message").textContent,
                nodes: Object.fromEntries(selectors.map(selector => {
                    const node = document.querySelector(selector);
                    return [selector, { box: rect(node), same: originals.get(selector) === node,
                        originalConnected: originals.get(selector)?.isConnected ?? false }];
                })) });
        };
        const mutations = new MutationObserver(changes => {
            probe.changes.push(...changes.map(change => ({ time: performance.now(), phase: probe.phase,
                target: change.target.id || change.target.className || change.target.nodeName,
                added: change.addedNodes.length, removed: change.removedNodes.length })));
        });

        mutations.observe(document.querySelector("main"), { childList: true, subtree: true });
        const shifts = new PerformanceObserver(list => {
            probe.shifts.push(...list.getEntries().map(entry => ({ time: entry.startTime, value: entry.value,
                hadRecentInput: entry.hadRecentInput,
                sources: (entry.sources || []).map(source => ({ node: source.node?.id || source.node?.className,
                    before: source.previousRect.toJSON(), after: source.currentRect.toJSON() })) })));
        });
        shifts.observe({ type: "layout-shift", buffered: false });
        sample();
        const next = () => { if (probe.running) { sample(); requestAnimationFrame(next); } };
        requestAnimationFrame(next);
        window.filterFrameProbe = probe;
        window.finishFilterProbe = () => {
            sample(); probe.running = false; mutations.disconnect(); shifts.disconnect();
            return { frames: probe.frames, changes: probe.changes, shifts: probe.shifts };
        };
    }, { triggerId, extra });
}
async function phase(page, value) { await page.evaluate(value => { window.filterFrameProbe.phase = value; }, value); }
async function finishProbe(page, name) {
    const trace = await page.evaluate(() => window.finishFilterProbe());
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, name + ".json"), JSON.stringify(trace, null, 2));
    }
    return trace;
}

for (const width of [1440, 760, 390]) test(`built shared filter: ${width}px pending, empty and reset preserve the control under the pointer`, { timeout: 45000 }, async t => {
    const records = frontendRecords(16), stamp = new Date(Date.now() - 10 * 86400000).toISOString();
    for (const [index, row] of records.entries()) {
        row.capturedAt = row.userPrompt.sourceTimestamp = row.toolCalls[0].startedAt = row.toolCalls[0].completedAt = stamp;
        row.userPrompt.text = index % 2 ? "Find the notes." : "Find the Cedar workshop notes. ".repeat(20);
    }
    const { runtime } = await searchFixture(t, { records, frontend: "react", reply: false });
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined,
        ignoreDefaultArgs: ["--hide-scrollbars"] });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 760 }, timezoneId: "UTC" });
    await page.route(url => url.origin !== new URL(runtime.url).origin, route => route.abort());
    await page.goto(runtime.url); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    const shell = [".app-header", "#sidebar", "#analyzeResultsSection", "#openChartReference", "#analyzeRefresh", "#openAnalyzeFilters", "#wireSearch", "#navigationFooter"];
    const controls = ["#dateFilter-control", "#closeAnalyzeFilters"];
    await startProbe(page, "openAnalyzeFilters", [...shell, ...controls]);
    await page.locator("#openAnalyzeFilters").hover(); await frames(page);
    await page.mouse.move(2, 2); await frames(page);
    await openAnalyzeFilters(page);
    await page.waitForFunction(() => !document.querySelector("#analyzeFilterDialog").getAnimations().length);
    await phase(page, "open"); await frames(page);
    for (const [choice, label] of [["day", "empty"], ["capture", "clear"]]) {
        const hold = deferred(), entered = deferred();
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch();
            entered.resolve(); await hold.promise; await route.fulfill({ response });
        }, { times: 1 });
        try {
            await selectActivityOption(page, "dateFilter", choice);
            await entered.promise; await phase(page, `${label}-pending`); await frames(page);
        } finally { hold.resolve(); }
        await ready(page); await phase(page, label); await frames(page);
        await expect(page.locator("#activityList .request-card-open")).toHaveCount(choice === "day" ? 0 : 8);
        await expect(page.locator("#dateFilter-control")).toBeFocused();
    }
    await phase(page, "close"); await closeAnalyzeFilters(page); await frames(page);
    const trace = await finishProbe(page, `built-filter-${width}`);
    const open = trace.frames.filter(row => row.phase !== "before" && row.phase !== "close");
    assert.ok(open.some(row => row.phase === "empty-pending" && row.busy === "true"));
    for (const selector of [...shell, ...controls]) {
        const boxes = (controls.includes(selector) ? open : trace.frames).map(row => row.nodes[selector].box).filter(Boolean);
        for (const key of ["x", "y", "width", "height"]) {
            const values = boxes.map(box => box[key]);
            if (values.length) assert.ok(Math.max(...values) - Math.min(...values) <= 1, `${selector} ${key}: ${[...new Set(values)]}`);
        }
    }
    assert.ok(trace.frames.every(row => row.scrollY === trace.frames[0].scrollY));
    await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
});

const rowKeys = page => page.locator("#activityList article[data-view-key]").evaluateAll(nodes => nodes.map(n => n.dataset.viewKey).sort());
const keys = indexes => indexes.map(i => `request:stability-${i}`);
const allRows = keys([0, 1, 2, 3, 4, 5, 6, 7]);
const evenRows = keys([0, 2, 4, 6]);

async function holdRead(page, matches = () => true) {
    const entered = deferred(), release = deferred(), done = deferred();
    let used = false;
    await page.route("**/api/snapshot", async route => {
        const input = route.request().postDataJSON();
        if (used || !matches(input)) return route.fallback();
        used = true;
        const response = await route.fetch();
        entered.resolve();
        await release.promise;
        try { await route.fulfill({ response }); } finally { done.resolve(); }
    });
    return { entered: entered.promise, release: release.resolve, done: done.promise };
}

for (const [id, value, expected, width] of [
    ["projectFilter", "project-a", evenRows, 1200],
    ["outcomeFilter", ["failure"], keys([1, 3, 5, 7]), 375],
    ["serviceFilter", "Calendar", evenRows, 1200],
    ["layerFilter", "reported-api", allRows, 1200],
    ["scopeFilter", "all", allRows, 1200],
]) test(`${id} keeps its anchor and publishes only the accepted rows`, { timeout: 20000 }, async t => {
    const { page } = await setup(t, { width });
    await openAnalyzeFilters(page);
    if (["projectFilter", "serviceFilter", "layerFilter", "scopeFilter"].includes(id)) await page.locator("#moreFiltersToggle").click();
    const trigger = page.locator(`#${id}-control`);
    await trigger.scrollIntoViewIfNeeded();
    await frames(page);
    const held = await holdRead(page), before = await rowKeys(page);
    await startProbe(page, id + "-control");
    try {
        await selectActivityOption(page, id, value);
        await held.entered; await phase(page, "pending"); await frames(page);
        assert.deepEqual(await rowKeys(page), before);
    } finally { held.release(); }
    await held.done; await ready(page);
    await expect.poll(() => rowKeys(page)).toEqual(expected);
    const unit = id === "layerFilter" ? "tool-returned API results" : "Work IQ tool calls";
    await expect(page.locator("#periodResult")).toContainText(`${expected.length} ${unit}`);
    await expect(trigger).toBeFocused();
    const selected = await page.locator("#" + id).evaluate(n => [...n.selectedOptions].map(o => o.value));
    assert.deepEqual(selected, [value].flat());
    await phase(page, "accepted"); await frames(page);
    const trace = await finishProbe(page, `${id}-${width}`);
    const observed = trace.frames.filter(f => f.phase !== "before");
    assert.ok(observed.some(f => f.phase === "pending" && f.busy === "true"));
    assert.ok(observed.every(f => f.workspaceVisible && f.nodes["#filters"].same && f.nodes[`#${id}-control`].same));
    const y = observed.map(f => f.nodes[`#${id}-control`].box.y);
    assert.ok(Math.max(...y) - Math.min(...y) <= 1, `${id}: ${[...new Set(y)]}`);
});

test("editing dates keeps the daily chart and its reading position until Apply; clearing returns to Dates", async t => {
    const { page, today, posts } = await setup(t, { width: 375, bucket: "day", spreadDays: true });
    const plot = page.locator("#chart .dimensional-scroll");
    const left = await plot.evaluate(node => { node.scrollLeft = 200; window.originalFilterPlot = node; return node.scrollLeft; });
    assert.ok(left > 0);
    const reads = posts.filter(p => p === "/api/snapshot").length;
    await selectActivityOption(page, "dateFilter", "custom");
    const editor = page.locator("#analyzeDates");
    await editor.getByLabel("From", { exact: true }).fill(today);
    await editor.getByLabel("To", { exact: true }).fill(today);
    assert.equal(posts.filter(p => p === "/api/snapshot").length, reads);
    assert.equal(await plot.evaluate(node => window.originalFilterPlot === node && node.scrollLeft), left);
    await editor.getByRole("button", { name: "Apply dates", exact: true }).click(); await ready(page);
    await expect.poll(() => rowKeys(page)).toEqual(keys([0]));
    await expect(page.locator("#dateFilter-control")).toBeFocused();
    await page.getByRole("button", { name: /^Remove date filter:/ }).click(); await ready(page);
    await expect(page.locator("#dateFilter")).toHaveValue("capture");
    await expect(page.locator("#dateFilter-control")).toBeFocused();
    await expect.poll(() => rowKeys(page)).toEqual(allRows);
});

test("late project reads cannot replace a newer reset, even when both filtered counts are equal", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const first = await holdRead(page, r => r.filters.projectIds?.[0] === "project-a");
    const second = await holdRead(page, r => r.filters.projectIds?.[0] === "project-b");
    try {
        await selectActivityOption(page, "projectFilter", "project-a"); await first.entered;
        await selectActivityOption(page, "projectFilter", "project-b"); await second.entered;
        await selectActivityOption(page, "projectFilter", "all"); await ready(page);
        await expect.poll(() => rowKeys(page)).toEqual(allRows);
        second.release(); await second.done;
        first.release(); await first.done; await frames(page);
    } finally { first.release(); second.release(); }
    await expect(page.locator("#projectFilter")).toHaveValue("all");
    await expect(page.locator("#projectFilter-control")).toBeFocused();
    assert.deepEqual(await rowKeys(page), allRows);
});

test("a failed filter read labels previous results; retry replaces them with the requested membership", async t => {
    const { page } = await setup(t);
    await page.route("**/api/snapshot", r => r.fulfill({ status: 503, json: { error: "Invented filter read failure." } }), { times: 1 });
    await selectActivityOption(page, "projectFilter", "project-a"); await ready(page);
    await expect(page.locator("#message")).toContainText("Invented filter read failure.");
    await expect(page.locator("#analyzeScopeError")).toContainText("Previous results");
    await expect(page.locator("#projectFilter")).toHaveValue("all");
    await expect(page.locator("#projectFilter-control")).toBeFocused();
    assert.deepEqual(await rowKeys(page), allRows);
    await selectActivityOption(page, "projectFilter", "project-a"); await ready(page);
    await expect(page.locator("#message")).toBeHidden();
    await expect.poll(() => rowKeys(page)).toEqual(evenRows);
    await expect(page.locator("#projectFilter-control")).toBeFocused();
    await page.getByRole("button", { name: "Remove project filter: Invented project A", exact: true }).press("Enter");
    await ready(page); await expect(page.locator("#projectFilter-control")).toBeFocused();
    await expect.poll(() => rowKeys(page)).toEqual(allRows);
});

test("a late refinement cannot reclaim the global Search field or expose its selected text", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { search: true });
    const held = await holdRead(page);
    const search = page.locator("#wireSearch"), phrase = "Invented filter request";
    try {
        await selectActivityOption(page, "projectFilter", "project-a"); await held.entered;
        await closeAnalyzeFilters(page); await search.fill(phrase);
        await search.evaluate(n => n.setSelectionRange(2, 6));
    } finally { held.release(); }
    await held.done; await ready(page);
    await expect(search).toBeFocused(); await expect(search).toHaveValue(phrase);
    assert.deepEqual(await search.evaluate(n => [n.selectionStart, n.selectionEnd]), [2, 6]);
    await expect.poll(() => rowKeys(page)).toEqual(evenRows);
    assert.ok(!decodeURIComponent(page.url()).includes(phrase));
    assert.ok(!await page.evaluate(q => JSON.stringify([history.state, localStorage, sessionStorage]).includes(q), phrase));
});

test("refreshing saved activity keeps the accepted project, date range and reader membership", { timeout: 30000 }, async t => {
    const { page, posts } = await setup(t);
    await selectActivityOption(page, "projectFilter", "project-a"); await ready(page);
    await closeAnalyzeFilters(page);
    const prior = page.url(), held = await holdRead(page);
    try {
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await held.entered;
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
        assert.deepEqual(await rowKeys(page), evenRows);
    } finally { held.release(); }
    await held.done; await ready(page);
    assert.equal(page.url(), prior);
    await expect(page.locator("#projectFilter")).toHaveValue("project-a");
    await expect(page.locator("#dateFilter")).toHaveValue("30");
    assert.deepEqual(await rowKeys(page), evenRows);
    assert.ok(!posts.includes("/api/collection/now"));
});

test("Reset and private-link reload preserve theme and named report membership without widening silently", async t => {
    const { page } = await setup(t, { draft: true });
    await chooseTheme(page, "dark");
    const saved = page.locator('[data-view-key="request:stability-1"]');
    await saved.getByRole("button", { name: "Add to report", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Report drafts", exact: true });
    await picker.getByRole("button", { name: "New draft", exact: true }).click();
    await picker.getByLabel("Draft name").fill("Filter reading");
    await picker.getByRole("button", { name: "Create draft and add" }).click();
    await expect(saved).toContainText("In draft: Filter reading");
    await selectActivityOption(page, "projectFilter", "project-a"); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(saved).toHaveCount(0);
    const url = page.url();
    assert.ok(url.includes("privateView=required") && !url.includes("project-a"));
    await page.reload();
    await expect(page.locator("#message")).toContainText("This tab no longer has the private view");
    await page.getByRole("button", { name: "Open this view without the private selection", exact: true }).click();
    await ready(page); await expect(saved).toContainText("In draft: Filter reading");
    await selectActivityOption(page, "projectFilter", "project-a"); await ready(page);
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#dateFilter")).toHaveValue("capture");
    await expect(page.locator("#projectFilter")).toHaveValue("all");
    await expect(page.locator("#message")).toBeHidden();
    await expect.poll(() => rowKeys(page)).toEqual(allRows);
    await expect(saved).toContainText("In draft: Filter reading");
    await expect(page.locator("html")).toHaveAttribute("data-evidence-theme", "dark");
});
