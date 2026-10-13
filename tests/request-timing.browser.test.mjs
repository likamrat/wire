import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, openActivitySessions, revealStoredRefresh } from "./helpers.mjs";

const proofs = process.env.WORKIQ_TIMING_PROOFS;
function record(id = "timing") {
    const value = fixture(id);
    value.userPrompt = { text: "Synthetic request: inspect recorded mail evidence.", status: "full",
        provenance: "recorded-user-message-origin-unverified", sourceEventId: "synthetic-message-event", sourceTimestamp: "2026-09-29T19:22:29Z" };
    value.capturedAt = "2026-09-29T19:22:44Z";
    value.followUpPrompts = [];
    value.promptAssociation = "Nearest preceding recorded message; association inferred, not proven.";
    value.coverageNote = "Recorded invocation only; missing completion does not establish success.";
    Object.assign(value.toolCalls[0], { startedAt: "2026-09-29T19:22:44Z", completedAt: "2026-09-29T19:22:45Z",
        durationMs: 1000, requestedApiPath: "/me/messages", requestArgs: { path: "/me/messages" } });
    return value;
}
async function ready(page) {
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
}
async function setup(t, records = [record()]) {
    const cleanups = [];
    const { context: store } = await privateFixture({ after: action => cleanups.push(action) }, records);
    const state = await loadBoardState(store);
    const evidencePath = path.join(store.dataDir, "private-evidence", state.evidenceFile);
    const evidence = await readFile(evidencePath);
    const runtime = await startServer(store, createExportController(store), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "America/Los_Angeles" });
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() !== "GET" && !(request.method() === "POST" && ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(new URL(request.url()).pathname))) writes.push(request.url());
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw new Error("Clipboard access is forbidden in this proof."); },
        writeText() { throw new Error("Clipboard access is forbidden in this proof."); },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await readFile(evidencePath), evidence);
            assert.deepEqual(errors, []); assert.deepEqual(writes, []);
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(runtime.url + "#request?request=" + records[0].scenarioId); await ready(page);
    return { page, url: runtime.url, store, records };
}
const provenance = page => page.locator(".request-support > details").filter({ has: page.locator("summary", { hasText: /^Prompt provenance$/ }) });
const technical = page => page.locator(".journey-item > details");
const fact = (container, name) => container.locator("dt").filter({ hasText: new RegExp("^" + name + "$") }).locator("+ dd");
async function inventory(page) {
    return page.locator("#requestContent").evaluate(root => {
        const text = root.innerText;
        return { fullTimestamps: (text.match(/Sep 29, 2026, \d+:\d+:\d+ [AP]M/g) || []).length,
            compactTimestamps: (text.match(/Sep 29, 2026, \d+:\d+ [AP]M/g) || []).length,
            offsets: (text.match(/GMT(?:[+-]\d+)?/g) || []).length, ianaLabels: (text.match(/America\/Los_Angeles/g) || []).length };
    });
}

test("one compact request time replaces default full timestamps; exact evidence remains deliberately accessible", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    assert.equal(await page.locator(".request-time").textContent(), "Message recorded: Sep 29, 2026, 12:22 PM");
    assert.deepEqual(await inventory(page), { fullTimestamps: 0, compactTimestamps: 1, offsets: 0, ianaLabels: 0 });
    assert.match(await page.locator("#displayTimeZone option:checked").textContent(), /America\/Los_Angeles/);
    assert.equal(await provenance(page).evaluate(node => node.open), false);
    assert.equal(await technical(page).evaluate(node => node.open), false);
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /origin-unverified|synthetic-message-event|Counts use separate|Started:|Ended:/);
    const beforeOpen = await inventory(page);
    await chooseTheme(page, "dark");
    if (proofs) await page.screenshot({ path: path.join(proofs, "after-closed.png"), fullPage: true });
    await technical(page).locator("summary").first().focus(); await page.keyboard.press("Enter");
    await expect(fact(technical(page), "Started")).toHaveText("Sep 29, 2026, 12:22:44 PM GMT-7");
    await expect(fact(technical(page), "Ended")).toHaveText("Sep 29, 2026, 12:22:45 PM GMT-7");
    assert.equal(await fact(technical(page), "Duration").textContent(), "1000 ms");
    assert.equal(await fact(technical(page), "Raw start timestamp").textContent(), "2026-09-29T19:22:44Z");
    await provenance(page).locator("summary").focus(); await page.keyboard.press("Space");
    await expect(fact(provenance(page), "Message recorded")).toHaveText("Sep 29, 2026, 12:22:29 PM GMT-7");
    assert.equal(await fact(provenance(page), "Origin").textContent(), "Recorded message; author not verified");
    assert.equal(await fact(provenance(page), "Text retained").textContent(), "Complete recorded text");
    assert.equal(await fact(provenance(page), "Source event").innerText(), "synthetic-message-event");
    assert.match(await provenance(page).innerText(), /association inferred, not proven/);
    if (proofs) {
        await page.screenshot({ path: path.join(proofs, "after-exact-details.png"), fullPage: true });
        await writeFile(path.join(proofs, "after-counts.json"), JSON.stringify({ closed: beforeOpen, exactDetailsOpened: await inventory(page), centralZoneLabels: 1 }, null, 2));
    }
    await page.goto(url + "#activity"); await ready(page); await openActivitySessions(page);
    assert.match(await page.locator(".request-meta").innerText(), /Message recorded: Sep 29, 2026, 12:22 PM/);
    assert.doesNotMatch(await page.locator(".request-meta").innerText(), /GMT|America\/Los_Angeles/);
});

