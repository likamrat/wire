import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { selectActivityOption } from "./helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";

const visibility = (page, hidden) => page.evaluate(hidden => {
    // Exercise the real listener without taking focus from the user's window.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
}, hidden);

async function setup(t, options = {}) {
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
    assert.equal(await page.locator("#wireSearchPanel").evaluate(node => node.hidden), true);
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

for (const action of ["clear", "cancel", "close", "idle", "expiry", "pagehide"]) {
    test(`hidden ${action} releases owned work and cannot restart on return`, { timeout: 30000 }, async t => {
        const { page, runtime, api, status, queries, children } = await setup(t);
        await page.locator("#wireSearch").fill("physician");
        await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
        await visibility(page, true);
        if (action === "idle" || action === "expiry") {
            const now = Date.now, elapsed = action === "idle" ? 120001 : 1800001;
            t.mock.method(Date, "now", () => now() + elapsed);
            if (action === "expiry") assert.equal((await status()).status, 403);
        }
        if (action === "clear") await page.evaluate(() => document.getElementById("wireSearchClear").click());
        if (action === "cancel" || action === "close") assert.equal((await api("/api/search/" + action)).status, 200);
        if (action === "pagehide") await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
        if (action === "clear" || action === "cancel") {
            await expect.poll(async () => (await status()).body.indexId).toBe(null);
        } else await expect.poll(() => runtime.search.status().panels, { timeout: 5000 }).toBe(0);
        await expect.poll(() => children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
        const prior = queries.length;
        await visibility(page, false);
        await page.waitForTimeout(300);
        assert.equal(queries.length, prior, `${action} must not replay a query on return.`);
        assert.equal(await page.locator("#wireSearchResults button").count(), 0);
        if (action === "clear" || action === "pagehide") assert.equal(await page.locator("#wireSearch").inputValue(), "");
    });
}
