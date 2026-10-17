import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { selectActivityOption, navigateMain } from "./helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import path from "node:path";
import { BOARD_ID } from "../lib/evidence.mjs";

const visibility = (page, hidden) => page.evaluate(hidden => {
    // Exercise the real listener without taking focus from the user's window.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
}, hidden);

async function setup(t, options = {}, prepare) {
    const cleanup = [], children = [], fork = childProcess.fork;
    const forkMock = t.mock.method(childProcess, "fork", (...args) => {
        const child = fork(...args);
        if (/search-(?:model|linguistics)-worker\.mjs$/.test(String(args[0]))) children.push(child);
        return child;
    });
    syncBuiltinESMExports();
    let browser;
    t.after(async () => {
        await browser?.close();
        for (const close of cleanup) await close();
        forkMock.mock.restore(); syncBuiltinESMExports();
        assert.equal(children.length, 0, "Literal Search must not start model or linguistic inference helpers.");
    });
    const app = await searchFixture({ after: close => cleanup.push(close) }, {
        search: { heartbeatMs: 50 },
        ...options,
    });
    browser = await chromium.launch({ channel: "msedge" });
    const page = await browser.newPage();
    const errors = [], queries = [], external = [];
    let capability;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        capability ??= request.headers()["x-board-capability"];
        if (request.url().endsWith("/api/search/query")) queries.push(request.postDataJSON());
    });
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(app.runtime.url).origin) {
            external.push(route.request().url());
            return route.abort();
        }
        return route.continue();
    });
    t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
    await prepare?.(page);
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const api = (route, input = {}) => page.evaluate(async ({ capability, route, input }) => {
        const response = await fetch(route, { method: "POST",
            headers: { "Content-Type": "application/json", "X-Board-Capability": capability }, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
    }, { capability, route, input });
    return { ...app, page, queries, api, cleanup, children, status: () => api("/api/search/status") };
}

test("four typed intents ending in latest retain one preparing index across hide and return", { timeout: 30000 }, async t => {
    const records = searchRecords();
    records[0].userPrompt.text = "The latest physician appointment.";
    const { page, bundles, runtime, queries, status, cleanup, children } = await setup(t, { records, formats: ["html"] });
    const report = bundles[0].files["product-report.html"], read = fs.readFile;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let hold = true;
    const readMock = t.mock.method(fs, "readFile", async (...args) => {
        if (hold && String(args[0]) === report) { entered.resolve(); await release.promise; }
        return read(...args);
    });
    syncBuiltinESMExports();
    cleanup.unshift(() => {
        hold = false; release.resolve();
        readMock.mock.restore(); syncBuiltinESMExports();
    });
    const input = page.locator("#wireSearch");
    await input.fill("l");
    await entered.promise;
    await expect(page.locator("#wireSearchStatus")).toHaveText("Preparing search...");
    for (const [delay, value] of [[141, "la"], [382, "late"], [311, "latest"]]) {
        await page.waitForTimeout(delay);
        await input.fill(value);
    }
    await expect.poll(() => queries.length).toBe(4);
    const focus = await input.evaluate(node => ({
        active: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd,
    }));
    await visibility(page, true);
    await visibility(page, true);
    assert.equal((await status()).status, 200, "Hiding must not close the owned preparing search.");
    assert.equal(runtime.search.status().panels, 1);
    await page.waitForTimeout(5500);
    assert.equal((await status()).status, 200, "Hidden timer throttling must not cause a stream failure.");
    hold = false; release.resolve();
    await expect.poll(async () => (await status()).body.indexId, { timeout: 10000 }).toBeTruthy();
    const built = (await status()).body;
    assert.equal(built.mode, "text");
    assert.equal(Object.hasOwn(built, "model"), false);
    assert.equal(children.length, 0);
    assert.equal(queries.length, 4, "Hiding must not dispatch another query.");
    assert.equal(await page.locator("#wireSearchResults button").count(), 0, "Hidden frames must not disclose saved text.");
    await visibility(page, false);
    await visibility(page, false);
    await expect(page.locator("#wireSearchStatus")).toHaveText("2 matches", { timeout: 10000 });
    assert.equal((await status()).body.indexId, built.indexId, "Return must reuse the prepared current index.");
    assert.equal(queries.length, 5, "Return must revalidate once, not start a retry loop.");
    assert.equal(children.length, 0, "Return does not initialize an inference helper.");
    assert.equal(queries.at(-1).query, "latest");
    assert.equal(await input.inputValue(), "latest");
    assert.deepEqual(await input.evaluate(node => ({
        active: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd,
    })), focus);
    assert.equal(await page.locator("#wireSearchPanel").evaluate(node => node.hidden), false);
    await input.click();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(2);
    await expect(page.locator("#wireSearchResults")).toContainText("latest physician");
});

test("hidden analysis defers scope updates and readmits only the current changed population", { timeout: 30000 }, async t => {
    const { page, context, runtime, queries } = await setup(t);
    await page.locator("#wireSearch").fill("physician");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#activityCount")).toHaveText("1");
    await visibility(page, true);
    await expect(page.locator("#homeView")).toBeHidden();
    assert.equal(await page.locator("#wireSearchResults button").count(), 0);
    const requests = queries.length, before = await loadBoardState(context);
    await replaceEvidence(context, records => ({
        records: records.map((record, index) => index === 1
            ? { ...record, userPrompt: { ...record.userPrompt, text: "A second physician treated a patient." } } : record),
        importCoverage: before.importCoverage,
    }));
    runtime.search.invalidate();
    await page.evaluate(() => document.getElementById("wireSearchScope").dispatchEvent(new Event("change")));
    await page.waitForTimeout(250);
    assert.equal(queries.length, requests, "Hidden scope changes must not submit a new admissible query.");
    await expect(page.locator("#homeView")).toBeHidden();
    assert.equal(await page.locator("#wireSearchResults button").count(), 0);
    await visibility(page, false);
    await expect(page.locator("#activityCount")).toHaveText("2", { timeout: 10000 });
    await expect(page.locator("#homeView")).toBeVisible();
    assert.equal(await page.locator("#wireSearch").inputValue(), "physician");
});

test("consent revocation while hidden cannot revive a retained reply on return", { timeout: 30000 }, async t => {
    const { page, context, runtime, api, status } = await setup(t);
    await page.locator("#wireSearch").fill("lab results");
    await selectActivityOption(page, "wireSearchType", "reply");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await visibility(page, true);
    assert.equal(await page.locator("#wireSearchResults button").count(), 0);
    const state = await loadBoardState(context), source = runtime.collector.assessmentSource(state);
    const revoked = await api("/api/assessment/consent/set", {
        schemaVersion: 1, mutationRef: `mutation-${randomUUID().replaceAll("-", "")}`,
        expectedSourceRevision: state.evidenceRevision, expectedConsentRevision: state.personalEvaluation.consent.revision,
        policyVersion: 1, enabled: false, categories: [], sourceConfigRef: source.sourceConfigRef,
        sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
    });
    assert.equal(revoked.status, 200);
    await expect.poll(async () => (await status()).body.indexId).toBe(null);
    await visibility(page, false);
    await expect(page.locator("#wireSearchStatus")).toHaveText("Search is incomplete. Some saved content could not be searched.", { timeout: 10000 });
    assert.equal(await page.locator("#wireSearchResults button").count(), 0);
});

test("return after two hidden minutes automatically reads the current query with a fresh Search owner", { timeout: 20000 }, async t => {
    const { page, runtime, queries } = await setup(t);
    const input = page.locator("#wireSearch");
    await input.fill("physician");
    await selectActivityOption(page, "wireSearchType", "interaction");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await input.focus();
    await input.press("Home"); await input.press("ArrowRight");
    const selection = await input.evaluate(node => [node.selectionStart, node.selectionEnd]);
    await visibility(page, true);
    const now = Date.now;
    t.mock.method(Date, "now", () => now() + 120001);
    await expect.poll(() => runtime.search.status().panels).toBe(0);
    const prior = queries.length;
    await visibility(page, false);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await expect(page.locator("#wireSearchStatus")).toHaveText("1 match");
    assert.equal(queries.length, prior + 1);
    await expect(input).toHaveValue("physician");
    await expect(input).toBeFocused();
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), selection);
    await expect(page.locator("#wireSearchType")).toHaveValue("interaction");
    assert.equal(runtime.search.status().panels, 1);
});