test("chronological actions preserve per-instant DST offsets, unknown ends and source-time distinction", { timeout: 30000 }, async t => {
    const source = record();
    source.userPrompt.sourceTimestamp = "2026-11-01T08:29:30Z";
    source.userPrompt.status = "partial"; source.userPrompt.provenance = "coordinator-message";
    source.toolCalls = ["2026-11-02T08:00:00Z", "2026-11-01T09:30:00Z", "2026-11-01T08:30:00Z"].map((startedAt, i) =>
        ({ ...source.toolCalls[0], startedAt, toolCallId: "ordered-" + i, startEventId: "start-" + i,
            completedAt: i === 0 ? null : startedAt, durationMs: i === 0 ? null : 0 }));
    const { page } = await setup(t, [source]);
    assert.deepEqual(await page.locator(".journey-item").evaluateAll(nodes => nodes.map(node => node.dataset.toolCallId)), ["ordered-2", "ordered-1", "ordered-0"]);
    assert.equal(await page.locator(".request-time").textContent(), "Message recorded: Nov 1, 2026, 1:29 AM");
    for (const detail of await technical(page).all()) await detail.locator("summary").first().click();
    assert.equal(await fact(technical(page).nth(0), "Started").textContent(), "Nov 1, 2026, 1:30:00 AM GMT-7");
    assert.equal(await fact(technical(page).nth(1), "Started").textContent(), "Nov 1, 2026, 1:30:00 AM GMT-8");
    assert.equal(await fact(technical(page).nth(2), "Ended").textContent(), "Time not recorded");
    assert.equal(await fact(technical(page).nth(2), "Duration").textContent(), "Not recorded");
    await provenance(page).locator("summary").click();
    assert.equal(await fact(provenance(page), "Origin").textContent(), "Coordinator message");
    assert.match(await fact(provenance(page), "Text retained").textContent(), /Partial text/);
    assert.match(await page.locator(".request-original").innerText(), /Missing text is not reconstructed/);
});

