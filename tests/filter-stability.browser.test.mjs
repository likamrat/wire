import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, openActivitySessions, selectActivityOption, revealStoredRefresh } from "./helpers.mjs";

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
async function setup(t, view = "home", { width = 1200, bucket = "week", spreadDays = false } = {}) {
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
    const errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    t.after(async () => {
        await browser.close(); await runtime.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.ok(posts.every(url => ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(url)),
            "Filter proof is read-only: " + JSON.stringify(posts));
    });
    await page.goto(runtime.url + `#${view}?range=30&from=${from}&to=${today}&bucket=${bucket}`);
    await ready(page);
    await expect(page.locator(`#${view}Insights .assessment-grid`)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime, today, from, posts };
}
async function startProbe(page, triggerId) {
    await page.evaluate(triggerId => {
        const selectors = ["#pageTitle", "#filters", "#periodFeedback", ".app-header", "#sidebar",
            "#homeView .chart-panel", "#chart .dimensional-scroll", "#homeInsights", "#activityInsights", "#activityList", `#${triggerId}`];
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
    }, triggerId);
}
async function phase(page, value) { await page.evaluate(value => { window.filterFrameProbe.phase = value; }, value); }
async function picture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, name + ".png") });
}
async function finishProbe(page, name) {
    const trace = await page.evaluate(() => window.finishFilterProbe());
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, name + ".json"), JSON.stringify(trace, null, 2));
    }
    return trace;
}

for (const view of ["home", "activity"]) for (const position of ["scrolled", "top"]) test(`${view} ${position} date refinement preserves visible filter anchor through pending and accepted frames`, { timeout: 20000 }, async t => {
    const { page } = await setup(t, view);
    const name = `${view}-${position}`;
    await page.locator("#dateFilter-control").scrollIntoViewIfNeeded();
    await page.evaluate(position => scrollTo(0, position === "top" ? 0 : Math.max(0, scrollY + document.querySelector("#filters").getBoundingClientRect().top - 140)), position);
    await page.locator("#dateFilter-control").click();
    await frames(page);
    const entered = deferred(), release = deferred();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        entered.resolve(); await release.promise;
        await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release.resolve());
    await startProbe(page, "dateFilter-control");
    await picture(page, `${name}-before`);
    await page.locator('.select-popup [data-value="7"]').click();
    await entered.promise; await phase(page, "pending"); await frames(page);
    await picture(page, `${name}-pending`);
    release.resolve(); await ready(page);
    await expect(page.locator(`#${view}Insights`)).not.toHaveAttribute("aria-busy", "true");
    await phase(page, "accepted"); await frames(page);
    await picture(page, `${name}-accepted`);
    const trace = await finishProbe(page, `${name}-transition`);
    const first = trace.frames[0], last = trace.frames.at(-1);
    const observed = {
        baselineY: first.nodes["#dateFilter-control"].box.y,
        filterY: [...new Set(trace.frames.map(frame => frame.nodes["#dateFilter-control"].box?.y))],
        scrollY: [...new Set(trace.frames.map(frame => frame.scrollY))],
        finalFocus: last.focus,
        messages: [...new Set(trace.frames.map(frame => frame.message))],
        shifts: trace.shifts.length,
    };
    t.diagnostic(JSON.stringify(observed));
    assert.ok(trace.frames.some(frame => frame.phase === "pending" && frame.busy === "true"), "The actual read reports pending.");
    assert.ok(trace.frames.every(frame => frame.workspaceVisible), "No blank full workspace.");
    assert.ok(trace.frames.every(frame => frame.nodes["#dateFilter-control"].same && frame.nodes["#filters"].same));
    assert.deepEqual(observed.filterY, [observed.baselineY], "Unchanged visible filter anchor must not bounce during an equal-content date refinement.");
    assert.equal(last.focus, "dateFilter-control", "A same-view refinement retains its control, not page-title focus.");
});