test("idle release while still active retains intent for a later leave and return", { timeout: 20000 }, async t => {
    const { page, runtime, queries } = await setup(t);
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const now = Date.now;
    t.mock.method(Date, "now", () => now() + 120001);
    await expect.poll(() => runtime.search.status().panels).toBe(0);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    const prior = queries.length;
    await visibility(page, true); await visibility(page, false);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    assert.equal(queries.length, prior + 1);
});

test("a held old-owner completion cannot clear a freshly recovered stream", { timeout: 20000 }, async t => {
    const { page, runtime, queries } = await setup(t);
    const attach = runtime.search.attach, ended = Promise.withResolvers();
    let first = true, finish;
    t.after(() => finish?.());
    t.mock.method(runtime.search, "attach", (owner, response, input) => {
        if (first) {
            first = false;
            const end = response.end.bind(response);
            response.end = (...args) => {
                finish = () => { finish = null; if (!response.destroyed) end(...args); };
                ended.resolve(); return response;
            };
        }
        return attach(owner, response, input);
    });
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const now = Date.now;
    t.mock.method(Date, "now", () => now() + 120001);
    await ended.promise;
    await expect.poll(() => runtime.search.status().panels).toBe(0);
    await visibility(page, true); await visibility(page, false);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const current = queries.length;
    finish?.();
    await page.waitForTimeout(200);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await expect(page.locator("#wireSearchStatus")).toHaveText("1 match");
    assert.equal(queries.length, current);
    assert.equal(runtime.search.status().panels, 1);
});