test("timing disclosures preserve keyboard state across live refresh and back without leaking between requests", { timeout: 30000 }, async t => {
    const { page, records, store } = await setup(t, [record(), record("other")]);
    await technical(page).locator("summary").first().focus(); await page.keyboard.press("Enter");
    await provenance(page).locator("summary").focus(); await page.keyboard.press("Enter");
    const before = await provenance(page).locator("summary").evaluate(node => node.getBoundingClientRect().top);
    await replaceEvidence(store, () => ({ records, importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    const response = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online"))); await response; await ready(page);
    assert.equal(await provenance(page).evaluate(node => node.open), true);
    assert.equal(await technical(page).evaluate(node => node.open), true);
    assert.equal(await provenance(page).locator("summary").evaluate(node => document.activeElement === node), true);
    assert.ok(Math.abs(await provenance(page).locator("summary").evaluate(node => node.getBoundingClientRect().top) - before) < 2);
    await page.evaluate(() => { location.hash = "#request?request=other"; }); await ready(page);
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:other");
    assert.equal(await provenance(page).evaluate(node => node.open), false);
    assert.equal(await technical(page).evaluate(node => node.open), false);
    await page.goBack(); await ready(page);
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:timing");
    assert.equal(await provenance(page).evaluate(node => node.open), true);
    assert.equal(await technical(page).evaluate(node => node.open), true);
});

test("Graph and HTTP timing stays secondary without changing raw evidence or manufacturing missing endpoints", { timeout: 30000 }, async t => {
    const source = record();
    source.graphActivities = [{
        activityId: "timing-graph", sourceSessionId: source.sourceSessionId, scenarioId: source.scenarioId,
        toolCallId: "graph-call", startEventId: "graph-start", startedAt: "2026-09-30T06:59:59Z",
        tool: "shell", evidenceLevel: "requested-direct-graph",
        endpoint: { path: "/me/messages", method: "GET", apiVersion: "v1.0", queryShape: [] },
        workload: "Mail", method: "GET", httpStatus: null, statusBasis: "none", requestCount: null,
        countUnit: "recorded-request-site", confidence: "high", synthetic: false,
        sourceKind: "inline-command", requestBasis: "request-command",
        fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
    }];
    source.httpRecords = [{
        recordId: "timing-http", classification: "direct-graph-http", synthetic: false,
        sourceSessionId: source.sourceSessionId, observedGraphHttp: true, startedAt: "2026-09-30T07:00:01Z", endedAt: null,
        status: 200, responseOrigin: "https://graph.microsoft.com", apiVersion: "v1.0", method: "GET",
        responsePath: { path: "/$metadata", query: [] },
    }];
    const { page } = await setup(t, [source]);
    assert.deepEqual(await page.locator(".journey-item h3").allTextContents(), ["workiq-fetch", "Direct Graph request site", "Explicit HTTP recorder"]);
    assert.doesNotMatch(await page.locator(".journey-pages").innerText(), /GMT|11:59:59|12:00:01|invalid/);
    for (const detail of await technical(page).all()) await detail.locator("summary").first().click();
    const graph = technical(page).nth(1), http = technical(page).nth(2);
    assert.equal(await fact(graph, "Recorded").textContent(), "Sep 29, 2026, 11:59:59 PM GMT-7");
    assert.equal(await fact(http, "Started").textContent(), "Sep 30, 2026, 12:00:01 AM GMT-7");
    assert.equal(await fact(http, "Ended").textContent(), "Time not recorded");
    assert.equal(await fact(http, "Duration").textContent(), "Not recorded");
    assert.equal(await graph.locator("pre").textContent(), JSON.stringify(source.graphActivities[0], null, 2));
    assert.equal(await http.locator("pre").textContent(), JSON.stringify(source.httpRecords[0], null, 2));
});

test("pending and failed zones never relabel request time or open exact fields before the snapshot applies", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await technical(page).locator("summary").first().click();
    let release, begun;
    const started = new Promise(resolve => { begun = resolve; });
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().timeContext.timeZone !== "UTC") return route.continue();
        begun(); await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 503, json: { error: "Synthetic failed time change" } });
    });
    await page.evaluate(() => {
        localStorage.setItem("workiq-evidence.time-zone", "UTC");
        window.dispatchEvent(new StorageEvent("storage", { key: "workiq-evidence.time-zone", newValue: "UTC" }));
    });
    await started;
    assert.equal(await page.locator("#displayTimeZone").inputValue(), "UTC");
    assert.match(await page.locator("#displayTimeEffective").textContent(), /Updating time zone\. Still using America\/Los_Angeles/);
    assert.equal(await page.locator(".request-time").textContent(), "Message recorded: Sep 29, 2026, 12:22 PM");
    assert.match(await fact(technical(page), "Started").textContent(), /GMT-7/);
    release(); await ready(page);
    assert.equal(await page.locator(".request-time").textContent(), "Message recorded: Sep 29, 2026, 12:22 PM");
    await expect(page.locator("#message")).toContainText("last recorded snapshot");
    await page.unroute("**/api/snapshot");
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.match(await page.locator("#displayTimeZone option:checked").textContent(), /UTC/);
    assert.equal(await page.locator(".request-time").textContent(), "Message recorded: Sep 29, 2026, 7:22 PM");
    assert.match(await fact(technical(page), "Started").textContent(), /^Sep 29, 2026, 7:22:44 PM GMT(?:\+0)?$/);
    assert.equal(await technical(page).evaluate(node => node.open), true);
});

test("concise and exact timing fit light and navy at 375/820/1200/2560 with 100/200 percent root text", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    const metrics = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        for (const open of [false, true]) {
            for (const detail of [technical(page), provenance(page)]) {
                if (await detail.evaluate(node => node.open) !== open) await detail.locator("summary").first().click();
            }
            const layout = await page.locator("#requestContent").evaluate(root => {
                const selector = ".request-time,.journey-item > details,.request-support > details,dt,dd,summary";
                const clipped = [...root.querySelectorAll(selector)].filter(node => node.checkVisibility() && node.scrollWidth > node.clientWidth + 1).map(node => node.tagName + "." + node.className);
                return { overflow: document.documentElement.scrollWidth - innerWidth, clipped };
            });
            assert.ok(layout.overflow <= 1, `${theme}/${width}/${scale}/${open}: page overflow`);
            assert.deepEqual(layout.clipped, [], `${theme}/${width}/${scale}/${open}: timing and provenance fit`);
            metrics.push({ theme, width, scale, open, ...layout });
            if (proofs && (width === 375 || width === 1200) && (scale === 1 || width === 375)) {
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.screenshot({ path: path.join(proofs, `timing-${theme}-${width}-${scale}-${open ? "exact" : "compact"}.png`), fullPage: true });
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "responsive-metrics.json"), JSON.stringify(metrics, null, 2));
});