test("opening custom-date inputs preserves unchanged plotted content and its reading position", async t => {
    const { page, posts } = await setup(t, "home", { width: 375, bucket: "day", spreadDays: true });
    await frames(page);
    const plot = page.locator("#chart .dimensional-scroll");
    const position = await plot.evaluate(node => {
        if (node.scrollWidth <= node.clientWidth) throw new Error("The invented daily chart must have a scrollable reading position.");
        node.scrollLeft = 200;
        window.retainedFilterPlot = node;
        return node.scrollLeft;
    });
    const reads = posts.filter(url => url === "/api/snapshot").length;
    await page.locator("#dateFilter-control").click();
    await startProbe(page, "dateFilter-control");
    await page.locator('.select-popup [data-value="custom"]').click();
    await expect(page.locator("#dateFields")).toBeVisible(); await frames(page);
    const trace = await finishProbe(page, "custom-controls-only");
    t.diagnostic(JSON.stringify({ plotBefore: position, plotAfter: await plot.evaluate(node => node.scrollLeft),
        connected: await page.evaluate(() => window.retainedFilterPlot.isConnected) }));
    assert.equal(posts.filter(url => url === "/api/snapshot").length, reads, "Changing only the editor mode does not change the applied evidence.");
    assert.ok(trace.frames.every(frame => frame.nodes["#chart .dimensional-scroll"].same),
        "A controls-only change must not tear down the unchanged plot.");
    assert.equal(await plot.evaluate(node => node.scrollLeft), position, "The existing chart reading position stays put.");
});

async function selectedHome(t) {
    const app = await setup(t, "activity");
    await openActivitySessions(app.page);
    await app.page.locator("#activityList input[type=checkbox]").first().check();
    await chooseTheme(app.page, "dark");
    await selectActivityOption(app.page, "projectFilter", "project-a"); await ready(app.page);
    await navigateMain(app.page, "home"); await ready(app.page);
    return app;
}
async function viewIntent(page) {
    return page.evaluate(() => ({
        hash: location.hash, theme: document.documentElement.dataset.evidenceTheme,
        period: document.querySelector("#dateFilter").value,
        project: document.querySelector("#projectFilter").value,
        selected: document.querySelector("#previewSelectionSummary").textContent,
        results: [...document.querySelector("#outcomeFilter").selectedOptions].map(option => option.value),
    }));
}

test("Reset to Home restores defaults without routine success narration or losing theme/report choices", async t => {
    const { page } = await selectedHome(t);
    const before = await viewIntent(page);
    await page.locator("#resetView").click(); await ready(page);
    const after = await viewIntent(page);
    assert.equal(after.hash, "#home");
    assert.equal(after.period, "capture");
    assert.equal(after.project, "all");
    assert.equal(after.theme, before.theme);
    assert.equal(after.selected, before.selected);
    await picture(page, "reset-view-complete");
    await expect(page.locator("#message")).toBeHidden();
});

test("Reload view reads the same intent and retains pending/error feedback without reset narration", async t => {
    const { page } = await selectedHome(t);
    const before = await viewIntent(page), gate = deferred(), entered = deferred();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(); entered.resolve(); await gate.promise; await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => gate.resolve());
    await (await revealStoredRefresh(page)).click(); await entered.promise;
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#message")).toContainText("Updating this view");
    gate.resolve(); await ready(page);
    assert.deepEqual(await viewIntent(page), before, "Explicit Reload does not reset filters, theme or report selection.");
    await expect(page.locator("#message")).toBeHidden();
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented read failure." } }), { times: 1 });
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#message")).toContainText("Invented read failure");
    await expect(page.locator("#message")).not.toContainText("View reset to Home");
    assert.deepEqual(await viewIntent(page), before, "A failed Reset cannot claim or apply new data.");
});

test("browser reload preserves its URL/theme contract and starts a fresh unsaved report selection", async t => {
    const { page } = await selectedHome(t);
    const before = await viewIntent(page);
    await page.reload(); await ready(page);
    const after = await viewIntent(page);
    assert.equal(after.hash, before.hash);
    assert.equal(after.period, before.period);
    assert.equal(after.project, before.project);
    assert.equal(after.theme, before.theme);
    assert.deepEqual(after.results, before.results);
    assert.notEqual(after.selected, before.selected);
    await expect(page.locator("#message")).toBeHidden();
});