for (const failure of ["protocol", "malformed", "network", "eof", "stale-owner", "stale-epoch"]) {
    test(`an away ${failure} stream failure stays terminal on return`, { timeout: 20000 }, async t => {
        let attempts = 0;
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        t.after(() => release.resolve());
        const { page } = await setup(t, {}, page => page.route("**/api/search/events", async route => {
            attempts++; entered.resolve(); await release.promise;
            if (failure === "protocol") return route.fulfill({ status: 409,
                json: { code: "search-protocol-changed", error: "Search changed. Reload this panel." } });
            if (failure === "malformed") return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: "{broken\n" });
            if (failure === "eof") return route.fulfill({ status: 200, contentType: "application/x-ndjson",
                body: JSON.stringify({ schemaVersion: 3, event: "connected", panelId: randomUUID(), epoch: 0 }) + "\n" });
            if (failure.startsWith("stale-")) {
                const panelId = randomUUID();
                const frames = [
                    { schemaVersion: 3, event: "connected", panelId, epoch: 0 },
                    { schemaVersion: 3, event: "fence", panelId, epoch: 1, reason: "idle" },
                    failure === "stale-owner" ? { schemaVersion: 3, event: "connected", panelId: randomUUID(), epoch: 0 }
                        : { schemaVersion: 3, event: "fence", panelId, epoch: 2, reason: "changed" },
                ];
                return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: frames.map(frame => JSON.stringify(frame)).join("\n") + "\n" });
            }
            return route.abort("failed");
        }));
        await page.locator("#wireSearch").fill("physician"); await entered.promise;
        await visibility(page, true); release.resolve();
        await expect(page.locator("#wireSearchRetry")).not.toHaveAttribute("hidden", "");
        const error = await page.locator("#wireSearchStatus").textContent();
        assert.match(error, failure === "protocol" ? /changed/ : failure === "malformed" ? /unreadable/
            : failure === "eof" || failure.startsWith("stale-") ? /disconnected/ : /unavailable/);
        await visibility(page, false); await page.locator("#wireSearch").focus();
        await page.waitForTimeout(300);
        assert.equal(attempts, 1, "A terminal stream error cannot be converted into an automatic reconnect.");
        await expect(page.locator("#wireSearchStatus")).toHaveText(error);
        await visibility(page, true); await visibility(page, false);
        await page.waitForTimeout(200);
        assert.equal(attempts, 1);
        await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        await page.waitForTimeout(200);
        assert.equal(attempts, 1);
        await expect(page.locator("#wireSearchStatus")).toHaveText(error);
    });
}

test("a visible engine read failure terminates automatic resume before leaving", { timeout: 20000 }, async t => {
    const { page, context, queries, runtime } = await setup(t, { search: { heartbeatMs: 60000 } });
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const stateFile = path.join(context.dataDir, BOARD_ID + ".state.json"), read = fs.readFile;
    let failing = true, failedReads = 0;
    const readMock = t.mock.method(fs, "readFile", (...args) => {
        if (failing && String(args[0]) === stateFile) {
            failedReads++;
            throw Object.assign(new Error("Synthetic current-state read failed."), { code: "EIO" });
        }
        return read(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { readMock.mock.restore(); syncBuiltinESMExports(); });
    await page.locator("#wireSearch").fill("mechanic");
    await expect(page.locator("#wireSearchStatus")).toHaveText("Search is unavailable. Try again.");
    assert.ok(failedReads > 0);
    failing = false;
    const prior = queries.length;
    await visibility(page, true); await visibility(page, false);
    await page.waitForTimeout(300);
    assert.equal(queries.length, prior, "A genuine engine read failure stays terminal when the page becomes inactive later.");
    await expect(page.locator("#wireSearchStatus")).toHaveText("Search is unavailable. Try again.");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await page.locator("#wireSearch").click();
    await page.locator("#wireSearchRetry").click();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    assert.equal(runtime.search.status().panels, 1);
});

test("focus-only return after two minutes reestablishes Search even when the document stayed visible", { timeout: 20000 }, async t => {
    const { page, runtime, queries } = await setup(t);
    const input = page.locator("#wireSearch");
    await input.fill("physician");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await page.evaluate(() => {
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
        window.dispatchEvent(new Event("blur"));
    });
    assert.equal(await page.evaluate(() => document.hidden), false, "A covered but unminimized window can remain visible.");
    const now = Date.now;
    t.mock.method(Date, "now", () => now() + 120001);
    await expect.poll(() => runtime.search.status().panels).toBe(0);
    const prior = queries.length;
    await page.evaluate(() => {
        delete document.hasFocus;
        window.dispatchEvent(new Event("focus"));
    });
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await expect(input).toHaveValue("physician");
    await expect(input).toBeFocused();
    await expect(page.locator("#wireSearchPanel")).toBeVisible();
    assert.equal(queries.length, prior + 1);
});

test("the return updater belongs to the snapshot read and settles independently of idle Search", { timeout: 25000 }, async t => {
    const { page, runtime } = await setup(t);
    await page.evaluate(() => { location.hash = "#reports"; });
    await expect(page.locator("#reportsView")).toBeVisible();
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/snapshot", async route => {
        entered.resolve(); await release.promise; await route.continue();
    });
    await visibility(page, true);
    const now = Date.now;
    t.mock.method(Date, "now", () => now() + 120001);
    await expect.poll(() => runtime.search.status().panels).toBe(0);
    await visibility(page, false);
    await entered.promise;
    await expect(page.locator("#message")).toBeHidden();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    t.diagnostic("Held return snapshot: " + await page.locator("#wireSearchStatus").textContent());
    release.resolve();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#message")).toBeHidden();
    await expect(page.locator("#reportsView")).toBeVisible();
});

test("a stalled return snapshot reaches an explicit error and read-only recovery instead of an indefinite updater", { timeout: 25000 }, async t => {
    const { page } = await setup(t);
    await navigateMain(page, "reports");
    await page.route("**/api/snapshot", () => {});
    await visibility(page, true); await visibility(page, false);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false", { timeout: 15000 });
    await expect(page.locator("#message")).toContainText("Local runtime unavailable");
    await expect(page.locator("#reportsView")).toBeVisible();
    await expect(page.locator("#message")).not.toContainText("Updating");
    await page.unroute("**/api/snapshot");
    await page.locator("#storedViewRetry").click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#message")).toBeHidden();
    await expect(page.locator("#reportsView")).toBeVisible();
});

test("return with no accepted snapshot still uses first-load error and loading ownership", { timeout: 20000 }, async t => {
    let first = true;
    const { page } = await setup(t, {}, page => page.route("**/api/snapshot", route => {
        if (first) { first = false; return route.abort("connectionrefused"); }
        return route.continue();
    }));
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator("#message")).toContainText("activity could not load");
    await expect(page.locator("#message")).not.toContainText("last recorded snapshot");
    await visibility(page, true); await visibility(page, false);
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#message")).toBeHidden();
});

test("a late return snapshot cannot settle or replace a newer route read", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await navigateMain(page, "reports");
    const entered = [Promise.withResolvers(), Promise.withResolvers()], releases = [Promise.withResolvers(), Promise.withResolvers()];
    let index = 0;
    t.after(() => releases.forEach(gate => gate.resolve()));
    await page.route("**/api/snapshot", async route => {
        const own = index++, response = await route.fetch();
        if (own < 2) { entered[own].resolve(); await releases[own].promise; }
        await route.fulfill({ response });
    });
    await visibility(page, true); await visibility(page, false); await entered[0].promise;
    await page.evaluate(() => { location.hash = "#analyze?layer=http"; });
    await entered[1].promise;
    const oldResponse = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
        && response.request().postDataJSON().layer === "tool");
    releases[0].resolve(); await (await oldResponse).finished();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    releases[1].resolve();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page).toHaveURL(/#analyze\?layer=http/);
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#reportsView")).toBeHidden();
    await expect(page.locator("#message")).toBeHidden();
});