async function prepareChoice(page, id, value) {
    const trigger = page.locator(`#${id}-control`);
    await trigger.scrollIntoViewIfNeeded();
    await page.evaluate(id => scrollTo(0, Math.max(0, scrollY + document.getElementById(id + "-control").getBoundingClientRect().top - 220)), id);
    await trigger.click();
    if (await page.locator(`#${id}`).evaluate(node => node.multiple)) {
        const values = await page.locator(`#${id} option`).evaluateAll(options => options.map(option => option.value));
        const wanted = Array.isArray(value) ? value : [value];
        for (const item of values) {
            const row = page.locator(`.select-popup [data-value="${item}"]`);
            if ((await row.getAttribute("aria-selected") === "true") !== wanted.includes(item)) await row.click();
        }
        return () => page.getByRole("button", { name: "Apply", exact: true }).click();
    }
    return () => page.locator(`.select-popup [data-value="${value}"]`).click();
}
for (const { view, id, value, width = 1200, theme = "light" } of [
    { view: "home", id: "serviceFilter", value: "Calendar" },
    { view: "activity", id: "projectFilter", value: "project-a" },
    { view: "home", id: "layerFilter", value: "reported-api" },
    { view: "activity", id: "scopeFilter", value: "all" },
    { view: "home", id: "dateFilter", value: "day" },
    { view: "home", id: "outcomeFilter", value: ["success", "failure"] },
    { view: "activity", id: "outcomeFilter", value: ["failure"], width: 375, theme: "dark" },
]) test(`${view} ${id} commits in place with stable control frames at ${width}px`, { timeout: 20000 }, async t => {
    const { page } = await setup(t, view, { width });
    await chooseTheme(page, theme);
    const commit = await prepareChoice(page, id, value);
    await frames(page);
    const entered = deferred(), release = deferred();
    let accepted;
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(); accepted = await response.json();
        entered.resolve(); await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release.resolve());
    await startProbe(page, id + "-control");
    await commit(); await entered.promise; await phase(page, "pending"); await frames(page);
    if (id === "outcomeFilter") await picture(page, `${view}-${id}-${width}-pending`);
    release.resolve(); await ready(page);
    await expect(page.locator(`#${view}Insights`)).not.toHaveAttribute("aria-busy", "true");
    await phase(page, "accepted"); await frames(page);
    const trace = await finishProbe(page, `${view}-${id}-${width}`);
    const selector = `#${id}-control`, first = trace.frames[0];
    const positions = [...new Set(trace.frames.map(frame => frame.nodes[selector].box?.y))];
    t.diagnostic(JSON.stringify({ id, positions, scroll: [...new Set(trace.frames.map(frame => frame.scrollY))], focus: trace.frames.at(-1).focus }));
    assert.deepEqual(positions, [first.nodes[selector].box.y], "Unchanged filter chrome does not move with data refresh.");
    assert.ok(trace.frames.every(frame => frame.nodes[selector].same && frame.workspaceVisible));
    assert.ok(trace.frames.some(frame => frame.phase === "pending" && frame.busy === "true"));
    assert.ok(trace.frames.every(frame => frame.message === ""));
    assert.equal(trace.frames.at(-1).focus, id + "-control");
    assert.equal(await page.locator("#periodResult").getAttribute("data-revision"), String(accepted.revision));
    if (view === "home") assert.equal(Number(await page.locator(".percentage-section").getAttribute("data-total")), accepted.analytics.totals.count);
    const selected = await page.locator(`#${id}`).evaluate(node => [...node.selectedOptions].map(option => option.value));
    assert.deepEqual(selected, Array.isArray(value) ? value : [value]);
});

test("custom Apply retains its control and Clear returns to the surviving period selector", async t => {
    const { page, today } = await setup(t);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(today);
    await page.locator("#toFilter").fill(today);
    await page.locator("#applyDates").click(); await ready(page);
    await expect(page.locator("#applyDates")).toBeFocused();
    await startProbe(page, "dateFilter-control");
    await page.locator("#clearDates").click(); await ready(page); await frames(page);
    const trace = await finishProbe(page, "custom-clear");
    t.diagnostic(JSON.stringify({ focusAfterClear: trace.frames.at(-1).focus }));
    assert.equal(await page.locator("#dateFilter").inputValue(), "capture");
    await expect(page.locator("#dateFields")).toBeHidden();
    await expect(page.locator("#dateFilter-control")).toBeFocused();
});