test("query and scope replacement around resume reject a deliberately late old request", { timeout: 20000 }, async t => {
    const { page, queries } = await setup(t);
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/search/query", async route => {
        if (route.request().postDataJSON().query === "mechanic") { entered.resolve(); await release.promise; }
        await route.continue();
    });
    await page.locator("#wireSearch").fill("mechanic"); await entered.promise;
    await visibility(page, true);
    await page.locator("#wireSearch").evaluate(node => {
        node.value = "credentials"; node.dispatchEvent(new Event("input"));
        document.getElementById("wireSearchScope").value = "analysis";
        document.getElementById("wireSearchScope").dispatchEvent(new Event("change"));
    });
    await visibility(page, false);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#wireSearchResults")).toContainText("credentials");
    const late = page.waitForResponse(response => response.url().endsWith("/api/search/query")
        && response.request().postDataJSON().query === "mechanic");
    release.resolve(); await (await late).finished();
    await expect(page.locator("#wireSearchResults")).toContainText("credentials");
    await expect(page.locator("#wireSearchResults")).not.toContainText("mechanic");
    await expect(page.locator("#activityCount")).toHaveText("1");
    assert.equal(queries.at(-1).purpose, "analysis");
    assert.equal(queries.at(-1).query, "credentials");
});

test("a replaced local runtime gets a new capability and current results, never the old owner", { timeout: 20000 }, async t => {
    const { page, runtime, context, cleanup } = await setup(t);
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await visibility(page, true);
    const close = runtime.close;
    let closing;
    t.mock.method(runtime, "close", () => closing ??= close());
    await runtime.close();
    const restarted = await startServer(context, createExportController(context), {
        port: Number(new URL(runtime.url).port), collector: { timers: false }, search: { heartbeatMs: 50 },
        evaluation: { evaluatorFactory: async () => { throw new Error("Provider forbidden."); } },
    });
    cleanup.unshift(() => restarted.close());
    const renewed = [];
    page.on("request", request => { if (request.url().endsWith("/api/session")) renewed.push(request); });
    await visibility(page, false);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    assert.equal(renewed.length, 1);
    assert.equal(restarted.search.status().panels, 1);
});

test("a frozen renderer consumes the elapsed idle fence before admitting fresh return results", { timeout: 20000 }, async t => {
    const { page, runtime } = await setup(t);
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const cdp = await page.context().newCDPSession(page);
    await visibility(page, true);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    try {
        const now = Date.now;
        t.mock.method(Date, "now", () => now() + 120001);
        await expect.poll(() => runtime.search.status().panels).toBe(0);
    } finally { await cdp.send("Page.setWebLifecycleState", { state: "active" }); }
    await visibility(page, false);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await expect(page.locator("#wireSearchPanel")).toBeVisible();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    t.diagnostic("Real Chromium renderer freeze; visibility and 120001ms server elapsed time are controlled, not native tab backgrounding.");
});

test("native history traversal records BFCache admission without inventing a restored document", { timeout: 20000 }, async t => {
    const { page, runtime } = await setup(t);
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const identity = await page.evaluate(() => {
        window.returnProbe = { identity: crypto.randomUUID(), persisted: false };
        window.addEventListener("pageshow", event => { window.returnProbe.persisted = event.persisted; });
        return window.returnProbe.identity;
    });
    await page.goto(runtime.url + "health");
    await page.goBack();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const restored = await page.evaluate(() => ({
        identity: window.returnProbe?.identity, persisted: window.returnProbe?.persisted,
        reasons: performance.getEntriesByType("navigation")[0]?.notRestoredReasons?.toJSON?.() ?? null,
    }));
    if (restored.identity === identity && restored.persisted) {
        await expect(page.locator("#wireSearch")).toHaveValue("physician");
        await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
        t.diagnostic("Native BFCache admitted the original document; query and fresh results restored.");
    } else {
        await expect(page.locator("#wireSearch")).toHaveValue("");
        t.diagnostic("Native traversal created a new document; BFCache recovery not claimed. " + JSON.stringify(restored.reasons));
    }
});

test("return restores the current results page and keyboard reading position", { timeout: 20000 }, async t => {
    const { page } = await setup(t, { records: searchRecords(24) });
    await page.locator("#wireSearch").fill("Invented local");
    await selectActivityOption(page, "wireSearchType", "interaction");
    await page.getByRole("button", { name: "Next results", exact: true }).click();
    const row = page.locator("#wireSearchResults button").nth(2);
    await row.focus();
    const id = await row.getAttribute("data-search-id");
    await visibility(page, true); await visibility(page, false);
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2; 24 total");
    await expect(page.locator(`[data-search-id="${id}"]`)).toBeFocused();
    await expect(page.locator("#wireSearchPanel")).toBeVisible();
});

for (const cause of ["capability-expiry", "session-release", "pagehide"]) {
    test(`${cause} on an away page renews read-only Search without retaining old results`, { timeout: 20000 }, async t => {
        const { page, runtime, queries, api } = await setup(t);
        const requests = [];
        page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
        await page.locator("#wireSearch").fill("physician");
        await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
        await visibility(page, true);
        if (cause === "capability-expiry") {
            const now = Date.now;
            t.mock.method(Date, "now", () => now() + 1800001);
            assert.equal((await api("/api/search/status")).status, 403);
        } else if (cause === "session-release") assert.equal((await api("/api/session/release")).status, 200);
        else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        await expect.poll(() => runtime.search.status().panels).toBe(0);
        await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
        const prior = queries.length;
        await visibility(page, false);
        if (cause === "pagehide") await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
        await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#wireSearch")).toHaveValue("physician");
        await expect(page.locator("#wireSearchPanel")).toBeVisible();
        assert.equal(queries.length, prior + 1);
        assert.ok(requests.every(route => ["/api/search/query", "/api/search/events", "/api/search/status", "/api/session",
            "/api/session/release", "/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary"].includes(route)),
        "Lifecycle return dispatches no collection, provider, save or other mutation");
        await visibility(page, true); await visibility(page, false); await visibility(page, false);
        await expect.poll(() => queries.length).toBe(prior + 2);
        await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    });
}

test("a silent stream on visible return still reaches an explicit reconnect instead of waiting forever", { timeout: 20000 }, async t => {
    const { page, runtime, queries } = await setup(t, {
        search: { heartbeatMs: 60000 },
    });
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
    await page.clock.install();
    await visibility(page, true);
    await page.clock.runFor(6000);
    assert.equal(runtime.search.status().panels, 1);
    await page.route("**/api/search/query", () => {});
    await visibility(page, false);
    await page.clock.runFor(5100);
    await expect(page.locator("#wireSearchStatus")).toContainText("Search disconnected.");
    await expect.poll(() => runtime.search.status().panels).toBe(0);
    const prior = queries.length;
    await visibility(page, true);
    await visibility(page, false);
    await page.clock.runFor(1000);
    assert.equal(queries.length, prior, "A real timeout must not become an automatic retry loop.");
    assert.equal(await page.locator("#wireSearchResults button").count(), 0);
});

for (const action of ["clear", "cancel", "close"]) {
    test(`hidden ${action} releases owned work and cannot restart on return`, { timeout: 30000 }, async t => {
        const { page, runtime, api, status, queries, children } = await setup(t);
        await page.locator("#wireSearch").fill("physician");
        await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
        await visibility(page, true);
        if (action === "clear") await page.evaluate(() => document.getElementById("wireSearchClear").click());
        if (action === "cancel" || action === "close") assert.equal((await api("/api/search/" + action)).status, 200);
        if (action === "clear" || action === "cancel") {
            await expect.poll(async () => (await status()).body.indexId).toBe(null);
        } else await expect.poll(() => runtime.search.status().panels, { timeout: 5000 }).toBe(0);
        await expect.poll(() => children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
        const prior = queries.length;
        await visibility(page, false);
        await page.waitForTimeout(300);
        assert.equal(queries.length, prior, `${action} must not replay a query on return.`);
        await visibility(page, true); await visibility(page, false);
        await page.waitForTimeout(300);
        assert.equal(queries.length, prior, `${action} stays terminal across repeated returns.`);
        assert.equal(await page.locator("#wireSearchResults button").count(), 0);
        if (action === "clear") assert.equal(await page.locator("#wireSearch").inputValue(), "");
    });
}