test("a slower scoped insight read does not refresh the shell or mislabel previous measures", async t => {
    const { page } = await setup(t, "activity");
    const commit = await prepareChoice(page, "projectFilter", "project-a");
    const entered = deferred(), release = deferred();
    await page.route("**/api/assessment/overview", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release.resolve());
    await startProbe(page, "projectFilter-control");
    await commit(); await entered.promise; await ready(page);
    await phase(page, "insights-pending"); await frames(page);
    await expect(page.locator("#activityInsights")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#activityInsights")).toContainText("Reading recorded insights");
    await expect(page.locator("#periodResult")).toContainText("4 Work IQ tool calls");
    await picture(page, "scoped-insights-pending");
    release.resolve();
    await expect(page.locator("#activityInsights .assessment-grid")).toBeVisible();
    await expect(page.locator("#activityInsights")).not.toHaveAttribute("aria-busy", "true");
    await phase(page, "accepted"); await frames(page);
    const trace = await finishProbe(page, "scoped-insights");
    assert.deepEqual([...new Set(trace.frames.map(frame => frame.nodes["#projectFilter-control"].box.y))],
        [trace.frames[0].nodes["#projectFilter-control"].box.y]);
    assert.ok(trace.frames.every(frame => frame.nodes["#filters"].same && frame.nodes["#pageTitle"].same && frame.workspaceVisible));
    await expect(page.locator("#projectFilter-control")).toBeFocused();
});

test("rapid refinements reject late replies without moving the active filter or replacing newer intent", async t => {
    const { page } = await setup(t);
    const gates = [deferred(), deferred()], entered = [deferred(), deferred()];
    await page.route("**/api/snapshot", async route => {
        const project = route.request().postDataJSON().filters.projectIds?.[0];
        const index = project === "project-a" ? 0 : project === "project-b" ? 1 : -1;
        if (index < 0) return route.continue();
        const response = await route.fetch(); entered[index].resolve(); await gates[index].promise; await route.fulfill({ response });
    });
    t.after(() => gates.forEach(gate => gate.resolve()));
    const first = await prepareChoice(page, "projectFilter", "project-a");
    await startProbe(page, "projectFilter-control"); await first(); await entered[0].promise;
    await selectActivityOption(page, "projectFilter", "project-b"); await entered[1].promise;
    await selectActivityOption(page, "projectFilter", "all"); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("8 Work IQ tool calls");
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.projectIds?.[0] === "project-a");
    const newerLate = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.projectIds?.[0] === "project-b");
    gates[1].resolve(); await newerLate; gates[0].resolve(); await late; await frames(page);
    const trace = await finishProbe(page, "rapid-refinements");
    assert.equal(await page.locator("#projectFilter").inputValue(), "all");
    await expect(page.locator("#periodResult")).toHaveText("8 Work IQ tool calls");
    await expect(page.locator("#projectFilter-control")).toBeFocused();
    assert.deepEqual([...new Set(trace.frames.map(frame => frame.nodes["#projectFilter-control"].box.y))],
        [trace.frames[0].nodes["#projectFilter-control"].box.y]);
    assert.ok(trace.frames.every(frame => frame.workspaceVisible && frame.message === ""));
});

test("failed refinement keeps accepted scope and contextual focus with a real recoverable error", async t => {
    const { page } = await setup(t);
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented filter read failure." } }), { times: 1 });
    await selectActivityOption(page, "projectFilter", "project-a"); await ready(page);
    await expect(page.locator("#message")).toContainText("Invented filter read failure");
    await expect(page.locator("#periodResult")).toHaveText("Previous results: 8 Work IQ tool calls");
    assert.equal(await page.locator("#projectFilter").inputValue(), "all");
    await expect(page.locator("#projectFilter-control")).toBeFocused();
    await picture(page, "refinement-error");
    await selectActivityOption(page, "projectFilter", "project-a"); await ready(page);
    await expect(page.locator("#message")).toBeHidden();
    await expect(page.locator("#periodResult")).toHaveText("4 Work IQ tool calls");
    await expect(page.locator("#projectFilter-control")).toBeFocused();
});

for (const width of [1200, 375]) test(`clearing a filter chip returns focus to its field in the ${width}px filter row`, async t => {
    const { page } = await setup(t, "home", { width });
    await selectActivityOption(page, "projectFilter", "project-a"); await ready(page);
    const target = page.locator("#projectFilter-control");
    await target.scrollIntoViewIfNeeded();
    await frames(page);
    await startProbe(page, "projectFilter-control");
    await page.getByRole("button", { name: "Remove copilot project filter: Invented project A", exact: true }).click();
    await ready(page); await frames(page);
    const trace = await finishProbe(page, `clear-chip-${width}`);
    t.diagnostic(JSON.stringify({ focusAfterClear: trace.frames.at(-1).focus }));
    assert.equal(await page.locator("#projectFilter").inputValue(), "all");
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
});

test("a pending refinement does not reclaim focus after the user moves into private search", async t => {
    const { page } = await setup(t, "activity");
    const commit = await prepareChoice(page, "projectFilter", "project-a");
    const entered = deferred(), release = deferred();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release.resolve());
    await commit(); await entered.promise;
    const search = page.locator("#activitySearch");
    await search.fill("Invented");
    await search.evaluate(node => node.setSelectionRange(2, 6));
    release.resolve(); await ready(page);
    await expect(search).toBeFocused();
    assert.deepEqual(await search.evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 6]);
    await expect(page.locator("#periodResult")).toContainText("4 Work IQ tool calls");
    assert.doesNotMatch(page.url(), /Invented/);
});
